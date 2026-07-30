// The silhouette editor: drag the profile directly instead of guessing at sliders.
//
// App-owned chrome by the kit's rule (renderPanel only renders scalar schema fields), drawn on a
// plain 2D canvas. The profile is drawn MIRRORED so it reads as a lamp rather than as a graph;
// control points live on the right half and only that half is hit-tested.

import {
  addPointAt,
  type CtrlPt,
  MAX_R,
  MIN_R,
  removePoint,
  sampleRadius,
  setPoint,
} from "./curve.ts";

export type CurveEditorOpts = {
  get: () => CtrlPt[];
  set: (pts: CtrlPt[]) => void;
  onChange: () => void;
};

export type CurveEditor = { draw: () => void; destroy: () => void };

const PAD = 14; // px of breathing room around the plot
const HIT = 11; // px grab radius

export function installCurveEditor(canvas: HTMLCanvasElement, opts: CurveEditorOpts): CurveEditor {
  let dragging = -1;
  let hover = -1;

  // The horizontal scale adapts to the curve so a small shade still fills the widget, but it is
  // quantised so the drawing does not visibly rescale on every pixel of a drag.
  const scaleR = (): number => {
    const peak = Math.max(...opts.get().map((p) => p.r), MIN_R);
    return Math.max(40, Math.ceil((peak * 1.18) / 20) * 20);
  };

  const geom = () => {
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 220;
    return { w, h, cx: w / 2, top: PAD, bot: h - PAD, max: scaleR() };
  };

  const toScreen = (p: CtrlPt) => {
    const g = geom();
    return {
      x: g.cx + (p.r / g.max) * (g.w / 2 - PAD),
      y: g.bot - p.v * (g.bot - g.top), // v = 0 at the bottom, like the printed part
    };
  };

  const fromScreen = (x: number, y: number) => {
    const g = geom();
    return {
      v: Math.min(1, Math.max(0, (g.bot - y) / (g.bot - g.top))),
      r: Math.min(MAX_R, Math.max(MIN_R, (Math.abs(x - g.cx) / (g.w / 2 - PAD)) * g.max)),
    };
  };

  const pointerAt = (ev: PointerEvent | MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const nearest = (x: number, y: number): number => {
    const pts = opts.get();
    let best = -1;
    let bestD = HIT;
    for (let i = 0; i < pts.length; i++) {
      const s = toScreen(pts[i]);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  function draw(): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const g = geom();
    // Redo the backing store only when the CSS size or DPR actually changed — resizing the canvas
    // clears it, so doing this unconditionally would fight the draw below.
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const wantW = Math.round(g.w * dpr);
    const wantH = Math.round(g.h * dpr);
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);

    const pts = opts.get();
    const style = getComputedStyle(canvas);
    const accent = style.getPropertyValue("--accent-soft").trim() || "#5c2bb8";
    const dim = style.getPropertyValue("--text-dim").trim() || "#a49db4";

    // Centre line and rim ticks.
    ctx.strokeStyle = "#ffffff1a";
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(g.cx, g.top);
    ctx.lineTo(g.cx, g.bot);
    ctx.stroke();
    ctx.setLineDash([]);

    // Sample the same spline the geometry uses, so what you drag is what you print.
    const N = 96;
    const right: [number, number][] = [];
    for (let k = 0; k <= N; k++) {
      const v = k / N;
      const s = toScreen({ v, r: sampleRadius(pts, v) });
      right.push([s.x, s.y]);
    }

    // Filled silhouette, both halves.
    ctx.beginPath();
    ctx.moveTo(right[0][0], right[0][1]);
    for (const [x, y] of right) ctx.lineTo(x, y);
    for (let k = right.length - 1; k >= 0; k--) {
      ctx.lineTo(g.cx - (right[k][0] - g.cx), right[k][1]);
    }
    ctx.closePath();
    ctx.fillStyle = `${accent}2e`;
    ctx.fill();

    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(right[0][0], right[0][1]);
    for (const [x, y] of right) ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(g.cx - (right[0][0] - g.cx), right[0][1]);
    for (const [x, y] of right) ctx.lineTo(g.cx - (x - g.cx), y);
    ctx.stroke();

    // Control points; the two rims are drawn as bars because they only move horizontally.
    for (let i = 0; i < pts.length; i++) {
      const s = toScreen(pts[i]);
      const isRim = i === 0 || i === pts.length - 1;
      const active = i === dragging || i === hover;
      ctx.beginPath();
      if (isRim) {
        ctx.roundRect(s.x - 3, s.y - 2.5, 6, 5, 2);
      } else {
        ctx.arc(s.x, s.y, active ? 5.5 : 4, 0, Math.PI * 2);
      }
      ctx.fillStyle = active ? "#ffffff" : accent;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#00000055";
      ctx.stroke();
    }

    // Widest-diameter readout, the number you actually need when checking bed fit.
    const peak = Math.max(...pts.map((p) => p.r));
    ctx.fillStyle = dim;
    ctx.font = "10px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`⌀${(peak * 2).toFixed(0)} mm`, g.w - 3, g.h - 3);
  }

  const onDown = (ev: PointerEvent) => {
    const { x, y } = pointerAt(ev);
    const i = nearest(x, y);
    if (i >= 0) {
      dragging = i;
      canvas.setPointerCapture(ev.pointerId);
      draw();
    }
  };

  const onMove = (ev: PointerEvent) => {
    const { x, y } = pointerAt(ev);
    if (dragging < 0) {
      const i = nearest(x, y);
      if (i !== hover) {
        hover = i;
        canvas.style.cursor = i >= 0 ? "grab" : "crosshair";
        draw();
      }
      return;
    }
    const { v, r } = fromScreen(x, y);
    opts.set(setPoint(opts.get(), dragging, v, r));
    draw();
    opts.onChange();
  };

  const onUp = (ev: PointerEvent) => {
    if (dragging >= 0 && canvas.hasPointerCapture(ev.pointerId)) {
      canvas.releasePointerCapture(ev.pointerId);
    }
    dragging = -1;
    draw();
  };

  // Double-click adds a point on the curve, or removes the one under the cursor.
  const onDbl = (ev: MouseEvent) => {
    const { x, y } = pointerAt(ev);
    const i = nearest(x, y);
    opts.set(i >= 0 ? removePoint(opts.get(), i) : addPointAt(opts.get(), fromScreen(x, y).v));
    hover = -1;
    draw();
    opts.onChange();
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("dblclick", onDbl);

  return {
    draw,
    destroy() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("dblclick", onDbl);
    },
  };
}
