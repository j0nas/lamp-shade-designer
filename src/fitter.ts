// The fitter: the ring that carries the shade on a socket, harp or cord grip.
//
// This is the part that needs true B-rep STEP, and it is the one part simple enough to get it — a
// low-face-count plate of annuli and radial arms, exactly what OCCT is good at and Manifold's mesh
// output is not. So it is built TWICE: here in Manifold (preview + STL, sharing the shade's kernel
// and viewer path) and in fitter-step.ts via replicad (true analytic surfaces for STEP).
//
// The two builders duplicate CONSTRUCTION but never DIMENSIONS: both consume fitterSpec() below, and
// a Node test asserts their volume and bounding box agree. That is what stops them drifting.
//
// Built in print orientation: plate on z = 0, thickness up, no supports needed.

import type { BufferGeometry } from "three";
import { type Mat, scope, type Solid } from "parametric-kit/csg";
import type { CtrlPt } from "./curve.ts";
import { effectiveWall, type Params, type Warning } from "./params.ts";
import { minSurfaceRadiusAt } from "./surface.ts";
import { annulus } from "./shapes.ts";

export type FitterKind = Params["fitterKind"];

export type FitterSpec = {
  kind: FitterKind;
  outerR: number; // press-fits inside the shade at fitterZ
  boreR: number; // central opening (socket collar, harp rod, or cord)
  thickness: number;
  rimWidth: number; // radial width of the outer band
  hubR: number; // outer radius of the central hub
  spokes: number;
  armW: number; // arm width
  collarH: number; // raised collar above the plate (uno / pendant)
  gripR: number; // clip-on grip circle radius
};

const CLEARANCE = 0.25; // press fit into the shade's inner surface
const MIN_BAND = 4; // never leave a band thinner than this between bore and rim

export function fitterSpec(p: Params, curve: readonly CtrlPt[]): FitterSpec {
  const wall = effectiveWall(p);
  // The ring sits inside the shade's opening, so it must clear the MODULATED minimum radius at the
  // mount height — section, flutes and waves all included. The silhouette alone overstates that by
  // up to fluteDepth + waveDepth/2, which against a 0.25 mm press fit is not a rounding error but a
  // part that will not go in.
  const shadeInner = minSurfaceRadiusAt(p, curve, p.fitterZ) - wall;
  const outerR = Math.max(10, shadeInner - CLEARANCE);
  const boreR = Math.max(2, Math.min(p.fitterBore / 2, outerR - MIN_BAND));
  const span = outerR - boreR;
  return {
    kind: p.fitterKind,
    outerR,
    boreR,
    thickness: p.fitterThickness,
    rimWidth: Math.max(3, Math.min(8, span * 0.35)),
    hubR: Math.min(outerR - 1, boreR + Math.max(3, Math.min(6, span * 0.25))),
    spokes: Math.max(2, Math.round(p.fitterSpokes)),
    armW: Math.max(3, Math.min(7, span * 0.3)),
    collarH: Math.max(4, p.fitterThickness * 2),
    gripR: Math.max(3, boreR * 0.62), // ~E27 bulb neck when the bore is a shade ring
  };
}

// Column-major Z rotation, for placing radial arms.
function rotZ(rad: number): Mat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

// A radial arm from r0 to r1 at angle `a`: built centred, moved out along +X, then rotated into place.
function arm(s: ReturnType<typeof scope>, r0: number, r1: number, w: number, t: number, a: number) {
  const len = Math.max(0.01, r1 - r0);
  const box = s.move(s.box(len, w, t), (r0 + r1) / 2, 0, t / 2);
  return s.transform(box, rotZ(a));
}

function spokedPlate(s: ReturnType<typeof scope>, f: FitterSpec, hubInnerR: number): Solid {
  const t = f.thickness;
  const parts: Solid[] = [
    s.extrude(annulus(f.outerR - f.rimWidth, f.outerR), t, 64),
    s.extrude(annulus(hubInnerR, f.hubR), t, 48),
  ];
  for (let k = 0; k < f.spokes; k++) {
    // Overlap both rings slightly so the union is a single solid, not three touching bodies.
    parts.push(
      arm(s, f.hubR - 0.5, f.outerR - f.rimWidth + 0.5, f.armW, t, (k / f.spokes) * Math.PI * 2),
    );
  }
  return s.union(parts);
}

export function buildFitter(p: Params, curve: readonly CtrlPt[]): BufferGeometry {
  const f = fitterSpec(p, curve);
  const s = scope();
  const t = f.thickness;
  let body: Solid;

  switch (f.kind) {
    case "ring":
      // Plain shade ring: a washer that the socket's threaded collar clamps against.
      body = s.extrude(annulus(f.boreR, f.outerR), t, 64);
      break;

    case "spider":
      // Open frame: outer rim, central hub bored for a harp rod, radial spokes between.
      body = spokedPlate(s, f, f.boreR);
      break;

    case "uno":
      // Shade ring plus a raised collar around the bore for the socket thread to engage.
      body = s.add(
        s.extrude(annulus(f.boreR, f.outerR), t, 64),
        s.move(s.extrude(annulus(f.boreR, f.boreR + 2.5), f.collarH, 48), 0, 0, t),
      );
      break;

    case "clip":
      // Sprung arms that grip the bulb glass. The arms are modelled as straight cantilevers reaching
      // in to the grip circle — a real clip needs the arms to flex, which is a material property we
      // cannot express in geometry; print it in PETG and expect to tune gripR by a few tenths.
      body = spokedPlate(s, f, f.gripR);
      break;

    case "pendant": {
      // Cord grip: hub bored for the standard M10x1 lamp thread, collar for the grip nut to bite.
      const m10 = 10.2 / 2;
      const hub = s.add(
        spokedPlate(s, f, m10),
        s.move(s.extrude(annulus(m10, m10 + 3), f.collarH, 32), 0, 0, t),
      );
      body = hub;
      break;
    }
  }

  // A locating chamfer would be nice here; Manifold has no edge fillet, which is exactly the kind of
  // thing the STEP path could add via replicad's fillet() if you want it on the machined version.
  return s.finish(body);
}

// The fitter's own lint. Kept here rather than in params.ts because this module imports params.ts
// at runtime (effectiveWall) — lint.ts composes the full list.
export function fitterWarnings(p: Params, curve: readonly CtrlPt[]): Warning[] {
  const f = fitterSpec(p, curve);
  const out: Warning[] = [];
  if (f.boreR * 2 < p.fitterBore - 0.01) {
    out.push({
      text: `The shade is only ${(f.outerR * 2).toFixed(0)} mm across at the mount height, so the ${p.fitterBore} mm bore was reduced to ${(f.boreR * 2).toFixed(0)} mm. Lower the mount, widen the shade, or use a smaller socket.`,
      bad: f.boreR <= 2.01,
    });
  }
  if (f.outerR - f.boreR < MIN_BAND + 1) {
    out.push({
      text: "Almost no material between bore and rim — the fitter will snap.",
      bad: true,
    });
  }
  if (p.fitterKind === "spider" && f.hubR >= f.outerR - f.rimWidth) {
    out.push({ text: "Hub reaches the rim; the spokes have no length.", bad: true });
  }
  return out;
}
