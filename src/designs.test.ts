// The design file format, the share-link codec, the library and the STL header stamp — all pure,
// so no initCSG here. The one rule under test throughout: every way a design can enter the app
// funnels through sanitizeDesign, and only a wrong ENVELOPE rejects; malformed fields degrade.
import { describe, expect, test } from "vite-plus/test";
import { defaults, type StorageLike } from "parametric-kit/params";
import { familyCurve, MAX_CURVE_PTS } from "./curve.ts";
import { type Params, schema } from "./params.ts";
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

describe("design files", () => {
  test("a saved design round-trips through JSON unchanged", () => {
    const d = makeDesign("Aurora v2", params({ height: 320, twistDeg: 90 }), curve, {
      now: new Date("2026-07-31T12:00:00Z"),
    });
    const back = sanitizeDesign(JSON.parse(JSON.stringify(d)));
    expect(back).toEqual(d);
  });

  test("only a wrong envelope rejects; malformed fields degrade", () => {
    // Wrong or missing format/version: not our file, or a future major we can't honour — null.
    expect(sanitizeDesign(null)).toBeNull();
    expect(sanitizeDesign("junk")).toBeNull();
    expect(sanitizeDesign({})).toBeNull();
    expect(sanitizeDesign({ format: "other-app", version: 1 })).toBeNull();
    expect(sanitizeDesign({ format: "lamp-shade-design", version: 2 })).toBeNull();

    // Right envelope with garbage fields: everything degrades per the sanitize contracts.
    const d = sanitizeDesign({
      format: "lamp-shade-design",
      version: 1,
      name: 42,
      savedAt: "not a date",
      params: { height: "tall", twistDeg: 90 },
      curve: "nope",
    });
    expect(d).not.toBeNull();
    expect(d?.name).toBe("untitled");
    expect(Number.isNaN(Date.parse(d!.savedAt))).toBe(false);
    expect(d?.params.height).toBe(defaults(schema).height); // typeof mismatch keeps the default
    expect(d?.params.twistDeg).toBe(90); // well-formed field survives
    expect(d?.curve).toEqual(familyCurve("empire")); // curve fallback is the default family
  });

  test("the slots migration applies to imported files, not just localStorage", () => {
    const d = sanitizeDesign({
      format: "lamp-shade-design",
      version: 1,
      name: "old slots design",
      params: { ...defaults(schema), perfPattern: "slots" },
      curve,
    });
    expect(d?.params.perfPattern).toBe("grid");
    expect(d?.params.perfShape).toBe("slot");
    expect(d?.params.perfEven).toBe(false);
  });

  test("names are trimmed, capped at 80 chars, and default to untitled", () => {
    expect(makeDesign("  Aurora  ", params(), curve).name).toBe("Aurora");
    expect(makeDesign("", params(), curve).name).toBe("untitled");
    expect(makeDesign("   ", params(), curve).name).toBe("untitled");
    expect(makeDesign("x".repeat(200), params(), curve).name).toHaveLength(80);
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
    expect(d?.curve).toHaveLength(MAX_CURVE_PTS);
    expect(d?.curve[0].v).toBe(0);
    expect(d?.curve[MAX_CURVE_PTS - 1].v).toBe(1);
  });
});

describe("share links", () => {
  test("encode/decode round-trips, unicode names included", () => {
    const d = makeDesign("Nørdlys ✨ 灯", params({ height: 260 }), curve, {
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
    lib.put(makeDesign("a", params({ height: 100 }), curve, at("2026-01-01T00:00:00Z")));
    lib.put(makeDesign("b", params(), curve, at("2026-01-02T00:00:00Z")));
    expect(lib.get("a")?.params.height).toBe(100);
    expect(lib.get("missing")).toBeNull();

    lib.put(makeDesign("a", params({ height: 300 }), curve, at("2026-01-03T00:00:00Z")));
    expect(lib.list()).toHaveLength(2); // upsert, not append
    expect(lib.get("a")?.params.height).toBe(300);

    lib.remove("a");
    expect(lib.get("a")).toBeNull();
    expect(lib.list()).toHaveLength(1);
  });

  test("list is sorted newest-saved first", () => {
    const lib = createLibrary(fakeStorage());
    lib.put(makeDesign("old", params(), curve, at("2026-01-01T00:00:00Z")));
    lib.put(makeDesign("new", params(), curve, at("2026-06-01T00:00:00Z")));
    lib.put(makeDesign("mid", params(), curve, at("2026-03-01T00:00:00Z")));
    expect(lib.list().map((d) => d.name)).toEqual(["new", "mid", "old"]);
  });

  test("corrupt storage reads as an empty library, and bad entries are dropped", () => {
    const storage = fakeStorage();
    storage.map.set(DESIGNS_KEY, "{not json");
    expect(createLibrary(storage).list()).toEqual([]);

    const good = makeDesign("good", params(), curve);
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
    expect(() => lib.put(makeDesign("a", params(), curve))).not.toThrow();
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
