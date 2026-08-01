// Layered shades: one lamp as N nested printed shells — an outer translucent skin over a coloured
// inner diffuser, or any deeper stack. Each layer is a full shade definition (its own silhouette,
// section, modulation, perforation, wall); the light and the fitter stay assembly-global.
//
// Deliberately NO hard constraint keeps layers apart: intersecting shells are a legitimate design
// (interlocked multi-material prints on a tool-changing machine), so overlap is linted, never
// clamped. The "nest" link is the opposite convenience — a layer that derives its silhouette from
// the next-outer layer at a fixed air gap, for the classic diffuser-inside-skin build.
//
// Pure data + math (no DOM beyond guarded localStorage, no kernel), so the worker, the UI and the
// Node tests all resolve a design identically.

import { defaults, sanitize } from "parametric-kit/params";
import {
  clampR,
  type CtrlPt,
  DEFAULT_FAMILY,
  familyCurve,
  sampleRadius,
  sanitizeCurve,
} from "./curve.ts";
import {
  dims,
  type Dims,
  effectiveWall,
  type GlobalParams,
  type LayerParams,
  mergeParams,
  migrateStored,
  type Params,
  schema,
  splitParams,
  type Warning,
} from "./params.ts";
import { minSurfaceRadiusAt, waveOffset } from "./surface.ts";

// Every layer is a full build (mesh + boolean); six is far past any sane lamp and still cheap
// enough to preview live. Imports beyond the cap keep the outermost layers.
export const MAX_LAYERS = 6;

export type LayerLink = "free" | "nest";

export type Layer = {
  color: string; // #rrggbb — preview material AND the 3MF object colour the slicer maps filaments by
  opacity: number; // preview translucency; 1 = opaque
  visible: boolean; // preview only — exports always include every layer
  link: LayerLink; // "nest": silhouette derived from the next-outer layer at `gap` mm
  gap: number; // air gap (mm) between this layer's outer face and the outer layer's inner face
  params: LayerParams;
  curve: CtrlPt[]; // own silhouette; kept (but unused) while nested so un-nesting restores it
};

export type Design = { globals: GlobalParams; layers: Layer[] };

// First colour matches the classic single-shade look; the rest are picked to read apart both as
// swatches and as lit shells.
export const LAYER_COLORS = ["#f3ece0", "#e08a3c", "#3c8ea0", "#7fa05a", "#8a5aa0", "#c05a4a"];

export function layerName(i: number, count: number): string {
  if (count <= 1) return "Shade";
  if (i === 0) return "Outer";
  if (i === count - 1) return "Inner";
  return `Mid ${i}`;
}

export function defaultLayer(): Layer {
  return {
    color: LAYER_COLORS[0],
    opacity: 1,
    visible: true,
    link: "free",
    gap: 6,
    params: splitParams(defaults(schema)).layer,
    curve: familyCurve(DEFAULT_FAMILY),
  };
}

export function defaultDesign(): Design {
  return { globals: splitParams(defaults(schema)).globals, layers: [defaultLayer()] };
}

// A new inner layer defaults to the thing people actually build: a solid nested diffuser. Geometry
// params copy the layer it goes inside (same height, wall, print settings) but perforation is off —
// the outer skin carries the pattern, the inner carries the colour — and girth resets to 1 because
// nesting defines the silhouette completely.
export function makeInnerLayer(outer: Layer, colorIndex: number): Layer {
  return {
    color: LAYER_COLORS[colorIndex % LAYER_COLORS.length],
    opacity: 1,
    visible: true,
    link: "nest",
    gap: 6,
    params: { ...outer.params, perfPattern: "none", girth: 1 },
    curve: outer.curve.map((pt) => ({ ...pt })),
  };
}

// --- sanitizers ----------------------------------------------------------------------------------
// Same contract as the kit's sanitize(): valid fields survive verbatim, malformed fields degrade to
// defaults, nothing throws. designs.ts funnels every imported/shared/stored layer through here.

const COLOR_RE = /^#[0-9a-f]{6}$/i;

function num(v: unknown, def: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
}

export function sanitizeLayer(raw: unknown, index: number): Layer {
  const base = defaultLayer();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  return {
    color:
      typeof r.color === "string" && COLOR_RE.test(r.color)
        ? r.color.toLowerCase()
        : LAYER_COLORS[index % LAYER_COLORS.length],
    opacity: num(r.opacity, 1, 0.1, 1),
    visible: typeof r.visible === "boolean" ? r.visible : true,
    // Layer 0 has nothing outside it to nest in; force it free so resolution never dangles.
    link: r.link === "nest" && index > 0 ? "nest" : "free",
    gap: num(r.gap, 6, 0.5, 60),
    params: splitParams(sanitize(schema, r.params)).layer,
    curve: sanitizeCurve(r.curve),
  };
}

export function sanitizeGlobals(raw: unknown): GlobalParams {
  return splitParams(sanitize(schema, raw)).globals;
}

// {globals, layers} from untrusted data; ≥1 layer guaranteed, capped at MAX_LAYERS keeping the
// outermost (a stack loses its innermost accents before it loses its shell).
export function sanitizeDesignBody(raw: unknown): Design {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawLayers = Array.isArray(r.layers) ? r.layers.slice(0, MAX_LAYERS) : [];
  const layers = rawLayers.map((l, i) => sanitizeLayer(l, i));
  return {
    globals: sanitizeGlobals(r.globals),
    layers: layers.length > 0 ? layers : [defaultLayer()],
  };
}

// --- resolution ----------------------------------------------------------------------------------

export type ResolvedLayer = {
  layer: Layer;
  params: Params; // globals merged over the layer subset — what the builders eat
  curve: CtrlPt[]; // the silhouette actually used: own, or derived from the outer layer
  z0: number; // assembled bottom (= lift); the PART is still built base-on-bed
  z1: number;
};

// Dense enough that Catmull-Rom through the samples reproduces the offset to well under 0.1 mm,
// comfortably inside MAX_CURVE_PTS so a materialised nest survives the curve sanitizer.
const NEST_SAMPLES = 48;

// The derived silhouette follows the reference's CURVE (× girth) minus wall and gap, sampled at
// this layer's own heights in world z. Section, flute and wave modulation deliberately don't
// offset-track — they're per-layer character, and the radial-gap lint accounts for what they do
// to the true clearance. Stored radii divide out this layer's girth so the surface pipeline
// (which multiplies it back) sees exactly the derived millimetres; girth is forced to 1 by the
// UI when nesting, so this is belt-and-braces, not a hidden scale.
function nestCurve(gap: number, flat: Params, ref: ResolvedLayer): CtrlPt[] {
  const g = Math.max(0.05, flat.girth);
  const refWall = effectiveWall(ref.params);
  const refSpan = ref.z1 - ref.z0;
  const pts: CtrlPt[] = [];
  for (let k = 0; k < NEST_SAMPLES; k++) {
    const v = k / (NEST_SAMPLES - 1);
    const worldZ = flat.lift + v * flat.height;
    const refV = refSpan > 1e-9 ? Math.min(1, Math.max(0, (worldZ - ref.z0) / refSpan)) : 0;
    const refR = sampleRadius(ref.curve, refV) * ref.params.girth;
    pts.push({ v, r: clampR((refR - refWall - gap) / g) });
  }
  return pts;
}

export function resolveLayers(d: Design): ResolvedLayer[] {
  const out: ResolvedLayer[] = [];
  for (let i = 0; i < d.layers.length; i++) {
    const layer = d.layers[i];
    const flat = mergeParams(d.globals, layer.params);
    const nested = layer.link === "nest" && i > 0;
    out.push({
      layer,
      params: flat,
      curve: nested ? nestCurve(layer.gap, flat, out[i - 1]) : layer.curve,
      z0: flat.lift,
      z1: flat.lift + flat.height,
    });
  }
  return out;
}

// --- assembly ------------------------------------------------------------------------------------

export type LayerGap = { outer: number; inner: number; minGap: number };

export type Assembly = {
  layers: ResolvedLayer[];
  perLayer: Dims[];
  height: number; // assembled: max over layers of lift + height
  outerDia: number;
  holeCount: number;
  bulbCentreZ: number; // world mm
  bulbGap: number; // min over layers; Infinity when no layer wraps the bulb
  requiredGap: number;
  fitterZ: number; // world mm
  gaps: LayerGap[]; // radial clearance between adjacent layers where their spans overlap
};

// Radial clearance between an adjacent pair over their overlapping z-range: the outer layer's
// worst-case inner face (modulated minimum, minus wall) against the inner layer's worst-case
// outer face (silhouette × girth, shifted by its wave — waves move the whole ring at a height,
// while section/flutes only carve inward and so can't tighten this bound).
function radialGap(o: ResolvedLayer, n: ResolvedLayer): number {
  const lo = Math.max(o.z0, n.z0);
  const hi = Math.min(o.z1, n.z1);
  if (hi - lo < 1e-6) return Number.POSITIVE_INFINITY;
  let m = Number.POSITIVE_INFINITY;
  const S = 64;
  for (let k = 0; k <= S; k++) {
    const z = lo + ((hi - lo) * k) / S;
    const vo = (z - o.z0) / (o.z1 - o.z0);
    const vn = (z - n.z0) / (n.z1 - n.z0);
    const outerInner = minSurfaceRadiusAt(o.params, o.curve, vo) - effectiveWall(o.params);
    const innerOuter =
      sampleRadius(n.curve, vn) * n.params.girth +
      waveOffset(n.params.waveCount, n.params.waveDepth, vn);
    m = Math.min(m, outerInner - innerOuter);
  }
  return m;
}

// Memoised per layer so a drag costs what a single-shade drag always cost: only the edited layer
// recomputes, and — critically — untouched layers keep their RESOLVED CURVE ARRAY IDENTITY, which
// is what the single-slot memos in params.ts key on. Reference-compared like those memos: every
// edit swaps the curve array, so identity is exact.
type AsmSlot = {
  paramsKey: string;
  curveRef: readonly CtrlPt[];
  refCurve: readonly CtrlPt[] | null; // the outer layer's resolved curve a nest derived from
  bulbLocal: number;
  resolved: ResolvedLayer;
  d: Dims;
};

let asmSlots: AsmSlot[] = [];
let asmGapMemo: { a: ResolvedLayer; b: ResolvedLayer; gap: number }[] = [];

export function assembly(d: Design): Assembly {
  const n = d.layers.length;
  const height = Math.max(...d.layers.map((l) => l.params.lift + l.params.height));
  const bulbCentreZ = d.globals.bulbZ * height;

  const resolved: ResolvedLayer[] = [];
  const perLayer: Dims[] = [];
  const slots: AsmSlot[] = [];
  for (let i = 0; i < n; i++) {
    const layer = d.layers[i];
    const paramsKey = JSON.stringify([layer.params, layer.link, layer.gap, d.globals]);
    const refCurve = layer.link === "nest" && i > 0 ? resolved[i - 1].curve : null;
    const bulbLocal = bulbCentreZ - layer.params.lift;
    const prev = asmSlots[i];
    if (
      prev &&
      prev.paramsKey === paramsKey &&
      prev.curveRef === layer.curve &&
      prev.refCurve === refCurve &&
      prev.bulbLocal === bulbLocal &&
      prev.resolved.layer === layer
    ) {
      resolved.push(prev.resolved);
      perLayer.push(prev.d);
      slots.push(prev);
      continue;
    }
    const flat = mergeParams(d.globals, layer.params);
    const nested = layer.link === "nest" && i > 0;
    const r: ResolvedLayer = {
      layer,
      params: flat,
      curve: nested ? nestCurve(layer.gap, flat, resolved[i - 1]) : layer.curve,
      z0: flat.lift,
      z1: flat.lift + flat.height,
    };
    const pd = dims(flat, r.curve, { bulbCentreZ: bulbLocal });
    resolved.push(r);
    perLayer.push(pd);
    slots.push({ paramsKey, curveRef: layer.curve, refCurve, bulbLocal, resolved: r, d: pd });
  }
  asmSlots = slots;

  const gaps: LayerGap[] = [];
  const gapMemo: typeof asmGapMemo = [];
  for (let i = 1; i < n; i++) {
    const a = resolved[i - 1];
    const b = resolved[i];
    const hit = asmGapMemo.find((m) => m.a === a && m.b === b);
    const gap = hit ? hit.gap : radialGap(a, b);
    gapMemo.push({ a, b, gap });
    if (Number.isFinite(gap)) gaps.push({ outer: i - 1, inner: i, minGap: gap });
  }
  asmGapMemo = gapMemo;

  return {
    layers: resolved,
    perLayer,
    height,
    outerDia: Math.max(...perLayer.map((pd) => pd.outerDia)),
    holeCount: perLayer.reduce((s, pd) => s + pd.holeCount, 0),
    bulbCentreZ,
    bulbGap: Math.min(...perLayer.map((pd) => pd.bulbGap)),
    requiredGap: perLayer[0].requiredGap,
    fitterZ: d.globals.fitterZ * height,
    gaps,
  };
}

// --- cross-layer lint ----------------------------------------------------------------------------
// Advisory by design: overlap is a feature on a multi-material printer, so nothing here is a hard
// stop — but nobody should discover fused shells or an uncarried diffuser at the printer.

export function layerLint(d: Design, a: Assembly): Warning[] {
  const out: Warning[] = [];
  const n = d.layers.length;
  const name = (i: number) => layerName(i, n);

  for (const g of a.gaps) {
    if (g.minGap < 0) {
      out.push({
        text: `${name(g.outer)} and ${name(g.inner)} overlap radially by ${(-g.minGap).toFixed(1)} mm — fine for an interlocked multi-material print; otherwise raise the gap or slim the inner layer.`,
        bad: false,
      });
    } else if (g.minGap < 0.8) {
      out.push({
        text: `${name(g.outer)} and ${name(g.inner)} nearly touch (${g.minGap.toFixed(2)} mm) — printed nested they may fuse; assembled they may rattle.`,
        bad: false,
      });
    }
  }

  if (n > 1) {
    for (let i = 0; i < n; i++) {
      const l = a.layers[i];
      if (a.fitterZ < l.z0 - 0.01 || a.fitterZ > l.z1 + 0.01) {
        out.push({
          text: `${name(i)} doesn't reach the fitter plane (mount height ${a.fitterZ.toFixed(0)} mm) — it won't be carried; move the mount or adjust the layer's lift/height.`,
          bad: false,
        });
      }
    }
  }
  return out;
}

// --- working-state persistence -------------------------------------------------------------------
// The whole design (all layers + globals) plus which layer is being edited, one versioned key.
// Boot migrates the pre-layer keys so an existing single-shade session comes back exactly as it
// was: its params become layer 0 and the old keys are left in place (harmless, and a downgrade
// still finds them).

export type WorkingState = { design: Design; active: number };

export const WORKING_KEY = "lamp-shade:design:v2";
const V1_PARAMS_KEY = "lamp-shade:params:v1";
const V1_CURVE_KEY = "lamp-shade:curve:v1";

export function sanitizeWorking(raw: unknown): WorkingState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const design = sanitizeDesignBody(r);
  const active =
    typeof r.active === "number" && Number.isFinite(r.active)
      ? Math.min(design.layers.length - 1, Math.max(0, Math.round(r.active)))
      : 0;
  return { design, active };
}

// Storage is injectable (kit StorageLike shape) purely so the save→load round trip is testable in
// Node; the app always passes nothing and gets localStorage.
type Storageish = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} | undefined;

export function loadWorking(storage: Storageish = globalThis.localStorage): WorkingState {
  try {
    const raw = storage?.getItem(WORKING_KEY);
    if (raw) return sanitizeWorking(JSON.parse(raw));
  } catch {
    /* fall through to migration / defaults */
  }
  // Pre-layer storage: flat params + curve under their own keys.
  try {
    const rawParams: unknown = JSON.parse(storage?.getItem(V1_PARAMS_KEY) ?? "null");
    const rawCurve: unknown = JSON.parse(storage?.getItem(V1_CURVE_KEY) ?? "null");
    if (rawParams || rawCurve) {
      const flat = sanitize(schema, migrateStored(rawParams) ?? rawParams);
      const layer = defaultLayer();
      layer.params = splitParams(flat).layer;
      layer.curve = sanitizeCurve(rawCurve);
      return { design: { globals: splitParams(flat).globals, layers: [layer] }, active: 0 };
    }
  } catch {
    /* unreadable legacy storage degrades to defaults */
  }
  return { design: defaultDesign(), active: 0 };
}

export function saveWorking(ws: WorkingState, storage: Storageish = globalThis.localStorage): void {
  try {
    // Flat {globals, layers, active} — the exact shape sanitizeWorking parses back.
    storage?.setItem(
      WORKING_KEY,
      JSON.stringify({ globals: ws.design.globals, layers: ws.design.layers, active: ws.active }),
    );
  } catch {
    /* storage unavailable — the session still works, it just won't persist */
  }
}
