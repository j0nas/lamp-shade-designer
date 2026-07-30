// Param schema + derived dimensions. Everything the geometry needs is either a scalar field here or
// the silhouette curve (see curve.ts — a point list can't be a schema field).
//
// Units: millimetres, degrees, Z-up. The shade is built in print orientation, bottom rim on z = 0.

import { defineParams, num, pick, toggle, type Infer } from "parametric-kit/params";
import { type CtrlPt, maxRadius, minRadius, sampleRadius } from "./curve.ts";
import { SECTION_KINDS, SECTION_LABELS, sectionMin, type SectionKind } from "./section.ts";
import { PERF_LABELS, PERF_PATTERNS, perfPlacements, type PerfPattern } from "./perforation.ts";

export const schema = defineParams({
  // --- form -------------------------------------------------------------------------------
  height: num({ def: 200, min: 40, max: 480, step: 1, group: "form", label: "Height", unit: "mm" }),
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
  const n = perfPlacements({
    pattern: p.perfPattern,
    rows: p.perfRows,
    cols: p.perfCols,
    dia: p.perfDia,
    margin: p.perfMargin,
    gradient: p.perfGradient,
    height: p.height,
    even: p.perfEven,
    radiusAt: (v) => sampleRadius(curve, v) * p.girth,
  }).length;
  holeMemo = { key, curve, n };
  return n;
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
export function dims(p: Params, curve: readonly CtrlPt[]): Dims {
  const maxR = maxRadius(curve) * p.girth;
  const minR = minRadius(curve) * p.girth;
  const secMin = sectionMin(p.sectionKind, p.sides, p.sectionDepth);
  const bulb = BULBS[p.bulbKind];
  const bulbCentreZ = p.bulbZ * p.height;

  // Clearance is checked against the narrowest wall the glass could touch: sample the silhouette
  // over the bulb's vertical span rather than trusting the overall minimum.
  let bulbGap = Number.POSITIVE_INFINITY;
  const z0 = bulbCentreZ - bulb.len / 2;
  const z1 = bulbCentreZ + bulb.len / 2;
  for (let k = 0; k <= 32; k++) {
    const z = z0 + ((z1 - z0) * k) / 32;
    if (z < 0 || z > p.height) continue; // outside the shade: not a clearance concern
    const wallR = sampleRadius(curve, z / p.height) * p.girth * secMin;
    bulbGap = Math.min(bulbGap, wallR - bulb.dia / 2);
  }
  if (!Number.isFinite(bulbGap)) bulbGap = minR * secMin - bulb.dia / 2;

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

// Printability + electrical-safety lint. Deterministic and derived only from params + curve, so the
// same warnings appear in the browser and in a Node test.
// `d` is optional so a caller that already has the dimensions (the readout does) doesn't pay for a
// second full derivation just to lint them.
export function warnings(
  p: Params,
  curve: readonly CtrlPt[],
  d: Dims = dims(p, curve),
): { text: string; bad: boolean }[] {
  const out: { text: string; bad: boolean }[] = [];
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

export type { SectionKind, PerfPattern };
