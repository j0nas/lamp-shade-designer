// The silhouette: the shade's profile as control points, sampled with Catmull-Rom.
//
// Radii are millimetres at a normalised height v (0 = bottom rim, 1 = top rim), so this curve is the
// SINGLE source of truth for the outline. There are deliberately no top/bottom-diameter sliders —
// they would fight the editor. `height` and `girth` in the schema scale the sampled curve instead.
//
// Lives outside the param schema on purpose: renderPanel only renders scalar fields, and a curve is
// a point list. It still has to persist, so it gets its own store slot and sanitizer below.

export type CtrlPt = { v: number; r: number };

export const MIN_R = 4; // mm; below this the wall has nowhere to go
export const MAX_R = 400;

// Named starting points. Concrete millimetre radii — `girth` scales them, so these read as a
// default ~200 mm-tall shade.
export const FAMILIES: Record<string, readonly CtrlPt[]> = {
  cone: [
    { v: 0, r: 104 },
    { v: 1, r: 44 },
  ],
  drum: [
    { v: 0, r: 84 },
    { v: 1, r: 84 },
  ],
  empire: [
    { v: 0, r: 104 },
    { v: 0.25, r: 94 },
    { v: 0.55, r: 74 },
    { v: 0.8, r: 59 },
    { v: 1, r: 56 },
  ],
  bell: [
    { v: 0, r: 112 },
    { v: 0.2, r: 84 },
    { v: 0.5, r: 68 },
    { v: 0.78, r: 61 },
    { v: 1, r: 64 },
  ],
  ogee: [
    { v: 0, r: 96 },
    { v: 0.28, r: 77 },
    { v: 0.55, r: 70 },
    { v: 0.8, r: 77 },
    { v: 1, r: 67 },
  ],
  sphere: [
    { v: 0, r: 56 },
    { v: 0.25, r: 90 },
    { v: 0.5, r: 100 },
    { v: 0.75, r: 90 },
    { v: 1, r: 56 },
  ],
  hourglass: [
    { v: 0, r: 96 },
    { v: 0.3, r: 64 },
    { v: 0.5, r: 56 },
    { v: 0.7, r: 64 },
    { v: 1, r: 96 },
  ],
  pagoda: [
    { v: 0, r: 108 },
    { v: 0.22, r: 96 },
    { v: 0.34, r: 102 },
    { v: 0.56, r: 83 },
    { v: 0.68, r: 90 },
    { v: 0.86, r: 67 },
    { v: 1, r: 72 },
  ],
};

export const FAMILY_NAMES = Object.keys(FAMILIES);
export const DEFAULT_FAMILY = "empire";

export function familyCurve(name: string): CtrlPt[] {
  return (FAMILIES[name] ?? FAMILIES[DEFAULT_FAMILY]).map((p) => ({ ...p }));
}

// Uniform Catmull-Rom through the control points. Spacing is NOT arc-length reparameterised — the
// tangents come from neighbouring radii directly — which is visually fine for a silhouette and is
// the form validated by the geometry spike. Overshoot is real (the spline can dip below a control
// point), so the result is clamped: a negative or tiny radius would self-intersect the wall.
export function sampleRadius(pts: readonly CtrlPt[], v: number): number {
  if (pts.length === 0) return MIN_R;
  if (pts.length === 1) return clampR(pts[0].r);
  const t01 = Math.min(1, Math.max(0, v));
  const n = pts.length;
  let i = 0;
  while (i < n - 2 && t01 > pts[i + 1].v) i++;
  const p1 = pts[i];
  const p2 = pts[i + 1];
  // Phantom neighbours outside the ends are REFLECTED, not duplicated. Duplicating them forces a
  // zero tangent at each rim, which eases a two-point curve into an S instead of the straight taper
  // a "cone" is supposed to be (measured: 89.8 mm where a straight line gives 87.5).
  const p0 = i - 1 >= 0 ? pts[i - 1] : { v: 0, r: 2 * p1.r - p2.r };
  const p3 = i + 2 <= n - 1 ? pts[i + 2] : { v: 1, r: 2 * p2.r - p1.r };
  const span = p2.v - p1.v;
  const t = span > 1e-9 ? Math.min(1, Math.max(0, (t01 - p1.v) / span)) : 0;
  const t2 = t * t;
  const t3 = t2 * t;
  const r =
    0.5 *
    (2 * p1.r +
      (-p0.r + p2.r) * t +
      (2 * p0.r - 5 * p1.r + 4 * p2.r - p3.r) * t2 +
      (-p0.r + 3 * p1.r - 3 * p2.r + p3.r) * t3);
  return clampR(r);
}

export function clampR(r: number): number {
  return Number.isFinite(r) ? Math.min(MAX_R, Math.max(MIN_R, r)) : MIN_R;
}

// Largest sampled radius — drives footprint, bed fit and camera framing. Sampled rather than taken
// from the control points because Catmull-Rom can bulge past all of them.
export function maxRadius(pts: readonly CtrlPt[], samples = 256): number {
  let m = 0;
  for (let k = 0; k <= samples; k++) m = Math.max(m, sampleRadius(pts, k / samples));
  return m;
}

export function minRadius(pts: readonly CtrlPt[], samples = 256): number {
  let m = Number.POSITIVE_INFINITY;
  for (let k = 0; k <= samples; k++) m = Math.min(m, sampleRadius(pts, k / samples));
  return m;
}

// --- editing ops (all pure; the editor swaps the whole array) --------------------------------

export function setPoint(pts: readonly CtrlPt[], i: number, v: number, r: number): CtrlPt[] {
  const out = pts.map((p) => ({ ...p }));
  if (i < 0 || i >= out.length) return out;
  // Endpoints own v = 0 and v = 1; interior points stay strictly between their neighbours so the
  // sampler's segment search can never see a zero or negative span.
  const gap = 0.005;
  const lo = i === 0 ? 0 : out[i - 1].v + gap;
  const hi = i === out.length - 1 ? 1 : out[i + 1].v - gap;
  out[i].v = i === 0 ? 0 : i === out.length - 1 ? 1 : Math.min(hi, Math.max(lo, v));
  out[i].r = clampR(r);
  return out;
}

export function addPointAt(pts: readonly CtrlPt[], v: number): CtrlPt[] {
  const r = sampleRadius(pts, v);
  const out = [...pts.map((p) => ({ ...p })), { v: Math.min(0.995, Math.max(0.005, v)), r }];
  out.sort((a, b) => a.v - b.v);
  return out;
}

export function removePoint(pts: readonly CtrlPt[], i: number): CtrlPt[] {
  if (pts.length <= 2 || i <= 0 || i >= pts.length - 1) return pts.map((p) => ({ ...p })); // keep both rims
  return pts.filter((_, k) => k !== i).map((p) => ({ ...p }));
}

// Moving average on radius, endpoints pinned. Repeated application walks toward a straight taper.
export function smooth(pts: readonly CtrlPt[]): CtrlPt[] {
  if (pts.length < 3) return pts.map((p) => ({ ...p }));
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return { ...p };
    return { v: p.v, r: clampR((pts[i - 1].r + 2 * p.r + pts[i + 1].r) / 4) };
  });
}

// Flip top-for-bottom: a cone becomes a funnel.
export function mirrorV(pts: readonly CtrlPt[]): CtrlPt[] {
  return pts
    .map((p) => ({ v: 1 - p.v, r: p.r }))
    .sort((a, b) => a.v - b.v)
    .map((p, i, all) => ({ v: i === 0 ? 0 : i === all.length - 1 ? 1 : p.v, r: p.r }));
}

// --- persistence ------------------------------------------------------------------------------

// Same defensive contract as the kit's sanitize(): anything malformed falls back to the default
// family rather than throwing, because this parses untrusted localStorage.
export function sanitizeCurve(raw: unknown): CtrlPt[] {
  if (!Array.isArray(raw)) return familyCurve(DEFAULT_FAMILY);
  const pts: CtrlPt[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { v, r } = item as Record<string, unknown>;
    // JSON turns NaN/Infinity into null, so a finite check rejects both.
    if (typeof v !== "number" || typeof r !== "number") continue;
    if (!Number.isFinite(v) || !Number.isFinite(r)) continue;
    pts.push({ v: Math.min(1, Math.max(0, v)), r: clampR(r) });
  }
  pts.sort((a, b) => a.v - b.v);
  // Collapse points that landed on top of each other, then force the rims to exactly 0 and 1.
  const dedup = pts.filter((p, i) => i === 0 || p.v - pts[i - 1].v > 1e-4);
  if (dedup.length < 2) return familyCurve(DEFAULT_FAMILY);
  dedup[0].v = 0;
  dedup[dedup.length - 1].v = 1;
  return dedup;
}

const CURVE_KEY = "lamp-shade:curve:v1";

export function loadCurve(): CtrlPt[] {
  try {
    const raw = globalThis.localStorage?.getItem(CURVE_KEY);
    return raw ? sanitizeCurve(JSON.parse(raw)) : familyCurve(DEFAULT_FAMILY);
  } catch {
    return familyCurve(DEFAULT_FAMILY); // private mode, bad JSON, or no DOM
  }
}

export function saveCurve(pts: readonly CtrlPt[]): void {
  try {
    globalThis.localStorage?.setItem(CURVE_KEY, JSON.stringify(pts));
  } catch {
    /* storage unavailable — the session still works, it just won't persist */
  }
}
