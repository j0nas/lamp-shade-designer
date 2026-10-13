// Schema-driven parameter model. In the source apps, adding one parameter touched four places — the
// Params type, the slider table, the storage sanitizer, and the panel markup. Declaring a field here
// once yields all four: the inferred Params type (Infer), the defaults, the defensive sanitizer for
// untrusted storage, and (via panel.ts) the control row. Framework-free and side-effect-free.

export type NumField = {
  kind: "num";
  def: number;
  min: number;
  max: number;
  step: number;
  group: string;
  label?: string;
  // Unit shown next to the value ("mm", "°"). Display-only — values stay raw numbers in the
  // field's native unit. Omit for unitless counts.
  unit?: string;
  // Upper bound tracks another num field's live value instead of `max` (e.g. notch depth ≤ lip
  // height). Neither source app applies a multiplier, so the ceiling is that field's raw value.
  maxKey?: string;
};

export type PickField<T extends string = string> = {
  kind: "pick";
  def: T;
  options: readonly T[];
  group: string;
  label?: string;
  // Display text per option; the raw value is shown when an option has no entry (e.g. "hex" →
  // "Honeycomb", "friction" → "Friction fit").
  optionLabels?: Partial<Record<T, string>>;
};

export type ToggleField = {
  kind: "toggle";
  def: boolean;
  group: string;
  label?: string;
};

export type Field = NumField | PickField | ToggleField;

export type Schema = Record<string, Field>;

export function num(opts: Omit<NumField, "kind">): NumField {
  return { kind: "num", ...opts };
}

// `options` fixes both the display order and the valid set; `def` must be one of them (NoInfer keeps
// the union coming from `options` alone).
export function pick<const T extends string>(
  options: readonly T[],
  opts: {
    def: NoInfer<T>;
    group: string;
    label?: string;
    optionLabels?: Partial<Record<T, string>>;
  },
): PickField<T> {
  return { kind: "pick", options, ...opts };
}

export function toggle(opts: Omit<ToggleField, "kind">): ToggleField {
  return { kind: "toggle", ...opts };
}

// Identity, but it pins the schema's precise field types so `Infer` can read the literal unions back.
export function defineParams<S extends Schema>(schema: S): S {
  return schema;
}

type FieldValue<F extends Field> = F extends { kind: "num" }
  ? number
  : F extends { kind: "toggle" }
    ? boolean
    : F extends { kind: "pick"; options: readonly (infer U)[] }
      ? U
      : never;

export type Infer<S extends Schema> = { [K in keyof S]: FieldValue<S[K]> };

export function defaults<S extends Schema>(schema: S): Infer<S> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(schema)) out[key] = schema[key].def;
  return out as Infer<S>;
}

// Rebuild a clean Params from an untrusted value (a blob that may be stale from an older schema or
// hand-edited), key by key against the schema's defaults. Semantics mirror the source apps'
// sanitizeParams exactly:
//   - a non-object root (null / string / number) yields all defaults;
//   - only keys declared in the schema survive (unknown keys are dropped);
//   - a stored value is taken only when its typeof matches the default's — JSON turns NaN/Infinity
//     into null, so non-finite numbers are rejected here too and keep the default;
//   - pick values are then pinned to the declared options (typeof passed any string).
export function sanitize<S extends Schema>(schema: S, raw: unknown): Infer<S> {
  const def = defaults(schema) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...def };
  if (!raw || typeof raw !== "object") return out as Infer<S>;
  const src = raw as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    const stored = src[key];
    if (typeof stored === typeof def[key]) out[key] = stored;
  }
  for (const key of Object.keys(schema)) {
    const field = schema[key];
    if (field.kind === "pick" && !field.options.includes(out[key] as string)) {
      out[key] = field.def;
    }
  }
  return out as Infer<S>;
}

// Clamp every maxKey field down to the live value of the field it tracks (notch depth ≤ lip height).
// Mutates in place; mirrors the panel's dynamic-ceiling bounders so a restored blob is normalised the
// same way the panel would on first paint.
export function clampCeilings<S extends Schema>(schema: S, params: Infer<S>): void {
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(schema)) {
    const field = schema[key];
    if (field.kind === "num" && field.maxKey) {
      const hi = p[field.maxKey] as number;
      if ((p[key] as number) > hi) p[key] = hi;
    }
  }
}
