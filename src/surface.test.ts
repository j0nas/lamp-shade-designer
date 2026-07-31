// The modulated-radius fixes: the fitter's press fit and the bulb-clearance lint must see the
// surface the shade actually has — section, flutes and waves included — not the silhouette. Pure
// math throughout; no kernel.
import { describe, expect, test } from "vite-plus/test";
import { defaults } from "parametric-kit/params";
import { familyCurve } from "./curve.ts";
import { dims, type Params, schema } from "./params.ts";
import { fitterSpec } from "./fitter.ts";
import { sectionMin } from "./section.ts";
import { makeSurface, minSurfaceRadiusAt, waveOffset } from "./surface.ts";

const base = (over: Partial<Params> = {}): Params => ({ ...defaults(schema), ...over });
const drum = familyCurve("drum");

// Ground truth: the surface's own radius function, sampled far denser than the helper does.
function bruteMin(p: Params, curve: ReturnType<typeof familyCurve>, v: number): number {
  const surface = makeSurface(p, curve);
  let m = Number.POSITIVE_INFINITY;
  for (let k = 0; k < 4096; k++) m = Math.min(m, surface.radius(k / 4096, v));
  return m;
}

describe("waveOffset", () => {
  test("is zero without waves and a signed sine with them", () => {
    expect(waveOffset(0, 20, 0.3)).toBe(0);
    expect(waveOffset(8, 6, 0)).toBeCloseTo(0, 9);
    // 8 waves: a quarter period up from v = 0 is the first crest, at half the depth.
    expect(waveOffset(8, 6, 1 / 32)).toBeCloseTo(3, 9);
    expect(waveOffset(8, 6, 3 / 32)).toBeCloseTo(-3, 9);
  });
});

describe("minSurfaceRadiusAt", () => {
  test("without flutes it is exactly silhouette × sectionMin (the golden fast path)", () => {
    const p = base({ sectionKind: "star", sides: 12, sectionDepth: 0.5 });
    const expected = 84 * sectionMin("star", 12, 0.5); // drum radius 84 everywhere
    expect(minSurfaceRadiusAt(p, drum, 0.5)).toBeCloseTo(expected, 9);
    expect(minSurfaceRadiusAt(p, drum, 0.5)).toBeCloseTo(bruteMin(p, drum, 0.5), 1);
  });

  test("flutes cut the minimum by their full depth on a circle section", () => {
    const p = base({ fluteCount: 12, fluteDepth: 8 });
    expect(minSurfaceRadiusAt(p, drum, 0.5)).toBeCloseTo(84 - 8, 2);
  });

  test("tracks the true sampled minimum when section and flutes combine", () => {
    const p = base({
      sectionKind: "lobed",
      sides: 6,
      sectionDepth: 0.7,
      fluteCount: 9,
      fluteDepth: 5,
    });
    const truth = bruteMin(p, drum, 0.4);
    const got = minSurfaceRadiusAt(p, drum, 0.4);
    expect(got).toBeCloseTo(truth, 1);
    // Never optimistic by more than the sampling residual: a press fit sized from this must go in.
    expect(got).toBeLessThan(truth + 0.05);
  });

  test("twist moves the minimum around the shade but never changes it", () => {
    const p = base({
      sectionKind: "star",
      sides: 8,
      sectionDepth: 0.4,
      fluteCount: 6,
      fluteDepth: 4,
    });
    expect(minSurfaceRadiusAt({ ...p, twistDeg: 180 }, drum, 0.7)).toBeCloseTo(
      minSurfaceRadiusAt(p, drum, 0.7),
      9,
    );
  });
});

describe("fitter press fit sees the modulated wall", () => {
  test("flutes shrink the ring by their depth — the part must physically go in", () => {
    const plain = fitterSpec(base(), drum);
    const fluted = fitterSpec(base({ fluteCount: 12, fluteDepth: 8 }), drum);
    expect(plain.outerR - fluted.outerR).toBeCloseTo(8, 2);

    // The invariant behind the number: the ring plus its clearance sits inside the real inner wall.
    const p = base({ fluteCount: 12, fluteDepth: 8 });
    const innerWall = bruteMin(p, drum, p.fitterZ) - p.wall;
    expect(fluted.outerR).toBeLessThan(innerWall);
  });

  test("waves at the mount height shift the ring by exactly the wave term", () => {
    const p = base({ waveCount: 8, waveDepth: 10, fitterZ: 0.95 });
    const delta = fitterSpec(p, drum).outerR - fitterSpec(base({ fitterZ: 0.95 }), drum).outerR;
    expect(delta).toBeCloseTo(waveOffset(8, 10, 0.95), 9);
  });
});

describe("bulb clearance sees the modulated wall", () => {
  test("flutes reduce the gap by their depth", () => {
    const plain = dims(base(), drum).bulbGap;
    const fluted = dims(base({ fluteCount: 12, fluteDepth: 8 }), drum).bulbGap;
    expect(plain - fluted).toBeCloseTo(8, 2);
  });

  test("the gap is measured to the INNER face: a thicker wall closes it", () => {
    const thin = dims(base({ wall: 1 }), drum).bulbGap;
    const thick = dims(base({ wall: 4 }), drum).bulbGap;
    expect(thin - thick).toBeCloseTo(3, 9);
  });

  test("vase mode measures against the single-extrusion wall, not the slider", () => {
    const gap = (over: Partial<Params>) => dims(base(over), drum).bulbGap;
    expect(gap({ vaseMode: true, wall: 4 })).toBeCloseTo(gap({ vaseMode: false, wall: 0.42 }), 9);
  });
});
