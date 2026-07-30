// The shade: a parametric shell S(u,v) — silhouette × cross-section × twist × flutes × waves —
// generated as a triangle mesh, adopted by Manifold via fromMesh(), then perforated.
//
// Why a generated mesh and not extrude/revolve: revolve is circular-only and a twisted extrude has a
// constant cross-section, so neither can express the product of these axes. Validated by spike: a
// 128×80 shell plus 360 batched perforations is ~130 ms with no WASM heap growth.
//
// Built in print orientation: bottom rim on z = 0, open top and bottom (topologically a tube, so a
// solid shell has genus 1 before perforation and genus 1 + holes after).

import { BufferAttribute, BufferGeometry } from "three";
import { type Mat, scope, type Solid } from "parametric-kit/csg";
import { type CtrlPt, sampleRadius } from "./curve.ts";
import { makeSection, suggestedUSegments } from "./section.ts";
import { type PerfShape, perfPlacements, type Placement } from "./perforation.ts";
import { effectiveWall, type Params, perfInputOf } from "./params.ts";
import { perfProfile } from "./shapes.ts";

const TAU = Math.PI * 2;

// `cut` is the segment count of a round perforation cutter, and it is the single most expensive
// number in the app: the boolean's cost tracks the cutters' triangle count almost linearly (measured
// on 4608 holes — 16 segments 14.7 s, 8 segments 6.4 s, 5 segments 4.0 s). A 6 mm hole is ~20 px
// across in the viewport, where 8 segments is indistinguishable from 16, so the preview halves it
// and export keeps the full count.
// `uMax` caps what the cross-section is allowed to ask for. A 24-sided star wants 336 segments around
// to keep its cusps from aliasing, which is right for a preview but is most of a draft's budget.
export type Quality = { u: number; v: number; cut: number; uMax: number };

// Preview trades a little smoothness for a responsive slider; export always runs at full resolution
// so the STL is not what you happened to be looking at.
export const PREVIEW: Quality = { u: 96, v: 56, cut: 8, uMax: 512 };
export const EXPORT: Quality = { u: 192, v: 128, cut: 16, uMax: 512 };
// Used while a control is actively being dragged: perforation is skipped entirely (see buildShade),
// so only the form is on screen and a rebuild is ~1 ms of mesh work instead of a boolean.
export const DRAFT: Quality = { u: 72, v: 40, cut: 0, uMax: 144 };

export function qualityFor(p: Params, base: Quality): Quality {
  return {
    u: Math.min(base.uMax, suggestedUSegments(p.sectionKind, p.sides, base.u)),
    v: base.v,
    cut: base.cut,
    uMax: base.uMax,
  };
}

// Segment count for one cutter. The circle/slot ratios reproduce the original 12/10/16 exactly at
// cut = 16, so an exported STL of a round-hole design is triangle-for-triangle what it always was.
// Straight-edged shapes fall through harmlessly: THREE samples line curves at their endpoints
// whatever the division count, so a hexagon cutter is 6 points around regardless.
function cutterSegments(shape: PerfShape, dia: number, cut: number): number {
  if (shape === "slot") return Math.max(5, Math.round(cut * 0.75));
  if (dia < 4) return Math.max(4, Math.round(cut * 0.625));
  return cut;
}

type Vec3 = [number, number, number];

// The one place the axes combine. Everything downstream — mesh, normals, cutter placement — reads
// the surface through this, so a new axis is added here once.
function makeSurface(p: Params, curve: readonly CtrlPt[]) {
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
    if (waves > 0) r += p.waveDepth * 0.5 * Math.sin(waves * TAU * v);
    return Math.max(1.5, r);
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

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(v: Vec3): Vec3 {
  const L = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}

// The shell as an indexed watertight mesh: outer skin, inner skin offset along the surface normal,
// and an annulus at each rim. Vertices are shared around the seam (index modulo NU), which is what
// lets fromMesh() skip Manifold's leaky merge step.
//
// `uv: true` is the DRAFT-ONLY variant: the seam column is stored twice (NU + 1 columns, identical
// positions) so a (u, v) attribute can run 0..1 without the last quad interpolating backwards
// through the whole texture — which is what the drag preview needs to alpha-map holes on. The
// duplicated column makes the seam topologically open, so this variant must never reach fromMesh();
// the draft path bypasses the kernel entirely.
export function shellMesh(
  p: Params,
  curve: readonly CtrlPt[],
  q: Quality,
): { verts: Float32Array; tris: Uint32Array };
export function shellMesh(
  p: Params,
  curve: readonly CtrlPt[],
  q: Quality,
  uv: true,
): { verts: Float32Array; tris: Uint32Array; uvs: Float32Array };
export function shellMesh(
  p: Params,
  curve: readonly CtrlPt[],
  q: Quality,
  uv = false,
): { verts: Float32Array; tris: Uint32Array; uvs?: Float32Array } {
  const NU = Math.max(8, Math.round(q.u));
  const NV = Math.max(3, Math.round(q.v));
  const C = uv ? NU + 1 : NU; // columns stored per ring; the extra one repeats i = 0 at u = 1
  const wall = effectiveWall(p);
  const surface = makeSurface(p, curve);

  const verts = new Float32Array(2 * C * NV * 3);
  const uvs = uv ? new Float32Array(2 * C * NV * 2) : undefined;
  let w = 0;
  let uw = 0;
  // Outer skin.
  for (let j = 0; j < NV; j++) {
    const v = j / (NV - 1);
    for (let i = 0; i < C; i++) {
      const pt = surface.at((i % NU) / NU, v);
      verts[w++] = pt[0];
      verts[w++] = pt[1];
      verts[w++] = pt[2];
      if (uvs) {
        uvs[uw++] = i / NU;
        uvs[uw++] = v;
      }
    }
  }
  // Inner skin: a true normal offset, so wall thickness is constant even where the silhouette slopes.
  // Same (u, v) as the outer skin, so alpha-mapped holes align exactly through the wall.
  for (let j = 0; j < NV; j++) {
    const v = j / (NV - 1);
    for (let i = 0; i < C; i++) {
      const { pos, n } = surface.frame((i % NU) / NU, v);
      verts[w++] = pos[0] - n[0] * wall;
      verts[w++] = pos[1] - n[1] * wall;
      // Clamped so both rims stay flat: on a sloped wall the normal has a Z component that would
      // otherwise push the inner rim above or below the outer one, leaving a knife edge on the bed.
      verts[w++] = Math.min(p.height, Math.max(0, pos[2] - n[2] * wall));
      if (uvs) {
        uvs[uw++] = i / NU;
        uvs[uw++] = v;
      }
    }
  }

  const base = C * NV;
  const o = (i: number, j: number) => j * C + (i % C);
  const n_ = (i: number, j: number) => base + j * C + (i % C);
  // 2 tris per outer quad + 2 per inner quad + 2 per rim quad at each of the two rims.
  const tris = new Uint32Array(((NV - 1) * 2 * 2 + 4) * NU * 3);
  let t = 0;
  const push = (a: number, b: number, c: number) => {
    tris[t++] = a;
    tris[t++] = b;
    tris[t++] = c;
  };
  for (let j = 0; j < NV - 1; j++) {
    for (let i = 0; i < NU; i++) {
      // Outer faces out (CCW seen from outside)...
      push(o(i, j), o(i + 1, j), o(i + 1, j + 1));
      push(o(i, j), o(i + 1, j + 1), o(i, j + 1));
      // ...inner faces in, so the shell is a closed surface with the material between the skins.
      push(n_(i, j), n_(i + 1, j + 1), n_(i + 1, j));
      push(n_(i, j), n_(i, j + 1), n_(i + 1, j + 1));
    }
  }
  const top = NV - 1;
  for (let i = 0; i < NU; i++) {
    push(o(i, 0), n_(i, 0), n_(i + 1, 0)); // bottom annulus, normal −Z
    push(o(i, 0), n_(i + 1, 0), o(i + 1, 0));
    push(o(i, top), o(i + 1, top), n_(i + 1, top)); // top annulus, normal +Z
    push(o(i, top), n_(i + 1, top), n_(i, top));
  }
  return { verts, tris, uvs };
}

// One prototype cutter, transformed per hole — building 300 separate CrossSections would dominate the
// rebuild. Each cutter is oriented so its local +Z is the surface normal and its local +Y runs up the
// surface, which is what makes slot cutters stand vertical rather than at an arbitrary roll.
function cutters(
  p: Params,
  curve: readonly CtrlPt[],
  s: ReturnType<typeof scope>,
  cut: number,
): Solid[] {
  const places = perfPlacements(perfInputOf(p, curve));
  if (places.length === 0) return [];

  const surface = makeSurface(p, curve);
  const wall = effectiveWall(p);
  const L = Math.max(12, wall * 8 + p.fluteDepth * 2 + p.waveDepth * 2); // must clear the wall everywhere
  const out: Solid[] = [];

  // Group by diameter so each distinct cutter size is built once and only transformed after.
  // Quantised to 0.05 mm: a gradient or scatter otherwise yields a unique size per hole and we'd be
  // back to building one CrossSection each. Shape, stretch and rotation are single params — the same
  // for every hole — so they need no place in the key.
  const groups = new Map<number, Placement[]>();
  for (const pl of places) {
    const dia = Math.round(pl.dia * 20) / 20;
    const g = groups.get(dia) ?? [];
    g.push(pl);
    groups.set(dia, g);
  }

  // The slot bakes its stretch into the profile (a stadium's ends stay semicircular at any length);
  // every other shape is stretched by scaling the cutter's local Y in the placement transform, so
  // the prototype is shared across all stretches. Rotation always rides in the transform — applied
  // after the stretch, so a shape elongates along its own axis and then tips.
  const aspect = Math.max(1, p.perfAspect);
  const yScale = p.perfShape === "slot" ? 1 : aspect;
  const rot = (p.perfRot * Math.PI) / 180;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);

  for (const [dia, at] of groups) {
    const proto = s.extrude(
      perfProfile(p.perfShape, dia, aspect),
      L,
      cutterSegments(p.perfShape, dia, cut),
    );
    for (const pl of at) {
      const { pos, n, tu, tv } = surface.frame(pl.u, pl.v);
      // Local X = rotated across-surface, local Y = rotated up-surface × stretch, local Z = normal —
      // the extrusion depth is untouched by the stretch because it lives on Z alone.
      const m: Mat = [
        cosR * tu[0] + sinR * tv[0],
        cosR * tu[1] + sinR * tv[1],
        cosR * tu[2] + sinR * tv[2],
        0,
        yScale * (cosR * tv[0] - sinR * tu[0]),
        yScale * (cosR * tv[1] - sinR * tu[1]),
        yScale * (cosR * tv[2] - sinR * tu[2]),
        0,
        n[0],
        n[1],
        n[2],
        0,
        pos[0] - n[0] * L * 0.5,
        pos[1] - n[1] * L * 0.5,
        pos[2] - n[2] * L * 0.5,
        1,
      ];
      out.push(s.transform(proto, m));
    }
  }
  return out;
}

// Where the last rebuild spent its time. Written on every buildShade() call; read by the readout and
// by bench/bench.ts. A handful of performance.now() calls per build is far below the noise floor of
// the work they measure, and having the split visible is what stopped us optimising the wrong phase
// (the mesh generation is ~1% of a perforated rebuild; the boolean is the other 99%).
export type BuildTimings = {
  mesh: number; // JS surface evaluation -> triangle soup
  adopt: number; // handing that mesh to the kernel
  cutters: number; // building + placing the hole prototypes
  boolean: number; // combining the cutters and subtracting them
  extract: number; // kernel -> BufferGeometry
  total: number;
  holes: number;
};

export const lastBuild: BuildTimings = {
  mesh: 0,
  adopt: 0,
  cutters: 0,
  boolean: 0,
  extract: 0,
  total: 0,
  holes: 0,
};

// Pure Params -> BufferGeometry: the preview mesh and the exported STL come from this one call.
export function buildShade(
  p: Params,
  curve: readonly CtrlPt[],
  quality: Quality = PREVIEW,
): BufferGeometry {
  const t0 = performance.now();
  const q = qualityFor(p, quality);

  // cut = 0 means DRAFT: no perforation, therefore no boolean, therefore nothing the kernel is
  // needed for — shellMesh already produced the exact triangles we want to draw. Adopting them into
  // Manifold would cost ~5x the mesh generation itself (ofMesh validates 2-manifoldness), which at
  // this quality is the entire budget. Preview and export still go through the kernel, so anything
  // that becomes an STL is still validated. The draft carries a uv attribute so the drag preview
  // can alpha-map the perforation onto it (see perf-texture.ts).
  if (q.cut === 0) {
    const { verts, tris, uvs } = shellMesh(p, curve, q, true);
    const t1 = performance.now();
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(verts, 3));
    g.setAttribute("uv", new BufferAttribute(uvs, 2));
    g.setIndex(new BufferAttribute(tris, 1));
    lastBuild.mesh = t1 - t0;
    lastBuild.adopt = 0;
    lastBuild.cutters = 0;
    lastBuild.boolean = 0;
    lastBuild.extract = 0;
    lastBuild.total = performance.now() - t0;
    lastBuild.holes = 0;
    return g;
  }

  const { verts, tris } = shellMesh(p, curve, q);
  const t1 = performance.now();

  const s = scope();
  let shade = s.fromMesh(verts, tris);

  const t2 = performance.now();
  const tools = cutters(p, curve, s, q.cut);

  const t3 = performance.now();
  if (tools.length > 0) {
    // One batched combine then one difference — sequential cuts are far slower for the same result.
    shade = s.sub(shade, s.union(tools));
    // Manifold is LAZY: the ops above only build a DAG, and the whole boolean is actually evaluated
    // by the first call that needs the result. Force it here so the timing split below attributes
    // the cost to the boolean rather than to the extract that would otherwise trigger it. Costs
    // nothing net — finish() would pay it a line later, and the kernel caches the evaluated node.
    shade.numTri();
  }

  const t4 = performance.now();
  const out = s.finish(shade);

  const t5 = performance.now();
  lastBuild.mesh = t1 - t0;
  lastBuild.adopt = t2 - t1;
  lastBuild.cutters = t3 - t2;
  lastBuild.boolean = t4 - t3;
  lastBuild.extract = t5 - t4;
  lastBuild.total = t5 - t0;
  lastBuild.holes = tools.length;
  return out;
}
