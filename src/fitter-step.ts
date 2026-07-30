// True B-rep STEP export for the fitter, via replicad (OpenCASCADE compiled to WASM).
//
// Separate module so it can be LAZILY imported: the OCCT wasm is ~10.8 MB, which nobody should pay
// for until they click "Fitter STEP". Nothing here is imported by the preview path.
//
// Reads the same fitterSpec() as the Manifold builder, so the two can only differ in construction,
// never in dimensions — and fitter-equivalence.test.ts asserts they agree on volume and bounds.
//
// The STEP output is genuinely MORE accurate than the STL: these are real analytic cylinders, where
// Manifold's annuli are 64-gons (~0.16% small on area). That is the whole point of having this path.

import type { Shape3D } from "replicad";
import type { FitterSpec } from "./fitter.ts";

type Replicad = typeof import("replicad");

let cached: Promise<Replicad> | null = null;

// Mirrors the kit's initCSG() contract: the browser passes a bundler-resolved wasm URL so Emscripten's
// locateFile can fetch it; Node passes nothing and lets the loader find the wasm beside its module.
export function initSTEP(wasmUrl?: string): Promise<Replicad> {
  cached ??= (async () => {
    const [replicad, ocModule] = await Promise.all([
      import("replicad"),
      import("replicad-opencascadejs/src/replicad_single.js"),
    ]);
    const factory = (ocModule as { default?: unknown }).default ?? ocModule;
    const OC = await (factory as (cfg?: unknown) => Promise<unknown>)(
      wasmUrl ? { locateFile: () => wasmUrl } : undefined,
    );
    replicad.setOC(OC as Parameters<typeof replicad.setOC>[0]);
    return replicad;
  })();
  return cached;
}

const deg = (rad: number) => (rad * 180) / Math.PI;

// Build the plate profile in 2D and extrude ONCE. Stacking 3D booleans would give the same solid with
// a messier face graph; a single extrude of a clean profile is what makes the STEP pleasant to open.
function platePlan(r: Replicad, f: FitterSpec, hubInnerR: number) {
  const { drawCircle, drawRoundedRectangle } = r;
  let plan = drawCircle(f.outerR).cut(drawCircle(f.outerR - f.rimWidth));
  plan = plan.fuse(drawCircle(f.hubR).cut(drawCircle(hubInnerR)));
  for (let k = 0; k < f.spokes; k++) {
    const r0 = f.hubR - 0.5;
    const r1 = f.outerR - f.rimWidth + 0.5;
    const arm = drawRoundedRectangle(r1 - r0, f.armW)
      .translate((r0 + r1) / 2, 0)
      .rotate(deg((k / f.spokes) * Math.PI * 2));
    plan = plan.fuse(arm);
  }
  return plan;
}

// An annulus Drawing holds TWO blueprints (outer + inner), so sketchOnPlane gives Sketches rather
// than Sketch, and its extrude() widens to AnyShape. These are always solids, so narrow once here
// instead of scattering casts through the switch.
const solid = (s: unknown): Shape3D => s as Shape3D;

export function buildFitterShape(r: Replicad, f: FitterSpec): Shape3D {
  const { drawCircle } = r;
  const t = f.thickness;

  switch (f.kind) {
    case "ring":
      return solid(drawCircle(f.outerR).cut(drawCircle(f.boreR)).sketchOnPlane("XY").extrude(t));

    case "spider":
      return solid(platePlan(r, f, f.boreR).sketchOnPlane("XY").extrude(t));

    case "clip":
      return solid(platePlan(r, f, f.gripR).sketchOnPlane("XY").extrude(t));

    case "uno": {
      const plate = solid(
        drawCircle(f.outerR).cut(drawCircle(f.boreR)).sketchOnPlane("XY").extrude(t),
      );
      const collar = solid(
        drawCircle(f.boreR + 2.5)
          .cut(drawCircle(f.boreR))
          .sketchOnPlane("XY", t)
          .extrude(f.collarH),
      );
      return plate.fuse(collar);
    }

    case "pendant": {
      const m10 = 10.2 / 2; // standard M10x1 lamp thread
      const plate = solid(platePlan(r, f, m10).sketchOnPlane("XY").extrude(t));
      const collar = solid(
        drawCircle(m10 + 3)
          .cut(drawCircle(m10))
          .sketchOnPlane("XY", t)
          .extrude(f.collarH),
      );
      return plate.fuse(collar);
    }
  }
}

// A STEP file as a Blob, ready for downloadBlob(). Callers must have awaited initSTEP().
export async function fitterStepBlob(f: FitterSpec, wasmUrl?: string): Promise<Blob> {
  const r = await initSTEP(wasmUrl);
  const shape = buildFitterShape(r, f);
  return shape.blobSTEP();
}
