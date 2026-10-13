// Versioned localStorage store: the storage key, the schema version, the JSON round-trip and the
// defensive merge in one place. Every access is wrapped so a disabled store (private mode), bad JSON,
// a full quota, or a non-browser host (no localStorage) degrades to defaults instead of throwing.

import { defaults, type Infer, sanitize, type Schema } from "./schema.ts";

// The slice of the DOM Storage API the store touches. Defaulting to the global `localStorage` keeps
// browser usage a no-config call; passing one in makes the store testable and SSR-safe.
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ParamStore<S extends Schema> = {
  key: string; // the composed storage key, e.g. "mtg-deck-box:params:v1"
  defaults: Infer<S>; // a fresh copy on each read
  load(): Infer<S>; // stored + sanitized, or defaults
  save(params: Infer<S>): void;
  clear(): void; // forget the persisted blob (reset-to-defaults path)
  sanitize(raw: unknown): Infer<S>;
};

export function createStore<S extends Schema>(
  schema: S,
  opts: { key: string; version?: number | string; storage?: StorageLike },
): ParamStore<S> {
  const key = opts.version == null ? opts.key : `${opts.key}:v${opts.version}`;
  const storage = (): StorageLike | undefined =>
    opts.storage ?? (globalThis as { localStorage?: StorageLike }).localStorage;

  return {
    key,
    get defaults(): Infer<S> {
      return defaults(schema);
    },
    load(): Infer<S> {
      try {
        const txt = storage()?.getItem(key);
        return txt ? sanitize(schema, JSON.parse(txt)) : defaults(schema);
      } catch {
        return defaults(schema); // storage disabled or bad JSON -> defaults
      }
    },
    save(params: Infer<S>): void {
      try {
        storage()?.setItem(key, JSON.stringify(params));
      } catch {
        // storage full or disabled -> non-fatal, just don't persist this change
      }
    },
    clear(): void {
      try {
        storage()?.removeItem(key);
      } catch {
        // ignore
      }
    },
    sanitize(raw: unknown): Infer<S> {
      return sanitize(schema, raw);
    },
  };
}
