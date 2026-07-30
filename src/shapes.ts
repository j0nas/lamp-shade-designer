// 2D THREE.Shape profiles. Model-specific by the kit's convention, so they live in the app.
// Only used for cutter prototypes and the fitter's revolve profile — the shade's own surface is
// generated as a mesh grid, not extruded from a profile.

import { Path, Shape } from "three";
import type { PerfShape } from "./perforation.ts";

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

// --- perforation cutter profiles ------------------------------------------------------------------
// Every profile is `dia` wide at zero rotation, centred so rotation pivots naturally, and wound CCW
// like circle() above. Orientations are the self-supporting ones for a hole in a near-vertical wall
// (the kit's 45° rule): point-up hex/diamond/triangle, the teardrop's 45° arch, the slot's
// semicircular ends. The circle is the one knowing exception — small round holes bridge acceptably.

function poly(pts: [number, number][]): Shape {
  const s = new Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.lineTo(pts[0][0], pts[0][1]);
  return s;
}

// n vertices on a circle of radius `r`, starting from straight up — CCW because angles increase.
function ring(n: number, r: (k: number) => number): [number, number][] {
  const pts: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = Math.PI / 2 + (k * 2 * Math.PI) / n;
    pts.push([r(k) * Math.cos(a), r(k) * Math.sin(a)]);
  }
  return pts;
}

// Point-up regular hexagon, `dia` across the flats; the top edges sit 60° from horizontal.
export function hexagon(dia: number): Shape {
  return poly(ring(6, () => dia / Math.sqrt(3)));
}

// Square stood on a corner — 45° slopes exactly, the printable orientation of a square hole.
export function diamond(dia: number): Shape {
  const r = dia / 2;
  return poly([
    [r, 0],
    [0, r],
    [-r, 0],
    [0, -r],
  ]);
}

// Equilateral, point up, `dia` across the base, centred on its centroid so rotation looks right.
export function triangleUp(dia: number): Shape {
  const R = dia / Math.sqrt(3);
  return poly([
    [0, R],
    [-dia / 2, -R / 2],
    [dia / 2, -R / 2],
  ]);
}

// The classic self-supporting round hole: a 270° arc whose 45° tangents meet at an apex above.
export function teardrop(dia: number): Shape {
  const r = dia / 2;
  const c = r * Math.SQRT1_2; // the arc endpoints at ±45°
  const s = new Shape();
  s.absarc(0, 0, r, (3 * Math.PI) / 4, Math.PI / 4, false); // the long way, through the bottom
  s.lineTo(0, r * Math.SQRT2); // apex where the two tangents cross
  s.lineTo(-c, c);
  return s;
}

// Five-pointed, point up. 0.45 inner ratio is chunkier than a pentagram — thin points would print
// as slivers of wall between hole and hole.
export function star(dia: number): Shape {
  const R = dia / 2;
  return poly(ring(10, (k) => (k % 2 === 0 ? R : R * 0.45)));
}

// The one lookup shade.ts uses to build a cutter prototype. `aspect` is consumed ONLY by the slot
// (a stadium's ends stay semicircular at any length); every other shape is stretched by scaling the
// cutter's local Y in its placement transform instead, so one profile serves all stretches.
export function perfProfile(shape: PerfShape, dia: number, aspect: number): Shape {
  switch (shape) {
    case "circle":
      return circle(dia / 2);
    case "hex":
      return hexagon(dia);
    case "diamond":
      return diamond(dia);
    case "triangle":
      return triangleUp(dia);
    case "slot":
      return slot(dia, dia * Math.max(1, aspect));
    case "teardrop":
      return teardrop(dia);
    case "star":
      return star(dia);
  }
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
