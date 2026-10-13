// Schema-driven params: one field declaration yields the Params type, defaults, a defensive storage
// sanitizer, a versioned localStorage store, presets, and the whole control panel.

export { clampCeilings, defaults, defineParams, num, pick, sanitize, toggle } from "./schema.ts";
export type { Field, Infer, NumField, PickField, Schema, ToggleField } from "./schema.ts";

export { createStore } from "./store.ts";
export type { ParamStore, StorageLike } from "./store.ts";

export { applyPreset, definePresets, matchPreset } from "./presets.ts";
export type { Preset, PresetGroup } from "./presets.ts";

export { renderPanel } from "./panel.ts";
export type { CollapseSpec, GroupSpec, HintSpec, Panel, RenderPanelOptions } from "./panel.ts";

export { installPanelCollapse } from "./panel-collapse.ts";
export type { PanelCollapse } from "./panel-collapse.ts";
