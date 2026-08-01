// The parametric surface S(u, v): silhouette × cross-section × twist × flutes × waves.
//
// The one place the axes combine. Everything that needs the shade's shape reads it through here —
// the mesh generator (shade.ts), the cutter placement, the overhang lint, AND the fit/clearance
// maths in params.ts and fitter.ts. It sits BELOW params.ts in the import graph (pure math over
// curve + section, no schema, no kernel), which is what lets the lint and the fitter use the true
// modulated radius: before this module existed they sat above shade.ts and had to approximate the
// wall with silhouette × sectionMin — ignoring flutes (up to 12 mm inward) and waves (±depth/2),
// against a press fit specified to a quarter of a millimetre.

import { type CtrlPt, sampleRadius } from "./curve.ts";
import { makeSection, type SectionKind, sectionMin } from "./section.ts";

const TAU = Math.PI * 2;

// A section/flute combination that pinched to zero would fold the shell into itself; the surface
// never returns a radius below this.
const FLOOR_R = 1.5;

// The schema fields the surface depends on — structural, so params.ts can pass its Params while
// this module stays below it in the import graph.
export type SurfaceParams = {
  height: number;
  girth: number;
  sectionKind: SectionKind;
  sides: number;
  sectionDepth: number;
  twistDeg: number;
  fluteCount: number;
  fluteDepth: number;
  waveCount: number;
  waveDepth: number;
};

// The wave term belongs to the SILHOUETTE (it modulates r by v alone), so the curve editor's band
// view and the 3D surface must agree on it exactly — one formula, used by both.
export function waveOffset(waveCount: number, waveDepth: number, v: number): number {
  const waves = Math.round(waveCount);
  return waves > 0 ? waveDepth * 0.5 * Math.sin(waves * TAU * v) : 0;
}

type Vec3 = [number, number, number];

export function makeSurface(p: SurfaceParams, curve: readonly CtrlPt[]) {
  const section = makeSection(p.sectionKind, p.sides, p.sectionDepth);
  const twist = (p.twistDeg * Math.PI) / 180;
  const flutes = Math.round(p.fluteCount);
  const waves = Math.round(p.waveCount);

  const radius = (u: number, v: number): number => {
    const theta = u * TAU;
    // Flutes and the section both rotate with the twist, so the whole profile shears together
    // instead of the flutes sliding across it.
    const local = theta - twist * v;
    let r = sampleRadius(curve, v) * p.girth * section(local);
    if (flutes > 0) r -= p.fluteDepth * 0.5 * (1 - Math.cos(flutes * local));
    if (waves > 0) r += waveOffset(waves, p.waveDepth, v);
    return Math.max(FLOOR_R, r);
  };

  const at = (u: number, v: number): Vec3 => {
    const theta = u * TAU;
    const r = radius(u, v);
    return [r * Math.cos(theta), r * Math.sin(theta), p.height * v];
  };

  // Central differences on the parametric surface. Cheaper and steadier than averaging face normals,
  // and it gives a usable tangent frame for orienting slot cutters.
  const frame = (u: number, v: number) => {
    const e = 1e-4;
    const a = at((u + e + 1) % 1, v);
    const b = at((u - e + 1) % 1, v);
    const c = at(u, Math.min(1, v + e));
    const d = at(u, Math.max(0, v - e));
    const du: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const dv: Vec3 = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
    const n = norm(cross(du, dv));
    return { pos: at(u, v), n, tu: norm(du), tv: norm(cross(n, norm(du))) };
  };

  return { radius, at, frame };
}

// Smallest surface radius over a full turn at height fraction v — the narrowest line the wall
// traces once section, flutes and waves are all applied. This is the number press fits and
// clearance lint must use; the silhouette alone overstates it by up to fluteDepth + waveDepth/2.
//
// The twist only rotates WHERE the minimum sits, never what it is, so it plays no part here.
export function minSurfaceRadiusAt(p: SurfaceParams, curve: readonly CtrlPt[], v: number): number {
  const base = sampleRadius(curve, v) * p.girth;
  const wave = waveOffset(p.waveCount, p.waveDepth, v);
  const flutes = Math.round(p.fluteCount);
  // No flutes: the section term is the only u-dependence, and its minimum is already memoised.
  // This path must reproduce base × sectionMin EXACTLY — the golden catalog pins fitter volumes
  // built from it.
  if (flutes <= 0) {
    return Math.max(FLOOR_R, base * sectionMin(p.sectionKind, p.sides, p.sectionDepth) + wave);
  }
  // Section trough and flute trough need not coincide, so sample the combined term. Resolution
  // follows the flute count — enough samples per period to land near every trough (worst case
  // 24/period; the residual undershoot is a few hundredths of a millimetre).
  const section = makeSection(p.sectionKind, p.sides, p.sectionDepth);
  const N = Math.min(1024, Math.max(256, flutes * 24));
  let m = Number.POSITIVE_INFINITY;
  for (let k = 0; k < N; k++) {
    const theta = (k / N) * TAU;
    m = Math.min(m, base * section(theta) - p.fluteDepth * 0.5 * (1 - Math.cos(flutes * theta)));
  }
  return Math.max(FLOOR_R, m + wave);
}

// Worst overhang-from-vertical anywhere on the modulated surface: asin(|n_z|) of the frame()
// normals over a coarse grid. |n_z| rather than a signed test because a thin shell fails leaning
// either way — an inward overhang sags exactly like an outward one. Rim rows are excluded: v = 0
// and v = 1 sit on the annuli, whose normals are ±Z by construction and would always read 90°.
//
// Small ring memo in the countHoles() pattern, sized for a layered design: the lint composition
// runs per frame during a drag and asks once PER LAYER, so a single slot would thrash the moment
// a second layer exists. Curves are compared by reference — every edit swaps the whole array, so
// that is exact rather than approximate.
const overhangMemo: { key: string; curve: readonly CtrlPt[]; deg: number }[] = [];
const OVERHANG_MEMO_MAX = 8;

export function maxOverhangDeg(
  p: SurfaceParams,
  curve: readonly CtrlPt[],
  samples = { u: 48, v: 32 },
): number {
  const key = [
    p.height,
    p.girth,
    p.sectionKind,
    p.sides,
    p.sectionDepth,
    p.twistDeg,
    p.fluteCount,
    p.fluteDepth,
    p.waveCount,
    p.waveDepth,
    samples.u,
    samples.v,
  ].join("|");
  const hit = overhangMemo.find((m) => m.key === key && m.curve === curve);
  if (hit) return hit.deg;
  const surface = makeSurface(p, curve);
  let worst = 0;
  for (let j = 1; j < samples.v; j++) {
    for (let i = 0; i < samples.u; i++) {
      worst = Math.max(worst, Math.abs(surface.frame(i / samples.u, j / samples.v).n[2]));
    }
  }
  const deg = (Math.asin(Math.min(1, worst)) * 180) / Math.PI;
  overhangMemo.push({ key, curve, deg });
  if (overhangMemo.length > OVERHANG_MEMO_MAX) overhangMemo.shift();
  return deg;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(v: Vec3): Vec3 {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}
