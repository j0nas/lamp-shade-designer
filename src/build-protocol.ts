// The wire contract between main.ts and build-worker.ts. Its own module so neither side imports the
// other: the worker entry pulls in the wasm kernel, and the main thread must not.
//
// Everything here has to survive structuredClone, so params and the curve travel as plain data.

import type { PackedGeometry } from "parametric-kit/worker";
import type { BuildTimings } from "./shade.ts";
import type { CtrlPt } from "./curve.ts";
import type { Params } from "./params.ts";

// "draft" is what a held-down control gets: form only, no perforation, reduced resolution.
// "preview" is the settled view.
export type BuildQuality = "draft" | "preview";

export type BuildReq = {
  kind: "build";
  params: Params;
  curve: CtrlPt[];
  quality: BuildQuality;
};

// Exports run at EXPORT quality on a SECOND, dedicated worker (see main.ts): a dense export takes
// seconds, and sharing the interactive worker would freeze the live preview for exactly that long —
// the same freeze moving builds off the main thread was meant to end.
export type ExportPart = "shade-stl" | "shade-3mf" | "fitter-stl";

export type ExportReq = {
  kind: "export";
  part: ExportPart;
  params: Params;
  curve: CtrlPt[];
  name: string; // design name at click time, for the provenance stamp
};

export type WorkerReq = BuildReq | ExportReq;

export type BuildRes = {
  kind: "build";
  quality: BuildQuality;
  shade: PackedGeometry;
  // null at draft quality: the fitter is skipped there — it cannot change enough mid-drag to
  // matter for the ~180 ms until the settled preview lands, and building it would double the cost
  // of the one build that has to fit inside a frame.
  fitter: PackedGeometry | null;
  // Computed worker-side so the main thread never needs the kernel to fill in the readout.
  shadeCm3: number;
  fitterCm3: number;
  timings: BuildTimings;
  fitterMs: number; // measured separately — lastBuild's phase split covers the shade alone
};

export type ExportRes = {
  kind: "export";
  part: ExportPart;
  bytes: ArrayBuffer; // stamped STL or finished 3MF, transferred rather than copied
};

export type WorkerRes = BuildRes | ExportRes;
