// Every printability/safety warning in one list: the schema-level lint (params.ts), the fitter's
// fit checks and the overhang lint. The composition lives in its own module because params.ts
// cannot host it — fitter.ts imports params.ts at runtime (effectiveWall), so params importing the
// fitter back would be a genuine cycle, not just a type one.

import type { CtrlPt } from "./curve.ts";
import { type Dims, dims, type Params, type Warning, warnings } from "./params.ts";
import { fitterWarnings } from "./fitter.ts";
import { overhangWarnings } from "./overhang.ts";

export function allWarnings(
  p: Params,
  curve: readonly CtrlPt[],
  d: Dims = dims(p, curve),
): Warning[] {
  return [...warnings(p, curve, d), ...fitterWarnings(p, curve), ...overhangWarnings(p, curve)];
}
