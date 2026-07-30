import "./style.css";
// Browser entry only: the ?url import lets Emscripten's locateFile fetch the wasm Vite bundled.
// It would break plain Node, which is why it lives here and not in any shared module.
import wasmUrl from "manifold-3d/manifold.wasm?url";
import { type BufferGeometry, Mesh } from "three";
import { initCSG } from "parametric-kit/csg";
import { createStore, installPanelCollapse, renderPanel } from "parametric-kit/params";
import { createViewer, creased, installAppHook } from "parametric-kit/viewer";
import { createBuildClient, unpackGeometry } from "parametric-kit/worker";
import { downloadBlob, exportSTL } from "parametric-kit/export";
import {
  filamentGrams,
  filamentMetres,
  fitFor,
  fitTitle,
  PRINTERS,
  volumeCm3,
} from "parametric-kit/readout";
import {
  type CtrlPt,
  DEFAULT_FAMILY,
  FAMILY_NAMES,
  familyCurve,
  loadCurve,
  maxRadius,
  mirrorV,
  saveCurve,
  smooth,
} from "./curve.ts";
import { dims, migrateStored, type Params, schema, warnings } from "./params.ts";
import { buildShade, EXPORT, PREVIEW } from "./shade.ts";
import type { BuildQuality, BuildReq, BuildRes } from "./build-protocol.ts";
import { buildFitter, fitterSpec, fitterWarnings } from "./fitter.ts";
import { installCurveEditor } from "./curve-editor.ts";
import { createLighting, setShadePerfPreview, shadeMesh, type ViewMode } from "./lit.ts";
import { createPerfPreview } from "./perf-texture.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

await initCSG(wasmUrl);

// --- state ---------------------------------------------------------------------------------------
// Storage migration runs on the raw blob BEFORE the store touches it: load() sanitizes unknown pick
// values back to their defaults, which would turn a saved "slots" design into staggered circles.
try {
  const key = "lamp-shade:params:v1"; // createStore appends :v1 to the key below
  const migrated = migrateStored(JSON.parse(localStorage.getItem(key) ?? "null"));
  if (migrated) localStorage.setItem(key, JSON.stringify(migrated));
} catch {
  // Unreadable storage degrades to defaults, exactly as store.load() would.
}
const store = createStore(schema, { key: "lamp-shade:params", version: 1 });
const params: Params = store.load();
let curve: CtrlPt[] = loadCurve();

// --- viewer --------------------------------------------------------------------------------------
// Shades are big compared with the kit's default part scale, so the shadow frustum and ground grow.
const viewer = createViewer($("app"), {
  shadowExtent: 420,
  shadowFar: 3000,
  groundSize: 6000,
});
const lighting = createLighting(viewer.scene);

// Built synchronously here so the first frame is the real thing — a worker round trip would show a
// hole-less draft first. Every rebuild after this one goes through the worker.
const shade = shadeMesh(creased(buildShade(params, curve, PREVIEW)), lighting.shadeMaterial);
viewer.scene.add(shade);

const fitter = new Mesh(creased(buildFitter(params, curve)), lighting.fitterMaterial);
fitter.castShadow = fitter.receiveShadow = true;
viewer.scene.add(fitter);

// While a control is being dragged the mesh on screen is a hole-less draft; this texture paints the
// live perforation onto it so the pattern — the very thing most sliders manipulate — never blinks
// out mid-drag. Draft results attach it, settled previews (real cut holes) drop it.
const perfPreview = createPerfPreview();

const swapGeom = (mesh: Mesh, geom: BufferGeometry): void => {
  const old = mesh.geometry;
  mesh.geometry = geom;
  old.dispose();
};

// --- rebuild -------------------------------------------------------------------------------------
// Every rebuild runs in a worker (latest-wins: mid-drag requests are dropped, never queued), so the
// main thread never blocks on a boolean. Each change asks for a DRAFT — form only, no perforation,
// ~1 ms — and a settle timer asks for the full PREVIEW once the control has been still for a moment.
// That is what makes dragging feel live even on a design whose perforated build takes seconds.
const SETTLE_MS = 180;

const client = createBuildClient<BuildReq, BuildRes>(
  () => new Worker(new URL("./build-worker.ts", import.meta.url), { type: "module" }),
);

let settleTimer: ReturnType<typeof setTimeout> | undefined;
let lastMs = 0;
let lastQuality: BuildQuality = "preview";
// Draft builds have no holes, so their volume is not the shade's. Keep the last real numbers and go
// on showing those rather than flashing a wrong weight for every frame of a drag.
let shadeCm3 = 0;
let fitterCm3 = 0;

// Snapshot: the panel mutates `params` in place, and the request may be posted a tick later.
const request = (quality: BuildQuality): void => {
  client.request({ params: { ...params }, curve: curve.map((pt) => ({ ...pt })), quality });
};

let chromeQueued = false;

function scheduleRebuild(): void {
  request("draft");
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => request("preview"), SETTLE_MS);
  // The readout and the silhouette editor derive from params rather than from the mesh, so they can
  // update without waiting for a build to land — but coalesced to one pass per frame, because this
  // runs on every pointermove of a drag.
  if (chromeQueued) return;
  chromeQueued = true;
  requestAnimationFrame(() => {
    chromeQueued = false;
    readout(dims(params, curve));
    curveEditor.draw();
  });
}

client.onResult((res) => {
  const d = dims(params, curve);

  swapGeom(shade, creased(unpackGeometry(res.shade)));
  swapGeom(fitter, creased(unpackGeometry(res.fitter)));
  // The fitter is BUILT flat on the bed (print orientation) and only lifted for display. Seat it so
  // its TOP face is level with the mount height, i.e. recessed into the opening rather than perched
  // on the rim like a lid.
  fitter.position.set(0, 0, Math.max(0, d.fitterZ - params.fitterThickness));

  // Drawn from the CURRENT params rather than the ones this draft was built from: with latest-wins
  // scheduling the texture can only be fresher than the mesh, never staler.
  if (res.quality === "draft") {
    setShadePerfPreview(shade, perfPreview.update(params, curve) ? perfPreview.texture : null);
  } else {
    setShadePerfPreview(shade, null);
  }

  if (res.quality !== "draft") {
    shadeCm3 = res.shadeCm3;
    fitterCm3 = res.fitterCm3;
  }
  lastMs = res.timings.total;
  lastQuality = res.quality;

  lighting.update(params, d.height, d.maxR);
  readout(d);
  viewer.invalidate();
});

client.onError((message) => {
  // A build throws on params the lint already flags (a wall thicker than the radius inverts the
  // inner surface). Keep the last good mesh on screen and let the warnings explain it.
  console.error("build failed", message);
});

// --- readout -------------------------------------------------------------------------------------
function readout(d: ReturnType<typeof dims>): void {
  // Volumes come from the worker (measured on the real cut solids) rather than from the mesh on
  // screen, which during a drag is a hole-less draft.
  const total = shadeCm3 + fitterCm3;
  const grams = Math.round(filamentGrams(total));
  const metres = filamentMetres(total);

  const badges = PRINTERS.map((printer) => {
    const fit = fitFor(printer, d.outerDia, d.outerDia);
    const mark = fit === "ok" ? "✓" : fit === "mod" ? "~" : "✗";
    return `<span class="badge ${fit}" title="${fitTitle(printer, fit)}">${printer.name} ${mark}</span>`;
  }).join(" ");

  $("dims").innerHTML =
    `<strong>⌀${d.outerDia.toFixed(0)} × ${d.height.toFixed(0)} mm</strong> · ` +
    `${d.holeCount} holes · <strong>${grams} g</strong> (${metres.toFixed(1)} m) · ` +
    `bulb gap <strong>${d.bulbGap.toFixed(0)} mm</strong><br>${badges}` +
    `<br><span class="perf">${lastQuality} rebuild ${lastMs.toFixed(0)} ms</span>`;

  const all = [...warnings(params, curve, d), ...fitterWarnings(params, curve)];
  $("warnings").innerHTML = all
    .map((w) => `<div class="${w.bad ? "bad" : ""}">${w.text}</div>`)
    .join("");
}

// --- panel ---------------------------------------------------------------------------------------
const panel = renderPanel($("controls"), schema, params, {
  collapsible: { key: "lamp-shade:collapse:v1" },
  groups: [
    { id: "form", title: "Form", open: true },
    { id: "section", title: "Cross-section" },
    { id: "section-shape", visibleWhen: (p) => p.sectionKind !== "circle" },
    { id: "modulation", title: "Modulation" },
    { id: "modulation-flute", visibleWhen: (p) => p.fluteCount > 0 },
    { id: "modulation-wave", visibleWhen: (p) => p.waveCount > 0 },
    { id: "perforation", title: "Perforation" },
    { id: "perforation-shape", visibleWhen: (p) => p.perfPattern !== "none" },
    // Rotating an unstretched circle is a no-op, so the knob only appears once it can do something.
    {
      id: "perforation-rot",
      visibleWhen: (p) => p.perfPattern !== "none" && (p.perfShape !== "circle" || p.perfAspect > 1),
    },
    { id: "perforation-grid", visibleWhen: (p) => p.perfPattern !== "none" },
    { id: "light", title: "Light" },
    { id: "fitter", title: "Fitter" },
    { id: "print", title: "Print" },
  ],
  onChange: () => {
    store.save(params);
    scheduleRebuild();
  },
});

// --- silhouette editor ---------------------------------------------------------------------------
const curveEditor = installCurveEditor($<HTMLCanvasElement>("curve"), {
  get: () => curve,
  set: (pts) => {
    curve = pts;
    saveCurve(curve);
  },
  onChange: scheduleRebuild,
});

const familySelect = $<HTMLSelectElement>("family");
for (const name of FAMILY_NAMES) {
  const opt = document.createElement("option");
  opt.value = name;
  opt.textContent = name[0].toUpperCase() + name.slice(1);
  familySelect.append(opt);
}
familySelect.value = DEFAULT_FAMILY;
familySelect.addEventListener("change", () => {
  curve = familyCurve(familySelect.value);
  saveCurve(curve);
  scheduleRebuild();
});

const editCurve = (fn: (pts: CtrlPt[]) => CtrlPt[]) => () => {
  curve = fn(curve);
  saveCurve(curve);
  scheduleRebuild();
};
$("curve-smooth").addEventListener("click", editCurve(smooth));
$("curve-mirror").addEventListener("click", editCurve(mirrorV));
$("curve-reset").addEventListener(
  "click",
  editCurve(() => familyCurve(familySelect.value)),
);

// --- view controls (app chrome: deliberately not schema params) -----------------------------------
const viewMode = $<HTMLSelectElement>("view-mode");
viewMode.addEventListener("change", () => {
  lighting.setMode(viewMode.value as ViewMode);
  viewer.invalidate();
});

const dimSlider = $<HTMLInputElement>("dim");
dimSlider.addEventListener("input", () => {
  $("dim-out").textContent = Number(dimSlider.value).toFixed(2);
  lighting.setRoomBrightness(Number(dimSlider.value));
  viewer.invalidate();
});

$<HTMLInputElement>("show-bulb").addEventListener("change", (ev) => {
  lighting.setShowBulb((ev.target as HTMLInputElement).checked);
  viewer.invalidate();
});

$<HTMLInputElement>("show-fitter").addEventListener("change", (ev) => {
  fitter.visible = (ev.target as HTMLInputElement).checked;
  viewer.invalidate();
});

// --- downloads -----------------------------------------------------------------------------------
// Export always rebuilds at full resolution: what you download must not depend on the preview
// quality you happened to be looking at.
const slug = () =>
  [
    params.sectionKind,
    `${Math.round(dims(params, curve).outerDia)}x${Math.round(params.height)}`,
    params.perfPattern === "none" ? "solid" : params.perfPattern,
    ...(params.perfPattern !== "none" && params.perfShape !== "circle" ? [params.perfShape] : []),
  ].join("-");

$("dl-shade-stl").addEventListener("click", () => {
  exportSTL(buildShade(params, curve, EXPORT), `shade-${slug()}.stl`);
});

$("dl-fitter-stl").addEventListener("click", () => {
  exportSTL(buildFitter(params, curve), `fitter-${params.fitterKind}.stl`);
});

// STEP is the one path that needs OpenCASCADE (~10.8 MB), so it is imported on first click only.
const stepBtn = $<HTMLButtonElement>("dl-fitter-step");
stepBtn.addEventListener("click", async () => {
  const label = stepBtn.textContent;
  stepBtn.disabled = true;
  stepBtn.textContent = "Loading CAD…";
  try {
    const [{ fitterStepBlob }, { default: ocWasmUrl }] = await Promise.all([
      import("./fitter-step.ts"),
      import("replicad-opencascadejs/src/replicad_single.wasm?url"),
    ]);
    const blob = await fitterStepBlob(fitterSpec(params, curve), ocWasmUrl);
    downloadBlob(`fitter-${params.fitterKind}.step`, blob); // kit signature is (name, blob)
  } catch (err) {
    stepBtn.textContent = "STEP failed";
    console.error("STEP export failed", err);
    setTimeout(() => (stepBtn.textContent = label), 2500);
    return;
  } finally {
    stepBtn.disabled = false;
  }
  stepBtn.textContent = label;
});

// 3MF is not wired yet — STL covers the same slicers meanwhile.
const mfBtn = $<HTMLButtonElement>("dl-shade-3mf");
mfBtn.disabled = true;
mfBtn.title = "Not implemented yet — use Shade STL";

// Factory reset: params, silhouette and family back to first-run state, persisted so a reload stays
// reset. View chrome (mode, brightness, toggles) is deliberately left alone — it frames the design
// but isn't part of it.
$("reset-all").addEventListener("click", () => {
  Object.assign(params, store.defaults);
  store.save(params);
  familySelect.value = DEFAULT_FAMILY;
  curve = familyCurve(DEFAULT_FAMILY);
  saveCurve(curve);
  panel.sync();
  scheduleRebuild();
});

// --- boot ----------------------------------------------------------------------------------------
installPanelCollapse($("panel"), $("panel").querySelector("h1")!, {
  startCollapsed: matchMedia("(max-width: 640px)").matches,
});

lighting.setMode("cad");
// Seed the readout from the boot build; from here on the worker supplies both volumes.
shadeCm3 = volumeCm3(shade.geometry);
fitterCm3 = volumeCm3(fitter.geometry);
{
  const d = dims(params, curve);
  fitter.position.set(0, 0, Math.max(0, d.fitterZ - params.fitterThickness));
  lighting.update(params, d.height, d.maxR);
  readout(d);
}
curveEditor.draw();
viewer.frameCamera([shade]);
viewer.start();

installAppHook({
  params,
  // Dev-only (installAppHook is a no-op outside a Vite dev build), so the scene graph and materials
  // are exposed for probing lighting/shadow behaviour without a rebuild cycle.
  viewer,
  lighting,
  shade,
  fitter,
  get curve() {
    return curve;
  },
  setCurve(pts: CtrlPt[]) {
    curve = pts;
  },
  rebuild: scheduleRebuild,
  // Synchronous full rebuild, for the dev-hook capture flow: the normal path is a worker round trip,
  // so `rebuild(); render()` would photograph the previous mesh.
  rebuildSync() {
    const d = dims(params, curve);
    swapGeom(shade, creased(buildShade(params, curve, PREVIEW)));
    swapGeom(fitter, creased(buildFitter(params, curve)));
    setShadePerfPreview(shade, null); // a full build has real holes; drop any drag overlay
    fitter.position.set(0, 0, Math.max(0, d.fitterZ - params.fitterThickness));
    shadeCm3 = volumeCm3(shade.geometry);
    fitterCm3 = volumeCm3(fitter.geometry);
    lighting.update(params, d.height, d.maxR);
    readout(d);
    curveEditor.draw();
    viewer.invalidate();
  },
  dims: () => dims(params, curve),
  warnings: () => [...warnings(params, curve), ...fitterWarnings(params, curve)],
  maxRadius: () => maxRadius(curve),
  panel,
  render: () => viewer.render(),
  frame: () => viewer.frameCamera([shade]),
});
