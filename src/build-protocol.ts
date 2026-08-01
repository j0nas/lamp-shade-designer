// The wire contract between main.ts and build-worker.ts. Its own module so neither side imports the
// other: the worker entry pulls in the wasm kernel, and the main thread must not.
//
// Everything here has to survive structuredClone, so the design travels as plain data and the
// worker resolves it (nest links included) with the same pure code the main thread uses.

import type { PackedGeometry } from "parametric-kit/worker";
import type { BuildTimings } from "./shade.ts";
import type { Design } from "./layers.ts";

// "draft" is what a held-down control gets: form only, no perforation, reduced resolution — and
// ONLY the active layer, because that is the one the control is editing.
// "preview" is the settled view: every layer, real holes, plus the fitter.
export type BuildQuality = "draft" | "preview";

export type BuildReq = {
  kind: "build";
  design: Design;
  active: number; // index of the layer being edited
  quality: BuildQuality;
};

// Exports run at EXPORT quality on a SECOND, dedicated worker (see main.ts): a dense export takes
// seconds, and sharing the interactive worker would freeze the live preview for exactly that long.
// "layer-stl" is one shell as a bare STL; "shades-3mf" is the whole stack as one multi-object 3MF,
// each layer a named, coloured object nested at the origin — the printable arrangement for a
// multi-nozzle machine and trivially separable in any slicer.
export type ExportPart = "layer-stl" | "shades-3mf" | "fitter-stl";

export type ExportReq = {
  kind: "export";
  part: ExportPart;
  design: Design;
  layerIndex: number; // which layer, for layer-stl; ignored otherwise
  name: string; // design name at click time, for the provenance stamp
};

export type WorkerReq = BuildReq | ExportReq;

export type BuildRes = {
  kind: "build";
  quality: BuildQuality;
  // One slot per layer. null = not rebuilt this round (drafts rebuild only the active layer;
  // the main thread keeps whatever mesh that layer already shows).
  shades: (PackedGeometry | null)[];
  // Computed worker-side so the main thread never needs the kernel to fill in the readout.
  // null mirrors a null shade slot — keep the last real number.
  shadeCm3: (number | null)[];
  fitter: PackedGeometry | null; // drafts skip the fitter
  fitterCm3: number;
  timings: BuildTimings; // summed across the layers actually built this round
  fitterMs: number;
};

export type ExportRes = {
  kind: "export";
  part: ExportPart;
  bytes: ArrayBuffer; // stamped STL or finished 3MF, transferred rather than copied
};

export type WorkerRes = BuildRes | ExportRes;
