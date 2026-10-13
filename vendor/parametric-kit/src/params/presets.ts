// Presets: a named collection rendered as one <select> that writes several fields at once, falling
// back to a "Custom…" option when the live params match no preset. Extracted from the sleeve/deck
// selects in the deck box and the item select in the tray app, including the tray's quirk that a
// preset writes a field it is NOT identified by (see `matchOn`).

import type { Infer, Schema } from "./schema.ts";

export type Preset<P> = {
  name: string;
  // Fields written into params when the preset is applied.
  set: Partial<P>;
  // Fields compared against params to decide whether this preset is the active one. Defaults to the
  // keys of `set`; give a narrower list when a preset writes fields it should not be matched on — the
  // tray item presets force frontOverhang to 0 on apply but stay matched on width + length only, so
  // raising the overhang afterwards does not drop the select to "Custom…".
  matchOn?: (keyof P)[];
};

export type PresetGroup<P> = {
  id: string; // referenced from a panel group's `presets` list
  label: string; // row label, e.g. "Deck preset" / "Sleeves" / "Item preset"
  custom?: string; // "Custom…" option text (default "Custom…")
  presets: Preset<P>[];
};

// Identity, typed against a schema so `set`/`matchOn` are checked against the inferred params.
export function definePresets<S extends Schema>(
  group: PresetGroup<Infer<S>>,
): PresetGroup<Infer<S>> {
  return group;
}

// The name of the first preset whose match fields all equal the current params, or null → "Custom…".
export function matchPreset<P>(group: PresetGroup<P>, params: P): string | null {
  for (const preset of group.presets) {
    const keys = preset.matchOn ?? (Object.keys(preset.set) as (keyof P)[]);
    if (keys.every((k) => params[k] === (preset.set as P)[k])) return preset.name;
  }
  return null;
}

// Write the named preset's fields into params in place. Returns false for an unknown name (e.g. the
// "Custom…" sentinel), so callers can leave params untouched.
export function applyPreset<P>(group: PresetGroup<P>, name: string, params: P): boolean {
  const preset = group.presets.find((p) => p.name === name);
  if (!preset) return false;
  Object.assign(params as object, preset.set);
  return true;
}
