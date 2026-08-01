// Every printability/safety warning in one list, assembly-wide: the schema-level lint per layer
// (params.ts), the fitter's fit checks, the overhang lint per layer, and the cross-layer checks
// (radial clearance, fitter reach). The composition lives in its own module because params.ts
// cannot host it — fitter.ts imports params.ts at runtime (effectiveWall), so params importing the
// fitter back would be a genuine cycle, not just a type one.
//
// With more than one layer every per-layer warning is prefixed by the layer's name, so "wall too
// thick" says WHICH wall.

import { type Warning, warnings } from "./params.ts";
import { fitterSpecAssembly, fitterSpecWarnings } from "./fitter.ts";
import { overhangWarnings } from "./overhang.ts";
import { type Assembly, assembly, type Design, layerLint, layerName } from "./layers.ts";

export function allWarnings(design: Design, a: Assembly = assembly(design)): Warning[] {
  const n = design.layers.length;
  const out: Warning[] = [];
  a.layers.forEach((l, i) => {
    const prefix = n > 1 ? `${layerName(i, n)}: ` : "";
    for (const w of [
      ...warnings(l.params, l.curve, a.perLayer[i]),
      ...overhangWarnings(l.params, l.curve),
    ]) {
      out.push(prefix ? { ...w, text: prefix + w.text } : w);
    }
  });
  out.push(...fitterSpecWarnings(fitterSpecAssembly(a), design.globals.fitterBore));
  out.push(...layerLint(design, a));
  return out;
}
