// The wire contract between main.ts and build-worker.ts. Its own module so neither side imports the
// other: the worker entry pulls in the wasm kernel, and the main thread must not.
//
// Everything here has to survive structuredClone, so params and the curve travel as plain data.

import type { PackedGeometry } from "parametric-kit/worker";
import type { BuildTimings } from "./shade.ts";
import type { CtrlPt } from "./curve.ts";
import type { Params } from "./params.ts";

// "draft" is what a held-down control gets: form only, no perforation, reduced resolution.
// "preview" is the settled view. Export stays on the main thread — it is a deliberate click, not an
// interactive frame, and routing it through here would mean blocking on a round trip.
export type BuildQuality = "draft" | "preview";

export type BuildReq = {
  params: Params;
  curve: CtrlPt[];
  quality: BuildQuality;
};

export type BuildRes = {
  quality: BuildQuality;
  shade: PackedGeometry;
  fitter: PackedGeometry;
  // Computed worker-side so the main thread never needs the kernel to fill in the readout.
  shadeCm3: number;
  fitterCm3: number;
  timings: BuildTimings;
};
