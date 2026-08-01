// The layer model, pure math end: nest resolution (the derived-silhouette helper), assembly
// aggregation, the radial-gap lint and the working-state migration. No kernel, no DOM.
import { describe, expect, test } from "vite-plus/test";
import { defaults } from "parametric-kit/params";
import { familyCurve, sampleRadius } from "./curve.ts";
import { type Params, schema, splitParams } from "./params.ts";
import {
  assembly,
  defaultDesign,
  defaultLayer,
  type Design,
  type Layer,
  layerLint,
  layerName,
  loadWorking,
  makeInnerLayer,
  resolveLayers,
  sanitizeWorking,
  saveWorking,
} from "./layers.ts";
import { fitterSpecAssembly } from "./fitter.ts";

const params = (over: Partial<Params> = {}): Params => ({ ...defaults(schema), ...over });

function layer(over: Partial<Params> = {}, extra: Partial<Layer> = {}): Layer {
  return {
    ...defaultLayer(),
    params: splitParams(params(over)).layer,
    curve: familyCurve("drum").map((p) => ({ ...p })),
    ...extra,
  };
}

function twoLayer(gap = 6, innerOver: Partial<Params> = {}): Design {
  return {
    globals: splitParams(params()).globals,
    layers: [
      layer({ wall: 2 }),
      layer({ girth: 1, ...innerOver }, { link: "nest", gap }),
    ],
  };
}

describe("nest resolution", () => {
  test("a nested layer sits exactly wall + gap inside its outer layer", () => {
    const d = twoLayer(6);
    const [outer, inner] = resolveLayers(d);
    // Drum silhouette: radius 84 everywhere; outer wall 2, gap 6 → inner outer face at 76.
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const outerR = sampleRadius(outer.curve, v) * outer.params.girth;
      const innerR = sampleRadius(inner.curve, v) * inner.params.girth;
      expect(innerR).toBeCloseTo(outerR - 2 - 6, 1);
    }
  });

  test("the gap parameter moves the derived silhouette one-for-one", () => {
    const near = resolveLayers(twoLayer(4))[1];
    const far = resolveLayers(twoLayer(10))[1];
    const rNear = sampleRadius(near.curve, 0.5) * near.params.girth;
    const rFar = sampleRadius(far.curve, 0.5) * far.params.girth;
    expect(rNear - rFar).toBeCloseTo(6, 1);
  });

  test("nesting chains: a third layer derives from the derived second", () => {
    const d = twoLayer(6);
    d.layers.push(layer({ girth: 1 }, { link: "nest", gap: 5 }));
    const [, , third] = resolveLayers(d);
    // 84 − (2 + 6) = 76, then − (wall 1.6 default + 5) = 69.4.
    const wallOfSecond = d.layers[1].params.wall;
    expect(sampleRadius(third.curve, 0.5)).toBeCloseTo(84 - 2 - 6 - wallOfSecond - 5, 1);
  });

  test("a shorter lifted inner layer samples the outer at matching world heights", () => {
    // Outer: cone 104→44 over 200 mm. Inner: 100 mm tall, lifted 50 — its v=0 sits at the
    // outer's v=0.25 and its v=1 at the outer's v=0.75.
    const d: Design = {
      globals: splitParams(params()).globals,
      layers: [
        { ...layer({ wall: 2 }), curve: familyCurve("cone") },
        layer({ girth: 1, height: 100, lift: 50 }, { link: "nest", gap: 6 }),
      ],
    };
    const [outer, inner] = resolveLayers(d);
    const at = (vOuter: number) => sampleRadius(outer.curve, vOuter) * outer.params.girth - 2 - 6;
    expect(sampleRadius(inner.curve, 0)).toBeCloseTo(at(0.25), 1);
    expect(sampleRadius(inner.curve, 1)).toBeCloseTo(at(0.75), 1);
  });

  test("a free layer keeps its own curve array identity", () => {
    const d = twoLayer();
    expect(resolveLayers(d)[0].curve).toBe(d.layers[0].curve);
  });
});

describe("assembly", () => {
  test("aggregates height, footprint and holes across layers", () => {
    const d = twoLayer();
    d.layers[1].params.height = 240; // inner taller than outer
    const a = assembly(d);
    expect(a.height).toBe(240);
    expect(a.outerDia).toBeCloseTo(84 * 2, 0);
    expect(a.holeCount).toBe(a.perLayer[0].holeCount + a.perLayer[1].holeCount);
  });

  test("bulb gap is the minimum across layers — the innermost wall governs", () => {
    const d = twoLayer();
    const a = assembly(d);
    expect(a.bulbGap).toBeCloseTo(Math.min(...a.perLayer.map((pd) => pd.bulbGap)), 6);
    expect(a.perLayer[1].bulbGap).toBeLessThan(a.perLayer[0].bulbGap);
  });

  test("memoised slots keep untouched layers' resolved curve identity across calls", () => {
    const d = twoLayer();
    const first = assembly(d);
    // Edit only the INNER layer's gap: the outer layer's slot must be reused verbatim.
    d.layers[1].gap = 12;
    const second = assembly(d);
    expect(second.layers[0]).toBe(first.layers[0]);
    expect(second.layers[1]).not.toBe(first.layers[1]);
  });

  test("radial gap reports the designed clearance and goes negative on overlap", () => {
    const ok = assembly(twoLayer(6));
    expect(ok.gaps).toHaveLength(1);
    expect(ok.gaps[0].minGap).toBeCloseTo(6, 0);

    // A free inner layer WIDER than the outer: radial overlap, reported but never clamped.
    const clash: Design = {
      globals: splitParams(params()).globals,
      layers: [layer({ wall: 2 }), layer({ girth: 1.05 })],
    };
    const a = assembly(clash);
    expect(a.gaps[0].minGap).toBeLessThan(0);
    const lint = layerLint(clash, a);
    expect(lint.some((w) => /overlap/i.test(w.text))).toBe(true);
    expect(lint.every((w) => !w.bad)).toBe(true); // advisory: overlap is a legit multi-material design
  });

  test("a layer the fitter plane misses is flagged, advisory only", () => {
    const d = twoLayer();
    d.layers[1].params.height = 80; // fitterZ default 1.0 → plane at the outer top, far above this
    const a = assembly(d);
    const lint = layerLint(d, a);
    expect(lint.some((w) => /doesn't reach the fitter plane/.test(w.text))).toBe(true);
    expect(lint.every((w) => !w.bad)).toBe(true);
  });
});

describe("multi-ring fitter spec", () => {
  test("one support ring per extra layer at the plane, inside the plate", () => {
    const d = twoLayer(6);
    const a = assembly(d);
    const spec = fitterSpecAssembly(a);
    expect(spec.supportRings).toHaveLength(1);
    // The ring press-fits the INNER layer's inner surface: 76 − wall(1.6) − clearance(0.25).
    expect(spec.supportRings[0]).toBeCloseTo(76 - d.layers[1].params.wall - 0.25, 1);
    expect(spec.supportRings[0]).toBeLessThan(spec.outerR);
    expect(spec.supportRings[0]).toBeGreaterThan(spec.boreR);
  });

  test("a single layer yields the classic spec — no rings", () => {
    expect(fitterSpecAssembly(assembly(defaultDesign())).supportRings).toEqual([]);
  });
});

describe("working-state sanitizing", () => {
  test("saveWorking → loadWorking round-trips the whole stack", () => {
    // Regression: saveWorking once wrote {design, active} nested while the loader parsed the flat
    // shape — a reload silently dropped every layer but the default.
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    const d = twoLayer(9);
    saveWorking({ design: d, active: 1 }, storage);
    const back = loadWorking(storage);
    expect(back.design.layers).toHaveLength(2);
    expect(back.design.layers[1].link).toBe("nest");
    expect(back.design.layers[1].gap).toBe(9);
    expect(back.active).toBe(1);
  });

  test("garbage degrades to the default design", () => {
    const ws = sanitizeWorking("junk");
    expect(ws.design.layers).toHaveLength(1);
    expect(ws.active).toBe(0);
  });

  test("active index is clamped into the layer list", () => {
    const d = twoLayer();
    const ws = sanitizeWorking({ ...d, active: 99 });
    expect(ws.active).toBe(ws.design.layers.length - 1);
  });
});

describe("layer naming", () => {
  test("reads naturally at every count", () => {
    expect(layerName(0, 1)).toBe("Shade");
    expect(layerName(0, 2)).toBe("Outer");
    expect(layerName(1, 2)).toBe("Inner");
    expect(layerName(1, 3)).toBe("Mid 1");
    expect(layerName(2, 3)).toBe("Inner");
  });
});

describe("makeInnerLayer", () => {
  test("defaults to a solid nested diffuser in the next palette colour", () => {
    const outer = defaultLayer();
    outer.params.perfPattern = "stagger";
    const inner = makeInnerLayer(outer, 1);
    expect(inner.link).toBe("nest");
    expect(inner.params.perfPattern).toBe("none"); // the outer carries the pattern
    expect(inner.params.girth).toBe(1); // nesting defines the silhouette completely
    expect(inner.color).not.toBe(outer.color);
  });
});
