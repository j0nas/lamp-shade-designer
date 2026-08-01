// Param schema + derived dimensions. Everything the geometry needs is either a scalar field here or
// the silhouette curve (see curve.ts — a point list can't be a schema field).
//
// Units: millimetres, degrees, Z-up. The shade is built in print orientation, bottom rim on z = 0.

import { defineParams, num, pick, toggle, type Infer } from "parametric-kit/params";
import { type CtrlPt, maxRadius, minRadius, sampleRadius } from "./curve.ts";
import { SECTION_KINDS, SECTION_LABELS, sectionMin, type SectionKind } from "./section.ts";
import { minSurfaceRadiusAt } from "./surface.ts";
import {
  PERF_LABELS,
  PERF_PATTERNS,
  PERF_SHAPE_LABELS,
  PERF_SHAPES,
  type PerfInput,
  perfPlacements,
  type PerfPattern,
  type PerfShape,
} from "./perforation.ts";

export const schema = defineParams({
  // --- form -------------------------------------------------------------------------------
  height: num({ def: 200, min: 40, max: 480, step: 1, group: "form", label: "Height", unit: "mm" }),
  // Where this layer's bottom rim sits in the assembled lamp. Purely an assembly offset: the part
  // itself is still built base-on-bed, so exports are unaffected — but bulb clearance, the fitter
  // plane and the layered preview all see it.
  lift: num({ def: 0, min: 0, max: 400, step: 1, group: "form", label: "Lift", unit: "mm" }),
  girth: num({
    def: 1,
    min: 0.3,
    max: 2.2,
    step: 0.02,
    group: "form",
    label: "Girth",
  }),
  wall: num({
    def: 1.6,
    min: 0.6,
    max: 4,
    step: 0.1,
    group: "form",
    label: "Wall",
    unit: "mm",
  }),

  // --- cross-section ----------------------------------------------------------------------
  sectionKind: pick(SECTION_KINDS, {
    def: "circle",
    group: "section",
    label: "Section",
    optionLabels: SECTION_LABELS,
  }),
  sides: num({ def: 8, min: 3, max: 24, step: 1, group: "section-shape", label: "Sides" }),
  sectionDepth: num({
    def: 0.35,
    min: 0,
    max: 1,
    step: 0.01,
    group: "section-shape",
    label: "Amount",
  }),

  // --- vertical modulation ----------------------------------------------------------------
  twistDeg: num({
    def: 0,
    min: -360,
    max: 360,
    step: 5,
    group: "modulation",
    label: "Twist",
    unit: "°",
  }),
  fluteCount: num({ def: 0, min: 0, max: 40, step: 1, group: "modulation", label: "Flutes" }),
  fluteDepth: num({
    def: 2,
    min: 0,
    max: 12,
    step: 0.2,
    group: "modulation-flute",
    label: "Flute depth",
    unit: "mm",
  }),
  waveCount: num({ def: 0, min: 0, max: 24, step: 1, group: "modulation", label: "Waves" }),
  waveDepth: num({
    def: 3,
    min: 0,
    max: 20,
    step: 0.2,
    group: "modulation-wave",
    label: "Wave depth",
    unit: "mm",
  }),

  // --- perforation ------------------------------------------------------------------------
  perfPattern: pick(PERF_PATTERNS, {
    def: "stagger",
    group: "perforation",
    label: "Pattern",
    optionLabels: PERF_LABELS,
  }),
  perfShape: pick(PERF_SHAPES, {
    def: "circle",
    group: "perforation-shape",
    label: "Hole shape",
    optionLabels: PERF_SHAPE_LABELS,
  }),
  perfAspect: num({
    def: 1,
    min: 1,
    max: 8,
    step: 0.1,
    group: "perforation-shape",
    label: "Stretch",
  }),
  perfRot: num({
    def: 0,
    min: -180,
    max: 180,
    step: 5,
    group: "perforation-rot",
    label: "Rotation",
    unit: "°",
  }),
  perfRows: num({ def: 14, min: 1, max: 48, step: 1, group: "perforation-grid", label: "Rows" }),
  perfCols: num({ def: 24, min: 3, max: 96, step: 1, group: "perforation-grid", label: "Columns" }),
  perfDia: num({
    def: 6,
    min: 0.8,
    max: 40,
    step: 0.2,
    group: "perforation-grid",
    label: "Hole size",
    unit: "mm",
  }),
  perfMargin: num({
    def: 12,
    min: 0,
    max: 80,
    step: 1,
    group: "perforation-grid",
    label: "Rim margin",
    unit: "mm",
  }),
  perfGradient: num({
    def: 0,
    min: -1,
    max: 1,
    step: 0.05,
    group: "perforation-grid",
    label: "Size gradient",
  }),
  perfEven: toggle({ def: true, group: "perforation-grid", label: "Even spacing" }),

  // --- light ------------------------------------------------------------------------------
  bulbKind: pick(["a60", "g95", "st64", "gu10", "led-strip"] as const, {
    def: "a60",
    group: "light",
    label: "Bulb",
    optionLabels: {
      a60: "A60 pear (E27)",
      g95: "G95 globe (E27)",
      st64: "ST64 edison (E27)",
      gu10: "GU10 spot",
      "led-strip": "LED filament",
    },
  }),
  watts: num({ def: 8, min: 1, max: 60, step: 1, group: "light", label: "Power", unit: "W" }),
  bulbZ: num({
    def: 0.45,
    min: 0,
    max: 1,
    step: 0.01,
    group: "light",
    label: "Bulb height",
  }),

  // --- fitter -----------------------------------------------------------------------------
  fitterKind: pick(["ring", "spider", "uno", "clip", "pendant"] as const, {
    def: "ring",
    group: "fitter",
    label: "Mount",
    optionLabels: {
      ring: "E27 shade ring",
      spider: "Spider (harp)",
      uno: "Uno (threaded)",
      clip: "Clip-on (bulb)",
      pendant: "Pendant cord grip",
    },
  }),
  fitterBore: num({
    def: 40.5,
    min: 8,
    max: 80,
    step: 0.5,
    group: "fitter",
    label: "Bore",
    unit: "mm",
  }),
  fitterThickness: num({
    def: 3,
    min: 1.6,
    max: 8,
    step: 0.2,
    group: "fitter",
    label: "Thickness",
    unit: "mm",
  }),
  fitterSpokes: num({ def: 3, min: 2, max: 8, step: 1, group: "fitter", label: "Spokes" }),
  fitterZ: num({
    def: 1,
    min: 0,
    max: 1,
    step: 0.01,
    group: "fitter",
    label: "Mount height",
  }),
  vaseMode: toggle({ def: false, group: "print", label: "Vase mode (single wall)" }),
});

export type Params = Infer<typeof schema>;

// --- layer/global partition ----------------------------------------------------------------------
// One lamp is N printed shells around ONE light and ONE mount, so the schema splits by scope: the
// light and fitter fields describe the assembly, everything else describes a single shell. The
// schema itself stays flat — every consumer (builders, dims, tests) keeps working on a full Params —
// and a layer stores just its subset, merged back over the shared globals when it is built.

export const GLOBAL_KEYS = [
  "bulbKind",
  "watts",
  "bulbZ",
  "fitterKind",
  "fitterBore",
  "fitterThickness",
  "fitterSpokes",
  "fitterZ",
] as const;

export type GlobalKey = (typeof GLOBAL_KEYS)[number];
export type GlobalParams = Pick<Params, GlobalKey>;
export type LayerParams = Omit<Params, GlobalKey>;

const isGlobalKey = (k: string): k is GlobalKey => (GLOBAL_KEYS as readonly string[]).includes(k);

export function splitParams(p: Params): { layer: LayerParams; globals: GlobalParams } {
  const layer: Record<string, unknown> = {};
  const globals: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) (isGlobalKey(k) ? globals : layer)[k] = v;
  return { layer: layer as LayerParams, globals: globals as GlobalParams };
}

export function mergeParams(globals: GlobalParams, layer: LayerParams): Params {
  return { ...layer, ...globals } as Params;
}

// --- bulb envelopes: real glass dimensions, so clearance is guaranteed rather than remembered ----
// Diameter × length in mm, measured from the socket shoulder.
export const BULBS: Record<Params["bulbKind"], { dia: number; len: number; label: string }> = {
  a60: { dia: 60, len: 110, label: "A60" },
  g95: { dia: 95, len: 135, label: "G95" },
  st64: { dia: 64, len: 143, label: "ST64" },
  gu10: { dia: 50, len: 55, label: "GU10" },
  "led-strip": { dia: 32, len: 90, label: "LED filament" },
};

// Minimum air gap from glass to plastic, by power. FDM PLA softens near 60 °C, so a hot bulb needs
// real distance; LED at low power needs little. Linear in watts with a floor.
export function minBulbGap(watts: number): number {
  return Math.max(8, watts * 1.6);
}

// Vase mode prints one continuous single-wall spiral, so the wall is whatever the nozzle lays down
// regardless of the param.
const VASE_WALL = 0.42;

// Split out of dims() because the geometry builders need ONLY this number, and dims() is expensive:
// it samples the curve ~550 times, the section 512 times, and materialises every hole placement just
// to count them. shellMesh(), cutters() and fitterSpec() each used to call dims() for this one field,
// so a single rebuild paid for that three times over before any geometry was built.
export function effectiveWall(p: Params): number {
  return p.vaseMode ? VASE_WALL : p.wall;
}

// The one adapter from params to the pattern generator's input — the cutter builder, the hole
// counter, the drag-preview texture and the bench all marshal through here, so they cannot disagree
// about what a placement means.
//
// radiusAt is the SILHOUETTE radius only (no section/flute modulation): even spacing and the
// preview's metric scaling are about how far apart holes sit around the shade, which the overall
// girth governs, not the local lobe wobble.
export function perfInputOf(p: Params, curve: readonly CtrlPt[]): PerfInput {
  return {
    pattern: p.perfPattern,
    rows: p.perfRows,
    cols: p.perfCols,
    dia: p.perfDia,
    margin: p.perfMargin,
    gradient: p.perfGradient,
    height: p.height,
    even: p.perfEven,
    radiusAt: (v) => sampleRadius(curve, v) * p.girth,
  };
}

// Counted from the real placements, not rows x cols: that product was only ever right for a plain
// grid, and is wrong for hex (short alternate rows), spiral, scatter, and any even-spaced lattice.
//
// Memoised on one slot because dims() runs several times per frame (readout, warnings, the build
// result handler) and building 4608 placement objects to read `.length` was the most expensive thing
// left on the main thread during a drag. The curve is compared by reference — every edit swaps the
// whole array, so that is exact rather than approximate.
let holeMemo: { key: string; curve: readonly CtrlPt[]; n: number } | null = null;

function countHoles(p: Params, curve: readonly CtrlPt[]): number {
  const key = [
    p.perfPattern,
    p.perfRows,
    p.perfCols,
    p.perfDia,
    p.perfMargin,
    p.perfGradient,
    p.height,
    p.perfEven,
    p.girth,
  ].join("|");
  if (holeMemo && holeMemo.key === key && holeMemo.curve === curve) return holeMemo.n;
  const n = perfPlacements(perfInputOf(p, curve)).length;
  holeMemo = { key, curve, n };
  return n;
}

// Glass-to-plastic clearance: the smallest distance from the bulb envelope to the shade's INNER
// face over the bulb's vertical span. The radius is the modulated minimum (section, flutes and
// waves all included — flutes cut real millimetres the silhouette doesn't show), and the wall is
// subtracted because the inner face, not the outer, is what a bulb can touch.
//
// Single-slot memo in the countHoles() pattern: with flutes on, the modulated minimum walks the
// section for each of the 33 z samples — too much to repeat several times per frame during a drag.
let gapMemo: { key: string; curve: readonly CtrlPt[]; gap: number } | null = null;

// `bulbCentreZ` is in the LAYER's own frame (bed = 0). A single shade IS the assembly, so the
// default is today's p.bulbZ × height; a lifted layer in a stack passes the assembly-derived
// position instead. A bulb whose span misses the layer entirely yields +Infinity — no glass near
// this wall means no clearance concern, not "measure the narrowest point anyway".
function bulbGapOf(p: Params, curve: readonly CtrlPt[], bulbCentreZ = p.bulbZ * p.height): number {
  const bulb = BULBS[p.bulbKind];
  const wall = effectiveWall(p);
  const key = [
    p.bulbKind,
    bulbCentreZ,
    p.height,
    p.girth,
    p.sectionKind,
    p.sides,
    p.sectionDepth,
    p.fluteCount,
    p.fluteDepth,
    p.waveCount,
    p.waveDepth,
    wall,
  ].join("|");
  if (gapMemo && gapMemo.key === key && gapMemo.curve === curve) return gapMemo.gap;

  const z0 = bulbCentreZ - bulb.len / 2;
  const z1 = bulbCentreZ + bulb.len / 2;
  let gap = Number.POSITIVE_INFINITY;
  for (let k = 0; k <= 32; k++) {
    const z = z0 + ((z1 - z0) * k) / 32;
    if (z < 0 || z > p.height) continue; // outside the shade: not a clearance concern
    gap = Math.min(gap, minSurfaceRadiusAt(p, curve, z / p.height) - wall - bulb.dia / 2);
  }
  gapMemo = { key, curve, gap };
  return gap;
}

export type Dims = {
  height: number;
  wall: number;
  maxR: number; // widest sampled radius, after girth
  minR: number; // narrowest, after girth
  outerDia: number;
  bedLong: number;
  bedShort: number;
  holeCount: number;
  bulb: { dia: number; len: number; label: string };
  bulbCentreZ: number;
  bulbGap: number; // smallest glass-to-wall clearance
  requiredGap: number;
  fitterZ: number;
  effectiveWall: number; // vase mode prints one extrusion regardless of the wall param
};

// Everything derived lives here so the builders, the readout and the warnings can't disagree.
// `opts.bulbCentreZ` places the bulb in the layer's own frame when the layer is part of a lifted
// stack; the default reproduces the single-shade behaviour exactly.
export function dims(
  p: Params,
  curve: readonly CtrlPt[],
  opts: { bulbCentreZ?: number } = {},
): Dims {
  const maxR = maxRadius(curve) * p.girth;
  const minR = minRadius(curve) * p.girth;
  const bulb = BULBS[p.bulbKind];
  const bulbCentreZ = opts.bulbCentreZ ?? p.bulbZ * p.height;
  const bulbGap = bulbGapOf(p, curve, bulbCentreZ);
  const holeCount = countHoles(p, curve);

  return {
    height: p.height,
    wall: p.wall,
    maxR,
    minR,
    outerDia: maxR * 2,
    bedLong: maxR * 2,
    bedShort: maxR * 2,
    holeCount,
    bulb,
    bulbCentreZ,
    bulbGap,
    requiredGap: minBulbGap(p.watts),
    fitterZ: p.fitterZ * p.height,
    effectiveWall: effectiveWall(p),
  };
}

// One warning shape for every lint source — params, fitter and overhang all emit these.
export type Warning = { text: string; bad: boolean };

// Printability + electrical-safety lint. Deterministic and derived only from params + curve, so the
// same warnings appear in the browser and in a Node test.
// `d` is optional so a caller that already has the dimensions (the readout does) doesn't pay for a
// second full derivation just to lint them.
export function warnings(p: Params, curve: readonly CtrlPt[], d: Dims = dims(p, curve)): Warning[] {
  const out: Warning[] = [];
  const secMin = sectionMin(p.sectionKind, p.sides, p.sectionDepth);

  if (d.bulbGap < d.requiredGap) {
    out.push({
      text: `Bulb clearance ${d.bulbGap.toFixed(1)} mm is under the ${d.requiredGap.toFixed(0)} mm a ${p.watts} W ${d.bulb.label} needs — widen the shade, raise the girth, or drop the wattage.`,
      bad: d.bulbGap < d.requiredGap * 0.5,
    });
  }
  if (d.bulbGap < 0) {
    out.push({ text: "The bulb intersects the shade wall.", bad: true });
  }
  // A wall thicker than the local radius turns the inner surface inside-out; fromMesh() would throw.
  if (!p.vaseMode && p.wall >= d.minR * secMin * 0.8) {
    out.push({
      text: `Wall ${p.wall} mm is too thick for the narrowest radius (${(d.minR * secMin).toFixed(1)} mm).`,
      bad: true,
    });
  }
  if (p.perfPattern !== "none" && p.perfDia >= (2 * Math.PI * d.minR * secMin) / p.perfCols) {
    out.push({
      text: `${p.perfDia} mm holes overlap at ${p.perfCols} columns where the shade narrows — reduce columns or hole size.`,
      bad: false,
    });
  }
  if (p.perfPattern !== "none") {
    // Vertical fit is a heuristic on the nominal size: stretch raises a hole's height, rotation
    // tips it back toward its width. Merged or rim-breaching holes still build a valid solid (the
    // union just fuses them), so both stay advisory — but the readout's hole count goes wrong and a
    // breached rim is usually not what was meant.
    const rad = (p.perfRot * Math.PI) / 180;
    const holeH = p.perfDia * (p.perfAspect * Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad)));
    if (p.perfRows > 1) {
      const mv = p.height > 0 ? Math.min(0.45, p.perfMargin / p.height) : 0;
      const rowPitch = ((1 - 2 * mv) * p.height) / (p.perfRows - 1);
      if (holeH >= rowPitch) {
        out.push({
          text: `${holeH.toFixed(0)} mm tall holes merge vertically at ${p.perfRows} rows — reduce the stretch or the rows.`,
          bad: false,
        });
      }
    }
    if (holeH / 2 > p.perfMargin) {
      out.push({
        text: "Holes are taller than the rim margin — they may cut into the rims.",
        bad: false,
      });
    }
  }
  if (p.fluteCount > 0 && p.fluteDepth >= d.minR * secMin * 0.5) {
    out.push({ text: "Flutes are deep enough to cut through the shade.", bad: true });
  }
  if (p.vaseMode && p.perfPattern !== "none") {
    out.push({
      text: "Vase mode prints one continuous single-wall spiral; perforations break it. Turn one off.",
      bad: false,
    });
  }
  if (d.outerDia > 256) {
    out.push({
      text: `${d.outerDia.toFixed(0)} mm across exceeds the H2C's 256 mm bed — print it in parts or scale down.`,
      bad: d.outerDia > 320,
    });
  }
  return out;
}

// The old "slots" PATTERN became pattern="grid" + shape="slot" when arrangement and profile split
// into orthogonal axes. This rewrites a stored raw blob (BEFORE sanitize, which would silently pin
// the unknown pick value back to the default and lose the design). Returns null when there is
// nothing to migrate. The aspect reproduces the auto height the old pattern computed from the band
// between rows, and perfEven is forced off because the old slots case never applied it.
export function migrateStored(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.perfPattern !== "slots") return null;
  const num = (v: unknown, def: number) => (typeof v === "number" && Number.isFinite(v) ? v : def);
  const rows = Math.max(1, Math.round(num(r.perfRows, 14)));
  const dia = Math.max(1, num(r.perfDia, 6));
  const height = num(r.height, 200);
  const mv = height > 0 ? Math.min(0.45, num(r.perfMargin, 12) / height) : 0;
  const aspect = Math.max(2, ((1 - 2 * mv) * height) / rows / dia / 1.6);
  return {
    ...r,
    perfPattern: "grid",
    perfShape: "slot",
    perfAspect: Math.min(8, Math.round(aspect * 10) / 10),
    perfEven: false,
  };
}

export type { SectionKind, PerfPattern, PerfShape };
