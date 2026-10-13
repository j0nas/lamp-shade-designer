// renderPanel builds the whole control panel from the schema and a groups descriptor: <section>
// blocks with headings and optional hint slots, slider rows for num fields, select rows for pick
// fields, checkbox rows for toggles, preset selects, dynamic (maxKey) slider ceilings, conditional
// group visibility, and one onChange(params) callback for the app. It mutates the app's shared params
// object in place and returns a controller (sync / refresh), exactly as the source apps expect.
//
// Groups are both the row bucket (fields with a matching `group`) and the visibility unit. A group
// with a `title` opens a new <section>; a title-less group continues the current one — that is how a
// single visual section (e.g. "Shell") holds several independently-hideable groups (its rows, the
// opening-size row, the body-style hint). DOM uses the same class names the apps already style:
// `.group` / `.row` / `.sel` / `.toggle` / `.sub` (plus `.num`, the span wrapping every num field's
// value input, holding a `.unit` span when the field declares one — style `.num` as the input box
// and the borderless input inside it fills it).
//
// With `collapsible` set, every titled group renders as <details class="group"> with its heading
// inside <summary><h2> — an accordion of independently collapsible sections, native and keyboard-
// accessible, no JS open/close state. Title-less groups keep continuing the current section, so a
// collapsed section swallows its continuations too. Sections default CLOSED (the point of the
// accordion is a short panel); mark the primary section `open: true`. Passing `{ key }` persists
// the user's open/closed choices, so the panel reopens the way they left it — user toggles override
// the app's `open` defaults on the next load.

import { clampCeilings, type Infer, type Schema } from "./schema.ts";
import { applyPreset, matchPreset, type PresetGroup } from "./presets.ts";
import type { StorageLike } from "./store.ts";

// A trailing <p class="sub"> under a group: a fixed string, or a function of params for a live hint
// (e.g. the closure explanation that changes with lidStyle).
export type HintSpec<P> = string | ((params: P) => string);

export type GroupSpec<P> = {
  id: string; // matches Field.group
  title?: string; // present -> new <section> + <h2>; absent -> continues the current section
  hint?: HintSpec<P>;
  visibleWhen?: (params: P) => boolean; // hides this group's block when false
  presets?: string[]; // PresetGroup ids rendered at the top of this group's block
  open?: boolean; // collapsible panels only: initial state of this titled section (default closed)
};

// true -> collapsible, state lives only in the DOM; { key } -> user toggles persist under that
// localStorage key (pass `storage` for tests / SSR, mirroring createStore).
export type CollapseSpec = boolean | { key?: string; storage?: StorageLike };

export type RenderPanelOptions<S extends Schema> = {
  groups: GroupSpec<Infer<S>>[];
  presets?: PresetGroup<Infer<S>>[];
  onChange: (params: Infer<S>) => void;
  format?: (n: number) => string; // value-readout formatter (default: round float noise to 3 dp)
  collapsible?: CollapseSpec; // render titled groups as an accordion of <details> sections
};

export type Panel = {
  // Push params -> every input, then refresh ceilings, visibility, hints and preset selection. Call
  // after mutating params outside the panel (reset to defaults, presets applied elsewhere).
  sync(): void;
  // Re-evaluate visibility + hints + preset selection only, without rewriting the inputs.
  refresh(): void;
};

// Round away float noise (0.30000000000000004) while keeping real precision like 0.305.
const defaultFormat = (n: number): string => String(Math.round(n * 1000) / 1000);

export function renderPanel<S extends Schema>(
  container: HTMLElement,
  schema: S,
  params: Infer<S>,
  opts: RenderPanelOptions<S>,
): Panel {
  const doc = container.ownerDocument;
  const format = opts.format ?? defaultFormat;
  const p = params as Record<string, unknown>;

  const presetsById = new Map<string, PresetGroup<Infer<S>>>();
  for (const group of opts.presets ?? []) presetsById.set(group.id, group);

  const syncers: Array<() => void> = []; // push params -> inputs
  const bounders: Array<() => void> = []; // re-evaluate maxKey ceilings, clamp values down
  const visRefreshers: Array<() => void> = [];
  const hintRefreshers: Array<() => void> = [];
  const presetRefreshers: Array<() => void> = [];

  const runAll = (fns: Array<() => void>): void => {
    for (const fn of fns) fn();
  };

  // After any in-panel edit: keep dependent ceilings, group visibility, live hints and preset
  // selection in step, then hand the whole params object back to the app.
  const emitChange = (): void => {
    runAll(bounders);
    runAll(visRefreshers);
    runAll(hintRefreshers);
    runAll(presetRefreshers);
    opts.onChange(params);
  };

  const sync = (): void => {
    clampCeilings(schema, params);
    runAll(syncers);
    runAll(visRefreshers);
    runAll(hintRefreshers);
    runAll(presetRefreshers);
  };

  const refresh = (): void => {
    runAll(visRefreshers);
    runAll(hintRefreshers);
    runAll(presetRefreshers);
  };

  const renderNum = (
    key: string,
    field: Extract<Schema[string], { kind: "num" }>,
    block: HTMLElement,
  ): void => {
    const hi = (): number => (field.maxKey ? (p[field.maxKey] as number) : field.max);

    const row = doc.createElement("div");
    row.className = "row";

    const labelText = field.label ?? key;
    const label = doc.createElement("label");
    label.textContent = labelText;

    const range = doc.createElement("input");
    range.type = "range";
    range.min = String(field.min);
    range.step = String(field.step);

    const text = doc.createElement("input");
    text.type = "text";

    const apply = (raw: number): void => {
      const v = Math.min(Math.max(raw, field.min), hi());
      p[key] = v;
      range.max = String(hi());
      range.value = String(v);
      text.value = format(v);
      emitChange();
    };
    range.addEventListener("input", () => apply(Number(range.value)));
    text.addEventListener("change", () => {
      const v = Number(text.value);
      if (!Number.isNaN(v)) apply(v);
    });

    // Keep a dynamic-max slider's ceiling in step with what it depends on, clamping its value down if
    // that ceiling dropped below the current value.
    if (field.maxKey) {
      bounders.push(() => {
        const h = hi();
        range.max = String(h);
        if ((p[key] as number) > h) {
          p[key] = h;
          range.value = String(h);
          text.value = format(h);
        }
      });
    }

    syncers.push(() => {
      range.max = String(hi());
      range.value = String(p[key] as number);
      text.value = format(p[key] as number);
    });

    // The value input and its unit share one box (`.num`) so the unit can sit INSIDE the field as a
    // suffix. As a bare fourth child it was a fourth grid item, which wrapped to its own line in any
    // app whose .row declares three columns. Emitted even for unitless fields so every value column
    // is the same element and one CSS rule styles them all.
    const num = doc.createElement("span");
    num.className = "num";
    num.append(text);
    if (field.unit) {
      // Decorative: the unit is part of the input's accessible name below, so a screen reader that
      // read the span too would announce it twice.
      const unit = doc.createElement("span");
      unit.className = "unit";
      unit.textContent = field.unit;
      unit.setAttribute("aria-hidden", "true");
      num.append(unit);
      text.setAttribute("aria-label", `${labelText} (${field.unit})`);
    }

    row.append(label, range, num);
    block.append(row);
  };

  const renderPick = (
    key: string,
    field: Extract<Schema[string], { kind: "pick" }>,
    block: HTMLElement,
  ): void => {
    const wrap = doc.createElement("label");
    wrap.className = "sel";
    wrap.append(doc.createTextNode(field.label ?? key));

    const select = doc.createElement("select");
    for (const option of field.options) {
      const opt = doc.createElement("option");
      opt.value = option;
      opt.textContent = field.optionLabels?.[option] ?? option;
      select.append(opt);
    }
    select.addEventListener("change", () => {
      p[key] = select.value;
      emitChange();
    });

    syncers.push(() => {
      select.value = p[key] as string;
    });

    wrap.append(select);
    block.append(wrap);
  };

  const renderToggle = (
    key: string,
    field: Extract<Schema[string], { kind: "toggle" }>,
    block: HTMLElement,
  ): void => {
    const wrap = doc.createElement("label");
    wrap.className = "toggle";

    const box = doc.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => {
      p[key] = box.checked;
      emitChange();
    });

    syncers.push(() => {
      box.checked = p[key] as boolean;
    });

    wrap.append(box, doc.createTextNode(` ${field.label ?? key}`));
    block.append(wrap);
  };

  const renderPresetSelect = (id: string, block: HTMLElement): void => {
    const group = presetsById.get(id);
    if (!group) return; // unknown preset id -> nothing to render

    const wrap = doc.createElement("label");
    wrap.className = "sel";
    wrap.append(doc.createTextNode(group.label));

    const select = doc.createElement("select");
    const custom = doc.createElement("option");
    custom.value = "";
    custom.textContent = group.custom ?? "Custom…";
    select.append(custom);
    for (const preset of group.presets) {
      const opt = doc.createElement("option");
      opt.value = preset.name;
      opt.textContent = preset.name;
      select.append(opt);
    }
    select.addEventListener("change", () => {
      if (!applyPreset(group, select.value, params)) return; // "Custom…" -> leave params alone
      sync();
      opts.onChange(params);
    });

    presetRefreshers.push(() => {
      select.value = matchPreset(group, params) ?? "";
    });

    wrap.append(select);
    block.append(wrap);
  };

  // --- section / group layout ---------------------------------------------
  const collapse = opts.collapsible ?? false;
  const collapseKey = typeof collapse === "object" ? collapse.key : undefined;
  const collapseStorage = (): StorageLike | undefined =>
    (typeof collapse === "object" ? collapse.storage : undefined) ??
    (globalThis as { localStorage?: StorageLike }).localStorage;

  // The persisted blob is a plain {groupId: open} map of the user's toggles; anything unreadable
  // (private mode, bad JSON, non-object) degrades to "no saved state" and the app's defaults win.
  const savedOpen = (): Record<string, boolean> => {
    if (collapseKey === undefined) return {};
    try {
      const raw = collapseStorage()?.getItem(collapseKey);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const state: Record<string, boolean> = {};
      for (const [id, v] of Object.entries(parsed)) if (typeof v === "boolean") state[id] = v;
      return state;
    } catch {
      return {};
    }
  };
  const initialOpen = savedOpen();
  const persistOpen = (id: string, open: boolean): void => {
    if (collapseKey === undefined) return;
    try {
      collapseStorage()?.setItem(collapseKey, JSON.stringify({ ...savedOpen(), [id]: open }));
    } catch {
      // storage full or disabled -> non-fatal, the section still toggles
    }
  };

  let currentSection: HTMLElement | null = null;

  for (const group of opts.groups) {
    if (group.title !== undefined || currentSection === null) {
      // A collapsible section needs a summary to toggle it, so only titled groups collapse; a
      // leading title-less group falls back to the plain <section> (nothing to click).
      if (collapse !== false && group.title !== undefined) {
        const details = doc.createElement("details");
        details.className = "group";
        details.open = initialOpen[group.id] ?? group.open ?? false;
        const summary = doc.createElement("summary");
        const h2 = doc.createElement("h2");
        h2.textContent = group.title;
        summary.append(h2);
        details.append(summary);
        details.addEventListener("toggle", () => persistOpen(group.id, details.open));
        container.append(details);
        currentSection = details;
        // fall through to the shared block/rows path below
      } else {
        const section = doc.createElement("section");
        section.className = "group";
        if (group.title !== undefined) {
          const h2 = doc.createElement("h2");
          h2.textContent = group.title;
          section.append(h2);
        }
        container.append(section);
        currentSection = section;
      }
    }

    const block = doc.createElement("div");

    for (const id of group.presets ?? []) renderPresetSelect(id, block);

    for (const key of Object.keys(schema)) {
      const field = schema[key];
      if (field.group !== group.id) continue;
      if (field.kind === "num") renderNum(key, field, block);
      else if (field.kind === "pick") renderPick(key, field, block);
      else renderToggle(key, field, block);
    }

    if (group.hint !== undefined) {
      const hintEl = doc.createElement("p");
      hintEl.className = "sub";
      const hint = group.hint;
      if (typeof hint === "function") {
        hintRefreshers.push(() => {
          hintEl.textContent = hint(params);
        });
      } else {
        hintEl.textContent = hint;
      }
      block.append(hintEl);
    }

    if (group.visibleWhen !== undefined) {
      const cond = group.visibleWhen;
      visRefreshers.push(() => {
        block.hidden = !cond(params);
      });
    }

    currentSection.append(block);
  }

  sync(); // initial paint: normalise ceilings, fill every input, set visibility / hints / presets
  return { sync, refresh };
}
