// The cross-section: a radial function r(θ) normalised so its maximum is exactly 1.
//
// This is the axis that multiplies with the silhouette — a "drum" silhouette times a "star" section
// times twist is a shade none of the three describes alone. Normalising to max 1 keeps the meaning of
// the silhouette intact: the curve's radius is always the widest point at that height.
//
// Pure math, no kernel, no DOM — the geometry tests exercise it directly.

export const SECTION_KINDS = ["circle", "polygon", "squircle", "lobed", "star", "scallop"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export const SECTION_LABELS: Record<SectionKind, string> = {
  circle: "Circle",
  polygon: "Polygon",
  squircle: "Squircle",
  lobed: "Lobed",
  star: "Star",
  scallop: "Scalloped",
};

// Kinds whose `sides`/`depth` knobs do nothing — the panel hides those rows.
export function usesSides(kind: SectionKind): boolean {
  return kind !== "circle";
}

const TAU = Math.PI * 2;

// Raw (un-normalised) radial function. Each formula is C¹ except `star`, which is cusped on purpose.
function raw(kind: SectionKind, sides: number, depth: number, theta: number): number {
  const n = Math.max(3, Math.round(sides));
  const d = Math.min(1, Math.max(0, depth));
  switch (kind) {
    case "circle":
      return 1;
    case "polygon": {
      // Regular n-gon by apothem, blended toward a circle as depth → 0.
      const a = TAU / n;
      const phi = ((theta % a) + a) % a;
      const poly = Math.cos(a / 2) / Math.cos(phi - a / 2);
      return 1 + d * (poly - 1);
    }
    case "squircle": {
      // Superellipse: exponent 2 is a circle, higher exponents square off the corners.
      const e = 2 + d * 10;
      const c = Math.abs(Math.cos((n * theta) / 4)) ** e;
      const s = Math.abs(Math.sin((n * theta) / 4)) ** e;
      return (c + s) ** (-1 / e);
    }
    case "lobed":
      return 1 + d * 0.35 * Math.cos(n * theta);
    case "star":
      // Cusped points: |cos| raised below 1 sharpens the valleys into creases.
      return 1 - d + d * Math.abs(Math.cos((n * theta) / 2)) ** 0.4;
    case "scallop":
      // Scoops inward only, so the envelope stays at the silhouette radius.
      return 1 - d * 0.3 * ((1 + Math.cos(n * theta)) / 2);
  }
}

// Normalisation is a sampled max, which is exact enough at 1024 samples and works for every formula
// without per-kind algebra. Cached because the shell generator calls sectionRadius() NU×NV times per
// rebuild and the divisor only depends on the three knobs.
const normCache = new Map<string, number>();

function normFactor(kind: SectionKind, sides: number, depth: number): number {
  const key = `${kind}|${sides}|${depth}`;
  const hit = normCache.get(key);
  if (hit !== undefined) return hit;
  let max = 0;
  const N = 1024;
  for (let k = 0; k < N; k++) max = Math.max(max, raw(kind, sides, depth, (k / N) * TAU));
  const f = max > 1e-9 ? 1 / max : 1;
  normCache.set(key, f);
  return f;
}

// Radial multiplier at angle θ, in (0, 1]. Multiply by the silhouette radius to get world radius.
export function sectionRadius(
  kind: SectionKind,
  sides: number,
  depth: number,
  theta: number,
): number {
  const r = raw(kind, sides, depth, theta) * normFactor(kind, sides, depth);
  // Guard the degenerate tail: a section that collapses to zero would pinch the shell into a
  // non-manifold spike, which fromMesh() would then reject.
  return Math.min(1, Math.max(0.05, r));
}

// Hoisted form for the shell generator, which evaluates the section ~50k times per rebuild: resolves
// the knobs and the normalisation factor once instead of hashing a cache key per vertex.
export function makeSection(
  kind: SectionKind,
  sides: number,
  depth: number,
): (theta: number) => number {
  const f = normFactor(kind, sides, depth);
  if (kind === "circle") return () => 1;
  return (theta) => Math.min(1, Math.max(0.05, raw(kind, sides, depth, theta) * f));
}

// Smallest radial multiplier over a full turn — the shell's thinnest point, needed to check that the
// wall still fits inside the section.
//
// Cached on the same key as normFactor: dims(), warnings() and fitterSpec() all want this number and
// all run several times per rebuild, and the uncached form is 512 sectionRadius() calls — each of
// which built its own template-string cache key. Depends only on the three knobs, so it memoises for
// free.
const minCache = new Map<string, number>();

export function sectionMin(kind: SectionKind, sides: number, depth: number, samples = 512): number {
  const key = `${kind}|${sides}|${depth}|${samples}`;
  const hit = minCache.get(key);
  if (hit !== undefined) return hit;
  // Resolve the knobs once rather than per sample, exactly as makeSection does.
  const section = makeSection(kind, sides, depth);
  let m = Number.POSITIVE_INFINITY;
  for (let k = 0; k < samples; k++) m = Math.min(m, section((k / samples) * TAU));
  minCache.set(key, m);
  return m;
}

// How many samples around the section the mesh needs. A circle is happy with far fewer than a
// 12-point star, whose cusps alias badly at low counts; more sides also needs more samples.
export function suggestedUSegments(kind: SectionKind, sides: number, base: number): number {
  if (kind === "circle") return base;
  const perFeature = kind === "star" || kind === "polygon" ? 14 : 10;
  return Math.max(base, Math.min(512, Math.round(sides * perFeature)));
}
