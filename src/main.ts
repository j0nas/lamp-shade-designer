import "./style.css";
// Browser entry only: the ?url import lets Emscripten's locateFile fetch the wasm Vite bundled.
// It would break plain Node, which is why it lives here and not in any shared module.
import wasmUrl from "manifold-3d/manifold.wasm?url";
import { BufferGeometry, Mesh } from "three";
import { initCSG } from "parametric-kit/csg";
import { installPanelCollapse, renderPanel } from "parametric-kit/params";
import { createViewer, creased, installAppHook } from "parametric-kit/viewer";
import { createBuildClient, unpackGeometry } from "parametric-kit/worker";
import { downloadBlob, downloadText } from "parametric-kit/export";
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
  FAMILY_NAMES,
  familyCurve,
  familyOf,
  sampleRadius,
  smooth,
  mirrorV,
} from "./curve.ts";
import {
  BULBS,
  effectiveWall,
  mergeParams,
  minBulbGap,
  type Params,
  schema,
  splitParams,
} from "./params.ts";
import {
  assembly,
  defaultDesign,
  type Design,
  layerName,
  loadWorking,
  makeInnerLayer,
  MAX_LAYERS,
  saveWorking,
} from "./layers.ts";
import { applyOverhangColors, overhangBands } from "./overhang.ts";
import { allWarnings } from "./lint.ts";
import {
  APP_VERSION,
  createLibrary,
  decodeDesignHash,
  type DesignFile,
  encodeDesignHash,
  makeDesign,
  sanitizeDesign,
  slugify,
} from "./designs.ts";
import { buildShade, PREVIEW } from "./shade.ts";
import type { BuildQuality, ExportPart, WorkerReq, WorkerRes } from "./build-protocol.ts";
import { buildFitterFromSpec, fitterSpecAssembly } from "./fitter.ts";
import { type EditorContext, installCurveEditor } from "./curve-editor.ts";
import {
  createLighting,
  setSectionCut,
  setShadePerfPreview,
  shadeMesh,
  type ViewMode,
} from "./lit.ts";
import { createPerfPreview } from "./perf-texture.ts";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

await initCSG(wasmUrl);

// --- state ---------------------------------------------------------------------------------------
// The whole design — globals plus every layer — under one versioned key; loadWorking migrates the
// pre-layer keys so an existing session comes back exactly as it was, as layer 0.
const working = loadWorking();
const design: Design = working.design;
let active = Math.min(working.active, design.layers.length - 1);

// A share link replaces the working copy — deliberately: the link IS the design being opened. The
// hash is then stripped so a reload keeps subsequent edits instead of re-applying the link.
{
  const shared = decodeDesignHash(location.hash);
  if (shared) {
    design.globals = { ...shared.globals };
    design.layers = shared.layers.map((l) => structuredClone(l));
    active = 0;
    saveWorking({ design, active });
    history.replaceState(null, "", location.pathname + location.search);
  }
}

const activeLayer = () => design.layers[active];
const persist = (): void => saveWorking({ design, active });
// Memoised per layer inside layers.ts, so calling this freely per frame costs what a single-shade
// dims() call always did: only the edited layer recomputes.
const asm = () => assembly(design);

// The live object the panel mutates: the ACTIVE layer's fields merged over the shared globals.
// onChange splits edits back to their owners; a layer switch re-assigns and panel.sync()s.
const params: Params = mergeParams(design.globals, activeLayer().params);

const isNested = (): boolean => activeLayer().link === "nest" && active > 0;
const displayCurve = (): CtrlPt[] =>
  isNested() ? asm().layers[active].curve : activeLayer().curve;

// --- viewer --------------------------------------------------------------------------------------
// Shades are big compared with the kit's default part scale, so the shadow frustum and ground grow.
const viewer = createViewer($("app"), {
  shadowExtent: 420,
  shadowFar: 3000,
  groundSize: 6000,
});
const lighting = createLighting(viewer.scene);

const fitterMesh = new Mesh(new BufferGeometry(), lighting.fitterMaterial);
fitterMesh.castShadow = fitterMesh.receiveShadow = true;
viewer.scene.add(fitterMesh);

// While a control is being dragged the mesh on screen is a hole-less draft; this texture paints the
// live perforation onto it so the pattern — the very thing most sliders manipulate — never blinks
// out mid-drag. Draft results attach it, settled previews (real cut holes) drop it.
const perfPreview = createPerfPreview();

const swapGeom = (mesh: Mesh, geom: BufferGeometry): void => {
  const old = mesh.geometry;
  mesh.geometry = geom;
  old.dispose();
};

// --- layer meshes --------------------------------------------------------------------------------
// One mesh per layer, kept in lockstep with the design: materials come from lighting (which owns
// every view mode's styling), positions from each layer's lift, visibility from its eye toggle.
let shadeMeshes: Mesh[] = [];
const layerCm3: number[] = [];
let fitterCm3 = 0;
let sectionCutOn = false;

const layerLooks = () =>
  design.layers.map((l) => ({
    color: l.color,
    opacity: l.opacity,
    wall: effectiveWall(mergeParams(design.globals, l.params)),
  }));

function syncMeshes(): void {
  const mats = lighting.syncLayerMaterials(layerLooks());
  while (shadeMeshes.length < design.layers.length) {
    const mesh = shadeMesh(new BufferGeometry(), mats[shadeMeshes.length]);
    viewer.scene.add(mesh);
    shadeMeshes.push(mesh);
  }
  while (shadeMeshes.length > design.layers.length) {
    const mesh = shadeMeshes.pop()!;
    viewer.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.customDepthMaterial?.dispose();
    mesh.customDistanceMaterial?.dispose();
  }
  while (layerCm3.length < design.layers.length) layerCm3.push(0);
  layerCm3.length = design.layers.length;
  shadeMeshes.forEach((mesh, i) => {
    mesh.material = mats[i];
    mesh.visible = design.layers[i].visible;
    // The PART is built base-on-bed; lift is purely an assembly offset, applied here for display.
    mesh.position.set(0, 0, design.layers[i].params.lift);
  });
  setSectionCut([...shadeMeshes, fitterMesh], sectionCutOn);
  viewer.invalidate();
}

// Heatmap recolour: writes the overhang colour attribute onto every layer's CURRENT geometry.
// Called wherever geometry lands while the overhang view is active — drafts included, which is
// what keeps the heatmap live mid-drag. The attribute must exist BEFORE the material flips to
// vertexColors (a vertex-colour material with no color attribute renders black), so the view-mode
// listener calls this before lighting.setMode. The fitter is deliberately untinted: a flat plate
// on the bed has no overhang to warn about.
function recolorShades(): void {
  if (viewModeSel.value !== "overhang") return;
  const a = asm();
  shadeMeshes.forEach((mesh, i) => {
    const l = a.layers[i];
    if (!l) return;
    applyOverhangColors(mesh.geometry, {
      height: l.params.height,
      wall: effectiveWall(l.params),
    });
  });
}

// --- rebuild -------------------------------------------------------------------------------------
// Every rebuild runs in a worker (latest-wins: mid-drag requests are dropped, never queued), so the
// main thread never blocks on a boolean. Each change asks for a DRAFT — the ACTIVE layer only,
// form only, no perforation, ~1 ms — and a settle timer asks for the full PREVIEW (all layers, the
// untouched ones served from the worker's cache) once the control has been still for a moment.
const SETTLE_MS = 180;

const client = createBuildClient<WorkerReq, WorkerRes>(
  () => new Worker(new URL("./build-worker.ts", import.meta.url), { type: "module" }),
);

let settleTimer: ReturnType<typeof setTimeout> | undefined;
let lastMs = 0;
let lastQuality: BuildQuality = "preview";

// Snapshot: the panel mutates the design in place, and the request may be posted a tick later.
const snapshotDesign = (): Design => structuredClone(design);

const request = (quality: BuildQuality): void => {
  client.request({ kind: "build", design: snapshotDesign(), active, quality });
};

let chromeQueued = false;

function scheduleRebuild(): void {
  request("draft");
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => request("preview"), SETTLE_MS);
  // The readout and the silhouette editor derive from the design rather than from the mesh, so
  // they can update without waiting for a build to land — but coalesced to one pass per frame,
  // because this runs on every pointermove of a drag.
  if (chromeQueued) return;
  chromeQueued = true;
  requestAnimationFrame(() => {
    chromeQueued = false;
    readout();
    curveEditor.draw();
  });
}

client.onResult((res) => {
  if (res.kind !== "build") return; // exports have their own client; belt-and-braces
  const a = asm();

  // Slot i non-null means layer i was rebuilt — the encoding survives layer switches mid-flight
  // because position, not "the active layer", says which mesh to swap.
  res.shades.forEach((packed, i) => {
    if (!packed || i >= shadeMeshes.length) return;
    swapGeom(shadeMeshes[i], creased(unpackGeometry(packed)));
  });
  if (res.fitter) swapGeom(fitterMesh, creased(unpackGeometry(res.fitter)));
  recolorShades(); // drafts included — the heatmap stays live mid-drag
  // The fitter is BUILT flat on the bed (print orientation) and only lifted for display. Seat it
  // so its TOP face is level with the mount height, i.e. recessed into the opening.
  fitterMesh.position.set(0, 0, Math.max(0, a.fitterZ - design.globals.fitterThickness));

  // Drawn from the CURRENT params rather than the ones this draft was built from: with latest-wins
  // scheduling the texture can only be fresher than the mesh, never staler.
  if (res.quality === "draft") {
    const mesh = shadeMeshes[active];
    if (mesh) {
      setShadePerfPreview(
        mesh,
        perfPreview.update(params, displayCurve()) ? perfPreview.texture : null,
      );
    }
  } else {
    for (const mesh of shadeMeshes) setShadePerfPreview(mesh, null);
  }

  // Draft builds carry no volumes; keep the last real numbers rather than flashing wrong ones.
  res.shadeCm3.forEach((v, i) => {
    if (v !== null && i < layerCm3.length) layerCm3[i] = v;
  });
  if (res.quality !== "draft") fitterCm3 = res.fitterCm3;
  lastMs = res.timings.total + res.fitterMs;
  lastQuality = res.quality;

  lighting.update(design.globals, a.height, a.outerDia / 2);
  readout();
  viewer.invalidate();
});

client.onError((message) => {
  // A build throws on params the lint already flags (a wall thicker than the radius inverts the
  // inner surface). Keep the last good mesh on screen and let the warnings explain it.
  console.error("build failed", message);
});

// --- readout -------------------------------------------------------------------------------------
function readout(): void {
  const a = asm();
  // Volumes come from the worker (measured on the real cut solids) rather than from the meshes on
  // screen, which during a drag include a hole-less draft.
  const total = layerCm3.reduce((s, v) => s + (v || 0), 0) + fitterCm3;
  const grams = Math.round(filamentGrams(total));
  const metres = filamentMetres(total);

  const badges = PRINTERS.map((printer) => {
    const fit = fitFor(printer, a.outerDia, a.outerDia);
    const mark = fit === "ok" ? "✓" : fit === "mod" ? "~" : "✗";
    return `<span class="badge ${fit}" title="${fitTitle(printer, fit)}">${printer.name} ${mark}</span>`;
  }).join(" ");

  const layerBit = design.layers.length > 1 ? ` · ${design.layers.length} layers` : "";
  const gapBit =
    a.gaps.length > 0
      ? ` · layer gap <strong>${Math.min(...a.gaps.map((g) => g.minGap)).toFixed(1)} mm</strong>`
      : "";
  const bulbBit = Number.isFinite(a.bulbGap) ? `${a.bulbGap.toFixed(0)} mm` : "—";

  $("dims").innerHTML =
    `<strong>⌀${a.outerDia.toFixed(0)} × ${a.height.toFixed(0)} mm</strong>${layerBit} · ` +
    `${a.holeCount} holes · <strong>${grams} g</strong> (${metres.toFixed(1)} m) · ` +
    `bulb gap <strong>${bulbBit}</strong>${gapBit}<br>${badges}` +
    `<br><span class="perf">${lastQuality} rebuild ${lastMs.toFixed(0)} ms</span>`;

  $("warnings").innerHTML = allWarnings(design, a)
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
      visibleWhen: (p) =>
        p.perfPattern !== "none" && (p.perfShape !== "circle" || p.perfAspect > 1),
    },
    { id: "perforation-grid", visibleWhen: (p) => p.perfPattern !== "none" },
    { id: "light", title: "Light" },
    { id: "fitter", title: "Fitter" },
    { id: "print", title: "Print" },
  ],
  onChange: () => {
    // The panel edited the merged view; hand each field back to its owner — layer fields to the
    // active layer, light/fitter fields to the shared globals.
    const split = splitParams(params);
    Object.assign(design.globals, split.globals);
    Object.assign(activeLayer().params, split.layer);
    persist();
    scheduleRebuild();
  },
});

// --- undo (silhouette edits) ---------------------------------------------------------------------
// Whole gestures, not pointermoves: the editor brackets each drag/add/remove/nudge-burst with
// beginEdit, and that is when the outgoing curve is snapshotted. Structural layer changes clear
// the stacks — entries index into the layer list.
type UndoEntry = { layer: number; curve: CtrlPt[] };
const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];

const snapshotCurve = (i: number): UndoEntry => ({
  layer: i,
  curve: design.layers[i].curve.map((p) => ({ ...p })),
});

function pushUndo(): void {
  undoStack.push(snapshotCurve(active));
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}

function applyUndo(from: UndoEntry[], to: UndoEntry[]): void {
  const entry = from.pop();
  if (!entry || entry.layer >= design.layers.length) return;
  to.push(snapshotCurve(entry.layer));
  design.layers[entry.layer].curve = entry.curve;
  if (entry.layer !== active) switchLayer(entry.layer);
  persist();
  syncFamily();
  curveEditor.draw();
  syncInspector();
  scheduleRebuild();
}

document.addEventListener("keydown", (ev) => {
  if (!(ev.metaKey || ev.ctrlKey) || ev.key.toLowerCase() !== "z") return;
  const t = ev.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
  ev.preventDefault();
  if (ev.shiftKey) applyUndo(redoStack, undoStack);
  else applyUndo(undoStack, redoStack);
});

// --- silhouette editor ---------------------------------------------------------------------------
function editorContext(): EditorContext {
  const a = asm();
  const l = a.layers[active];
  const bulb = BULBS[design.globals.bulbKind];
  const n = design.layers.length;
  const ghosts = a.layers
    .filter((_, i) => i !== active && design.layers[i].visible)
    .map((rl) => {
      const span = rl.z1 - rl.z0;
      const pts: [number, number][] = [];
      for (let k = 0; k <= 48; k++) {
        const v = k / 48;
        pts.push([sampleRadius(rl.curve, v) * rl.params.girth, rl.z0 + v * span]);
      }
      return { pts, color: rl.layer.color };
    });
  return {
    spanMm: a.height,
    girth: l.params.girth,
    liftMm: l.z0,
    heightMm: l.params.height,
    editable: !isNested(),
    nestedHint: isNested()
      ? `Follows ${layerName(active - 1, n)} at ${activeLayer().gap} mm — adjust with the air-gap slider`
      : null,
    ghosts,
    bulb: {
      rMm: bulb.dia / 2,
      lenMm: bulb.len,
      zMm: a.bulbCentreZ,
      clearMm: minBulbGap(design.globals.watts),
    },
    fitterZMm: a.fitterZ,
    bands: overhangBands(l.curve, {
      height: l.params.height,
      girth: l.params.girth,
      waveCount: l.params.waveCount,
      waveDepth: l.params.waveDepth,
    }),
  };
}

const curveEditor = installCurveEditor($<HTMLCanvasElement>("curve"), {
  get: displayCurve,
  set: (pts) => {
    activeLayer().curve = pts;
    persist();
    syncFamily();
  },
  onChange: scheduleRebuild,
  context: editorContext,
  beginEdit: pushUndo,
  onSelect: syncInspector,
});

// Numeric inspector: exact values for the selected point, in world millimetres.
const ptR = $<HTMLInputElement>("pt-r");
const ptZ = $<HTMLInputElement>("pt-z");

function syncInspector(): void {
  const sel = curveEditor.selection();
  const enabled = sel !== null && !isNested();
  ptR.disabled = ptZ.disabled = !enabled;
  if (!sel) {
    ptR.value = "";
    ptZ.value = "";
    return;
  }
  if (document.activeElement !== ptR) ptR.value = sel.rMm.toFixed(1);
  if (document.activeElement !== ptZ) ptZ.value = sel.zMm.toFixed(1);
}

const applyInspector = (): void => {
  const r = Number.parseFloat(ptR.value);
  const z = Number.parseFloat(ptZ.value);
  if (Number.isFinite(r) && Number.isFinite(z)) curveEditor.applySelection(r, z);
};
ptR.addEventListener("change", applyInspector);
ptZ.addEventListener("change", applyInspector);

// Expanded mode re-parents the editor onto <body>: #panel's backdrop-filter makes it the
// containing block for position:fixed descendants, so a fixed overlay left INSIDE the panel would
// be positioned relative to it and clipped by its overflow — i.e. it would simply vanish.
{
  const curveWrap = $("curve-wrap");
  const wrapHome = curveWrap.nextElementSibling; // the smooth/mirror/reset row
  const wrapParent = curveWrap.parentElement!;
  const expandBtn = $<HTMLButtonElement>("curve-expand");

  const setExpanded = (on: boolean): void => {
    curveWrap.classList.toggle("expanded", on);
    if (on) document.body.append(curveWrap);
    else wrapParent.insertBefore(curveWrap, wrapHome);
    expandBtn.textContent = on ? "⤡" : "⤢";
    expandBtn.title = on ? "Collapse the editor" : "Expand the editor";
    curveEditor.draw(); // the ResizeObserver fires too, but draw now — no one-frame blank
  };

  expandBtn.addEventListener("click", () => setExpanded(!curveWrap.classList.contains("expanded")));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && curveWrap.classList.contains("expanded")) setExpanded(false);
  });
}

const familySelect = $<HTMLSelectElement>("family");
{
  // Shown whenever the curve is not literally a named family — edited, imported, loaded. Hidden
  // from the dropdown itself; only ever selected programmatically by syncFamily().
  const custom = document.createElement("option");
  custom.value = "";
  custom.disabled = true;
  custom.hidden = true;
  custom.textContent = "Custom";
  familySelect.append(custom);
}
for (const name of FAMILY_NAMES) {
  const opt = document.createElement("option");
  opt.value = name;
  opt.textContent = name[0].toUpperCase() + name.slice(1);
  familySelect.append(opt);
}

// The select displays as state, so it must tell the truth: the family the active layer's curve
// actually is, or "Custom" the moment an edit moves a point.
const syncFamily = (): void => {
  familySelect.value = familyOf(activeLayer().curve) ?? "";
};

familySelect.addEventListener("change", () => {
  if (isNested()) return;
  pushUndo();
  activeLayer().curve = familyCurve(familySelect.value);
  persist();
  curveEditor.draw();
  scheduleRebuild();
});

const editCurve = (fn: (pts: CtrlPt[]) => CtrlPt[]) => () => {
  if (isNested()) return;
  pushUndo();
  activeLayer().curve = fn(activeLayer().curve);
  persist();
  syncFamily(); // smoothing can leave a family; mirroring a drum still is one — let the data say
  curveEditor.draw();
  scheduleRebuild();
};
$("curve-smooth").addEventListener("click", editCurve(smooth));
$("curve-mirror").addEventListener("click", editCurve(mirrorV));
$("curve-reset").addEventListener(
  "click",
  editCurve(() => familyCurve(familySelect.value)),
);

// --- layers UI -----------------------------------------------------------------------------------
const layerColor = $<HTMLInputElement>("layer-color");
const layerColorOut = $("layer-color-out");
const layerOpacity = $<HTMLInputElement>("layer-opacity");
const layerOpacityOut = $("layer-opacity-out");
const linkSel = $<HTMLSelectElement>("curve-link");
const gapRow = $("nest-gap-row");
const gapInput = $<HTMLInputElement>("nest-gap");
const gapOut = $("nest-gap-out");

function renderLayerList(): void {
  const list = $("layer-list");
  list.innerHTML = "";
  const n = design.layers.length;
  design.layers.forEach((l, i) => {
    const row = document.createElement("div");
    row.className = `layer-row${i === active ? " active" : ""}${l.visible ? "" : " hidden-layer"}`;
    const swatch = document.createElement("span");
    swatch.className = "layer-swatch";
    swatch.style.background = l.color;
    const name = document.createElement("span");
    name.className = "layer-name";
    name.textContent = layerName(i, n);
    const tag = document.createElement("span");
    tag.className = "layer-tag";
    tag.textContent = l.link === "nest" && i > 0 ? `nested ${l.gap} mm` : "";
    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "layer-eye";
    eye.textContent = l.visible ? "●" : "○";
    eye.title = l.visible ? "Hide in preview" : "Show in preview";
    eye.addEventListener("click", (ev) => {
      ev.stopPropagation();
      l.visible = !l.visible;
      persist();
      syncMeshes();
      renderLayerList();
      curveEditor.draw();
    });
    row.append(swatch, name, tag, eye);
    row.addEventListener("click", () => switchLayer(i));
    list.append(row);
  });
}

function syncLayerChrome(): void {
  const l = activeLayer();
  const n = design.layers.length;
  layerColor.value = l.color;
  layerColorOut.textContent = l.color;
  layerOpacity.value = String(l.opacity);
  layerOpacityOut.textContent = l.opacity.toFixed(2);
  linkSel.value = isNested() ? "nest" : "free";
  linkSel.disabled = active === 0; // the outermost layer has nothing to nest inside
  gapRow.style.display = isNested() ? "" : "none";
  gapInput.value = String(l.gap);
  gapOut.textContent = `${l.gap} mm`;
  $("family-row").style.display = isNested() ? "none" : "";
  for (const id of ["curve-smooth", "curve-mirror", "curve-reset"]) {
    $<HTMLButtonElement>(id).disabled = isNested();
  }
  $<HTMLButtonElement>("layer-add").disabled = n >= MAX_LAYERS;
  $<HTMLButtonElement>("layer-delete").disabled = n <= 1;
  $<HTMLButtonElement>("dl-shade-stl").textContent = `${layerName(active, n)} STL`;
  $<HTMLButtonElement>("dl-shade-3mf").textContent = n > 1 ? "All layers 3MF" : "Shade 3MF";
  renderLayerList();
  syncInspector();
}

function switchLayer(i: number): void {
  if (i === active || i < 0 || i >= design.layers.length) return;
  active = i;
  Object.assign(params, activeLayer().params);
  panel.sync();
  persist();
  syncLayerChrome();
  syncFamily();
  curveEditor.draw();
}

// After any structural layer change: normalise, rebind the panel, resize the scene, rebuild.
function afterLayersChanged(): void {
  if (design.layers[0].link === "nest") design.layers[0].link = "free";
  active = Math.min(Math.max(0, active), design.layers.length - 1);
  undoStack.length = 0;
  redoStack.length = 0;
  Object.assign(params, mergeParams(design.globals, activeLayer().params));
  panel.sync();
  syncMeshes();
  syncLayerChrome();
  syncFamily();
  persist();
  scheduleRebuild();
}

$("layer-add").addEventListener("click", () => {
  if (design.layers.length >= MAX_LAYERS) return;
  design.layers.push(
    makeInnerLayer(design.layers[design.layers.length - 1], design.layers.length),
  );
  active = design.layers.length - 1;
  afterLayersChanged();
});

$("layer-duplicate").addEventListener("click", () => {
  if (design.layers.length >= MAX_LAYERS) return;
  design.layers.splice(active + 1, 0, structuredClone(activeLayer()));
  active += 1;
  afterLayersChanged();
});

$("layer-delete").addEventListener("click", () => {
  if (design.layers.length <= 1) return;
  design.layers.splice(active, 1);
  active = Math.max(0, active - 1);
  afterLayersChanged();
});

layerColor.addEventListener("input", () => {
  activeLayer().color = layerColor.value;
  layerColorOut.textContent = layerColor.value;
  persist();
  syncMeshes(); // restyles the layer materials
  renderLayerList();
  curveEditor.draw(); // ghost outlines carry layer colours
});

layerOpacity.addEventListener("input", () => {
  activeLayer().opacity = Number(layerOpacity.value);
  layerOpacityOut.textContent = activeLayer().opacity.toFixed(2);
  persist();
  syncMeshes();
});

linkSel.addEventListener("change", () => {
  const l = activeLayer();
  l.link = linkSel.value === "nest" && active > 0 ? "nest" : "free";
  if (l.link === "nest") {
    // Nesting defines the silhouette completely; girth would double-scale the derived curve.
    l.params.girth = 1;
    params.girth = 1;
    panel.sync();
  }
  persist();
  syncLayerChrome();
  curveEditor.draw();
  scheduleRebuild();
});

gapInput.addEventListener("input", () => {
  activeLayer().gap = Number(gapInput.value);
  gapOut.textContent = `${activeLayer().gap} mm`;
  persist();
  renderLayerList();
  curveEditor.draw();
  scheduleRebuild();
});

// --- design library ------------------------------------------------------------------------------
const library = createLibrary();
const designSelect = $<HTMLSelectElement>("design-select");
const designName = $<HTMLInputElement>("design-name");

function refreshDesigns(selected = ""): void {
  designSelect.innerHTML = "";
  // A disabled placeholder so the select can sit on "nothing loaded" — the working copy is its own
  // state, not implicitly the first saved design.
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— load a design —";
  blank.disabled = true;
  designSelect.append(blank);
  for (const d of library.list()) {
    const opt = document.createElement("option");
    opt.value = d.name;
    opt.textContent = d.name;
    designSelect.append(opt);
  }
  designSelect.value = selected;
}

function applyDesign(d: DesignFile): void {
  design.globals = { ...d.globals };
  design.layers = d.layers.map((l) => structuredClone(l));
  active = 0;
  designName.value = d.name;
  afterLayersChanged();
}

const currentName = (): string => designName.value.trim() || designSelect.value || "untitled";

const saveAs = (name: string): void => {
  const d = makeDesign(name, design);
  library.put(d);
  refreshDesigns(d.name);
  designName.value = d.name;
};

$("design-save").addEventListener("click", () => saveAs(currentName()));
$("design-duplicate").addEventListener("click", () => saveAs(`${currentName()} copy`));

$("design-delete").addEventListener("click", () => {
  const name = designSelect.value;
  if (!name) return;
  library.remove(name);
  refreshDesigns(); // the working copy stays on screen; delete only removes the saved entry
});

designSelect.addEventListener("change", () => {
  const d = library.get(designSelect.value);
  if (d) applyDesign(d);
});

$("design-export").addEventListener("click", () => {
  const d = makeDesign(currentName(), design);
  downloadText(`lamp-shade-${slugify(d.name)}.json`, JSON.stringify(d, null, 2));
});

// Import goes through the same sanitizer as every other design source; a file that isn't a design
// reports on the button itself, the same transient pattern the STEP button uses.
const importBtn = $<HTMLButtonElement>("design-import");
const importFile = $<HTMLInputElement>("design-file");
importBtn.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  importFile.value = ""; // so picking the same file again still fires change
  if (!file) return;
  let d: DesignFile | null = null;
  try {
    d = sanitizeDesign(JSON.parse(await file.text()));
  } catch {
    /* unreadable file or invalid JSON — reported below exactly like a wrong envelope */
  }
  if (!d) {
    const label = importBtn.textContent;
    importBtn.textContent = "Not a design file";
    setTimeout(() => (importBtn.textContent = label), 2500);
    return;
  }
  library.put(d);
  refreshDesigns(d.name);
  applyDesign(d);
});

const shareUrl = (): string =>
  `${location.origin}${location.pathname}#${encodeDesignHash(makeDesign(currentName(), design))}`;

const linkBtn = $<HTMLButtonElement>("design-link");
linkBtn.addEventListener("click", () => {
  const label = linkBtn.textContent;
  navigator.clipboard.writeText(shareUrl()).then(
    () => (linkBtn.textContent = "Copied!"),
    () => (linkBtn.textContent = "Copy failed"),
  );
  setTimeout(() => (linkBtn.textContent = label), 2000);
});

refreshDesigns();

// --- view controls (app chrome: deliberately not schema params) -----------------------------------
const viewModeSel = $<HTMLSelectElement>("view-mode");
viewModeSel.addEventListener("change", () => {
  recolorShades(); // attribute before material: entering overhang mode must never render black
  lighting.setMode(viewModeSel.value as ViewMode);
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
  fitterMesh.visible = (ev.target as HTMLInputElement).checked;
  viewer.invalidate();
});

// Costs nothing until a material actually carries planes, so it is switched on unconditionally.
viewer.renderer.localClippingEnabled = true;
$<HTMLInputElement>("section-cut").addEventListener("change", (ev) => {
  sectionCutOn = (ev.target as HTMLInputElement).checked;
  setSectionCut([...shadeMeshes, fitterMesh], sectionCutOn);
  viewer.invalidate();
});

// --- downloads -----------------------------------------------------------------------------------
// Exports rebuild at full resolution on their own dedicated worker: what you download must not
// depend on the preview quality you happened to be looking at, and a seconds-long dense export
// must neither freeze the tab nor queue against live drag rebuilds. Provenance rides in the file
// itself — the STL header, the 3MF metadata — stamped worker-side.
//
// One export at a time: the worker client is latest-wins by design, so a second concurrent
// request would silently supersede the first. The buttons disable as a set instead.
const exportClient = createBuildClient<WorkerReq, WorkerRes>(
  () => new Worker(new URL("./build-worker.ts", import.meta.url), { type: "module" }),
);

const exportButtons = ["dl-shade-stl", "dl-shade-3mf", "dl-fitter-stl"].map((id) =>
  $<HTMLButtonElement>(id),
);

const slug = () => {
  const a = asm();
  return [
    params.sectionKind,
    `${Math.round(a.outerDia)}x${Math.round(a.height)}`,
    params.perfPattern === "none" ? "solid" : params.perfPattern,
    ...(params.perfPattern !== "none" && params.perfShape !== "circle" ? [params.perfShape] : []),
  ].join("-");
};

let exportJob: { filename: string; mime: string; button: HTMLButtonElement; label: string } | null =
  null;

function requestExport(
  button: HTMLButtonElement,
  part: ExportPart,
  filename: string,
  mime: string,
) {
  if (exportJob) return;
  exportJob = { filename, mime, button, label: button.textContent ?? "" };
  for (const b of exportButtons) b.disabled = true;
  button.textContent = "Building…";
  exportClient.request({
    kind: "export",
    part,
    design: snapshotDesign(),
    layerIndex: active,
    name: currentName(),
  });
}

function finishExport(failed: boolean): void {
  const job = exportJob;
  if (!job) return;
  exportJob = null;
  for (const b of exportButtons) b.disabled = false;
  job.button.textContent = failed ? "Export failed" : job.label;
  if (failed) setTimeout(() => (job.button.textContent = job.label), 2500);
}

exportClient.onResult((res) => {
  if (res.kind !== "export" || !exportJob) return;
  downloadBlob(exportJob.filename, new Blob([res.bytes], { type: exportJob.mime }));
  finishExport(false);
});

exportClient.onError((message) => {
  console.error("export failed", message);
  finishExport(true);
});

// The active layer's part slug: distinguishes multi-layer exports, disappears for a single shade.
const layerSlug = (): string =>
  design.layers.length > 1 ? `${slugify(layerName(active, design.layers.length))}-` : "";

$("dl-shade-stl").addEventListener("click", (ev) => {
  requestExport(
    ev.currentTarget as HTMLButtonElement,
    "layer-stl",
    `shade-${slugify(currentName())}-${layerSlug()}${slug()}-${slugify(APP_VERSION)}.stl`,
    "model/stl",
  );
});

$("dl-shade-3mf").addEventListener("click", (ev) => {
  requestExport(
    ev.currentTarget as HTMLButtonElement,
    "shades-3mf",
    `shade-${slugify(currentName())}-${slug()}-${slugify(APP_VERSION)}.3mf`,
    "model/3mf",
  );
});

$("dl-fitter-stl").addEventListener("click", (ev) => {
  requestExport(
    ev.currentTarget as HTMLButtonElement,
    "fitter-stl",
    `fitter-${slugify(currentName())}-${design.globals.fitterKind}-${slugify(APP_VERSION)}.stl`,
    "model/stl",
  );
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
    const blob = await fitterStepBlob(fitterSpecAssembly(asm()), ocWasmUrl);
    downloadBlob(`fitter-${design.globals.fitterKind}.step`, blob); // kit signature is (name, blob)
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

// Factory reset: globals, layers and silhouettes back to first-run state, persisted so a reload
// stays reset. View chrome (mode, brightness, toggles) is deliberately left alone.
$("reset-all").addEventListener("click", () => {
  const fresh = defaultDesign();
  design.globals = fresh.globals;
  design.layers = fresh.layers;
  active = 0;
  afterLayersChanged();
});

// --- boot ----------------------------------------------------------------------------------------
installPanelCollapse($("panel"), $("panel").querySelector("h1")!, {
  startCollapsed: matchMedia("(max-width: 640px)").matches,
});

lighting.setMode("cad");
syncMeshes();
// Built synchronously here so the first frame is the real thing — a worker round trip would show
// hole-less drafts first. Every rebuild after this one goes through the worker.
{
  const a = asm();
  a.layers.forEach((l, i) => {
    swapGeom(shadeMeshes[i], creased(buildShade(l.params, l.curve, PREVIEW)));
    layerCm3[i] = volumeCm3(shadeMeshes[i].geometry);
  });
  swapGeom(fitterMesh, creased(buildFitterFromSpec(fitterSpecAssembly(a))));
  fitterCm3 = volumeCm3(fitterMesh.geometry);
  fitterMesh.position.set(0, 0, Math.max(0, a.fitterZ - design.globals.fitterThickness));
  lighting.update(design.globals, a.height, a.outerDia / 2);
  readout();
}
syncLayerChrome();
syncFamily();
curveEditor.draw();
viewer.frameCamera(shadeMeshes);
viewer.start();

installAppHook({
  params,
  // Dev-only (installAppHook is a no-op outside a Vite dev build), so the scene graph and materials
  // are exposed for probing lighting/shadow behaviour without a rebuild cycle.
  viewer,
  lighting,
  get design() {
    return design;
  },
  get active() {
    return active;
  },
  setActive: switchLayer,
  shades: () => shadeMeshes,
  fitter: fitterMesh,
  get curve() {
    return activeLayer().curve;
  },
  setCurve(pts: CtrlPt[]) {
    activeLayer().curve = pts;
  },
  rebuild: scheduleRebuild,
  // Synchronous full rebuild, for the dev-hook capture flow: the normal path is a worker round trip,
  // so `rebuild(); render()` would photograph the previous meshes.
  rebuildSync() {
    const a = asm();
    a.layers.forEach((l, i) => {
      swapGeom(shadeMeshes[i], creased(buildShade(l.params, l.curve, PREVIEW)));
      layerCm3[i] = volumeCm3(shadeMeshes[i].geometry);
    });
    swapGeom(fitterMesh, creased(buildFitterFromSpec(fitterSpecAssembly(a))));
    fitterCm3 = volumeCm3(fitterMesh.geometry);
    recolorShades();
    for (const mesh of shadeMeshes) setShadePerfPreview(mesh, null);
    fitterMesh.position.set(0, 0, Math.max(0, a.fitterZ - design.globals.fitterThickness));
    lighting.update(design.globals, a.height, a.outerDia / 2);
    readout();
    curveEditor.draw();
    viewer.invalidate();
  },
  dims: () => asm(),
  warnings: () => allWarnings(design),
  library,
  shareUrl,
  applyDesign,
  addInnerLayer: () => $("layer-add").click(),
  version: APP_VERSION,
  panel,
  curveEditor,
  render: () => viewer.render(),
  frame: () => viewer.frameCamera(shadeMeshes),
});
