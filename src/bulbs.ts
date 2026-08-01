// Real bulb geometry, not approximations. Each profile is the outer silhouette of an actual
// product, extracted from the manufacturer's to-scale dimension drawing (LEDVANCE publishes them
// as vector SVGs under its freely usable asset path, ledvance.com/00_Free_To_Use/). The profile
// is a [z, r] millimetre polyline, z = 0 at the base tip, z = len at the glass tip — ONE source
// of truth that the 3D preview lathes, the silhouette editor draws as the true section cut, and
// the clearance lint measures against.
//
// Extraction: sample every SVG subpath, take max |x − centre| per height bin (the outer
// envelope), normalise to the datasheet's diameter × overall length, simplify. Extracted
// 2026-08-01; drawn proportions agreed with the datasheet dims to within 0.5% for a60/g95/st64
// (gu10 and the tube share a family drawing and are normalised to their product's numbers).
//
//   a60       LED Classic A 60 Filament 7W 840 Clear E27         GTIN 4058075592315  Ø60 × 105
//   g95       Vintage 1906 Globe 95 55 Filament DIM 824 Gold E27 GTIN 4099854132315  Ø95 × 135
//   st64      Vintage 1906 Edison 60 Filament DIM 824 Gold E27   GTIN 4099854137822  Ø64 × 143
//   gu10      LED Star PAR16 80 36° GU10                         GTIN 4058075112605  Ø50 × 54
//   led-strip Vintage 1906 Tubular 20 Filament 2.5W Gold E27     GTIN 4099854091858  Ø32 × 127

export const BULB_KINDS = ["a60", "g95", "st64", "gu10", "led-strip"] as const;
export type BulbKind = (typeof BULB_KINDS)[number];

export type BulbSpec = {
  label: string;
  dia: number; // widest glass diameter, mm — equals 2 × max profile radius
  len: number; // overall length, mm — base tip to glass tip
  capMm: number; // z below which the profile is the metal/ceramic base rather than glass
  pts: readonly (readonly [number, number])[]; // [z, r] outer silhouette, base → tip
};

export const BULBS: Record<BulbKind, BulbSpec> = {
  a60: {
    label: "A60",
    dia: 60,
    len: 105,
    capMm: 29,
    // prettier-ignore
    pts: [[0, 4.8], [4.6, 7.8], [4.8, 9.8], [7.9, 13.3], [9.5, 12.5], [11.4, 13.4], [11.8, 13.2], [12.2, 13.4], [13.8, 12.5], [15.7, 13.4], [16.5, 13.3], [17.9, 12.5], [19.8, 13.3], [20.6, 13.2], [22.2, 12.5], [23.9, 13.4], [28, 13.4], [28.2, 13.1], [30, 15.3], [32.9, 17.1], [35.8, 17.7], [41.7, 17.9], [45.2, 18.6], [49.9, 20.5], [59.6, 25.8], [64.5, 28], [67.2, 28.9], [70.2, 29.6], [75.8, 30], [81.5, 29.4], [86.4, 27.9], [91, 25.7], [93.2, 24.1], [95.5, 22.2], [98.5, 18.9], [101.4, 14.6], [103.7, 9.3], [105, 3.5]],
  },
  g95: {
    label: "G95",
    dia: 95,
    len: 135,
    capMm: 32,
    // prettier-ignore
    pts: [[0, 5.2], [4.9, 8.3], [5.1, 10.4], [7.8, 13.5], [8.8, 14.4], [10.7, 13.5], [12.3, 14.4], [13.3, 14.6], [15.2, 13.5], [17, 14.4], [17.3, 14.3], [17.8, 14.6], [19.6, 13.5], [22.3, 14.4], [24.4, 13.6], [26.2, 14.4], [30.7, 14.4], [32.6, 16.8], [34.4, 18.4], [37, 19.9], [41.8, 21.6], [45, 23.6], [55.5, 35], [60, 38.9], [65, 42.2], [70, 44.7], [75.3, 46.4], [80.8, 47.3], [86.9, 47.5], [92.2, 47.2], [96.6, 46.6], [101.9, 45.4], [106.7, 43.8], [111.4, 41.6], [114.8, 39.6], [117.7, 37.5], [120.9, 34.8], [123.5, 32.1], [126.2, 28.7], [128.5, 24.9], [130.1, 21.7], [131.7, 17.8], [133, 13.6], [134.3, 7.3], [135, 3.2]],
  },
  st64: {
    label: "ST64",
    dia: 64,
    len: 143,
    capMm: 28,
    // prettier-ignore
    pts: [[0, 5], [4.3, 7.7], [4.6, 9.5], [7.7, 13], [9.6, 12.2], [10.8, 12.8], [11, 13.3], [11.3, 12.8], [11.9, 13.2], [13.6, 12.2], [14.9, 12.8], [15.2, 13.3], [15.5, 12.9], [16.1, 13.1], [17.5, 12.2], [18.9, 12.7], [19.1, 13.2], [19.4, 12.8], [20, 13], [21.9, 12.2], [23.3, 12.9], [24.2, 13], [27.2, 13], [27.5, 12.7], [28.4, 14.5], [29.5, 15.8], [30.6, 16.6], [33.1, 17.3], [94.3, 30], [105.4, 31.7], [111.3, 32], [116.3, 31.5], [121.3, 30.2], [125.5, 28.1], [128.9, 25.5], [132, 22.4], [134.5, 19.1], [136.2, 16.1], [138.9, 9.1], [142, 5], [143, 2.7]],
  },
  gu10: {
    label: "GU10",
    dia: 50,
    len: 54,
    capMm: 48,
    // prettier-ignore
    pts: [[0, 7.3], [3.1, 7.3], [3.2, 6.4], [6, 6.4], [6.1, 7.7], [6.5, 8.3], [8, 9.8], [9, 10.4], [32.3, 12.3], [33.7, 13.2], [38, 17.2], [42.2, 20.1], [47.8, 22.8], [54, 25]],
  },
  "led-strip": {
    label: "LED filament",
    dia: 32,
    len: 127,
    capMm: 28,
    // prettier-ignore
    pts: [[0, 4.9], [4.1, 7.7], [4.3, 9.7], [7.3, 13.4], [8.8, 12.6], [10.3, 13.4], [11.3, 13.5], [12.8, 12.6], [14.3, 13.4], [14.8, 13.3], [15, 13.5], [16.5, 12.6], [18.2, 13.4], [19, 13.4], [20.5, 12.7], [22.2, 13.5], [25.9, 13.5], [26.2, 12.3], [27.7, 13.8], [29.6, 15.2], [32.1, 16], [112.7, 16], [115.5, 15.7], [117.5, 15.1], [119.7, 13.9], [121.7, 12.4], [123.7, 10.3], [124.9, 8.5], [126.1, 5.8], [127, 2.9]],
  },
};

// The bulb hangs cap-first from its socket, so the cap points at the mount: pendant (fitter above
// the bulb) means cap up, table-lamp means cap down. Fractions compare in the same frame.
export const bulbCapUp = (fitterZ: number, bulbZ: number): boolean => fitterZ >= bulbZ;

// Envelope-local z (0 at base tip) → world z, for a bulb whose ENVELOPE CENTRE sits at centreZ.
const worldZ = (spec: BulbSpec, centreZ: number, capUp: boolean, z: number): number =>
  capUp ? centreZ + spec.len / 2 - z : centreZ - spec.len / 2 + z;

// The section cut through the axis: [r, world z] polyline from base to tip, closed onto the axis
// at both ends so mirroring it draws the whole lamp outline.
export function bulbSectionWorld(
  kind: BulbKind,
  centreZ: number,
  capUp: boolean,
): [number, number][] {
  const spec = BULBS[kind];
  const out: [number, number][] = [[0, worldZ(spec, centreZ, capUp, 0)]];
  for (const [z, r] of spec.pts) out.push([r, worldZ(spec, centreZ, capUp, z)]);
  out.push([0, worldZ(spec, centreZ, capUp, spec.len)]);
  return out;
}

// Ramer–Douglas–Peucker, for the keep-out: the E27 thread ripple is real glass-envelope detail,
// but offsetting it by an air gap would just draw a wobbly line that means nothing.
function rdp(pts: readonly (readonly [number, number])[], eps: number): [number, number][] {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1]]);
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1e-12;
  let iMax = 0;
  let dMax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
    if (d > dMax) {
      dMax = d;
      iMax = i;
    }
  }
  if (dMax <= eps) {
    return [
      [ax, ay],
      [bx, by],
    ];
  }
  const left = rdp(pts.slice(0, iMax + 1), eps);
  return left.slice(0, -1).concat(rdp(pts.slice(iMax), eps));
}

// The keep-out: the glass outline dilated by the required air gap — [r, world z], closed onto the
// axis beyond both tips. Offset along averaged outward normals (miter clamped), which is exact on
// the flats and slightly taut across concave corners; for a warning boundary that is the right
// side to err on... it under-reports the forbidden zone by at most the corner rounding.
export function bulbKeepOutWorld(
  kind: BulbKind,
  centreZ: number,
  capUp: boolean,
  clearMm: number,
): [number, number][] {
  const spec = BULBS[kind];
  // Offset the CLOSED outline — profile plus its axis closures — so the two ends are ordinary
  // corners. That matters for the GU10, whose profile ends at its widest point (the face rim):
  // an open-ended offset there would fold inward instead of wrapping the corner.
  const pts: [number, number][] = [[0, 0], ...rdp(spec.pts, 0.8), [spec.len, 0]];
  const n = pts.length;
  // Per-segment outward unit normal in the (z, r) plane: rotate the travel direction 90° CCW
  // (+z right, +r up), which points away from the axis on the flanks, up past the tip, down
  // past the base. Stored [nz, nr].
  const normals: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) {
    const dz = pts[i + 1][0] - pts[i][0];
    const dr = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dz, dr) || 1e-12;
    normals.push([-dr / l, dz / l]);
  }
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = normals[Math.max(0, i - 1)];
    const b = normals[Math.min(n - 2, i)];
    const sumLen = Math.hypot(a[0] + b[0], a[1] + b[1]) || 1e-12;
    // Averaged unit normals under-shoot corners by cos(θ/2) = |a+b|/2; the miter compensation
    // is 2/|a+b|, clamped so a hairpin cannot fling the line out.
    const k = (clearMm * Math.min(2, 2 / sumLen)) / sumLen;
    out.push([
      Math.max(0, pts[i][1] + (a[1] + b[1]) * k),
      worldZ(spec, centreZ, capUp, pts[i][0] + (a[0] + b[0]) * k),
    ]);
  }
  return out;
}

// Lathe profiles for the 3D preview, split where metal ends and glass begins so the two can be
// materialled apart. Local frame (z up from the base tip), each part closed onto the axis.
export function bulbLatheProfiles(kind: BulbKind): {
  base: [number, number][];
  glass: [number, number][];
} {
  const spec = BULBS[kind];
  const seam = seamR(spec);
  const base: [number, number][] = [[0, 0]];
  const glass: [number, number][] = [[0, spec.capMm]];
  for (const [z, r] of spec.pts) {
    if (z <= spec.capMm) base.push([r, z]);
    else glass.push([r, z]);
  }
  base.push([seam, spec.capMm], [0, spec.capMm]);
  glass.splice(1, 0, [seam, spec.capMm]);
  glass.push([0, spec.len]);
  return { base, glass };
}

// Where the light actually comes from: the middle of the glass, not of the whole envelope.
export function bulbGlassMid(kind: BulbKind): number {
  const spec = BULBS[kind];
  return (spec.capMm + spec.len) / 2;
}

function seamR(spec: BulbSpec): number {
  const pts = spec.pts;
  for (let i = 0; i < pts.length - 1; i++) {
    const [z0, r0] = pts[i];
    const [z1, r1] = pts[i + 1];
    if (z1 >= spec.capMm && z0 <= spec.capMm) {
      return z1 === z0 ? r0 : r0 + ((spec.capMm - z0) / (z1 - z0)) * (r1 - r0);
    }
  }
  return pts[pts.length - 1][1];
}

// Signed clearance between the bulb's section and the shade's inner face, both as [r, z]
// polylines in the same world frame. Coaxial surfaces of revolution are nearest at the same
// azimuth, so this 2D section distance IS the true 3D clearance. Negative = the glass pokes
// through the wall, by how much (radially, matching what "widen the shade by X" fixes).
// `wall` must be sorted by ascending z.
export function sectionGap(
  section: readonly (readonly [number, number])[],
  wall: readonly (readonly [number, number])[],
): number {
  if (wall.length === 0) return Number.POSITIVE_INFINITY;

  // Penetration first: any section point radially outside the interpolated inner face.
  let pen = 0;
  for (const [r, z] of section) {
    if (z < wall[0][1] || z > wall[wall.length - 1][1]) continue;
    for (let i = 0; i < wall.length - 1; i++) {
      const [r0, z0] = wall[i];
      const [r1, z1] = wall[i + 1];
      if (z < z0 || z > z1) continue;
      const rw = z1 === z0 ? Math.min(r0, r1) : r0 + ((z - z0) / (z1 - z0)) * (r1 - r0);
      pen = Math.max(pen, r - rw);
      break;
    }
  }
  if (pen > 0) return -pen;

  // Min distance polyline↔polyline: every vertex of each against every segment of the other.
  let best = Number.POSITIVE_INFINITY;
  const ptToSeg = (
    p: readonly [number, number],
    a: readonly [number, number],
    b: readonly [number, number],
  ): number => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t =
      l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  for (const p of section) {
    for (let i = 0; i < wall.length - 1; i++)
      best = Math.min(best, ptToSeg(p, wall[i], wall[i + 1]));
  }
  for (const p of wall) {
    for (let i = 0; i < section.length - 1; i++) {
      best = Math.min(best, ptToSeg(p, section[i], section[i + 1]));
    }
  }
  return best;
}
