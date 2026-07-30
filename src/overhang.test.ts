// The overhang lint, end to end: severity math, the colour ramp, the surface sampling, the
// silhouette bands and the heatmap attribute. One real CSG build at the bottom; everything above
// it is pure math on curves and hand-built geometry.
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { BufferAttribute, BufferGeometry, Color } from "three";
import { initCSG } from "parametric-kit/csg";
import { defaults } from "parametric-kit/params";
import { creased } from "parametric-kit/viewer";
import { familyCurve } from "./curve.ts";
import { type Params, schema } from "./params.ts";
import { buildShade, maxOverhangDeg } from "./shade.ts";
import { SHADE_COLOR } from "./lit.ts";
import {
  applyOverhangColors,
  OVERHANG_BAD_DEG,
  OVERHANG_WARN_DEG,
  overhangBands,
  overhangWarnings,
  ramp,
  severityDeg,
  silhouetteDeg,
} from "./overhang.ts";

// For the one real build at the bottom; everything else in this file never touches the kernel.
beforeAll(async () => {
  await initCSG();
});

const base = (over: Partial<Params> = {}): Params => ({ ...defaults(schema), ...over });

// A bulb with violently flared rims: the spline runs ~74° from vertical near both ends, safely
// past OVERHANG_BAD_DEG, while the equator stays near-vertical.
const bulb = [
  { v: 0, r: 44 },
  { v: 0.1, r: 104 },
  { v: 0.5, r: 110 },
  { v: 0.9, r: 104 },
  { v: 1, r: 44 },
];

const silOpts = { height: 200, girth: 1, waveCount: 0, waveDepth: 0 };

describe("severityDeg", () => {
  test("anchors at 0, 45 and 90 degrees, sign-agnostic", () => {
    expect(severityDeg(0)).toBe(0);
    expect(severityDeg(Math.sin(Math.PI / 4))).toBeCloseTo(45, 9);
    expect(severityDeg(1)).toBeCloseTo(90, 9);
    expect(severityDeg(-1)).toBeCloseTo(90, 9); // leaning inward fails exactly like outward
    expect(severityDeg(-Math.sin(Math.PI / 4))).toBeCloseTo(45, 9);
    expect(severityDeg(1.0000001)).toBeCloseTo(90, 9); // float noise past unit length is clamped
  });
});

describe("ramp", () => {
  test("is monotonic: green falls as the angle rises", () => {
    let g = ramp(0)[1];
    for (let deg = 1; deg <= 90; deg++) {
      const next = ramp(deg)[1];
      expect(next).toBeLessThanOrEqual(g + 1e-9);
      g = next;
    }
  });

  test("hits the exact stop colours, in LINEAR space", () => {
    const close = (a: [number, number, number], c: Color) => {
      expect(a[0]).toBeCloseTo(c.r, 6);
      expect(a[1]).toBeCloseTo(c.g, 6);
      expect(a[2]).toBeCloseTo(c.b, 6);
    };
    close(ramp(0), new Color(SHADE_COLOR));
    close(ramp(OVERHANG_WARN_DEG), new Color(0xe0a33a));
    close(ramp(OVERHANG_BAD_DEG), new Color(0xe05a5a));
    close(ramp(90), new Color(0xe05a5a)); // clamped past bad
    // The linear-space pin: sRGB 163/255 read as raw linear would be 0.64 — the converted value
    // is far darker. If this fails the ramp is writing sRGB into a linear attribute.
    expect(ramp(OVERHANG_WARN_DEG)[1]).toBeLessThan(0.45);
  });
});

describe("maxOverhangDeg", () => {
  test("a drum is vertical everywhere", () => {
    expect(maxOverhangDeg(base(), familyCurve("drum"))).toBeCloseTo(0, 3);
  });

  test("a straight cone measures exactly its taper angle", () => {
    // cone family: r 104 -> 44 over height 200 at girth 1, and a two-point Catmull-Rom is straight.
    const expected = (Math.atan(60 / 200) * 180) / Math.PI; // 16.7°
    expect(maxOverhangDeg(base(), familyCurve("cone"))).toBeCloseTo(expected, 1);
  });

  test("girth scales the overhang: the same curve leans harder when wider", () => {
    const narrow = maxOverhangDeg(base({ girth: 1 }), familyCurve("sphere"));
    const wide = maxOverhangDeg(base({ girth: 2 }), familyCurve("sphere"));
    expect(wide).toBeGreaterThan(narrow);
    expect(wide).toBeGreaterThan(OVERHANG_WARN_DEG); // ≈ 56.6°: a fat sphere is a cooling test
    expect(wide).toBeLessThan(OVERHANG_BAD_DEG);
  });

  test("waves raise it: the wave term is part of the surface, not decoration", () => {
    const plain = maxOverhangDeg(base(), familyCurve("empire"));
    const wavy = maxOverhangDeg(base({ waveCount: 8, waveDepth: 6 }), familyCurve("empire"));
    expect(wavy).toBeGreaterThan(plain);
  });

  test("the memo is keyed on the curve by reference, so a new array can never serve stale", () => {
    const p = base();
    const drum = familyCurve("drum");
    expect(maxOverhangDeg(p, drum)).toBeCloseTo(0, 3);
    expect(maxOverhangDeg(p, drum)).toBeCloseTo(0, 3); // memo hit, same answer
    // Fresh array, same params: the memo must miss and remeasure.
    expect(maxOverhangDeg(p, familyCurve("cone"))).toBeGreaterThan(10);
  });
});

describe("overhangBands", () => {
  test("a drum has no bands", () => {
    expect(overhangBands(familyCurve("drum"), silOpts)).toEqual([]);
  });

  test("the flared bulb gets a bad band at each rim and none at the equator", () => {
    const bands = overhangBands(bulb, silOpts);
    const bad = bands.filter((b) => b.level === "bad");
    expect(bad.length).toBeGreaterThanOrEqual(2);
    expect(bad[0].v0).toBe(0); // the flare starts AT the rim — the editor must show that
    expect(bad[bad.length - 1].v1).toBe(1);
    for (const b of bands) {
      const overlapsEquator = b.v0 < 0.6 && b.v1 > 0.4;
      expect(overlapsEquator).toBe(false);
    }
  });

  test("waves put bands where the silhouette alone has none", () => {
    const drum = familyCurve("drum");
    const wavy = { ...silOpts, waveCount: 12, waveDepth: 16 };
    // 12 waves × 8 mm amplitude over 200 mm: local slope ≈ atan(603/200) ≈ 71°.
    expect(overhangBands(drum, wavy).length).toBeGreaterThan(0);
  });

  test("agreement pin: silhouette atan(|dr/dz|) equals surface asin(|n_z|) on a circle section", () => {
    // Two independent measurements of the same angle — central differences on r(v) here, sampled
    // 3D surface normals there. On a circle section they must agree; the identity is
    // asin(|n_z|) === atan(|dr/dz|) for any surface of revolution.
    let silhouetteMax = 0;
    for (let k = 0; k <= 512; k++) {
      silhouetteMax = Math.max(silhouetteMax, silhouetteDeg(bulb, silOpts, k / 512));
    }
    const surfaceMax = maxOverhangDeg(base(), bulb, { u: 16, v: 128 });
    expect(surfaceMax).toBeCloseTo(73.8, 0); // the bulb's true worst slope, from the spline math
    expect(Math.abs(silhouetteMax - surfaceMax)).toBeLessThan(1.5);
  });
});

describe("overhangWarnings", () => {
  test("a printable shade raises nothing", () => {
    expect(overhangWarnings(base(), familyCurve("empire"))).toEqual([]);
  });

  test("past the warn threshold it asks for cooling, advisory only", () => {
    const out = overhangWarnings(base({ girth: 2 }), familyCurve("sphere"));
    expect(out).toHaveLength(1);
    expect(out[0].text).toMatch(/good cooling/i);
    expect(out[0].bad).toBe(false);
  });

  test("past the bad threshold it says the surface will sag", () => {
    const out = overhangWarnings(base(), bulb);
    expect(out).toHaveLength(1);
    expect(out[0].text).toMatch(/will sag/i);
    expect(out[0].bad).toBe(true);
  });
});

describe("applyOverhangColors", () => {
  // A hand-built non-indexed 3-triangle geometry: a vertical wall (safe), a 70° overhang (red),
  // and a horizontal face inside the bottom rim band (would read 90° — must be neutralised).
  function threeFaces(): BufferGeometry {
    const s70 = Math.sin((70 * Math.PI) / 180);
    const c70 = Math.cos((70 * Math.PI) / 180);
    // prettier-ignore
    const positions = new Float32Array([
      50, 0, 50,   51, 0, 55,   50, 0, 60,   // vertical wall, z 50..60
      40, 0, 100,  44, 0, 105,  40, 0, 110,  // 70° overhang face, z 100..110
      10, 0, 0,    14, 2, 1.5,  10, 4, 0,    // bottom annulus stand-in, z ≤ wall + 0.1
    ]);
    // prettier-ignore
    const normals = new Float32Array([
      1, 0, 0,     1, 0, 0,     1, 0, 0,
      c70, 0, -s70, c70, 0, -s70, c70, 0, -s70,
      0, 0, -1,    0, 0, -1,    0, 0, -1,
    ]);
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(positions, 3));
    g.setAttribute("normal", new BufferAttribute(normals, 3));
    return g;
  }

  const rgbAt = (g: BufferGeometry, i: number): [number, number, number] => {
    const c = g.getAttribute("color");
    return [c.getX(i), c.getY(i), c.getZ(i)];
  };

  test("colours by severity, neutralising rim-band faces whatever their normals say", () => {
    const g = threeFaces();
    applyOverhangColors(g, { height: 200, wall: 1.6 });
    const color = g.getAttribute("color");
    expect(color.count).toBe(g.getAttribute("position").count);

    const neutral = new Color(SHADE_COLOR);
    const red = new Color(0xe05a5a);
    for (const i of [0, 1, 2]) expect(rgbAt(g, i)[1]).toBeCloseTo(neutral.g, 5); // vertical: neutral
    for (const i of [3, 4, 5]) expect(rgbAt(g, i)[1]).toBeCloseTo(red.g, 5); // 70°: red
    for (const i of [6, 7, 8]) expect(rgbAt(g, i)[1]).toBeCloseTo(neutral.g, 5); // rim: neutral
  });

  test("a real creased build gets a full-count attribute, and re-apply overwrites", () => {
    const p = base({ girth: 2, perfPattern: "none" });
    const g = creased(buildShade(p, familyCurve("sphere")));
    applyOverhangColors(g, { height: p.height, wall: p.wall });
    const color = g.getAttribute("color");
    expect(color.count).toBe(g.getAttribute("position").count);

    // The fat sphere leans to ~56°, so somewhere the tint left neutral.
    const neutral = new Color(SHADE_COLOR);
    let tinted = 0;
    for (let i = 0; i < color.count; i++) {
      if (Math.abs(color.getY(i) - neutral.g) > 1e-3) tinted++;
    }
    expect(tinted).toBeGreaterThan(0);

    // Re-apply with an absurd wall: every triangle lands in a rim band, so everything neutralises
    // — proving the second application overwrote the first rather than blending with it.
    applyOverhangColors(g, { height: p.height, wall: 1e6 });
    const after = g.getAttribute("color");
    for (let i = 0; i < after.count; i++) {
      expect(Math.abs(after.getY(i) - neutral.g)).toBeLessThan(1e-6);
    }
  });
});
