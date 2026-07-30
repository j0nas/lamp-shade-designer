// Perforation patterns: where light gets out, and the axis that makes the lit preview worth having.
//
// Patterns emit placements in (u, v) PARAMETER space with a relative size, not world coordinates —
// so a pattern knows nothing about the silhouette, section or twist it will be projected onto, and
// every pattern works with every form. shade.ts turns each placement into a cutter oriented along
// the local surface normal.
//
// Pure and deterministic: `scatter` uses a seeded PRNG so the same params always give the same holes
// (a rebuild mid-slider-drag must not reshuffle the pattern).

export const PERF_PATTERNS = [
  "none",
  "grid",
  "stagger",
  "hex",
  "spiral",
  "scatter",
  "slots",
] as const;
export type PerfPattern = (typeof PERF_PATTERNS)[number];

export const PERF_LABELS: Record<PerfPattern, string> = {
  none: "None (solid)",
  grid: "Grid",
  stagger: "Staggered",
  hex: "Hex packed",
  spiral: "Spiral",
  scatter: "Scatter",
  slots: "Vertical slots",
};

export type Placement = {
  u: number; // 0..1 around
  v: number; // 0..1 up
  dia: number; // mm across
  aspect: number; // 1 = round; >1 = taller than wide (slots)
};

// mulberry32 — small, fast, and stable across runs. Seeded from the pattern knobs so changing rows
// or columns reshuffles deliberately, but re-rendering the same design never does.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PerfInput = {
  pattern: PerfPattern;
  rows: number;
  cols: number;
  dia: number;
  margin: number; // mm kept clear at each rim
  gradient: number; // −1 = big at the bottom, +1 = big at the top
  height: number; // mm, to convert the margin into v
  // Constant PITCH instead of constant column count. On a tapering shade a fixed column count
  // crowds the holes wherever it narrows — visibly so on an empire silhouette, where the top rows
  // nearly merge. With this on, `cols` sets the spacing at the widest point and narrower rows get
  // proportionally fewer holes. Needs the silhouette radius, hence radiusAt.
  even?: boolean;
  radiusAt?: (v: number) => number;
};

function maxOver(f: (v: number) => number, v0: number, v1: number, samples = 64): number {
  let m = 0;
  for (let k = 0; k <= samples; k++) m = Math.max(m, f(v0 + ((v1 - v0) * k) / samples));
  return m;
}

// Scale a hole by where it sits, so a gradient reads as light density rather than a size jump.
function graded(dia: number, v: number, gradient: number): number {
  if (gradient === 0) return dia;
  const f = 1 + gradient * (v - 0.5) * 1.6; // ±80% across the full height
  return Math.max(0.4, dia * f);
}

export function perfPlacements(inp: PerfInput): Placement[] {
  const { pattern, dia, gradient } = inp;
  if (pattern === "none" || dia <= 0) return [];

  const rows = Math.max(1, Math.round(inp.rows));
  const cols = Math.max(1, Math.round(inp.cols));
  // Margin is a real millimetre standoff from each rim, converted into the v range holes may occupy.
  const mv = inp.height > 0 ? Math.min(0.45, inp.margin / inp.height) : 0;
  const v0 = mv;
  const v1 = 1 - mv;
  const vSpan = Math.max(0, v1 - v0);
  const at = (i: number, n: number) => (n === 1 ? 0.5 : i / (n - 1));
  const out: Placement[] = [];

  switch (pattern) {
    case "grid":
    case "hex":
    case "stagger": {
      // All three are a row/column lattice; they differ only in row offset.
      const stagger = pattern === "grid" ? 0 : 0.5;
      // With even spacing on, `cols` describes the widest row and every other row is derived from its
      // own circumference, so the pitch stays constant up the shade.
      const widest = inp.even && inp.radiusAt ? maxOver(inp.radiusAt, v0, v1) : 0;
      for (let r = 0; r < rows; r++) {
        const v = v0 + vSpan * at(r, rows);
        let n = cols;
        if (inp.even && inp.radiusAt && widest > 0) {
          n = Math.max(3, Math.round((cols * inp.radiusAt(v)) / widest));
        } else if (pattern === "hex" && r % 2) {
          n = cols - 1;
        }
        const offset = r % 2 ? stagger / n : 0;
        for (let c = 0; c < n; c++) {
          out.push({ u: (c / n + offset) % 1, v, dia: graded(dia, v, gradient), aspect: 1 });
        }
      }
      break;
    }
    case "spiral": {
      // One continuous helix; rows × cols total holes, turning `rows` times bottom to top.
      const total = rows * cols;
      for (let k = 0; k < total; k++) {
        const t = total === 1 ? 0.5 : k / (total - 1);
        const v = v0 + vSpan * t;
        out.push({ u: (t * rows) % 1, v, dia: graded(dia, v, gradient), aspect: 1 });
      }
      break;
    }
    case "scatter": {
      const rand = prng(rows * 73856093 + cols * 19349663 + Math.round(dia * 100));
      const total = rows * cols;
      for (let k = 0; k < total; k++) {
        const v = v0 + vSpan * rand();
        // Size varies ±35% on top of any gradient, which is what makes scatter read as organic.
        const jitter = 0.65 + rand() * 0.7;
        out.push({ u: rand(), v, dia: graded(dia * jitter, v, gradient), aspect: 1 });
      }
      break;
    }
    case "slots": {
      // Tall thin openings: one per column, `rows` stacked bands up the height.
      const aspect = Math.max(2, (vSpan * inp.height) / rows / Math.max(1, dia) / 1.6);
      for (let r = 0; r < rows; r++) {
        const v = v0 + vSpan * at(r, rows);
        for (let c = 0; c < cols; c++) {
          out.push({ u: c / cols, v, dia: graded(dia, v, gradient), aspect });
        }
      }
      break;
    }
  }
  return out;
}

// Circumferential pitch between neighbouring holes at a given world radius — used by the lint to
// catch holes that overlap where the shade narrows.
export function pitchAt(radius: number, cols: number): number {
  return (2 * Math.PI * radius) / Math.max(1, cols);
}
