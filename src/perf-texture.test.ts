// The drag preview's polygon math, pinned in Node (no canvas, no kernel). What matters here is
// METRIC correctness — the alpha-mapped holes must land where the real cutters land, at the size
// the real cutters cut, or the preview lies for exactly the 180 ms the user is looking hardest.
import { describe, expect, test } from "vite-plus/test";
import { defaults } from "parametric-kit/params";
import { familyCurve, sampleRadius } from "./curve.ts";
import { dims, type Params, schema } from "./params.ts";
import { perfUvPolys } from "./perf-texture.ts";

const base = (over: Partial<Params> = {}): Params => ({ ...defaults(schema), ...over });
// A drum has no taper, so every hole sees the same circumference and the numbers are exact.
const drum = familyCurve("drum");
const TAU = Math.PI * 2;

function bboxOf(poly: [number, number][]): { du: number; dv: number } {
  let u0 = Number.POSITIVE_INFINITY;
  let u1 = Number.NEGATIVE_INFINITY;
  let v0 = Number.POSITIVE_INFINITY;
  let v1 = Number.NEGATIVE_INFINITY;
  for (const [u, v] of poly) {
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  return { du: u1 - u0, dv: v1 - v0 };
}

describe("perfUvPolys", () => {
  test("one polygon per hole, matching the readout's count", () => {
    const p = base({ perfPattern: "grid", perfRows: 5, perfCols: 12, perfDia: 6 });
    expect(perfUvPolys(p, drum).length).toBe(dims(p, drum).holeCount);
  });

  test("a circle is metric-correct: dia over circumference wide, dia over height tall", () => {
    const p = base({ perfPattern: "grid", perfRows: 3, perfCols: 8, perfDia: 10, perfGradient: 0 });
    const circumference = TAU * sampleRadius(drum, 0.5) * p.girth;
    const b = bboxOf(perfUvPolys(p, drum)[0]);
    expect(b.du).toBeCloseTo(10 / circumference, 5);
    expect(b.dv).toBeCloseTo(10 / p.height, 5);
  });

  test("stretch scales only v; rotating 90° hands the stretch to u", () => {
    const p = base({ perfPattern: "grid", perfRows: 3, perfCols: 8, perfDia: 8, perfAspect: 3 });
    const circumference = TAU * sampleRadius(drum, 0.5) * p.girth;
    const upright = bboxOf(perfUvPolys(p, drum)[0]);
    expect(upright.du).toBeCloseTo(8 / circumference, 5);
    expect(upright.dv).toBeCloseTo(24 / p.height, 5);
    const flat = bboxOf(perfUvPolys({ ...p, perfRot: 90 }, drum)[0]);
    expect(flat.du).toBeCloseTo(24 / circumference, 5);
    expect(flat.dv).toBeCloseTo(8 / p.height, 5);
  });

  test("the slot's stretch is not applied twice", () => {
    // The slot bakes its stretch into the stadium profile; the shared y-scale must then stay 1, or
    // the preview would show slots aspect² tall while the cutters cut aspect.
    const p = base({ perfShape: "slot", perfAspect: 4, perfDia: 6, perfRows: 4, perfCols: 8 });
    const b = bboxOf(perfUvPolys(p, drum)[0]);
    const circumference = TAU * sampleRadius(drum, 0.5) * p.girth;
    expect(b.du).toBeCloseTo(6 / circumference, 5);
    expect(b.dv).toBeCloseTo(24 / p.height, 5);
  });

  test("seam holes run past the edge instead of folding back", () => {
    // A grid places a column at u = 0; its polygon must straddle into negative u so the canvas can
    // draw the wrapped copy, rather than clamping and drawing half a hole.
    const p = base({ perfPattern: "grid", perfEven: false, perfRows: 3, perfCols: 8, perfDia: 10 });
    const polys = perfUvPolys(p, drum);
    expect(polys.some((poly) => poly.some(([u]) => u < 0))).toBe(true);
  });

  test("a size gradient reaches the polygons, not just the cutters", () => {
    const p = base({
      perfPattern: "grid",
      perfEven: false,
      perfRows: 5,
      perfCols: 8,
      perfDia: 8,
      perfGradient: 1,
    });
    const polys = perfUvPolys(p, drum);
    // Row order is bottom-up, so the last polygon (top row) must be wider than the first.
    expect(bboxOf(polys[polys.length - 1]).du).toBeGreaterThan(bboxOf(polys[0]).du * 1.3);
  });
});
