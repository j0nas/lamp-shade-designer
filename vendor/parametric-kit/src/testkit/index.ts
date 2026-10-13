// Geometry test probes for consuming apps' own suites. The mesh probes (bbox, volume,
// verticesOnDisc) run on real solids built through the Manifold kernel (Node build, no DOM); the
// polygon probes (pointInPolygon, signedArea) serve 2D-panel apps (laser cutting), whose geometry
// is outlines rather than meshes. Both catch what pure-math parameter tests can't: a cut in the
// wrong place, a boss that got clipped, an opening that broke through a margin.

import type { BufferGeometry } from "three";

export type Box = { min: [number, number, number]; max: [number, number, number] };

// Axis-aligned bounding box of the mesh's position attribute.
export function bbox(g: BufferGeometry): Box {
  const pos = g.getAttribute("position");
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.count; i++) {
    const v = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], v[a]);
      max[a] = Math.max(max[a], v[a]);
    }
  }
  return { min, max };
}

// Solid volume (mm³) via the signed-tetrahedron sum — valid on any closed mesh. Works with both
// indexed geometry (Manifold output) and non-indexed geometry (three's ExtrudeGeometry and
// friends), where each consecutive position triplet is a triangle.
//
// NOTE: this returns the ABSOLUTE value, so it cannot distinguish a solid from its inside-out twin
// — an inverted mesh measures as perfectly healthy here. Use signedVolume() when orientation is
// what's under test (e.g. validating a hand-generated surface).
export function volume(g: BufferGeometry): number {
  return Math.abs(signedVolume(g));
}

// Signed volume (mm³): positive when triangles wind CCW seen from outside, negative when the mesh
// is inside-out. Manifold accepts a uniformly inverted mesh with NoError status, so this is the only
// way to catch that in a test.
export function signedVolume(g: BufferGeometry): number {
  const pos = g.getAttribute("position");
  const idx = g.index;
  const triCount = idx ? idx.count : pos.count;
  let v = 0;
  for (let i = 0; i < triCount; i += 3) {
    const a = idx ? idx.getX(i) : i;
    const b = idx ? idx.getX(i + 1) : i + 1;
    const c = idx ? idx.getX(i + 2) : i + 2;
    const ax = pos.getX(a),
      ay = pos.getY(a),
      az = pos.getZ(a);
    const bx = pos.getX(b),
      by = pos.getY(b),
      bz = pos.getZ(b);
    const cx = pos.getX(c),
      cy = pos.getY(c),
      cz = pos.getZ(c);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

// --- 2D polygon probes (panel/outline apps) --------------------------------------------------

export type Pt2 = readonly [number, number];

// Ray-casting point-in-polygon on a closed outline (first point not repeated). Points exactly on
// an edge are unspecified — probe clearly inside or outside a feature, never on its boundary.
export function pointInPolygon(outline: readonly Pt2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i]!;
    const [xj, yj] = outline[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Shoelace area: positive for counter-clockwise winding (y-up), so it doubles as a winding check.
export function signedArea(outline: readonly Pt2[]): number {
  let a = 0;
  for (let i = 0; i < outline.length; i++) {
    const [x1, y1] = outline[i]!;
    const [x2, y2] = outline[(i + 1) % outline.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

// Count mesh vertices inside a horizontal disc — used to prove a pocket floor exists exactly where a
// feature (e.g. a magnet) should bottom out.
export function verticesOnDisc(
  g: BufferGeometry,
  cx: number,
  cy: number,
  z: number,
  r: number,
): number {
  const pos = g.getAttribute("position");
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getZ(i) - z) > 1e-4) continue;
    const dx = pos.getX(i) - cx;
    const dy = pos.getY(i) - cy;
    if (dx * dx + dy * dy <= r * r) n++;
  }
  return n;
}
