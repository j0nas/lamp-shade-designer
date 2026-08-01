// The guardrail for the dual-kernel fitter. The fitter exists twice — Manifold for preview/STL,
// replicad/OCCT for STEP — which is a drift risk by construction. These tests make drift a build
// failure: if someone edits one builder and not the other, volume or bounds stop agreeing.
//
// Loads the ~10.8 MB OCCT wasm, so this file is slower than the rest of the suite by design.
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { initCSG } from "parametric-kit/csg";
import { defaults } from "parametric-kit/params";
import { bbox, volume } from "parametric-kit/testkit";
import { familyCurve } from "./curve.ts";
import { type Params, schema } from "./params.ts";
import {
  buildFitter,
  buildFitterFromSpec,
  type FitterKind,
  fitterSpec,
  RIDGE_H,
} from "./fitter.ts";
import { buildFitterShape, initSTEP } from "./fitter-step.ts";

const curve = familyCurve("empire");
const base = (over: Partial<Params> = {}): Params => ({ ...defaults(schema), ...over });
const KINDS: FitterKind[] = ["ring", "spider", "uno", "clip", "pendant"];

let replicad: Awaited<ReturnType<typeof initSTEP>>;

beforeAll(async () => {
  await initCSG();
  replicad = await initSTEP();
}, 120_000);

describe("both kernels agree on the fitter", () => {
  for (const fitterKind of KINDS) {
    test(`${fitterKind}: volume and bounds match within faceting error`, () => {
      const p = base({ fitterKind, fitterZ: 0.95 });
      const spec = fitterSpec(p, curve);

      const mesh = buildFitter(p, curve);
      const meshVol = volume(mesh);
      const b = bbox(mesh);

      const shape = buildFitterShape(replicad, spec);
      // measureVolume(), not shape.volume() — the latter is MeshShape-only.
      const brepVol = replicad.measureVolume(shape);
      const [bmin, bmax] = shape.boundingBox.bounds;

      // Manifold's annuli are inscribed 64-gons; OCCT's are exact circles. So the B-rep is slightly
      // BIGGER, by ~0.16% on a circular area — assert that direction explicitly rather than papering
      // over it with a symmetric tolerance, because the inequality is the meaningful part.
      expect(brepVol).toBeGreaterThan(meshVol);
      expect(brepVol / meshVol).toBeLessThan(1.02);

      // Bounds should agree closely: the polygon's vertices sit ON the nominal circle, so the extreme
      // extents coincide even though the areas differ.
      expect(bmax[2] - bmin[2]).toBeCloseTo(b.max[2] - b.min[2], 3); // height is exact either way
      expect(bmax[0] - bmin[0]).toBeCloseTo(b.max[0] - b.min[0], 0);
      expect(bmax[1] - bmin[1]).toBeCloseTo(b.max[1] - b.min[1], 0);
    });
  }

  test("both sit on z = 0 in print orientation", () => {
    const p = base({ fitterKind: "uno", fitterZ: 0.95 });
    expect(bbox(buildFitter(p, curve)).min[2]).toBeCloseTo(0, 6);
    expect(buildFitterShape(replicad, fitterSpec(p, curve)).boundingBox.bounds[0][2]).toBeCloseTo(
      0,
      6,
    );
  });

  test("support rings (layered assemblies) exist identically in both kernels", () => {
    const p = base({ fitterKind: "spider", fitterZ: 0.95 });
    const bare = fitterSpec(p, curve);
    const ringed = { ...bare, supportRings: [bare.boreR + 12, bare.outerR - 8] };

    const meshDelta = volume(buildFitterFromSpec(ringed)) - volume(buildFitterFromSpec(bare));
    const brepDelta =
      replicad.measureVolume(buildFitterShape(replicad, ringed)) -
      replicad.measureVolume(buildFitterShape(replicad, bare));
    // Two raised locating ridges of identical nominal dimensions; the deltas agree within the
    // usual polygon-vs-analytic faceting margin.
    expect(meshDelta).toBeGreaterThan(0);
    expect(brepDelta / meshDelta).toBeGreaterThan(0.98);
    expect(brepDelta / meshDelta).toBeLessThan(1.05);

    // Ridges stand ON the plate: the part grows upward by RIDGE_H, never below z = 0.
    const b = bbox(buildFitterFromSpec(ringed));
    expect(b.min[2]).toBeCloseTo(0, 6);
    expect(b.max[2]).toBeCloseTo(bare.thickness + RIDGE_H, 4);
  });

  test("spoke count changes both builders the same way", () => {
    const spec3 = fitterSpec(base({ fitterKind: "spider", fitterSpokes: 3, fitterZ: 0.95 }), curve);
    const spec6 = fitterSpec(base({ fitterKind: "spider", fitterSpokes: 6, fitterZ: 0.95 }), curve);
    const mesh3 = volume(
      buildFitter(base({ fitterKind: "spider", fitterSpokes: 3, fitterZ: 0.95 }), curve),
    );
    const mesh6 = volume(
      buildFitter(base({ fitterKind: "spider", fitterSpokes: 6, fitterZ: 0.95 }), curve),
    );
    const brep3 = replicad.measureVolume(buildFitterShape(replicad, spec3));
    const brep6 = replicad.measureVolume(buildFitterShape(replicad, spec6));
    // More spokes = more material, in both kernels, by a comparable proportion.
    expect(mesh6).toBeGreaterThan(mesh3);
    expect(brep6).toBeGreaterThan(brep3);
    expect(brep6 / brep3).toBeCloseTo(mesh6 / mesh3, 1);
  });
});

describe("the STEP file itself", () => {
  test("is real analytic B-rep, not a faceted mesh dressed as STEP", async () => {
    const spec = fitterSpec(base({ fitterKind: "ring", fitterZ: 0.95 }), curve);
    const step = await buildFitterShape(replicad, spec).blobSTEP().text();

    // The whole reason this path exists: cylindrical surfaces rather than thousands of planar facets.
    expect(step).toMatch(/CYLINDRICAL_SURFACE/);
    expect(step).toMatch(/ISO-10303-21/); // a well-formed STEP header
    expect(step).toMatch(/ADVANCED_BREP|MANIFOLD_SOLID_BREP/);
    // A faceted-BREP fallback would be full of PLANE entities and no cylinders; make that a failure.
    const cylinders = step.match(/CYLINDRICAL_SURFACE/g)?.length ?? 0;
    expect(cylinders).toBeGreaterThanOrEqual(2); // bore + outer wall at minimum
  }, 60_000);
});
