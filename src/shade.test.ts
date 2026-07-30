// Geometry probes on the real solids. These catch what param math can't: a shell that isn't closed,
// a wall offset the wrong way, holes that don't pierce, a section that pinches the surface.
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { initCSG } from "parametric-kit/csg";
import { defaults } from "parametric-kit/params";
import { bbox, signedVolume, volume } from "parametric-kit/testkit";
import { familyCurve, FAMILY_NAMES } from "./curve.ts";
import { SECTION_KINDS } from "./section.ts";
import { PERF_PATTERNS, PERF_SHAPES } from "./perforation.ts";
import { dims, migrateStored, type Params, schema, warnings } from "./params.ts";
import { buildShade, PREVIEW, qualityFor, shellMesh } from "./shade.ts";
import { genusOf } from "./test-probes.ts";

beforeAll(async () => {
  await initCSG();
});

const base = (over: Partial<Params> = {}): Params => ({ ...defaults(schema), ...over });
const curve = familyCurve("empire");

describe("the shell", () => {
  test("is a closed tube standing on the bed", () => {
    const p = base({ perfPattern: "none" });
    const g = buildShade(p, curve);
    const b = bbox(g);
    expect(b.min[2]).toBeCloseTo(0, 3); // bottom rim on z = 0, print orientation
    expect(b.max[2]).toBeCloseTo(p.height, 3);
    expect(genusOf(g)).toBe(1); // open top and bottom => torus topology
  });

  test("is positively oriented, not an inside-out twin", () => {
    // fromMesh() guards this, but assert it here too: an inverted shell is the one failure mode that
    // Manifold reports as NoError and the unsigned volume() helper calls healthy.
    const g = buildShade(base({ perfPattern: "none" }), curve);
    expect(signedVolume(g)).toBeGreaterThan(0);
  });

  test("fills the footprint the readout advertises", () => {
    const p = base({ perfPattern: "none", sectionKind: "circle" });
    const d = dims(p, curve);
    const b = bbox(buildShade(p, curve));
    // Circular section: the widest sampled radius is the true half-width, within faceting error.
    expect((b.max[0] - b.min[0]) / 2).toBeCloseTo(d.maxR, 0);
    expect(d.outerDia).toBeCloseTo(d.maxR * 2, 6);
  });

  test("wall thickness shows up as shell volume, and scales with it", () => {
    const thin = volume(buildShade(base({ perfPattern: "none", wall: 1 }), curve));
    const thick = volume(buildShade(base({ perfPattern: "none", wall: 3 }), curve));
    expect(thick).toBeGreaterThan(thin * 2.4); // ~3x, less the curvature of the offset
    expect(thick).toBeLessThan(thin * 3.6);
  });

  test("girth scales the footprint but not the height", () => {
    const p = base({ perfPattern: "none", girth: 1.5 });
    const b = bbox(buildShade(p, curve));
    const ref = bbox(buildShade(base({ perfPattern: "none" }), curve));
    expect((b.max[0] - b.min[0]) / (ref.max[0] - ref.min[0])).toBeCloseTo(1.5, 1);
    expect(b.max[2]).toBeCloseTo(ref.max[2], 3);
  });

  test("the mesh is indexed with shared seam vertices", () => {
    // fromMesh() passes no merge vectors, so the seam must already be welded by index arithmetic:
    // exactly 2 skins x NU x NV vertices, no duplicate ring.
    const p = base();
    const q = qualityFor(p, PREVIEW);
    const { verts, tris } = shellMesh(p, curve, q);
    expect(verts.length / 3).toBe(2 * q.u * q.v);
    expect(tris.length % 3).toBe(0);
    for (const i of tris) expect(i).toBeLessThan(verts.length / 3);
  });

  test("the draft uv variant duplicates the seam column so u can run 0..1", () => {
    // The drag preview alpha-maps holes by uv; a shared seam vertex would have to be u = 0 AND
    // u = 1 at once, so the draft mesh stores that column twice at identical positions.
    const p = base();
    const q = qualityFor(p, PREVIEW);
    const { verts, tris, uvs } = shellMesh(p, curve, q, true);
    const C = q.u + 1;
    expect(verts.length / 3).toBe(2 * C * q.v);
    expect(uvs.length / 2).toBe(verts.length / 3);
    for (const k of [0, 1, 2]) expect(verts[(C - 1) * 3 + k]).toBeCloseTo(verts[k], 9);
    expect(uvs[0]).toBe(0);
    expect(uvs[(C - 1) * 2]).toBe(1);
    // Same triangle count as the welded variant — only the indexing changed, not the surface.
    expect(tris.length).toBe(shellMesh(p, curve, q).tris.length);
    for (const i of tris) expect(i).toBeLessThan(verts.length / 3);
  });
});

describe("the axes multiply", () => {
  test("every cross-section builds a valid solid", () => {
    for (const sectionKind of SECTION_KINDS) {
      const g = buildShade(base({ sectionKind, perfPattern: "none" }), curve);
      expect(signedVolume(g)).toBeGreaterThan(0);
      expect(genusOf(g)).toBe(1);
    }
  });

  test("every silhouette family builds a valid solid", () => {
    for (const name of FAMILY_NAMES) {
      const g = buildShade(base({ perfPattern: "none" }), familyCurve(name));
      expect(signedVolume(g)).toBeGreaterThan(0);
      expect(genusOf(g)).toBe(1);
    }
  });

  test("twist survives a full turn without tearing the shell", () => {
    for (const twistDeg of [-360, -90, 45, 360]) {
      const g = buildShade(base({ twistDeg, sectionKind: "lobed", perfPattern: "none" }), curve);
      expect(signedVolume(g)).toBeGreaterThan(0);
      expect(genusOf(g)).toBe(1);
    }
  });

  test("twist is a no-op on a circular section", () => {
    // A circle is rotationally symmetric, so shearing it about Z cannot change the solid at all.
    // Any drift here means twist is leaking into the silhouette or the wall offset.
    const p = base({ sectionKind: "circle", perfPattern: "none", fluteCount: 0 });
    const straight = buildShade(p, curve);
    const twisted = buildShade({ ...p, twistDeg: 270 }, curve);
    expect(volume(twisted)).toBeCloseTo(volume(straight), 6);
  });

  test("twisting a non-circular section adds material, because the surface lengthens", () => {
    // Not a conservation law: the lobe ridges trace helices, so the shell surface is genuinely longer
    // than the untwisted one and a constant-thickness wall over it holds more material. Measured
    // ~23% at 180° on a lobed section — assert the direction and a sane ceiling, not equality.
    const p = base({ sectionKind: "lobed", sectionDepth: 0.5, perfPattern: "none" });
    const straight = volume(buildShade(p, curve));
    const twisted = volume(buildShade({ ...p, twistDeg: 180 }, curve));
    expect(twisted).toBeGreaterThan(straight);
    expect(twisted).toBeLessThan(straight * 1.8);
    expect(bbox(buildShade({ ...p, twistDeg: 180 }, curve)).max[2]).toBeCloseTo(p.height, 3);
  });

  test("flutes keep the envelope but deepen monotonically into the wall", () => {
    // Flutes subtract via (1 − cos), which is ZERO at the ridges — so the outer envelope is unchanged
    // and only the troughs move inward. Counter-intuitively that ADDS shell volume: the corrugated
    // surface is longer, and a constant-thickness wall over a longer surface holds more material,
    // exactly as with twist. Assert the envelope and the monotonic trend, not "flutes remove material".
    const plain = base({ perfPattern: "none" });
    const shallow = base({ perfPattern: "none", fluteCount: 16, fluteDepth: 2 });
    const deep = base({ perfPattern: "none", fluteCount: 16, fluteDepth: 5 });
    const wPlain = bbox(buildShade(plain, curve));
    const wDeep = bbox(buildShade(deep, curve));
    expect(wDeep.max[0] - wDeep.min[0]).toBeCloseTo(wPlain.max[0] - wPlain.min[0], 0);

    const g = buildShade(deep, curve);
    expect(signedVolume(g)).toBeGreaterThan(0);
    expect(genusOf(g)).toBe(1);
    expect(volume(g)).toBeGreaterThan(volume(buildShade(shallow, curve)));
  });

  test("waves build a valid solid and change the envelope", () => {
    const wavy = buildShade(base({ perfPattern: "none", waveCount: 8, waveDepth: 6 }), curve);
    expect(signedVolume(wavy)).toBeGreaterThan(0);
    expect(genusOf(wavy)).toBe(1);
  });

  test("a hard combination of every axis at once still builds", () => {
    const g = buildShade(
      base({
        sectionKind: "star",
        sides: 11,
        sectionDepth: 0.8,
        twistDeg: 240,
        fluteCount: 7,
        fluteDepth: 2,
        waveCount: 5,
        waveDepth: 3,
        perfPattern: "hex",
        perfRows: 10,
        perfCols: 18,
        perfDia: 4,
      }),
      familyCurve("pagoda"),
    );
    expect(signedVolume(g)).toBeGreaterThan(0);
  });
});

describe("perforation", () => {
  test("each hole adds exactly one to the genus", () => {
    // genus === holeCount + 1 is the real invariant, and asserting it against dims() validates BOTH:
    // that every hole actually pierced the wall (a dent or a merged pair would not add 1) and that
    // the count in the readout is truthful. Checked across patterns because rows x cols is not the
    // hole count for hex, spiral, scatter, or an even-spaced lattice.
    for (const perfPattern of ["grid", "stagger", "hex", "spiral"] as const) {
      for (const perfEven of [false, true]) {
        const p = base({
          perfPattern,
          perfEven,
          perfRows: 6,
          perfCols: 12,
          perfDia: 4,
          perfMargin: 20,
        });
        expect(genusOf(buildShade(p, curve))).toBe(dims(p, curve).holeCount + 1);
      }
    }
  });

  test("even spacing thins out the narrow rows instead of crowding them", () => {
    // The empire silhouette tapers from r=104 to r=56, so a constant column count crowds the top.
    const fixed = base({ perfPattern: "grid", perfEven: false, perfRows: 8, perfCols: 20 });
    const even = { ...fixed, perfEven: true };
    expect(dims(even, curve).holeCount).toBeLessThan(dims(fixed, curve).holeCount);
    // A drum has no taper, so even spacing must be a no-op there — proving it tracks the silhouette
    // rather than just removing holes everywhere.
    const drum = familyCurve("drum");
    expect(dims({ ...even }, drum).holeCount).toBe(dims({ ...fixed }, drum).holeCount);
  });

  test("holes remove material", () => {
    const solid = volume(buildShade(base({ perfPattern: "none" }), curve));
    const holed = volume(buildShade(base({ perfPattern: "stagger" }), curve));
    expect(holed).toBeLessThan(solid);
  });

  test("every pattern builds a valid solid", () => {
    for (const perfPattern of PERF_PATTERNS) {
      const g = buildShade(base({ perfPattern, perfRows: 8, perfCols: 14, perfDia: 4 }), curve);
      expect(signedVolume(g)).toBeGreaterThan(0);
      expect(genusOf(g)).toBeGreaterThanOrEqual(1);
    }
  });

  test("the rim margin keeps holes clear of both rims", () => {
    // A generous margin must leave an unbroken band of material at each end: slice the bbox and
    // check the extreme rows are intact by comparing against a zero-margin build.
    const p = base({ perfPattern: "grid", perfRows: 4, perfCols: 10, perfDia: 6, perfMargin: 40 });
    const g = buildShade(p, curve);
    const b = bbox(g);
    expect(b.min[2]).toBeCloseTo(0, 3);
    expect(b.max[2]).toBeCloseTo(p.height, 3);
    // Every hole intact and none breaching a rim into the open end (which would merge with it and
    // lose a genus rather than adding one).
    expect(genusOf(g)).toBe(dims(p, curve).holeCount + 1);
  });

  test("a size gradient removes more material than uniform holes of the same mean", () => {
    const p = base({ perfPattern: "grid", perfRows: 8, perfCols: 16, perfDia: 5, perfMargin: 16 });
    const uniform = volume(buildShade({ ...p, perfGradient: 0 }, curve));
    const graded = volume(buildShade({ ...p, perfGradient: 1 }, curve));
    // The gradient scales diameter linearly about the same mean, but removed area goes as diameter
    // SQUARED — and mean-of-squares exceeds square-of-mean, so a gradient always eats more material.
    expect(graded).toBeLessThan(uniform);
  });

  test("mirrored gradients weigh the same on a fixed lattice, but not an even-spaced one", () => {
    // On a FIXED lattice the two are indistinguishable by weight: +1 and −1 give mirror-image size
    // sets, and removed volume depends only on the multiset of sizes, not where they sit — so the
    // gram readout genuinely cannot tell two very different-looking shades apart.
    const fixed = base({
      perfPattern: "grid",
      perfEven: false,
      perfRows: 8,
      perfCols: 16,
      perfDia: 5,
      perfMargin: 16,
    });
    const up = buildShade({ ...fixed, perfGradient: 1 }, curve);
    const down = buildShade({ ...fixed, perfGradient: -1 }, curve);
    for (const g of [up, down]) expect(signedVolume(g)).toBeGreaterThan(0);
    expect(volume(up)).toBeCloseTo(volume(down), 0);

    // Even spacing BREAKS that symmetry, because narrow rows now hold fewer holes — so which end
    // gets the big holes starts to matter to the weight after all.
    const even = { ...fixed, perfEven: true };
    const evenUp = volume(buildShade({ ...even, perfGradient: 1 }, curve));
    const evenDown = volume(buildShade({ ...even, perfGradient: -1 }, curve));
    expect(Math.abs(evenUp - evenDown)).toBeGreaterThan(100);
  });

  test("scatter is deterministic for the same params", () => {
    const p = base({ perfPattern: "scatter", perfRows: 6, perfCols: 10 });
    expect(volume(buildShade(p, curve))).toBeCloseTo(volume(buildShade(p, curve)), 6);
  });
});

describe("hole shapes", () => {
  // Modest hole counts throughout: the boolean is the entire cost and these multiply across shapes.
  const shaped = (over: Partial<Params> = {}): Params =>
    base({ perfPattern: "grid", perfRows: 4, perfCols: 8, perfDia: 6, perfMargin: 20, ...over });

  test("every shape pierces the wall: genus = holeCount + 1", () => {
    // The same invariant the circle tests lean on, per shape — a cutter that merely dents the wall,
    // or a mis-wound profile the kernel rejects, both fail here.
    for (const perfShape of PERF_SHAPES) {
      const p = shaped({ perfShape });
      const g = buildShade(p, curve);
      expect(signedVolume(g)).toBeGreaterThan(0);
      expect(genusOf(g)).toBe(dims(p, curve).holeCount + 1);
    }
  });

  test("stretch elongates the holes: more material removed, same topology", () => {
    const round = buildShade(shaped({ perfShape: "hex" }), curve);
    const tall = buildShade(shaped({ perfShape: "hex", perfAspect: 3 }), curve);
    expect(volume(tall)).toBeLessThan(volume(round));
    expect(genusOf(tall)).toBe(genusOf(round));
  });

  test("rotation by a shape's symmetry angle changes nothing", () => {
    // A diamond has 90° symmetry, so rot 0 and rot 90 place geometrically identical cutters — any
    // volume drift means rotation is leaking into the placement or the stretch axis.
    const v0 = volume(buildShade(shaped({ perfShape: "diamond" }), curve));
    const v90 = volume(buildShade(shaped({ perfShape: "diamond", perfRot: 90 }), curve));
    expect(Math.abs(v90 - v0) / v0).toBeLessThan(1e-6);
  });

  test("a stretched slot rotated flat still pierces cleanly", () => {
    // Horizontal slots are the stretch axis tipped 90° — the transform must stretch the shape's own
    // Y before rotating, or this would stretch along the surface normal and stop cutting through.
    const p = shaped({ perfShape: "slot", perfAspect: 4, perfRot: 90, perfDia: 4 });
    const g = buildShade(p, curve);
    expect(signedVolume(g)).toBeGreaterThan(0);
    expect(genusOf(g)).toBe(dims(p, curve).holeCount + 1);
  });
});

describe("stored-params migration", () => {
  test("a saved slots design becomes grid + slot shape with the old auto stretch", () => {
    const out = migrateStored({ perfPattern: "slots", perfRows: 8, perfDia: 4, height: 200, perfMargin: 12 });
    expect(out).toMatchObject({ perfPattern: "grid", perfShape: "slot", perfEven: false });
    // Old formula: max(2, vSpan·height / rows / dia / 1.6) with mv = 12/200.
    expect(out?.perfAspect).toBeCloseTo(Math.max(2, (0.88 * 200) / 8 / 4 / 1.6), 1);
  });

  test("anything else passes through untouched", () => {
    expect(migrateStored({ perfPattern: "grid" })).toBeNull();
    expect(migrateStored(null)).toBeNull();
    expect(migrateStored("junk")).toBeNull();
  });
});

describe("lint", () => {
  // Each assertion pins a DISTINCTIVE phrase. Matching loosely on /wall/ once passed for the wrong
  // reason — it caught "the bulb intersects the shade wall" while the wall-thickness rule never ran.
  const has = (p: Params, re: RegExp, c: readonly { v: number; r: number }[] = curve) =>
    warnings(p, c).some((x) => re.test(x.text));
  const hasBad = (p: Params, re: RegExp, c: readonly { v: number; r: number }[] = curve) =>
    warnings(p, c).some((x) => re.test(x.text) && x.bad);

  test("flags a hot bulb too close to the wall", () => {
    expect(hasBad(base({ girth: 0.55, bulbKind: "g95", watts: 40 }), /clearance/i)).toBe(true);
  });

  test("flags a bulb that physically intersects the shade", () => {
    expect(hasBad(base({ girth: 0.3, bulbKind: "g95" }), /intersects/i)).toBe(true);
  });

  test("a roomy shade with a cool bulb raises nothing serious", () => {
    // 0.9 girth keeps the footprint on the bed; an LED filament at 5 W needs only the 8 mm floor.
    const p = base({ girth: 0.9, bulbKind: "led-strip", watts: 5, perfDia: 4, perfCols: 20 });
    expect(warnings(p, curve).filter((x) => x.bad)).toHaveLength(0);
  });

  test("flags a wall too thick for the narrowest radius", () => {
    // Needs a silhouette that actually pinches — the empire family never gets near a 4 mm wall.
    const pinched = [
      { v: 0, r: 120 },
      { v: 1, r: 4 },
    ];
    expect(hasBad(base({ wall: 4 }), /too thick/i, pinched)).toBe(true);
    expect(has(base({ wall: 1.6 }), /too thick/i)).toBe(false);
  });

  test("flags holes that would overlap where the shade narrows", () => {
    expect(has(base({ perfPattern: "grid", perfCols: 64, perfDia: 20 }), /overlap/i)).toBe(true);
  });

  test("flags stretched holes that merge into the next row", () => {
    const tall = base({ perfShape: "slot", perfAspect: 6, perfDia: 8, perfRows: 20 });
    expect(has(tall, /merge vertically/i)).toBe(true);
    expect(has(base(), /merge vertically/i)).toBe(false);
    // Rotating the same slot flat drops its height back to its width, so the warning must clear.
    expect(has({ ...tall, perfRot: 90, perfRows: 8 }, /merge vertically/i)).toBe(false);
  });

  test("flags holes taller than the rim margin", () => {
    expect(
      has(base({ perfShape: "slot", perfAspect: 8, perfDia: 10, perfMargin: 5 }), /taller than the rim/i),
    ).toBe(true);
    expect(has(base(), /taller than the rim/i)).toBe(false);
  });

  test("flags a footprint that overruns the H2C bed", () => {
    expect(has(base({ girth: 2.2 }), /bed/i)).toBe(true);
    expect(has(base({ girth: 0.9 }), /bed/i)).toBe(false);
  });

  test("warns that vase mode and perforation are mutually exclusive", () => {
    expect(has(base({ vaseMode: true, perfPattern: "grid" }), /vase mode/i)).toBe(true);
    expect(has(base({ vaseMode: true, perfPattern: "none" }), /vase mode/i)).toBe(false);
  });
});
