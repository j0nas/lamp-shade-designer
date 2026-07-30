// The drag preview's perforation: the same (u, v) placements the cutters use, rasterised into an
// alpha map instead of subtracted as geometry.
//
// During a drag the shade on screen is a DRAFT — a hole-less shell that rebuilds in ~1 ms — and this
// texture is what keeps the perforation visible and live on top of it. Alpha-tested holes cost the
// same whether the pattern has 30 holes or 5000, which is exactly the regime (dense patterns) where
// the real boolean takes seconds. The settled PREVIEW build carries real cut geometry and drops the
// map, so the texture is ephemeral UI, never exported — the kit's "what you export is what you
// settled on" invariant is untouched.
//
// perfUvPolys is the pure half (placements -> polygons in (u, v) space); Node tests pin its metric
// correctness without a canvas. createPerfPreview is the browser half that owns the CanvasTexture.

import { CanvasTexture } from "three";
import type { CtrlPt } from "./curve.ts";
import { perfPlacements } from "./perforation.ts";
import { type Params, perfInputOf } from "./params.ts";
import { perfProfile } from "./shapes.ts";

const TAU = Math.PI * 2;

// One polygon per hole, in (u, v) coordinates. Metric-correct: a profile point (x, y) in mm maps to
// (x / circumference(v), y / height), so a hole that is round in millimetres stays round on the
// shade wherever the silhouette narrows — the same rule the real cutters follow by construction.
// Near the seam, u simply runs past 0 or 1; the canvas draws a wrapped copy rather than folding the
// polygon back.
export function perfUvPolys(p: Params, curve: readonly CtrlPt[]): [number, number][][] {
  const inp = perfInputOf(p, curve);
  const places = perfPlacements(inp);
  if (places.length === 0) return [];

  // One unit profile per call: every shape scales linearly with dia, so per-hole size is a multiply
  // rather than a Shape build. The stretch/rotate order matches the cutter transform exactly —
  // stretch along the shape's own Y (baked into the slot's profile, scaled here for the rest),
  // then rotate.
  const aspect = Math.max(1, p.perfAspect);
  const yScale = p.perfShape === "slot" ? 1 : aspect;
  const unit = perfProfile(p.perfShape, 1, aspect).getPoints(16);
  const rot = (p.perfRot * Math.PI) / 180;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const cv = 1 / Math.max(1, p.height);

  return places.map((pl) => {
    const cu = 1 / (TAU * Math.max(1, inp.radiusAt?.(pl.v) ?? 1));
    return unit.map((pt) => {
      const x = pt.x * pl.dia;
      const y = pt.y * pl.dia * yScale;
      return [pl.u + (cosR * x - sinR * y) * cu, pl.v + (sinR * x + cosR * y) * cv] as [
        number,
        number,
      ];
    });
  });
}

// Which extra wraps a polygon needs so a seam-straddling hole shows on both sides of the texture.
function wrapOffsets(poly: [number, number][]): number[] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const [u] of poly) {
    min = Math.min(min, u);
    max = Math.max(max, u);
  }
  const out = [0];
  if (min < 0) out.push(1);
  if (max > 1) out.push(-1);
  return out;
}

// Fixed resolution, sized for the app's scale: a ~650 mm circumference lands ~3 px/mm horizontally
// and a 200 mm height ~5 px/mm vertically — a 6 mm hole is ~19 px across, plenty for a drag frame.
const W = 2048;
const H = 1024;

export type PerfPreview = {
  texture: CanvasTexture;
  /** Redraw for the given design. Returns false when there is nothing to show (pattern "none"). */
  update: (p: Params, curve: readonly CtrlPt[]) => boolean;
  dispose: () => void;
};

export function createPerfPreview(): PerfPreview {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("perf preview: no 2d canvas context");
  const texture = new CanvasTexture(canvas);

  return {
    texture,
    update(p, curve) {
      // White keeps material, black is discarded by the alpha test (three reads the green channel).
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, W, H);
      const polys = perfUvPolys(p, curve);
      if (polys.length > 0) {
        ctx.fillStyle = "#000";
        ctx.beginPath();
        for (const poly of polys) {
          for (const off of wrapOffsets(poly)) {
            // Canvas y runs down while v runs up; CanvasTexture's default flipY makes v = 0 sample
            // the bottom canvas row, so y = H − v·H lines the two up.
            poly.forEach(([u, v], k) => {
              const x = (u + off) * W;
              const y = H - v * H;
              if (k === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.closePath();
          }
        }
        ctx.fill();
      }
      texture.needsUpdate = true;
      return polys.length > 0;
    },
    dispose() {
      texture.dispose();
    },
  };
}
