// The build worker: the whole geometry pipeline, off the main thread.
//
// A perforated rebuild is a boolean against thousands of cutters — hundreds of milliseconds at
// default settings and seconds at high hole counts. Run on the main thread that freezes the very
// slider driving it. The builders are pure `Params -> BufferGeometry`, so they run here unchanged.
//
// Scheduling is latest-wins and lives in the client (see parametric-kit/worker): at most one build
// is ever in flight and mid-drag requests are dropped rather than queued, so this side is just
// receive -> build -> reply.

import wasmUrl from "manifold-3d/manifold.wasm?url";
import { initCSG } from "parametric-kit/csg";
import { volumeCm3 } from "parametric-kit/readout";
import { geometryTransferables, packGeometry, serveBuilds } from "parametric-kit/worker";
import type { BuildReq, BuildRes } from "./build-protocol.ts";
import { buildShade, DRAFT, lastBuild, PREVIEW } from "./shade.ts";
import { buildFitter } from "./fitter.ts";

serveBuilds<BuildReq, BuildRes>(
  (req) => {
    const shade = buildShade(req.params, req.curve, req.quality === "draft" ? DRAFT : PREVIEW);
    // Snapshot before buildFitter runs: lastBuild is module state and the fitter build would not
    // overwrite it today, but nothing stops it later.
    const timings = { ...lastBuild };
    const fitter = buildFitter(req.params, req.curve);
    return {
      quality: req.quality,
      shade: packGeometry(shade),
      fitter: packGeometry(fitter),
      shadeCm3: volumeCm3(shade),
      fitterCm3: volumeCm3(fitter),
      timings,
    };
  },
  {
    init: () => initCSG(wasmUrl),
    transfer: (res) => geometryTransferables([res.shade, res.fitter]),
  },
);
