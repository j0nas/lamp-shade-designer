// Bambu Lab bed compatibility. Kept separate from the geometry/params so the printer table can grow
// without touching the modeller. Models that share a bed are grouped into one entry. `w × d` is the
// largest single-nozzle horizontal printable area each model can reach (single-material parts), from
// Bambu's tech specs / wiki — so e.g. the H2D/H2C carry each nozzle's 325×320 reach, not the 330/350 mm
// full plate only both nozzles cover. Some beds can't use all of that cleanly, though, so a fit can be
// amber for one of two reasons (see Corner / Common below). Discontinued-but-common models (P1P, X1C/
// X1E) stay in, since the tool is for any owner. A part may rotate 90°, so it fits if its long/short
// sides clear the bed's.

const EXCLUSION_WIKI = "https://wiki.bambulab.com/en/knowledge-sharing/print-volume-limitations";
const H2_AREA_WIKI = "https://wiki.bambulab.com/en/h2/manual/max-printable-area";

// A part that clears the full w×d rectangle can still be an AMBER fit — it prints, but with a caveat
// worth flagging. Two independent flavours, at most one per printer today:

// Corner — P1/X1 reserve an 18×28 mm front-left corner for the AMS filament cutter's foldable stopper.
// Reaching it needs a small printed stopper-block plus a Bambu Studio preset change (see the wiki).
export type Corner = {
  ex: number; // unusable corner width (mm, along bed X)
  ey: number; // unusable corner depth (mm, along bed Y)
  note: string;
  url: string;
};

// Common — H2D/H2C carry two nozzles; only a narrower central band (w×d here) is reachable by BOTH.
// A part wider than this still prints, on a single nozzle — fine for a single-material part — but it
// forfeits dual-nozzle / two-colour use, so we flag it amber rather than plain green.
export type Common = {
  w: number; // both-nozzle common width (mm, bed X)
  d: number; // both-nozzle common depth (mm, bed Y)
  note: string;
  url: string;
};

export type Printer = {
  name: string; // group label shown on the badge
  members?: string[]; // models in this group (shown in the tooltip)
  w: number; // max single-nozzle printable area, bed X (mm)
  d: number; // max single-nozzle printable area, bed Y (mm)
  corner?: Corner; // front-left exclusion zone needing a mod (P1/X1)
  common?: Common; // both-nozzle common area; beyond it = single-nozzle only (H2D/H2C)
};

export const PRINTERS: Printer[] = [
  { name: "A1 mini", w: 180, d: 180 },
  { name: "A1 / X2D", members: ["A1", "X2D"], w: 256, d: 256 },
  {
    name: "P1 / P2 / X1",
    members: ["P1P", "P1S", "P2S", "X1C", "X1E"],
    w: 256,
    d: 256,
    corner: {
      ex: 18,
      ey: 28,
      note: "fits only with the filament-cutter exclusion-zone mod",
      url: EXCLUSION_WIKI,
    },
  },
  {
    // Each nozzle reaches 325×320 (H2C's left; its right reaches 305), but both nozzles only share a
    // 300×320 central band — so anything wider prints single-nozzle only.
    name: "H2D / H2C",
    members: ["H2D", "H2C"],
    w: 325,
    d: 320,
    common: {
      w: 300,
      d: 320,
      note: "fits the 325×320 single-nozzle area but exceeds the 300×320 both-nozzle band — prints single-nozzle only",
      url: H2_AREA_WIKI,
    },
  },
  { name: "A2L", w: 330, d: 320 },
  { name: "H2S", w: 340, d: 320 }, // single nozzle: the whole 340×320 is reachable
];

export type Fit = "ok" | "mod" | "no";

// "ok": clears the bed with no caveat. "mod": fits the full w×d rectangle but only with a caveat — the
// corner mod (P1/X1) or single-nozzle only (H2D/H2C). "no": too big even for w×d. A centred part only
// collides with the P1/X1 front-left corner when it reaches into both the ex-wide and ey-deep strips at
// once, so a short part can still be "ok" there.
export function fitFor(p: Printer, longSide: number, shortSide: number): Fit {
  const orients: [number, number][] = [
    [longSide, shortSide],
    [shortSide, longSide],
  ];
  let fitsBed = false;
  let clean = false;
  for (const [px, py] of orients) {
    if (px > p.w || py > p.d) continue; // beyond the max printable rectangle in this orientation
    fitsBed = true;
    let caveat = false;
    // P1/X1: only "dirty" when the part reaches into BOTH exclusion strips at once.
    if (p.corner && px > p.w - 2 * p.corner.ex && py > p.d - 2 * p.corner.ey) caveat = true;
    // H2D/H2C: "dirty" (single-nozzle only) once it overflows the both-nozzle common band.
    if (p.common && (px > p.common.w || py > p.common.d)) caveat = true;
    if (!caveat) clean = true;
  }
  if (clean) return "ok";
  if (fitsBed) return "mod";
  return "no";
}

// The active amber caveat for a printer (corner mod or single-nozzle band), or undefined if none.
export function caveatOf(p: Printer): { note: string; url: string } | undefined {
  return p.corner ?? p.common;
}

// Tooltip text for a badge given its fit verdict.
export function fitTitle(p: Printer, fit: Fit): string {
  const who = p.members ? p.members.join(" · ") : p.name;
  const size = `${p.w} × ${p.d} mm`;
  if (fit === "no") return `${who}: ${size} — too big`;
  if (fit === "mod") return `${who}: ${caveatOf(p)?.note ?? "fits with a caveat"}`;
  return `${who}: ${size} — fits`;
}
