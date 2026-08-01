// The silhouette editor: drag the profile directly instead of guessing at sliders.
//
// App-owned chrome by the kit's rule (renderPanel only renders scalar schema fields), drawn on a
// plain 2D canvas. The profile is drawn MIRRORED so it reads as a lamp rather than as a graph, and
// everything is plotted in REAL WORLD MILLIMETRES — girth and lift applied — so the bulb envelope,
// the other layers and the mm grid can share the same axes and every readout is the number that
// prints.
//
// Precision machinery, each piece earned by a real failure of the old editor:
// - The scale FREEZES while a drag is down. It used to adapt live to the curve's peak, so dragging
//   the widest point outward rescaled the plot under the cursor — a positive feedback loop that
//   made outward drags accelerate and overshoot.
// - Shift mid-drag switches to 0.25× relative movement for fine placement; positions quantise to
//   0.1 mm so values are always honest print-scale numbers.
// - Click selects; arrows nudge 1 mm (0.1 mm with Shift); Delete removes; hovering the curve shows
//   a ghost point a single click drops and immediately drags (double-click still works).
// - Gestures report begin/commit so main.ts can keep an undo history of whole edits, not of every
//   pointermove.

import { addPointAt, type CtrlPt, MIN_R, removePoint, sampleRadius, setPoint } from "./curve.ts";
import { OVERHANG_BAD_DEG, type OverhangBand, OVERHANG_WARN_DEG } from "./overhang.ts";

// A non-active layer's resolved outline, for context: [radius mm, world z mm] samples, bottom→top.
export type EditorGhost = { pts: [number, number][]; color: string; label: string };

export type EditorContext = {
  spanMm: number; // vertical extent of the plot — the assembled lamp's height
  girth: number; // active layer: world radius = point r × girth
  liftMm: number; // active layer: world z = lift + v × height
  heightMm: number;
  editable: boolean; // false while the active layer is nested (its curve is derived)
  nestedHint: string | null;
  ghosts: EditorGhost[];
  // The glass and the clearance it needs — drawn so the silhouette is designed AROUND the bulb
  // rather than checked against it afterwards.
  bulb: { rMm: number; lenMm: number; zMm: number; clearMm: number } | null;
  fitterZMm: number;
  // Overhang lint bands (active layer, v-space). Always drawn — this is lint, like the warnings
  // list, not something gated on the 3D view mode.
  bands: OverhangBand[];
};

export type CurveEditorOpts = {
  get: () => CtrlPt[];
  set: (pts: CtrlPt[]) => void;
  onChange: () => void;
  context: () => EditorContext;
  // A gesture (drag, add, remove, nudge burst) is bracketed by beginEdit → … → commit; main.ts
  // snapshots for undo on beginEdit.
  beginEdit?: () => void;
  // Selection changed or the selected point moved — the numeric inspector resyncs on this.
  onSelect?: () => void;
  // Container the editor fills with a legend of the markings CURRENTLY drawn — owned by the
  // editor so the explanation can never drift from the drawing. CSS shows it in expanded mode.
  legend?: HTMLElement;
};

export type CurveSelection = { index: number; rMm: number; zMm: number; interior: boolean };

export type CurveEditor = {
  draw: () => void;
  destroy: () => void;
  selection: () => CurveSelection | null;
  // Exact numeric entry from the inspector, in world mm; ignored when nothing is selected.
  applySelection: (rMm: number, zMm: number) => void;
};

const PAD = 16; // px of breathing room around the plot
const HIT = 12; // px grab radius
const GHOST_HIT = 9; // px distance to the curve that summons the add-ghost
const NUDGE_GAP_MS = 800; // arrow presses closer than this coalesce into one undo step

const quant = (mm: number): number => Math.round(mm * 10) / 10;

export function installCurveEditor(canvas: HTMLCanvasElement, opts: CurveEditorOpts): CurveEditor {
  let dragging = -1;
  let hover = -1;
  let selected = -1;
  let ghost: { v: number; x: number; y: number } | null = null;
  let frozenMax: number | null = null; // r-scale locked for the duration of a drag
  let dragWorld = { r: 0, z: 0 }; // the dragged point's target in world mm
  let lastCursor = { x: 0, y: 0 };
  let dragReadout = false; // show the r/z tag beside the dragged point
  let lastNudgeAt = 0;

  canvas.tabIndex = 0; // arrow keys need focus; pointerdown grants it

  // The horizontal scale adapts to everything on the plot — active curve, ghost layers, bulb — so
  // context never clips, but it is quantised so it doesn't visibly rescale on every pixel, and it
  // freezes entirely while dragging.
  const scaleR = (ctx: EditorContext): number => {
    if (frozenMax !== null) return frozenMax;
    let peak = MIN_R;
    for (const p of opts.get()) peak = Math.max(peak, p.r * ctx.girth);
    for (const g of ctx.ghosts) for (const [r] of g.pts) peak = Math.max(peak, r);
    if (ctx.bulb) peak = Math.max(peak, ctx.bulb.rMm + ctx.bulb.clearMm);
    return Math.max(40, Math.ceil((peak * 1.12) / 20) * 20);
  };

  // ONE px/mm for both axes — the silhouette draws in true proportion whatever shape the canvas
  // is (compact panel or expanded overlay). The scale is whichever axis binds; the slack axis
  // centres its content instead of stretching to fill.
  const geom = (ctx: EditorContext) => {
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 220;
    const max = scaleR(ctx);
    const span = Math.max(1, ctx.spanMm);
    const s = Math.min((h - 2 * PAD) / span, (w / 2 - PAD) / max);
    const bot = (h + span * s) / 2;
    return { w, h, cx: w / 2, top: bot - span * s, bot, max, span, s };
  };

  type Geom = ReturnType<typeof geom>;

  const xOf = (g: Geom, rMm: number) => g.cx + rMm * g.s;
  const yOf = (g: Geom, zMm: number) => g.bot - zMm * g.s;
  const rAt = (g: Geom, x: number) => Math.abs(x - g.cx) / g.s;
  const zAt = (g: Geom, y: number) => (g.bot - y) / g.s;

  const worldOf = (ctx: EditorContext, p: CtrlPt): { r: number; z: number } => ({
    r: p.r * ctx.girth,
    z: ctx.liftMm + p.v * ctx.heightMm,
  });

  const pointerAt = (ev: PointerEvent | MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const nearest = (ctx: EditorContext, g: Geom, x: number, y: number): number => {
    const pts = opts.get();
    let best = -1;
    let bestD = HIT;
    for (let i = 0; i < pts.length; i++) {
      const w = worldOf(ctx, pts[i]);
      const d = Math.hypot(xOf(g, w.r) - x, yOf(g, w.z) - y);
      // The selected point wins ties so a cluster stays workable.
      if (d < bestD || (i === selected && d < HIT)) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  // The nearest spot ON the active curve (for the add-ghost): sampled in world space, screen-dist
  // tested, and suppressed near existing points so it never fights the grab affordance.
  const curveSpot = (
    ctx: EditorContext,
    g: Geom,
    x: number,
    y: number,
  ): { v: number; x: number; y: number } | null => {
    const pts = opts.get();
    const N = 96;
    let best: { v: number; x: number; y: number } | null = null;
    let bestD = GHOST_HIT;
    for (let k = 0; k <= N; k++) {
      const v = k / N;
      const rW = sampleRadius(pts, v) * ctx.girth;
      const zW = ctx.liftMm + v * ctx.heightMm;
      const sx = xOf(g, rW);
      const sy = yOf(g, zW);
      // Both halves are drawn, so both are clickable.
      for (const px of [sx, g.cx - (sx - g.cx)]) {
        const d = Math.hypot(px - x, sy - y);
        if (d < bestD) {
          bestD = d;
          best = { v, x: px, y: sy };
        }
      }
    }
    if (!best) return null;
    for (const p of pts) {
      const w = worldOf(ctx, p);
      if (Math.hypot(xOf(g, w.r) - best.x, yOf(g, w.z) - best.y) < HIT + 4) return null;
    }
    return best;
  };

  const setSelected = (i: number): void => {
    if (i !== selected) {
      selected = i;
      opts.onSelect?.();
    }
  };

  // Grid step: the largest of these that still lands ≥ 26 px apart, so density adapts to both the
  // widget size (compact panel vs expanded overlay) and the design's scale.
  const gridStep = (pxPerMm: number): number => {
    for (const step of [5, 10, 20, 50, 100]) {
      if (step * pxPerMm >= 26) return step;
    }
    return 200;
  };

  // Legend of what draw() just painted — entries appear and disappear WITH their markings (an
  // overhang stripe you can't produce shouldn't be explained). Rebuilt only when the entry list
  // actually changes; draw() runs per pointermove and DOM churn there would cost real frames.
  let legendKey = "";
  const updateLegend = (ctx: EditorContext): void => {
    const el = opts.legend;
    if (!el) return;
    const entries: { swatch: string; color?: string; text: string }[] = [];
    const levels = new Set(ctx.bands.map((b) => b.level));
    if (levels.has("warn")) {
      entries.push({
        swatch: "band-warn",
        text: `${OVERHANG_WARN_DEG}–${OVERHANG_BAD_DEG}° overhang — wants cooling`,
      });
    }
    if (levels.has("bad")) {
      entries.push({
        swatch: "band-bad",
        text: `>${OVERHANG_BAD_DEG}° overhang — sags / needs supports`,
      });
    }
    if (ctx.bulb) {
      entries.push({ swatch: "line-bulb", text: "bulb glass" });
      entries.push({ swatch: "line-clear", text: "bulb keep-out (glass + air gap)" });
    }
    entries.push({ swatch: "line-mount", text: "mount plane (fitter seat)" });
    for (const g of ctx.ghosts) entries.push({ swatch: "line-layer", color: g.color, text: g.label });

    const key = JSON.stringify(entries);
    if (key === legendKey) return;
    legendKey = key;
    el.innerHTML = "";
    for (const e of entries) {
      const item = document.createElement("span");
      item.className = "legend-item";
      const sw = document.createElement("span");
      sw.className = `legend-swatch legend-${e.swatch}`;
      if (e.color) sw.style.borderTopColor = e.color;
      item.append(sw, e.text);
      el.append(item);
    }
  };

  function draw(): void {
    const c2d = canvas.getContext("2d");
    if (!c2d) return;
    const ctx = opts.context();
    const g = geom(ctx);
    // Redo the backing store only when the CSS size or DPR actually changed — resizing the canvas
    // clears it, so doing this unconditionally would fight the draw below.
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const wantW = Math.round(g.w * dpr);
    const wantH = Math.round(g.h * dpr);
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
    }
    c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2d.clearRect(0, 0, g.w, g.h);

    const pts = opts.get();
    const style = getComputedStyle(canvas);
    const accent = style.getPropertyValue("--accent-soft").trim() || "#5c2bb8";
    const dim = style.getPropertyValue("--text-dim").trim() || "#a49db4";

    // --- mm grid ---------------------------------------------------------------------------
    // One step for both axes — the scale is uniform, so the grid is genuinely square.
    const step = gridStep(g.s);
    const gridX0 = g.cx - g.max * g.s;
    const gridX1 = g.cx + g.max * g.s;
    c2d.strokeStyle = "#ffffff0d";
    c2d.lineWidth = 1;
    c2d.beginPath();
    for (let r = step; r <= g.max; r += step) {
      for (const x of [xOf(g, r), g.cx - (xOf(g, r) - g.cx)]) {
        c2d.moveTo(x, g.top);
        c2d.lineTo(x, g.bot);
      }
    }
    for (let z = 0; z <= g.span; z += step) {
      c2d.moveTo(gridX0, yOf(g, z));
      c2d.lineTo(gridX1, yOf(g, z));
    }
    c2d.stroke();

    // Centre line.
    c2d.strokeStyle = "#ffffff1a";
    c2d.setLineDash([3, 4]);
    c2d.beginPath();
    c2d.moveTo(g.cx, g.top);
    c2d.lineTo(g.cx, g.bot);
    c2d.stroke();
    c2d.setLineDash([]);

    // --- other layers, dimmed, in their own colours ----------------------------------------
    for (const ghostLayer of ctx.ghosts) {
      if (ghostLayer.pts.length < 2) continue;
      c2d.strokeStyle = ghostLayer.color;
      c2d.globalAlpha = 0.45;
      c2d.lineWidth = 1;
      for (const sign of [1, -1]) {
        c2d.beginPath();
        ghostLayer.pts.forEach(([r, z], k) => {
          const x = g.cx + sign * (xOf(g, r) - g.cx);
          if (k === 0) c2d.moveTo(x, yOf(g, z));
          else c2d.lineTo(x, yOf(g, z));
        });
        c2d.stroke();
      }
      c2d.globalAlpha = 1;
    }

    // --- active silhouette (same spline the geometry uses) ---------------------------------
    const N = 96;
    const right: [number, number][] = [];
    for (let k = 0; k <= N; k++) {
      const v = k / N;
      right.push([
        xOf(g, sampleRadius(pts, v) * ctx.girth),
        yOf(g, ctx.liftMm + v * ctx.heightMm),
      ]);
    }

    c2d.beginPath();
    c2d.moveTo(right[0][0], right[0][1]);
    for (const [x, y] of right) c2d.lineTo(x, y);
    for (let k = right.length - 1; k >= 0; k--) {
      c2d.lineTo(g.cx - (right[k][0] - g.cx), right[k][1]);
    }
    c2d.closePath();
    c2d.fillStyle = `${accent}2e`;
    c2d.fill();

    // Overhang bands: each flagged v-range fills the region between the two silhouette edges, so
    // the tint is clipped to the lamp's own shape. Band edges snap to the nearest sample, which at
    // N = 96 is under 1% of the height.
    for (const band of ctx.bands) {
      const k0 = Math.max(0, Math.min(N, Math.round(band.v0 * N)));
      const k1 = Math.max(k0, Math.min(N, Math.round(band.v1 * N)));
      c2d.beginPath();
      c2d.moveTo(right[k0][0], right[k0][1]);
      for (let k = k0; k <= k1; k++) c2d.lineTo(right[k][0], right[k][1]);
      for (let k = k1; k >= k0; k--) c2d.lineTo(g.cx - (right[k][0] - g.cx), right[k][1]);
      c2d.closePath();
      c2d.fillStyle = band.level === "bad" ? "rgba(224,90,90,0.28)" : "rgba(224,163,58,0.20)";
      c2d.fill();
    }

    c2d.strokeStyle = accent;
    c2d.lineWidth = 1.5;
    for (const sign of [1, -1]) {
      c2d.beginPath();
      right.forEach(([x, y], k) => {
        const px = g.cx + sign * (x - g.cx);
        if (k === 0) c2d.moveTo(px, y);
        else c2d.lineTo(px, y);
      });
      c2d.stroke();
    }

    // --- bulb envelope + required clearance ------------------------------------------------
    if (ctx.bulb) {
      const capsule = (r: number): void => {
        const b = ctx.bulb!;
        const cap = Math.min(r, b.lenMm / 2); // end-cap radius, clamped for stubby envelopes
        const yTop = yOf(g, b.zMm + b.lenMm / 2 - cap);
        const yBot = yOf(g, b.zMm - b.lenMm / 2 + cap);
        const rx = xOf(g, r) - g.cx;
        const ry = cap * g.s; // uniform scale: end caps are true circles
        c2d.beginPath();
        c2d.ellipse(g.cx, yTop, rx, ry, 0, Math.PI, 0); // top arc, left → right
        c2d.lineTo(g.cx + rx, yBot);
        c2d.ellipse(g.cx, yBot, rx, ry, 0, 0, Math.PI); // bottom arc, right → left
        c2d.closePath();
      };
      c2d.strokeStyle = "#ffd9a066";
      c2d.setLineDash([4, 3]);
      c2d.lineWidth = 1;
      capsule(ctx.bulb.rMm);
      c2d.stroke();
      // The keep-out: glass plus the wattage-driven air gap. Inside this line is a warning.
      c2d.strokeStyle = "rgba(224,163,58,0.4)";
      c2d.setLineDash([2, 4]);
      capsule(ctx.bulb.rMm + ctx.bulb.clearMm);
      c2d.stroke();
      c2d.setLineDash([]);
    }

    // --- fitter plane ----------------------------------------------------------------------
    {
      const y = yOf(g, ctx.fitterZMm);
      c2d.strokeStyle = "#ffffff33";
      c2d.setLineDash([6, 4]);
      c2d.beginPath();
      c2d.moveTo(PAD, y);
      c2d.lineTo(g.w - PAD, y);
      c2d.stroke();
      c2d.setLineDash([]);
      c2d.fillStyle = dim;
      c2d.font = "9px ui-sans-serif, system-ui, sans-serif";
      c2d.textAlign = "left";
      c2d.fillText("mount", PAD + 1, y - 3);
    }

    // --- control points --------------------------------------------------------------------
    if (ctx.editable) {
      for (let i = 0; i < pts.length; i++) {
        const w = worldOf(ctx, pts[i]);
        const x = xOf(g, w.r);
        const y = yOf(g, w.z);
        const isRim = i === 0 || i === pts.length - 1;
        const active = i === dragging || i === hover;
        if (i === selected) {
          c2d.beginPath();
          c2d.arc(x, y, 8, 0, Math.PI * 2);
          c2d.strokeStyle = "#ffffff88";
          c2d.lineWidth = 1;
          c2d.stroke();
        }
        c2d.beginPath();
        if (isRim) {
          c2d.roundRect(x - 3.5, y - 2.5, 7, 5, 2);
        } else {
          c2d.arc(x, y, active ? 5.5 : 4, 0, Math.PI * 2);
        }
        c2d.fillStyle = active || i === selected ? "#ffffff" : accent;
        c2d.fill();
        c2d.lineWidth = 1;
        c2d.strokeStyle = "#00000055";
        c2d.stroke();
      }

      // Ghost add-point.
      if (ghost && dragging < 0) {
        c2d.beginPath();
        c2d.arc(ghost.x, ghost.y, 5, 0, Math.PI * 2);
        c2d.strokeStyle = "#ffffffaa";
        c2d.setLineDash([2, 2]);
        c2d.lineWidth = 1.2;
        c2d.stroke();
        c2d.setLineDash([]);
      }

      // Live numeric tag beside the point being dragged — the value that would otherwise need a
      // steady hand and a guess.
      if (dragging >= 0 && dragReadout) {
        const w = worldOf(ctx, pts[dragging]);
        const x = xOf(g, w.r);
        const y = yOf(g, w.z);
        const label = `r ${w.r.toFixed(1)} · z ${w.z.toFixed(1)}`;
        c2d.font = "10px ui-sans-serif, system-ui, sans-serif";
        const tw = c2d.measureText(label).width;
        const tx = Math.min(g.w - PAD - tw - 8, x + 10);
        const ty = Math.max(g.top + 12, y - 10);
        c2d.fillStyle = "#000000b0";
        c2d.beginPath();
        c2d.roundRect(tx - 4, ty - 10, tw + 8, 14, 4);
        c2d.fill();
        c2d.fillStyle = "#ffffff";
        c2d.textAlign = "left";
        c2d.fillText(label, tx, ty);
      }
    } else if (ctx.nestedHint) {
      c2d.fillStyle = dim;
      c2d.font = "10.5px ui-sans-serif, system-ui, sans-serif";
      c2d.textAlign = "center";
      c2d.fillText(ctx.nestedHint, g.cx, g.top + 4);
    }

    // Widest-diameter readout — in real millimetres, the number that decides bed fit.
    let peak = 0;
    for (let k = 0; k <= N; k++) peak = Math.max(peak, sampleRadius(pts, k / N) * ctx.girth);
    c2d.fillStyle = dim;
    c2d.font = "10px ui-sans-serif, system-ui, sans-serif";
    c2d.textAlign = "right";
    c2d.fillText(`⌀${(peak * 2).toFixed(0)} mm`, g.w - 4, g.h - 4);
    c2d.textAlign = "left";
    c2d.fillText(`grid ${step} mm`, PAD, g.h - 4);

    updateLegend(ctx);
  }

  // Apply the current dragWorld target to the dragged point, quantised to 0.1 mm.
  const applyDrag = (ctx: EditorContext): void => {
    const r = quant(dragWorld.r) / Math.max(0.05, ctx.girth);
    const v = ctx.heightMm > 0 ? (quant(dragWorld.z) - ctx.liftMm) / ctx.heightMm : 0;
    opts.set(setPoint(opts.get(), dragging, Math.min(1, Math.max(0, v)), r));
  };

  const onDown = (ev: PointerEvent): void => {
    const ctx = opts.context();
    if (!ctx.editable) return;
    const g = geom(ctx);
    const { x, y } = pointerAt(ev);
    canvas.focus({ preventScroll: true });
    let i = nearest(ctx, g, x, y);
    if (i < 0) {
      // Click on the curve itself drops a new point there and starts dragging it immediately.
      const spot = curveSpot(ctx, g, x, y);
      if (spot) {
        opts.beginEdit?.();
        opts.set(addPointAt(opts.get(), spot.v));
        i = opts.get().findIndex((p) => Math.abs(p.v - Math.min(0.995, Math.max(0.005, spot.v))) < 1e-9);
        opts.onChange();
      }
    } else {
      opts.beginEdit?.();
    }
    if (i >= 0) {
      dragging = i;
      setSelected(i);
      frozenMax = scaleR(ctx); // freeze the scale: no rescale feedback loop mid-drag
      const w = worldOf(ctx, opts.get()[i]);
      dragWorld = { r: w.r, z: w.z };
      dragReadout = false;
      lastCursor = { x, y };
      canvas.setPointerCapture(ev.pointerId);
      canvas.style.cursor = "grabbing";
    } else {
      setSelected(-1);
    }
    ghost = null;
    draw();
  };

  const onMove = (ev: PointerEvent): void => {
    const ctx = opts.context();
    const g = geom(ctx);
    const { x, y } = pointerAt(ev);

    if (dragging < 0) {
      if (!ctx.editable) return;
      const i = nearest(ctx, g, x, y);
      const spot = i < 0 ? curveSpot(ctx, g, x, y) : null;
      const changed =
        i !== hover || (spot === null) !== (ghost === null) || spot?.v !== ghost?.v;
      hover = i;
      ghost = spot;
      canvas.style.cursor = i >= 0 ? "grab" : spot ? "copy" : "crosshair";
      if (changed) draw();
      return;
    }

    if (ev.shiftKey) {
      // Fine mode: the point follows a quarter of the cursor's movement, relative — precision
      // without a magnifier.
      dragWorld = {
        r: dragWorld.r + ((Math.abs(x - g.cx) - Math.abs(lastCursor.x - g.cx)) / g.s) * 0.25,
        z: dragWorld.z + (zAt(g, y) - zAt(g, lastCursor.y)) * 0.25,
      };
    } else {
      dragWorld = { r: rAt(g, x), z: zAt(g, y) };
    }
    lastCursor = { x, y };
    dragReadout = true;
    applyDrag(ctx);
    opts.onSelect?.();
    draw();
    opts.onChange();
  };

  const onUp = (ev: PointerEvent): void => {
    if (dragging >= 0 && canvas.hasPointerCapture(ev.pointerId)) {
      canvas.releasePointerCapture(ev.pointerId);
    }
    if (dragging >= 0) {
      dragging = -1;
      frozenMax = null;
      dragReadout = false;
      canvas.style.cursor = "grab";
      opts.onSelect?.();
    }
    draw();
  };

  // Double-click keeps its old meanings: on a point removes it, elsewhere adds one on the curve.
  const onDbl = (ev: MouseEvent): void => {
    const ctx = opts.context();
    if (!ctx.editable) return;
    const g = geom(ctx);
    const { x, y } = pointerAt(ev);
    const i = nearest(ctx, g, x, y);
    opts.beginEdit?.();
    if (i > 0 && i < opts.get().length - 1) {
      opts.set(removePoint(opts.get(), i));
      setSelected(-1);
    } else if (i < 0) {
      const v = ctx.heightMm > 0 ? (zAt(g, y) - ctx.liftMm) / ctx.heightMm : 0.5;
      opts.set(addPointAt(opts.get(), Math.min(1, Math.max(0, v))));
    }
    hover = -1;
    ghost = null;
    draw();
    opts.onChange();
  };

  const onKey = (ev: KeyboardEvent): void => {
    const ctx = opts.context();
    if (!ctx.editable || selected < 0 || selected >= opts.get().length) return;

    if (ev.key === "Delete" || ev.key === "Backspace") {
      if (selected > 0 && selected < opts.get().length - 1) {
        ev.preventDefault();
        opts.beginEdit?.();
        opts.set(removePoint(opts.get(), selected));
        setSelected(-1);
        draw();
        opts.onChange();
      }
      return;
    }

    const step = ev.shiftKey ? 0.1 : 1;
    let dr = 0;
    let dz = 0;
    if (ev.key === "ArrowLeft") dr = -step;
    else if (ev.key === "ArrowRight") dr = step;
    else if (ev.key === "ArrowUp") dz = step;
    else if (ev.key === "ArrowDown") dz = -step;
    else return;
    ev.preventDefault();

    // A burst of presses is one edit; a pause starts a new undo step.
    const now = performance.now();
    if (now - lastNudgeAt > NUDGE_GAP_MS) opts.beginEdit?.();
    lastNudgeAt = now;

    const w = worldOf(ctx, opts.get()[selected]);
    const r = quant(w.r + dr) / Math.max(0.05, ctx.girth);
    const v = ctx.heightMm > 0 ? (quant(w.z + dz) - ctx.liftMm) / ctx.heightMm : 0;
    opts.set(setPoint(opts.get(), selected, Math.min(1, Math.max(0, v)), r));
    opts.onSelect?.();
    draw();
    opts.onChange();
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("dblclick", onDbl);
  canvas.addEventListener("keydown", onKey);

  // Redraw when the widget is resized — the expanded overlay and panel collapse both change the
  // canvas's CSS size without a window resize.
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => draw()) : null;
  ro?.observe(canvas);

  return {
    draw,
    selection() {
      const pts = opts.get();
      if (selected < 0 || selected >= pts.length) return null;
      const ctx = opts.context();
      const w = worldOf(ctx, pts[selected]);
      return {
        index: selected,
        rMm: w.r,
        zMm: w.z,
        interior: selected > 0 && selected < pts.length - 1,
      };
    },
    applySelection(rMm, zMm) {
      const pts = opts.get();
      if (selected < 0 || selected >= pts.length) return;
      const ctx = opts.context();
      if (!ctx.editable) return;
      opts.beginEdit?.();
      const r = quant(rMm) / Math.max(0.05, ctx.girth);
      const v = ctx.heightMm > 0 ? (quant(zMm) - ctx.liftMm) / ctx.heightMm : 0;
      opts.set(setPoint(pts, selected, Math.min(1, Math.max(0, v)), r));
      draw();
      opts.onChange();
    },
    destroy() {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("dblclick", onDbl);
      canvas.removeEventListener("keydown", onKey);
      ro?.disconnect();
    },
  };
}
