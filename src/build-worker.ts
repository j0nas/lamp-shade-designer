// The build worker: the whole geometry pipeline, off the main thread.
//
// A perforated rebuild is a boolean against thousands of cutters — hundreds of milliseconds at
// default settings and seconds at high hole counts. Run on the main thread that freezes the very
// slider driving it. The builders are pure `Params -> BufferGeometry`, so they run here unchanged.
//
// One entry, two roles: main.ts spawns this file TWICE. The interactive client sends "build"
// requests (latest-wins scheduling, mid-drag requests dropped — see parametric-kit/worker); the
// export client sends "export" requests to its own instance, so a seconds-long dense export never
// queues behind — or in front of — a live drag.

import wasmUrl from "manifold-3d/manifold.wasm?url";
import type { BufferGeometry } from "three";
import { initCSG } from "parametric-kit/csg";
import { stlBinary } from "parametric-kit/export";
import { volumeCm3 } from "parametric-kit/readout";
import { geometryTransferables, packGeometry, serveBuilds } from "parametric-kit/worker";
import type {
  BuildReq,
  BuildRes,
  ExportReq,
  ExportRes,
  WorkerReq,
  WorkerRes,
} from "./build-protocol.ts";
import { buildShade, DRAFT, EXPORT, lastBuild, PREVIEW } from "./shade.ts";
import { buildFitter } from "./fitter.ts";
import { APP_VERSION, stampStlHeader } from "./designs.ts";
import { meshTo3mf } from "./threemf.ts";

function handleBuild(req: BuildReq): BuildRes {
  const shade = buildShade(req.params, req.curve, req.quality === "draft" ? DRAFT : PREVIEW);
  // Snapshot before buildFitter runs: lastBuild is module state and the fitter build would not
  // overwrite it today, but nothing stops it later.
  const timings = { ...lastBuild };
  if (req.quality === "draft") {
    // No fitter and no volumes at draft: a draft's whole budget is one frame, the fitter cannot
    // change enough mid-drag to matter for the ~180 ms until the preview lands, and the main
    // thread keeps showing the last settled numbers anyway.
    return {
      kind: "build",
      quality: req.quality,
      shade: packGeometry(shade),
      fitter: null,
      shadeCm3: 0,
      fitterCm3: 0,
      timings,
      fitterMs: 0,
    };
  }
  const t0 = performance.now();
  const fitter = buildFitter(req.params, req.curve);
  const fitterMs = performance.now() - t0;
  return {
    kind: "build",
    quality: req.quality,
    shade: packGeometry(shade),
    fitter: packGeometry(fitter),
    shadeCm3: volumeCm3(shade),
    fitterCm3: volumeCm3(fitter),
    timings,
    fitterMs,
  };
}

// Provenance rides in the file itself — the STL's 80-byte header, the 3MF's metadata — so a file
// found on disk next year traces back to the exact build that made it, surviving any rename.
const stlBytes = (geom: BufferGeometry, stamp: string): ArrayBuffer =>
  stampStlHeader(stlBinary(geom), stamp).buffer;

function handleExport(req: ExportReq): ExportRes {
  const stamp = `lamp-shade ${APP_VERSION} ${req.name}`;
  switch (req.part) {
    case "shade-stl":
      return {
        kind: "export",
        part: req.part,
        bytes: stlBytes(buildShade(req.params, req.curve, EXPORT), stamp),
      };
    case "fitter-stl":
      return {
        kind: "export",
        part: req.part,
        bytes: stlBytes(buildFitter(req.params, req.curve), stamp),
      };
    case "shade-3mf": {
      const g = buildShade(req.params, req.curve, EXPORT);
      return {
        kind: "export",
        part: req.part,
        bytes: meshTo3mf({
          verts: g.getAttribute("position").array as Float32Array,
          tris: g.index!.array as Uint32Array,
          title: req.name,
          app: `lamp-shade ${APP_VERSION}`,
        }).buffer,
      };
    }
  }
}

serveBuilds<WorkerReq, WorkerRes>(
  (req) => (req.kind === "export" ? handleExport(req) : handleBuild(req)),
  {
    init: () => initCSG(wasmUrl),
    transfer: (res) =>
      res.kind === "export"
        ? [res.bytes]
        : geometryTransferables(res.fitter ? [res.shade, res.fitter] : [res.shade]),
  },
);
