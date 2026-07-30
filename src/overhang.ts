// Overhang lint: the one physical failure mode nothing else checks. FDM prints a wall by stacking
// perimeters; past ~50° from vertical each layer hangs too far over the last and the surface
// droops, and past ~65° it sags outright or needs supports — which scar a translucent shade.
//
// Three consumers, one set of thresholds: the heatmap view (applyOverhangColors), the curve-editor
// band tints (overhangBands) and the warnings list (overhangWarnings). Severity is direction-
// agnostic on |n_z| throughout, because a thin shell fails leaning inward exactly like outward.

import { BufferAttribute, type BufferGeometry, Color } from "three";
import { type CtrlPt, sampleRadius } from "./curve.ts";
import { maxOverhangDeg } from "./shade.ts";
import type { Params } from "./params.ts";
import { SHADE_COLOR } from "./lit.ts";

const TAU = Math.PI * 2;

export const OVERHANG_WARN_DEG = 50; // printable, but wants cooling and a good profile
export const OVERHANG_BAD_DEG = 65; // sags or needs supports
const RAMP_START_DEG = 35; // below this any printer is happy — the surface reads as plain material

// Overhang-from-vertical of a surface point, from its unit normal's z-component.
export function severityDeg(nz: number): number {
  return (Math.asin(Math.min(1, Math.abs(nz))) * 180) / Math.PI;
}

// Ramp stops go through `new Color(hex)` deliberately: a color ATTRIBUTE is raw floats in the
// linear working space, and these hex values are sRGB. Skipping the conversion washes the whole
// ramp out (sRGB values interpreted as linear read far too bright).
const STOP_NEUTRAL = new Color(SHADE_COLOR);
const STOP_WARN = new Color(0xe0a33a); // --warn amber
const STOP_BAD = new Color(0xe05a5a); // --bad red

function mix(a: Color, b: Color, t: number): [number, number, number] {
  return [a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t];
}

// Piecewise-linear heatmap ramp in linear space: neutral shade colour until printable-by-anyone,
// blending to amber at the warn threshold and red at the bad one.
export function ramp(deg: number): [number, number, number] {
  if (deg <= RAMP_START_DEG) return [STOP_NEUTRAL.r, STOP_NEUTRAL.g, STOP_NEUTRAL.b];
  if (deg <= OVERHANG_WARN_DEG) {
    return mix(STOP_NEUTRAL, STOP_WARN, (deg - RAMP_START_DEG) / (OVERHANG_WARN_DEG - RAMP_START_DEG));
  }
  if (deg <= OVERHANG_BAD_DEG) {
    return mix(STOP_WARN, STOP_BAD, (deg - OVERHANG_WARN_DEG) / (OVERHANG_BAD_DEG - OVERHANG_WARN_DEG));
  }
  return [STOP_BAD.r, STOP_BAD.g, STOP_BAD.b];
}

// Writes the heatmap as a per-vertex color attribute onto a CREASED (non-indexed) geometry, whose
// normal attribute drives severity.
//
// The rim annuli must not read as overhang: an annulus normal is ±Z, so its severity is 90° minus
// the wall's — a false red ring on perfectly safe shades. An epsilon on |n_z| CANNOT identify them
// (the clamped inner rim of a sloped wall is not exactly horizontal), so they are recognised by
// POSITION instead: a triangle whose three vertices all sit within a wall-thickness of a rim is an
// annulus face by construction. The >89.5° test is belt-and-braces for one that escapes the band.
export function applyOverhangColors(
  geometry: BufferGeometry,
  opts: { height: number; wall: number },
): void {
  const pos = geometry.getAttribute("position");
  const nor = geometry.getAttribute("normal");
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const loZ = opts.wall + 0.1;
  const hiZ = opts.height - opts.wall - 0.1;

  for (let t = 0; t < count; t += 3) {
    let rim = true;
    for (let k = 0; k < 3 && rim; k++) {
      const z = pos.getZ(t + k);
      rim = z <= loZ || z >= hiZ;
    }
    for (let k = 0; k < 3; k++) {
      const deg = severityDeg(nor.getZ(t + k));
      const c = rim || deg > 89.5 ? ramp(0) : ramp(deg);
      colors[(t + k) * 3] = c[0];
      colors[(t + k) * 3 + 1] = c[1];
      colors[(t + k) * 3 + 2] = c[2];
    }
  }
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
}

// --- silhouette bands (curve editor) -------------------------------------------------------------

export type OverhangBand = { v0: number; v1: number; level: "warn" | "bad" };
export type SilhouetteOpts = {
  height: number;
  girth: number;
  waveCount: number;
  waveDepth: number;
};

// Silhouette-only severity at a height fraction v, from central differences of the radius the
// surface actually uses: the sampled curve scaled by girth, plus the axisymmetric wave term (waves
// modulate r by v alone, so they belong to the silhouette; flutes and sections modulate by u and
// average out of a band view). For a surface of revolution atan(|dr/dz|) ≡ asin(|n_z|), so this
// agrees with maxOverhangDeg's normal sampling on a circle section — a test pins that identity.
export function silhouetteDeg(
  curve: readonly CtrlPt[],
  opts: SilhouetteOpts,
  v: number,
): number {
  const waves = Math.round(opts.waveCount);
  const r = (vv: number): number => {
    let out = sampleRadius(curve, vv) * opts.girth;
    if (waves > 0) out += opts.waveDepth * 0.5 * Math.sin(waves * TAU * vv);
    return out;
  };
  const e = 1e-3;
  const lo = Math.max(0, v - e);
  const hi = Math.min(1, v + e);
  const drdz = (r(hi) - r(lo)) / ((hi - lo) * opts.height);
  return (Math.atan(Math.abs(drdz)) * 180) / Math.PI;
}

// Contiguous v-ranges where the silhouette out-slopes a threshold, for the curve editor to tint.
// Unlike maxOverhangDeg this INCLUDES the rims — the editor is exactly where rim steepness should
// be visible, and there is no annulus here to lie about it.
export function overhangBands(curve: readonly CtrlPt[], opts: SilhouetteOpts): OverhangBand[] {
  const N = 128;
  const levelOf = (deg: number): OverhangBand["level"] | null =>
    deg >= OVERHANG_BAD_DEG ? "bad" : deg >= OVERHANG_WARN_DEG ? "warn" : null;

  const out: OverhangBand[] = [];
  for (let k = 0; k <= N; k++) {
    const level = levelOf(silhouetteDeg(curve, opts, k / N));
    if (!level) continue;
    const prev = out[out.length - 1];
    if (prev && prev.level === level && k / N - prev.v1 < 1.5 / N) prev.v1 = k / N;
    else out.push({ v0: k / N, v1: k / N, level });
  }
  return out.filter((b) => b.v1 > b.v0); // single-sample spikes are noise, not bands
}

// --- lint ----------------------------------------------------------------------------------------
// Composed into the readout by main.ts, NOT merged into params.warnings(): shade.ts already
// imports params.ts, so routing this through params would close an import cycle.

export function overhangWarnings(
  p: Params,
  curve: readonly CtrlPt[],
): { text: string; bad: boolean }[] {
  const deg = maxOverhangDeg(p, curve);
  if (deg >= OVERHANG_BAD_DEG) {
    return [
      {
        text: `The surface leans ${deg.toFixed(0)}° from vertical — past ${OVERHANG_BAD_DEG}° it will sag or need supports, which scar a translucent shade. Ease the silhouette, reduce girth, or shrink the waves.`,
        bad: true,
      },
    ];
  }
  if (deg >= OVERHANG_WARN_DEG) {
    return [
      {
        text: `The surface leans ${deg.toFixed(0)}° from vertical — printable with good cooling. Check the overhang view for where.`,
        bad: false,
      },
    ];
  }
  return [];
}
