// 2D THREE.Shape profiles. Model-specific by the kit's convention, so they live in the app.
// Only used for cutter prototypes and the fitter's revolve profile — the shade's own surface is
// generated as a mesh grid, not extruded from a profile.

import { Path, Shape } from "three";

// Resolution is NOT set here: the kit's extrude() takes a curveSegments argument and calls
// getPoints(n) itself, so a `curveSegments` property on the Shape would be ignored anyway.
export function circle(r: number): Shape {
  const s = new Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  return s;
}

// Washer profile. The kit's extrude() reads `.holes` with the EvenOdd fill rule, so the inner ring
// reads as a hole; it is wound the opposite way anyway by convention.
export function annulus(ri: number, ro: number): Shape {
  const s = circle(ro);
  const hole = new Path();
  hole.absarc(0, 0, ri, 0, Math.PI * 2, true);
  s.holes.push(hole);
  return s;
}

// A stadium (rounded-end slot), `len` tall and `w` wide, centred on the origin. Semicircular ends
// keep it self-supporting when it lands on a sloped wall — the kit's 45° rule.
export function slot(w: number, len: number): Shape {
  const r = w / 2;
  const straight = Math.max(0, len - w) / 2;
  const s = new Shape();
  s.absarc(0, straight, r, 0, Math.PI, false);
  s.lineTo(-r, -straight);
  s.absarc(0, -straight, r, Math.PI, Math.PI * 2, false);
  s.lineTo(r, straight);
  return s;
}

// Annular ring profile in the (radius, z) half-plane for revolving: from `ri` to `ro`, `h` tall,
// sitting on z = 0. Revolve-ready profiles are 2D polygons in X (radius) and Y (height).
export function ringProfile(ri: number, ro: number, h: number): Shape {
  const s = new Shape();
  s.moveTo(ri, 0);
  s.lineTo(ro, 0);
  s.lineTo(ro, h);
  s.lineTo(ri, h);
  s.lineTo(ri, 0);
  return s;
}
