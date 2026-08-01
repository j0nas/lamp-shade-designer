// The design file format, the share-link codec, the library and the STL header stamp — all pure,
// so no initCSG here. The one rule under test throughout: every way a design can enter the app
// funnels through sanitizeDesign, and only a wrong ENVELOPE rejects; malformed fields degrade.
// Version 1 files (flat params + one curve) must keep opening as a single-layer v2 design.
import { describe, expect, test } from "vite-plus/test";
import { defaults, type StorageLike } from "parametric-kit/params";
import { familyCurve, MAX_CURVE_PTS } from "./curve.ts";
import { type Params, schema, splitParams } from "./params.ts";
import { defaultLayer, type Design, MAX_LAYERS } from "./layers.ts";
import {
  createLibrary,
  decodeDesignHash,
  DESIGNS_KEY,
  encodeDesignHash,
  makeDesign,
  sanitizeDesign,
  slugify,
  stampStlHeader,
} from "./designs.ts";

const params = (over: Partial<Params> = {}): Params => ({ ...defaults(schema), ...over });
const curve = familyCurve("empire");

// A one-layer design from flat params — the shape most tests need.
function design(over: Partial<Params> = {}, layers = 1): Design {
  const split = splitParams(params(over));
  const first = { ...defaultLayer(), params: split.layer, curve: curve.map((p) => ({ ...p })) };
  const rest = Array.from({ length: layers - 1 }, (_, i) => ({
    ...defaultLayer(),
    color: "#e08a3c",
    link: "nest" as const,
    gap: 5 + i,
    params: { ...split.layer },
    curve: curve.map((p) => ({ ...p })),
  }));
  return { globals: split.globals, layers: [first, ...rest] };
}

describe("design files", () => {
  test("a saved design round-trips through JSON unchanged", () => {
    const d = makeDesign("Aurora v2", design({ height: 320, twistDeg: 90 }), {
      now: new Date("2026-07-31T12:00:00Z"),
    });
    const back = sanitizeDesign(JSON.parse(JSON.stringify(d)));
    expect(back).toEqual(d);
  });

  test("a layered design round-trips, nest link and appearance included", () => {
    const d = makeDesign("Stacked", design({ height: 260 }, 3), {
      now: new Date("2026-07-31T12:00:00Z"),
    });
    const back = sanitizeDesign(JSON.parse(JSON.stringify(d)));
    expect(back).toEqual(d);
    expect(back?.layers).toHaveLength(3);
    expect(back?.layers[1].link).toBe("nest");
    expect(back?.layers[1].gap).toBe(5);
    expect(back?.layers[1].color).toBe("#e08a3c");
  });

  test("only a wrong envelope rejects; malformed fields degrade", () => {
    // Wrong or missing format/version: not our file, or a future major we can't honour — null.
    expect(sanitizeDesign(null)).toBeNull();
    expect(sanitizeDesign("junk")).toBeNull();
    expect(sanitizeDesign({})).toBeNull();
    expect(sanitizeDesign({ format: "other-app", version: 1 })).toBeNull();
    expect(sanitizeDesign({ format: "lamp-shade-design", version: 3 })).toBeNull();

    // Right envelope with garbage fields: everything degrades per the sanitize contracts.
    const d = sanitizeDesign({
      format: "lamp-shade-design",
      version: 2,
      name: 42,
      savedAt: "not a date",
      globals: { watts: "many" },
      layers: [
        { color: "not-a-colour", opacity: "solid", params: { height: "tall" }, curve: "nope" },
      ],
    });
    expect(d).not.toBeNull();
    expect(d?.name).toBe("untitled");
    expect(Number.isNaN(Date.parse(d!.savedAt))).toBe(false);
    expect(d?.globals.watts).toBe(defaults(schema).watts);
    expect(d?.layers[0].params.height).toBe(defaults(schema).height);
    expect(d?.layers[0].opacity).toBe(1);
    expect(d?.layers[0].color).toMatch(/^#[0-9a-f]{6}$/);
    expect(d?.layers[0].curve).toEqual(familyCurve("empire")); // curve fallback is the default family
  });

  test("a v1 file opens as a single-layer design with identical fields", () => {
    const d = sanitizeDesign({
      format: "lamp-shade-design",
      version: 1,
      name: "legacy",
      savedAt: "2026-01-01T00:00:00.000Z",
      params: params({ height: 320, twistDeg: 90, watts: 12 }),
      curve,
    });
    expect(d).not.toBeNull();
    expect(d?.version).toBe(2);
    expect(d?.layers).toHaveLength(1);
    expect(d?.layers[0].params.height).toBe(320); // layer field landed on the layer
    expect(d?.layers[0].params.twistDeg).toBe(90);
    expect(d?.globals.watts).toBe(12); // global field landed on the globals
    expect(d?.layers[0].link).toBe("free");
    expect(d?.layers[0].curve).toEqual(curve);
  });

  test("the slots migration applies to imported v1 files, not just localStorage", () => {
    const d = sanitizeDesign({
      format: "lamp-shade-design",
      version: 1,
      name: "old slots design",
      params: { ...defaults(schema), perfPattern: "slots" },
      curve,
    });
    expect(d?.layers[0].params.perfPattern).toBe("grid");
    expect(d?.layers[0].params.perfShape).toBe("slot");
    expect(d?.layers[0].params.perfEven).toBe(false);
  });

  test("layer 0 can never be nested, and layer count caps at MAX_LAYERS", () => {
    const many = Array.from({ length: MAX_LAYERS + 3 }, () => ({
      ...defaultLayer(),
      link: "nest",
    }));
    const d = sanitizeDesign({
      format: "lamp-shade-design",
      version: 2,
      name: "deep",
      globals: {},
      layers: many,
    });
    expect(d?.layers).toHaveLength(MAX_LAYERS);
    expect(d?.layers[0].link).toBe("free"); // nothing outside it to nest in
    expect(d?.layers[1].link).toBe("nest");
  });

  test("a v2 file with no layers gets the default layer rather than an empty stack", () => {
    const d = sanitizeDesign({ format: "lamp-shade-design", version: 2, name: "bare", layers: [] });
    expect(d?.layers).toHaveLength(1);
    expect(d?.layers[0].params.height).toBe(defaults(schema).height);
  });

  test("names are trimmed, capped at 80 chars, and default to untitled", () => {
    expect(makeDesign("  Aurora  ", design()).name).toBe("Aurora");
    expect(makeDesign("", design()).name).toBe("untitled");
    expect(makeDesign("   ", design()).name).toBe("untitled");
    expect(makeDesign("x".repeat(200), design()).name).toHaveLength(80);
  });

  test("an oversized imported curve is capped with both rims pinned", () => {
    const huge = Array.from({ length: 500 }, (_, i) => ({ v: i / 499, r: 50 + (i % 40) }));
    const d = sanitizeDesign({
      format: "lamp-shade-design",
      version: 1,
      name: "dense",
      params: defaults(schema),
      curve: huge,
    });
    expect(d?.layers[0].curve).toHaveLength(MAX_CURVE_PTS);
    expect(d?.layers[0].curve[0].v).toBe(0);
    expect(d?.layers[0].curve[MAX_CURVE_PTS - 1].v).toBe(1);
  });
});

describe("share links", () => {
  test("encode/decode round-trips, unicode names included", () => {
    const d = makeDesign("Nørdlys ✨ 灯", design({ height: 260 }, 2), {
      now: new Date("2026-07-31T12:00:00Z"),
    });
    const hash = encodeDesignHash(d);
    expect(hash).toMatch(/^d=[A-Za-z0-9_-]+$/); // base64url, fragment-safe, no padding
    expect(decodeDesignHash(hash)).toEqual(d);
    expect(decodeDesignHash(`#${hash}`)).toEqual(d); // location.hash arrives with the #
  });

  test("junk fragments decode to null, never throw", () => {
    for (const junk of ["", "#", "#junk", "d=", "d=!!!", "#d=AAAA", `d=${btoa("[1,2]")}`]) {
      expect(decodeDesignHash(junk)).toBeNull();
    }
  });
});

describe("the library", () => {
  // Map-backed StorageLike: the library must behave identically over real localStorage and this.
  const fakeStorage = (): StorageLike & { map: Map<string, string> } => {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
  };

  const at = (iso: string) => ({ now: new Date(iso) });

  test("put/get/remove round-trip, and put upserts by name", () => {
    const lib = createLibrary(fakeStorage());
    lib.put(makeDesign("a", design({ height: 100 }), at("2026-01-01T00:00:00Z")));
    lib.put(makeDesign("b", design(), at("2026-01-02T00:00:00Z")));
    expect(lib.get("a")?.layers[0].params.height).toBe(100);
    expect(lib.get("missing")).toBeNull();

    lib.put(makeDesign("a", design({ height: 300 }), at("2026-01-03T00:00:00Z")));
    expect(lib.list()).toHaveLength(2); // upsert, not append
    expect(lib.get("a")?.layers[0].params.height).toBe(300);

    lib.remove("a");
    expect(lib.get("a")).toBeNull();
    expect(lib.list()).toHaveLength(1);
  });

  test("list is sorted newest-saved first", () => {
    const lib = createLibrary(fakeStorage());
    lib.put(makeDesign("old", design(), at("2026-01-01T00:00:00Z")));
    lib.put(makeDesign("new", design(), at("2026-06-01T00:00:00Z")));
    lib.put(makeDesign("mid", design(), at("2026-03-01T00:00:00Z")));
    expect(lib.list().map((d) => d.name)).toEqual(["new", "mid", "old"]);
  });

  test("corrupt storage reads as an empty library, and bad entries are dropped", () => {
    const storage = fakeStorage();
    storage.map.set(DESIGNS_KEY, "{not json");
    expect(createLibrary(storage).list()).toEqual([]);

    const good = makeDesign("good", design());
    storage.map.set(DESIGNS_KEY, JSON.stringify([good, { format: "other" }, 42]));
    expect(createLibrary(storage).list()).toEqual([good]);
  });

  test("a throwing storage is swallowed, not fatal", () => {
    const angry: StorageLike = {
      getItem: () => {
        throw new Error("quota");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("quota");
      },
    };
    const lib = createLibrary(angry);
    expect(() => lib.put(makeDesign("a", design()))).not.toThrow();
    expect(lib.list()).toEqual([]);
    // And no storage at all (plain Node) degrades the same way.
    expect(createLibrary(undefined).list()).toEqual([]);
  });
});

describe("stampStlHeader", () => {
  const blank = (bytes = 100): DataView<ArrayBuffer> => new DataView(new ArrayBuffer(bytes));
  const headerText = (view: DataView): string => {
    let s = "";
    for (let i = 0; i < 80 && view.getUint8(i) !== 0; i++)
      s += String.fromCharCode(view.getUint8(i));
    return s;
  };

  test("writes the text into bytes 0–79 and leaves byte 80+ untouched", () => {
    const view = blank();
    view.setUint32(80, 1234, true); // stand-in for the triangle count field
    stampStlHeader(view, "lamp-shade 1.0.0+abc1234 aurora");
    expect(headerText(view)).toBe("lamp-shade 1.0.0+abc1234 aurora");
    expect(view.getUint8(31)).toBe(0); // rest of the header is zero-filled
    expect(view.getUint32(80, true)).toBe(1234);
  });

  test("never lets the header start with 'solid', which would read as ASCII STL", () => {
    const view = stampStlHeader(blank(), "solid provenance");
    expect(headerText(view).startsWith("solid")).toBe(false);
    expect(headerText(view)).toContain("solid provenance");
  });

  test("truncates at 80 bytes and strips non-ASCII", () => {
    const view = stampStlHeader(blank(), "x".repeat(200));
    expect(headerText(view)).toHaveLength(80);
    expect(view.getUint8(80)).toBe(0); // truncation never spills past the header

    expect(headerText(stampStlHeader(blank(), "Nørdlys ✨ shade"))).toBe("Nrdlys  shade");
  });
});

describe("slugify", () => {
  test("makes filename-safe slugs and never returns empty", () => {
    expect(slugify("Aurora v2 (tall)")).toBe("aurora-v2-tall");
    expect(slugify("  ---  ")).toBe("design");
    expect(slugify("Ängen — Nørdlys")).toBe("angen-n-rdlys"); // ä decomposes; ø just separates
  });
});
