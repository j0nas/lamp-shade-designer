// The real bulb profiles: every consumer (3D lathe, editor section, clearance lint) trusts that
// the data honours its declared envelope and that the section/keep-out/clearance math is sound.
// Pure math throughout; no kernel.
import { describe, expect, test } from "vite-plus/test";
import {
  BULB_KINDS,
  BULBS,
  bulbCapUp,
  bulbKeepOutWorld,
  bulbLatheProfiles,
  bulbSectionWorld,
  sectionGap,
} from "./bulbs.ts";

describe("profiles honour their declared envelope", () => {
  for (const kind of BULB_KINDS) {
    const spec = BULBS[kind];
    test(`${kind}: z spans 0..len, max r = dia/2, z monotonic`, () => {
      const zs = spec.pts.map(([z]) => z);
      const rs = spec.pts.map(([, r]) => r);
      expect(zs[0]).toBe(0);
      expect(zs[zs.length - 1]).toBeCloseTo(spec.len, 6);
      for (let i = 1; i < zs.length; i++) expect(zs[i]).toBeGreaterThanOrEqual(zs[i - 1]);
      expect(Math.max(...rs)).toBeCloseTo(spec.dia / 2, 1);
      for (const r of rs) {
        expect(r).toBeGreaterThan(0);
        expect(r).toBeLessThanOrEqual(spec.dia / 2 + 1e-9);
      }
    });

    test(`${kind}: the cap/glass seam lies inside the profile and the glass outgrows it`, () => {
      expect(spec.capMm).toBeGreaterThan(0);
      expect(spec.capMm).toBeLessThan(spec.len);
      const glassMax = Math.max(...spec.pts.filter(([z]) => z > spec.capMm).map(([, r]) => r));
      expect(glassMax).toBeCloseTo(spec.dia / 2, 1);
    });
  }
});

describe("world section", () => {
  test("cap-down puts the base at centre − len/2, the tip above", () => {
    const spec = BULBS.a60;
    const sec = bulbSectionWorld("a60", 100, false);
    expect(sec[0]).toEqual([0, 100 - spec.len / 2]);
    expect(sec[sec.length - 1]).toEqual([0, 100 + spec.len / 2]);
  });

  test("cap-up mirrors the same section about the centre", () => {
    const down = bulbSectionWorld("st64", 80, false);
    const up = bulbSectionWorld("st64", 80, true);
    expect(up.length).toBe(down.length);
    for (let i = 0; i < down.length; i++) {
      expect(up[i][0]).toBeCloseTo(down[i][0], 9); // radii identical
      expect(up[i][1]).toBeCloseTo(160 - down[i][1], 9); // z reflected about the centre
    }
  });

  test("the cap points at the mount", () => {
    expect(bulbCapUp(1, 0.45)).toBe(true); // pendant: fitter above the bulb
    expect(bulbCapUp(0, 0.45)).toBe(false); // table lamp: socket below
  });
});

describe("keep-out", () => {
  for (const kind of BULB_KINDS) {
    test(`${kind}: dilates the section by ~the air gap and clears both tips`, () => {
      const clear = 10;
      const spec = BULBS[kind];
      const keep = bulbKeepOutWorld(kind, 100, false, clear);
      // Extends past both tips by the gap.
      expect(keep[0][1]).toBeCloseTo(100 - spec.len / 2 - clear, 6);
      expect(keep[keep.length - 1][1]).toBeCloseTo(100 + spec.len / 2 + clear, 6);
      // Every profile point sits well inside: at least half the gap from the keep-out line
      // (the boundary is offset from an RDP-simplified profile, so corners give a little back).
      const sec = bulbSectionWorld(kind, 100, false);
      const gap = sectionGap(
        sec,
        keep.slice().sort((a, b) => a[1] - b[1]),
      );
      expect(gap).toBeGreaterThan(clear * 0.5);
    });
  }
});

describe("sectionGap", () => {
  const drum = (r: number, h = 300): [number, number][] => [
    [r, 0],
    [r, h],
  ];

  test("against a wide drum the gap is radial and exact", () => {
    const gap = sectionGap(bulbSectionWorld("a60", 150, false), drum(80));
    expect(gap).toBeCloseTo(80 - 30, 6);
  });

  test("a drum narrower than the glass reports the penetration depth", () => {
    const gap = sectionGap(bulbSectionWorld("a60", 150, false), drum(25));
    expect(gap).toBeCloseTo(-5, 1);
  });

  test("a shade closing in above the glass tip is caught (the radial check never saw it)", () => {
    // Wide drum around the bulb, necking to r = 10 just above the tip (tip at z = 202.5).
    const wall: [number, number][] = [
      [60, 0],
      [60, 205],
      [10, 206],
      [10, 240],
    ];
    const gap = sectionGap(bulbSectionWorld("a60", 150, false), wall);
    expect(gap).toBeLessThan(11); // the tip is ~10 mm from the neck wall, not 30 mm from the drum
    expect(gap).toBeGreaterThan(0);
  });
});

describe("lathe profiles", () => {
  for (const kind of BULB_KINDS) {
    test(`${kind}: both parts close onto the axis and share the seam`, () => {
      const spec = BULBS[kind];
      const { base, glass } = bulbLatheProfiles(kind);
      expect(base[0]).toEqual([0, 0]);
      expect(base[base.length - 1]).toEqual([0, spec.capMm]);
      expect(glass[0]).toEqual([0, spec.capMm]);
      expect(glass[glass.length - 1]).toEqual([0, spec.len]);
      // Seam continuity: the two parts meet at the same radius at capMm.
      expect(base[base.length - 2][1]).toBeCloseTo(spec.capMm, 6);
      expect(glass[1][1]).toBeCloseTo(spec.capMm, 6);
      expect(base[base.length - 2][0]).toBeCloseTo(glass[1][0], 6);
    });
  }
});
