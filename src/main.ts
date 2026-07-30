import "./style.css";
// Browser entry only: the ?url import lets Emscripten's locateFile fetch the wasm Vite bundled.
// It would break plain Node, which is why it lives here and not in any shared module.
import wasmUrl from "manifold-3d/manifold.wasm?url";
import { Mesh } from "three";
import { initCSG } from "parametric-kit/csg";
import { createStore, installPanelCollapse, renderPanel } from "parametric-kit/params";
import { createViewer, creased, installAppHook } from "parametric-kit/viewer";
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
import { dims, type Params, schema, warnings } from "./params.ts";
import { buildShade, EXPORT, PREVIEW } from "./shade.ts";
import { buildFitter, fitterSpec, fitterWarnings } from "./fitter.ts";
import { installCurveEditor } from "./curve-editor.ts";
import { createLighting, shadeMesh, type ViewMode } from "./lit.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

await initCSG(wasmUrl);

// --- state ---------------------------------------------------------------------------------------
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

const shade = shadeMesh(buildShade(params, curve, PREVIEW), lighting.shadeMaterial);
viewer.scene.add(shade);

const fitter = new Mesh(creased(buildFitter(params, curve)), lighting.fitterMaterial);
fitter.castShadow = fitter.receiveShadow = true;
viewer.scene.add(fitter);

// --- rebuild -------------------------------------------------------------------------------------
// Coalesced to one build per frame. Measured ~60–130 ms per rebuild depending on hole count, so a
// fast drag will not hit 60 fps; if that becomes annoying this moves to parametric-kit/worker, which
// exists for exactly this and needs no change to the pure builders.
let queued = false;
let lastMs = 0;

function rebuild(): void {
  const t0 = performance.now();
  const d = dims(params, curve);

  const oldShade = shade.geometry;
  shade.geometry = creased(buildShade(params, curve, PREVIEW));
  oldShade.dispose();

  const oldFitter = fitter.geometry;
  fitter.geometry = creased(buildFitter(params, curve));
  oldFitter.dispose();
  // The fitter is BUILT flat on the bed (print orientation) and only lifted for display. Seat it so
  // its TOP face is level with the mount height, i.e. recessed into the opening rather than perched
  // on the rim like a lid.
  fitter.position.set(0, 0, Math.max(0, d.fitterZ - params.fitterThickness));

  lighting.update(params, d.height, d.maxR);
  lastMs = performance.now() - t0;
  readout(d);
  curveEditor.draw();
  viewer.invalidate();
}

function scheduleRebuild(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    rebuild();
  });
}

// --- readout -------------------------------------------------------------------------------------
function readout(d: ReturnType<typeof dims>): void {
  const shadeCm3 = volumeCm3(shade.geometry);
  const fitterCm3 = volumeCm3(fitter.geometry);
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
    `<br><span class="perf">rebuild ${lastMs.toFixed(0)} ms</span>`;

  const all = [...warnings(params, curve), ...fitterWarnings(params, curve)];
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

// --- boot ----------------------------------------------------------------------------------------
installPanelCollapse($("panel"), $("panel").querySelector("h1")!, {
  startCollapsed: matchMedia("(max-width: 640px)").matches,
});

lighting.setMode("cad");
rebuild();
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
  rebuild,
  dims: () => dims(params, curve),
  warnings: () => [...warnings(params, curve), ...fitterWarnings(params, curve)],
  maxRadius: () => maxRadius(curve),
  panel,
  render: () => viewer.render(),
  frame: () => viewer.frameCamera([shade]),
});
