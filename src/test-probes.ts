// Shared geometry probes for the Node test suites. Test-only: never imported by app code.

import type { BufferGeometry } from "three";

// Genus from the Euler characteristic. For a closed orientable surface every edge is shared by two
// triangles, so E = 3F/2 and χ = V − F/2; genus = (2 − χ)/2. A tube is genus 1, and every hole
// punched through the wall adds exactly one — which is a much stronger claim than "volume went down".
export function genusOf(g: BufferGeometry): number {
  const V = g.getAttribute("position").count;
  const F = (g.index?.count ?? 0) / 3;
  return (2 - (V - F / 2)) / 2;
}
