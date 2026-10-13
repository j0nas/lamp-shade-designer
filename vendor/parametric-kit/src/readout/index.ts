// Shared readout primitives: the filament estimate (volume → grams/metres) both 3D apps compute, and
// the Bambu bed-fit table the tray app badges. The app-specific readout composition (the dims line,
// warnings, fit badges) stays in each app.

export { DENSITY, filamentGrams, filamentMetres, volumeCm3 } from "./filament.ts";
export {
  caveatOf,
  type Common,
  type Corner,
  type Fit,
  fitFor,
  fitTitle,
  type Printer,
  PRINTERS,
} from "./printers.ts";
