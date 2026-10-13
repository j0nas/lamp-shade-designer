// Named column-major transforms for scope().transform(). Every consumer of the kit was
// hand-deriving the same 90° axis-swap literals ([0,1,0,0,…]) to stand face-plane
// profiles upright or lay extrusions on their side — unreviewable at a glance and easy
// to get subtly wrong. These are the exact quarter-turns Manifold applies rounding-free.
//
// Reading guide: a column-major Mat's first three columns are the world-space images of
// local X̂, Ŷ, Ẑ. Extrusions run along local +Z, so "where does Ẑ go" tells you where the
// extrusion points after the transform.

import type { Mat } from "./index.ts";

/** +90° about X: Ŷ→Ẑ, Ẑ→−Ŷ. An XY profile stands upright; the extrusion runs −Y (into a front face). */
export const ROT_X_90: Mat = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

/** −90° about X: Ŷ→−Ẑ, Ẑ→Ŷ. The extrusion runs +Y (a cylinder lying along the depth axis). */
export const ROT_X_270: Mat = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

/** +90° about Y: X̂→−Ẑ, Ẑ→X̂. The extrusion runs +X (a cylinder lying along the width axis). */
export const ROT_Y_90: Mat = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];

/** −90° about Y: X̂→Ẑ, Ẑ→−X̂. The extrusion runs −X. */
export const ROT_Y_270: Mat = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1];

/** +90° about Z: X̂→Ŷ, Ŷ→−X̂. In-plane quarter turn; the extrusion keeps pointing +Z. */
export const ROT_Z_90: Mat = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** −90° about Z: X̂→−Ŷ, Ŷ→X̂. */
export const ROT_Z_270: Mat = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * Cyclic axis swap X̂→Ŷ, Ŷ→Ẑ, Ẑ→X̂: an XY profile faces the +X direction (local X runs
 * across that face, local Y becomes height) and the extrusion runs +X — the "stand a
 * side-face profile against a wall" transform.
 */
export const AXIS_CYCLE: Mat = [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1];

/** The inverse cycle X̂→Ẑ, Ŷ→X̂, Ẑ→Ŷ. */
export const AXIS_CYCLE_INV: Mat = [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];

/** Rotation about Z by an arbitrary angle in degrees — placing radial copies of a feature. */
export function rotZDeg(deg: number): Mat {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
