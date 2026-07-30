// Rebuild benchmark. Not a test — it asserts nothing; it prints numbers so a performance change can
// be defended with a before/after rather than a feeling.
//
// Run: node bench/bench.ts            (Node strips the types; no build step)
//      node bench/bench.ts --json     (machine-readable, for diffing two revisions)
//
// Lives outside src/ so tsc (include: ["src"]) and the test glob both ignore it.

import { initCSG } from "parametric-kit/csg";
import { defaults } from "parametric-kit/params";
import { familyCurve } from "../src/curve.ts";
import { type Params, perfInputOf, schema } from "../src/params.ts";
import {
  buildShade,
  DRAFT,
  EXPORT,
  lastBuild,
  PREVIEW,
  type Quality,
  qualityFor,
} from "../src/shade.ts";
import { perfPlacements } from "../src/perforation.ts";

// This file runs under plain Node, but the app is a browser bundle and types only "vite/client".
// Declaring the two globals we use beats pulling @types/node in for a benchmark.
declare const process: { env: Record<string, string | undefined>; argv: string[] };

await initCSG();

const curve = familyCurve("empire");
const base = (over: Partial<Params> = {}): Params => ({ ...defaults(schema), ...over });

// The cases a live slider actually hits. "default" is what you see on load; the rest are the axes
// that plausibly blow up the vertex or cutter count.
const CASES: { name: string; p: Params; q: Quality }[] = [
  { name: "default (circle, stagger)", p: base(), q: PREVIEW },
  { name: "solid (no perforation)", p: base({ perfPattern: "none" }), q: PREVIEW },
  { name: "star-24 section", p: base({ sectionKind: "star", sides: 24 }), q: PREVIEW },
  { name: "twist 180deg", p: base({ twistDeg: 180 }), q: PREVIEW },
  { name: "flutes + waves", p: base({ fluteCount: 24, waveCount: 8 }), q: PREVIEW },
  { name: "dense perf (48x96)", p: base({ perfRows: 48, perfCols: 96 }), q: PREVIEW },
  {
    name: "worst case",
    p: base({ sectionKind: "star", sides: 24, twistDeg: 180, perfRows: 48, perfCols: 96 }),
    q: PREVIEW,
  },
  { name: "EXPORT quality", p: base(), q: EXPORT },
  // What a drag actually costs now: the same params at DRAFT, which is what the app builds while a
  // control is held down.
  { name: "DRAFT default", p: base(), q: DRAFT },
  { name: "DRAFT star-24", p: base({ sectionKind: "star", sides: 24 }), q: DRAFT },
  { name: "DRAFT dense perf", p: base({ perfRows: 48, perfCols: 96 }), q: DRAFT },
];

// Deliberately few runs: the heavy cases take seconds each, and the spread between runs turned out
// to be far smaller than the differences we're chasing, so more samples buy nothing but wall clock.
const RUNS = Number(process.env.BENCH_RUNS ?? 7);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 2);
// `only=substring` restricts the suite while iterating on one hot path.
const ONLY = process.env.BENCH_ONLY ?? "";

function stats(ms: number[]): { median: number; min: number; p95: number } {
  const s = [...ms].sort((a, b) => a - b);
  return {
    median: s[Math.floor(s.length / 2)],
    min: s[0],
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
  };
}

function time(fn: () => void): { median: number; min: number; p95: number } {
  for (let i = 0; i < WARMUP; i++) fn();
  const ms: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    fn();
    ms.push(performance.now() - t0);
  }
  return stats(ms);
}

const rows: Record<string, unknown>[] = [];

for (const c of CASES) {
  if (ONLY && !c.name.includes(ONLY)) continue;
  const q = qualityFor(c.p, c.q);
  // The real curve, not a stand-in radius: with even spacing on, a fake radius reports a hole count
  // buildShade() below doesn't actually cut.
  const holes = perfPlacements(perfInputOf(c.p, curve)).length;

  const total = time(() => void buildShade(c.p, curve, c.q));
  // Phase split from the final run — the spread across runs is small enough that one sample is
  // representative, and averaging would need buildShade to accumulate rather than overwrite.
  const ph = { ...lastBuild };

  rows.push({
    case: c.name,
    NU: q.u,
    NV: q.v,
    holes,
    mesh: +ph.mesh.toFixed(1),
    adopt: +ph.adopt.toFixed(1),
    cutters: +ph.cutters.toFixed(1),
    boolean: +ph.boolean.toFixed(1),
    extract: +ph.extract.toFixed(1),
    total_ms: +total.median.toFixed(1),
    p95_ms: +total.p95.toFixed(1),
  });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.table(rows);
  const sum = rows.reduce((a, r) => a + (r.total_ms as number), 0);
  console.log(`\nsum of medians: ${sum.toFixed(1)} ms`);
}
