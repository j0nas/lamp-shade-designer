// The design file: one named, versioned, self-contained snapshot of a design (params + silhouette),
// and the library that keeps a catalog of them in localStorage.
//
// Pure on purpose — no three, no DOM — so the same sanitizer runs in the browser (import, share
// links, library load) and in Node (the golden regression tests parse committed catalog files with
// exactly this code). Every path that ACCEPTS a design funnels through sanitizeDesign(): storage
// migration first, then the kit's schema sanitize, then the curve sanitizer, so a file saved by an
// old app version degrades field-by-field instead of being rejected or trusted.

import { sanitize, type StorageLike } from "parametric-kit/params";
import { type CtrlPt, sanitizeCurve } from "./curve.ts";
import { migrateStored, type Params, schema } from "./params.ts";

// Injected by vite's `define` in dev and build; absent in plain Node, which the typeof guard covers.
export const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

const MAX_NAME = 80;

export type DesignFile = {
  format: "lamp-shade-design";
  version: 1;
  app: string; // APP_VERSION at save time — informational provenance, never load logic
  name: string;
  savedAt: string; // ISO 8601
  params: Params;
  curve: CtrlPt[];
};

function cleanName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().slice(0, MAX_NAME) : "";
  return s || "untitled";
}

export function makeDesign(
  name: string,
  params: Params,
  curve: readonly CtrlPt[],
  opts: { now?: Date; app?: string } = {},
): DesignFile {
  return {
    format: "lamp-shade-design",
    version: 1,
    app: opts.app ?? APP_VERSION,
    name: cleanName(name),
    savedAt: (opts.now ?? new Date()).toISOString(),
    params: { ...params },
    curve: curve.map((p) => ({ ...p })),
  };
}

// THE import path — files, share links and library entries all come through here. Only a wrong
// envelope (not our format, or a future major version) returns null; malformed FIELDS degrade
// instead, per the kit sanitize contract, so a hand-edited or half-corrupted file still opens as
// something rather than nothing. Params run through migrateStored first for the same reason the
// boot path does: sanitize would silently pin an old "slots" design back to the default pattern.
export function sanitizeDesign(raw: unknown): DesignFile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.format !== "lamp-shade-design" || r.version !== 1) return null;
  const migrated = migrateStored(r.params);
  return {
    format: "lamp-shade-design",
    version: 1,
    app: typeof r.app === "string" ? r.app.slice(0, MAX_NAME) : "unknown",
    name: cleanName(r.name),
    savedAt:
      typeof r.savedAt === "string" && !Number.isNaN(Date.parse(r.savedAt))
        ? r.savedAt
        : new Date(0).toISOString(),
    params: sanitize(schema, migrated ?? r.params),
    curve: sanitizeCurve(r.curve),
  };
}

// --- share links ---------------------------------------------------------------------------------
// The whole design rides in the URL fragment: nothing is uploaded anywhere, and the fragment never
// reaches a server log. base64url via TextEncoder so a unicode design name survives btoa, which
// only accepts latin-1.

export function encodeDesignHash(d: DesignFile): string {
  const bytes = new TextEncoder().encode(JSON.stringify(d));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `d=${btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export function decodeDesignHash(hash: string): DesignFile | null {
  const m = /^#?d=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!m) return null;
  try {
    const b64 = m[1].replaceAll("-", "+").replaceAll("_", "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return sanitizeDesign(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null; // truncated paste, junk fragment, invalid JSON — a bad link is not an error state
  }
}

// --- library -------------------------------------------------------------------------------------
// One storage key holding every design, name-keyed. A key per design would need an index key anyway,
// and a whole catalog of these files is a few kilobytes — nowhere near quota territory.

export const DESIGNS_KEY = "lamp-shade:designs:v1";

export type DesignLibrary = {
  list(): DesignFile[]; // newest saved first
  get(name: string): DesignFile | null;
  put(d: DesignFile): void; // upsert by name
  remove(name: string): void;
};

export function createLibrary(
  storage: StorageLike | undefined = globalThis.localStorage,
): DesignLibrary {
  // Same defensive posture as the kit's store: storage may be absent (Node), throwing (private
  // mode, quota) or corrupt (hand-edited), and none of those may take the app down. Entries re-run
  // through sanitizeDesign on every read so the library can never hand out a design the rest of
  // the app would choke on.
  const read = (): DesignFile[] => {
    try {
      const raw: unknown = JSON.parse(storage?.getItem(DESIGNS_KEY) ?? "null");
      if (!Array.isArray(raw)) return [];
      return raw.map(sanitizeDesign).filter((d): d is DesignFile => d !== null);
    } catch {
      return [];
    }
  };
  const write = (all: DesignFile[]): void => {
    try {
      storage?.setItem(DESIGNS_KEY, JSON.stringify(all));
    } catch {
      /* storage unavailable — the session still works, it just won't persist */
    }
  };
  return {
    // ISO 8601 timestamps sort lexicographically, so no Date parsing here.
    list: () => read().sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    get: (name) => read().find((d) => d.name === name) ?? null,
    put(d) {
      write([...read().filter((x) => x.name !== d.name), d]);
    },
    remove(name) {
      write(read().filter((d) => d.name !== name));
    },
  };
}

// --- STL provenance ------------------------------------------------------------------------------
// A binary STL's first 80 bytes are a free-text header almost every tool preserves and none parse —
// except that a file BEGINNING with "solid" gets mistaken for ASCII STL by sniffing importers, so
// that one prefix is forbidden. Lives here rather than in the kit because the text we stamp is this
// app's provenance line, and here rather than main.ts so a Node test can pin the byte layout.

export function stampStlHeader(view: DataView<ArrayBuffer>, text: string): DataView<ArrayBuffer> {
  let ascii = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x20 && c <= 0x7e) ascii += ch; // printable ASCII only; a header is not unicode-safe
  }
  if (/^solid/i.test(ascii)) ascii = `!${ascii}`;
  for (let i = 0; i < 80; i++) {
    view.setUint8(i, i < ascii.length ? ascii.charCodeAt(i) : 0);
  }
  return view;
}

export function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // decomposed diacritics vanish rather than becoming separators
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "design";
}
