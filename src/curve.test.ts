import { describe, expect, test } from "vite-plus/test";
import {
  addPointAt,
  DEFAULT_FAMILY,
  FAMILY_NAMES,
  familyCurve,
  MAX_R,
  MIN_R,
  maxRadius,
  mirrorV,
  removePoint,
  sampleRadius,
  sanitizeCurve,
  setPoint,
  smooth,
} from "./curve.ts";

describe("sampleRadius", () => {
  test("passes exactly through its control points", () => {
    const c = familyCurve("empire");
    for (const p of c) expect(sampleRadius(c, p.v)).toBeCloseTo(p.r, 6);
  });

  test("a two-point curve is a straight taper", () => {
    const c = [
      { v: 0, r: 100 },
      { v: 1, r: 50 },
    ];
    expect(sampleRadius(c, 0.5)).toBeCloseTo(75, 6);
    expect(sampleRadius(c, 0.25)).toBeCloseTo(87.5, 6);
  });

  test("clamps out-of-range v instead of extrapolating off the end", () => {
    const c = familyCurve("cone");
    expect(sampleRadius(c, -5)).toBeCloseTo(sampleRadius(c, 0), 6);
    expect(sampleRadius(c, 99)).toBeCloseTo(sampleRadius(c, 1), 6);
  });

  test("clamps spline overshoot to a buildable radius", () => {
    // Control points wild enough that Catmull-Rom undershoots hard between them.
    const c = [
      { v: 0, r: 300 },
      { v: 0.45, r: 5 },
      { v: 0.55, r: 5 },
      { v: 1, r: 300 },
    ];
    for (let k = 0; k <= 200; k++) {
      const r = sampleRadius(c, k / 200);
      expect(r).toBeGreaterThanOrEqual(MIN_R);
      expect(r).toBeLessThanOrEqual(MAX_R);
    }
  });

  test("every family samples to a finite buildable radius throughout", () => {
    for (const name of FAMILY_NAMES) {
      const c = familyCurve(name);
      for (let k = 0; k <= 64; k++) {
        const r = sampleRadius(c, k / 64);
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(MIN_R);
      }
    }
  });

  test("maxRadius catches a bulge between control points, not just at them", () => {
    const c = [
      { v: 0, r: 50 },
      { v: 0.5, r: 120 },
      { v: 1, r: 50 },
    ];
    expect(maxRadius(c)).toBeGreaterThanOrEqual(120);
  });
});

describe("editing ops", () => {
  test("setPoint pins the rims to v=0 and v=1 however far they are dragged", () => {
    const c = familyCurve("empire");
    expect(setPoint(c, 0, 0.4, 100)[0].v).toBe(0);
    const last = c.length - 1;
    expect(setPoint(c, last, 0.4, 100)[last].v).toBe(1);
  });

  test("setPoint keeps interior points strictly ordered", () => {
    const c = familyCurve("empire");
    // Drag point 2 far past its neighbours in both directions.
    for (const target of [-9, 9]) {
      const out = setPoint(c, 2, target, 90);
      for (let i = 1; i < out.length; i++) expect(out[i].v).toBeGreaterThan(out[i - 1].v);
    }
  });

  test("removePoint refuses to drop either rim but drops interior points", () => {
    const c = familyCurve("empire");
    expect(removePoint(c, 0)).toHaveLength(c.length);
    expect(removePoint(c, c.length - 1)).toHaveLength(c.length);
    expect(removePoint(c, 2)).toHaveLength(c.length - 1);
  });

  test("removePoint never goes below two points", () => {
    const two = [
      { v: 0, r: 90 },
      { v: 1, r: 40 },
    ];
    expect(removePoint(two, 1)).toHaveLength(2);
  });

  test("addPointAt inserts in order and on the existing curve", () => {
    const c = familyCurve("cone");
    const out = addPointAt(c, 0.3);
    expect(out).toHaveLength(c.length + 1);
    for (let i = 1; i < out.length; i++) expect(out[i].v).toBeGreaterThan(out[i - 1].v);
    // The new point lies on the curve it was sampled from, so the shape does not jump.
    expect(sampleRadius(out, 0.3)).toBeCloseTo(sampleRadius(c, 0.3), 6);
  });

  test("smooth pins the rims and pulls interior radii together", () => {
    const c = [
      { v: 0, r: 100 },
      { v: 0.5, r: 20 },
      { v: 1, r: 100 },
    ];
    const out = smooth(c);
    expect(out[0].r).toBe(100);
    expect(out[2].r).toBe(100);
    expect(out[1].r).toBeGreaterThan(20); // pulled toward its neighbours
  });

  test("mirrorV flips top for bottom", () => {
    const c = familyCurve("cone"); // wide bottom, narrow top
    const m = mirrorV(c);
    expect(m[0].v).toBe(0);
    expect(m[m.length - 1].v).toBe(1);
    expect(sampleRadius(m, 0)).toBeCloseTo(sampleRadius(c, 1), 6);
    expect(sampleRadius(m, 1)).toBeCloseTo(sampleRadius(c, 0), 6);
  });
});

describe("sanitizeCurve (untrusted localStorage)", () => {
  test("non-array input falls back to the default family", () => {
    for (const junk of [null, undefined, 42, "curve", {}, true]) {
      expect(sanitizeCurve(junk)).toEqual(familyCurve(DEFAULT_FAMILY));
    }
  });

  test("drops malformed entries and keeps well-formed ones", () => {
    const out = sanitizeCurve([
      { v: 0, r: 100 },
      { v: "x", r: 50 },
      null,
      { v: 0.5 },
      { v: 0.7, r: 60 },
      { nope: 1 },
      { v: 1, r: 40 },
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.r)).toEqual([100, 60, 40]);
  });

  test("rejects non-finite numbers, which JSON serialises as null", () => {
    const round = JSON.parse(
      JSON.stringify([
        { v: 0, r: Number.NaN },
        { v: 1, r: Infinity },
      ]),
    );
    expect(sanitizeCurve(round)).toEqual(familyCurve(DEFAULT_FAMILY));
  });

  test("forces the rims to exactly 0 and 1 and sorts by height", () => {
    const out = sanitizeCurve([
      { v: 0.9, r: 40 },
      { v: 0.1, r: 100 },
      { v: 0.5, r: 70 },
    ]);
    expect(out[0].v).toBe(0);
    expect(out[out.length - 1].v).toBe(1);
    expect(out.map((p) => p.r)).toEqual([100, 70, 40]);
  });

  test("collapses coincident points rather than yielding a zero-length span", () => {
    const out = sanitizeCurve([
      { v: 0, r: 100 },
      { v: 0.5, r: 80 },
      { v: 0.5, r: 60 },
      { v: 1, r: 40 },
    ]);
    for (let i = 1; i < out.length; i++) expect(out[i].v).toBeGreaterThan(out[i - 1].v);
  });

  test("clamps radii into the buildable range", () => {
    const out = sanitizeCurve([
      { v: 0, r: -50 },
      { v: 1, r: 99999 },
    ]);
    expect(out[0].r).toBe(MIN_R);
    expect(out[1].r).toBe(MAX_R);
  });

  test("fewer than two usable points falls back to the default family", () => {
    expect(sanitizeCurve([{ v: 0, r: 100 }])).toEqual(familyCurve(DEFAULT_FAMILY));
  });
});
