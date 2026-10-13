// Filament estimate shared by every readout: a closed mesh's solid volume → grams and metres of
// 1.75 mm filament. The volume comes from testkit's signed-tetrahedron sum (robust through the CSG
// T-junctions), so the weight tracks the real cut solid rather than a nominal bounding box.

import type { BufferGeometry } from "three";
import { volume } from "../testkit/index.ts";

// g/cm³. PLA doubles as the fallback for a material that isn't listed.
export const DENSITY: Record<string, number> = { PLA: 1.24, PETG: 1.27, ABS: 1.04, TPU: 1.21 };
const DEFAULT_DENSITY = DENSITY.PLA;

const FILAMENT_AREA_MM2 = Math.PI * (1.75 / 2) ** 2; // cross-section of 1.75 mm filament

// Solid volume of a closed mesh in cm³ — the source of truth for the filament estimate.
export function volumeCm3(g: BufferGeometry): number {
  return volume(g) / 1000; // mm³ → cm³
}

// Mass (g) of a solid print of this volume in the given material.
export function filamentGrams(volCm3: number, material = "PLA"): number {
  const density = Object.hasOwn(DENSITY, material) ? DENSITY[material] : DEFAULT_DENSITY;
  return volCm3 * density;
}

// Length (m) of 1.75 mm filament for this volume. cm³ → mm³ (×1000) and length (÷area ÷1000) cancel,
// leaving volCm3 / area.
export function filamentMetres(volCm3: number): number {
  return volCm3 / FILAMENT_AREA_MM2;
}
