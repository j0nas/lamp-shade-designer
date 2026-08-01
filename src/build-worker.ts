// The build worker: the whole geometry pipeline, off the main thread.
//
// A perforated rebuild is a boolean against thousands of cutters — hundreds of milliseconds at
// default settings and seconds at high hole counts, PER LAYER. Run on the main thread that freezes
// the very slider driving it. The builders are pure `Params -> BufferGeometry`, so they run here
// unchanged; the worker resolves the layered design itself (nest links included) with the same
// pure code the main thread uses.
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
import { buildShade, DRAFT, EXPORT, lastBuild, PREVIEW, type Quality } from "./shade.ts";
import { buildFitterFromSpec, fitterSpecAssembly } from "./fitter.ts";
import { layerName, type ResolvedLayer, resolveLayers } from "./layers.ts";
import { APP_VERSION, stampStlHeader } from "./designs.ts";
import { modelTo3mf, type Object3mf } from "./threemf.ts";

// Settled previews cache per layer: dragging one layer's sliders must not pay to rebuild the
// other N−1 shells every settle. Keyed on the layer's RESOLVED inputs (params + derived curve +
// quality), so a nest follows its outer layer's edits and a cache entry can never go stale.
// The cache stores live geometries and PACKS A CLONE on reply — packGeometry hands the actual
// buffers to postMessage as transferables, which would detach (and poison) a cached array.
const CACHE_MAX = 12;
const shadeCache = new Map<string, { geom: BufferGeometry; cm3: number }>();

type BuiltLayer = { geom: BufferGeometry; cm3: number; fresh: boolean };

function builtLayer(l: ResolvedLayer, quality: Quality): BuiltLayer {
  const key = JSON.stringify([l.params, l.curve, quality.u, quality.cut]);
  const hit = shadeCache.get(key);
  if (hit) {
    // Refresh recency: Map iteration is insertion-ordered, so re-inserting makes eviction LRU.
    shadeCache.delete(key);
    shadeCache.set(key, hit);
    return { ...hit, fresh: false };
  }
  const geom = buildShade(l.params, l.curve, quality);
  const entry = { geom, cm3: volumeCm3(geom) };
  shadeCache.set(key, entry);
  if (shadeCache.size > CACHE_MAX) {
    const oldest = shadeCache.keys().next().value!;
    shadeCache.get(oldest)!.geom.dispose();
    shadeCache.delete(oldest);
  }
  return { ...entry, fresh: true };
}

const zeroTimings = () => ({
  mesh: 0,
  adopt: 0,
  cutters: 0,
  boolean: 0,
  extract: 0,
  total: 0,
  holes: 0,
});

function handleBuild(req: BuildReq): BuildRes {
  const resolved = resolveLayers(req.design);
  const n = resolved.length;
  const timings = zeroTimings();
  const addTimings = () => {
    timings.mesh += lastBuild.mesh;
    timings.adopt += lastBuild.adopt;
    timings.cutters += lastBuild.cutters;
    timings.boolean += lastBuild.boolean;
    timings.extract += lastBuild.extract;
    timings.total += lastBuild.total;
    timings.holes += lastBuild.holes;
  };

  if (req.quality === "draft") {
    // Only the layer under the control, form only, no fitter, no volumes: a draft's whole budget
    // is one frame, and the other layers cannot have changed since their settled build.
    const active = Math.min(n - 1, Math.max(0, req.active));
    const shades: BuildRes["shades"] = Array.from({ length: n }, () => null);
    const draft = buildShade(resolved[active].params, resolved[active].curve, DRAFT);
    addTimings();
    shades[active] = packGeometry(draft);
    return {
      kind: "build",
      quality: req.quality,
      shades,
      shadeCm3: Array.from({ length: n }, () => null),
      fitter: null,
      fitterCm3: 0,
      timings,
      fitterMs: 0,
    };
  }

  const shades: BuildRes["shades"] = [];
  const shadeCm3: BuildRes["shadeCm3"] = [];
  for (const l of resolved) {
    const built = builtLayer(l, PREVIEW);
    if (built.fresh) addTimings(); // cache hits have no timings to add
    shades.push(packGeometry(built.geom.clone()));
    shadeCm3.push(built.cm3);
  }

  const t0 = performance.now();
  const height = Math.max(...resolved.map((l) => l.z1));
  const fitter = buildFitterFromSpec(
    fitterSpecAssembly({ layers: resolved, fitterZ: req.design.globals.fitterZ * height }),
  );
  const fitterMs = performance.now() - t0;
  return {
    kind: "build",
    quality: req.quality,
    shades,
    shadeCm3,
    fitter: packGeometry(fitter),
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
  const resolved = resolveLayers(req.design);
  switch (req.part) {
    case "layer-stl": {
      const i = Math.min(resolved.length - 1, Math.max(0, req.layerIndex));
      return {
        kind: "export",
        part: req.part,
        bytes: stlBytes(buildShade(resolved[i].params, resolved[i].curve, EXPORT), stamp),
      };
    }
    case "fitter-stl": {
      const height = Math.max(...resolved.map((l) => l.z1));
      const spec = fitterSpecAssembly({
        layers: resolved,
        fitterZ: req.design.globals.fitterZ * height,
      });
      return { kind: "export", part: req.part, bytes: stlBytes(buildFitterFromSpec(spec), stamp) };
    }
    case "shades-3mf": {
      const objects: Object3mf[] = resolved.map((l, i) => {
        const g = buildShade(l.params, l.curve, EXPORT);
        return {
          verts: g.getAttribute("position").array as Float32Array,
          tris: g.index!.array as Uint32Array,
          name: `${layerName(i, resolved.length)} — ${req.name}`,
          color: l.layer.color,
        };
      });
      return {
        kind: "export",
        part: req.part,
        bytes: modelTo3mf({ objects, title: req.name, app: `lamp-shade ${APP_VERSION}` }).buffer,
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
        : geometryTransferables(
            [...res.shades, res.fitter].filter((g): g is NonNullable<typeof g> => g !== null),
          ),
  },
);
