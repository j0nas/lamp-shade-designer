# lamp-shade-designer

A browser parametric designer for 3D-printable lamp shades, built on
[parametric-kit](../parametric-kit). Design by dragging the silhouette and watching what the shade
throws on a wall, then export STL for the shade and true B-rep **STEP** for the fitter.

A design is a **stack of layers** — up to six nested shells, each a full shade definition (own
silhouette, section, modulation, perforation, wall, colour, translucency) around one shared light
and fitter. The canonical build: a perforated translucent outer skin over a solid coloured inner
diffuser. A layer can nest (silhouette derived from the next-outer layer at a fixed air gap) or be
fully free — including intersecting its neighbours, which is linted but never clamped, because
interlocked shells are a legitimate multi-material print. The all-layers 3MF exports every shell as
its own named, coloured object so a multi-nozzle slicer maps filaments per layer; the fitter grows
one press ring per layer at the mount plane so a single plate carries the whole assembly.

## Why not Fusion 360

Two things this does that a CAD package structurally cannot:

- **Lit preview.** An emissive bulb at the real socket height, inside the shade, casting the actual
  perforation pattern onto a floor and back wall — with wall thickness driving how much the shade
  glows. You are designing a light; Fusion shows you a grey solid.
- **Orthogonal axes that multiply.** Silhouette × cross-section × twist × flutes × waves ×
  perforation pattern × hole shape. Eight silhouettes times six sections times six patterns times
  seven hole shapes is tens of thousands of distinct shades from a small amount of code, and exploring them is a slider drag rather than 20 edits.

What it deliberately gives up: it makes the shades it was programmed to make. Anything outside that
envelope is a code change, not a click.

## Architecture

```
curve.ts        silhouette as control points + Catmull-Rom sampler + families (pure)
section.ts      cross-section radial functions, normalised to max radius 1 (pure)
surface.ts      S(u,v): the axes combined — plus the modulated MINIMUM radius that press fits
                and clearance lint must use (silhouette alone ignores flutes/waves) (pure)
perforation.ts  patterns -> placements in (u,v) parameter space; hole-shape ids (pure, deterministic)
perf-texture.ts placements -> drag-preview alpha map (pure polygon math + a CanvasTexture)
params.ts       flat schema + dims() + printability/electrical lint; layer/global key partition
layers.ts       the layer model: nest resolution, assembly aggregation, cross-layer lint,
                working-state persistence + v1 migration (pure)
lint.ts         composes per-layer + fitter + overhang + cross-layer warnings into one list
shade.ts        surface -> indexed mesh -> Manifold via fromMesh() -> batched perforation cut
fitter.ts       fitter in Manifold (preview + STL) + fitterSpec() shared with the STEP builder;
                fitterSpecAssembly() adds one support ring per extra layer at the mount plane
fitter-step.ts  the SAME spec in replicad/OCCT -> true analytic STEP (lazily imported)
threemf.ts      minimal 3MF writer: multi-object, per-object name + displaycolor, stored zip (pure)
lit.ts          CAD vs lamp vs overhang view modes, one physical material PER LAYER
curve-editor.ts the silhouette editor: world-mm canvas with grid, bulb keep-out, layer ghosts,
                frozen-scale drags, fine mode, ghost-point add, nudge keys, numeric inspector
build-worker.ts the whole geometry pipeline off-thread; per-layer preview cache; spawned twice
main.ts         wiring (browser only: the ?url wasm import lives here)
```

Units are millimetres, Z-up, and every part is built **in print orientation** — the shade's bottom
rim and the fitter's plate both sit on z = 0.

### Two kernels, one spec

The shade is perforation-heavy (hundreds of booleans), which is Manifold's strength and OCCT's
weakness. The fitter needs STEP, which requires OCCT. So the fitter is built twice — and both
builders read one `fitterSpec()`, so they can differ in construction but never in dimensions.
`fitter-equivalence.test.ts` asserts their volume and bounds agree, and that the STEP output really
contains `CYLINDRICAL_SURFACE` entities rather than being a faceted mesh in a STEP wrapper.

The B-rep is slightly _larger_ than the mesh (~0.2%) because Manifold's annuli are inscribed 64-gons
while OCCT's are exact circles. The test asserts that direction explicitly.

## Measured behaviour

Things established by experiment, not assumption:

- `Manifold.ofMesh()` does **not** leak: 0.00 MB of `external` growth over 200 full rebuilds. A
  pre-indexed mesh skips `Mesh.merge()`, which is the call that leaks in 3.5.1.
- **The perforation boolean is essentially the entire rebuild cost.** Measured with `bench/bench.ts`:
  at default settings the shell mesh is 1.9 ms and `ofMesh` 10 ms, while subtracting 336 cutters is
  130 ms. Nothing else is worth optimising until that is — see "Rebuild pipeline" below.
- Boolean cost tracks the cutters' **triangle count** almost linearly, not their number: at 4608
  holes, 16-segment cutters take 14.7 s, 8-segment 6.4 s, 5-segment 4.0 s. It is also superlinear in
  hole count (~n^1.6), which is why dense patterns fall off a cliff.
- `Manifold.compose()` (topological concatenation of disjoint solids) is **no faster** than
  `Manifold.union()` here — tested and discarded. The union of the cutter field was never the cost;
  the difference against the shell is. Batching the subtraction buys ~16%, not enough to justify the
  extra intermediates.
- Manifold is **lazy**: `sub`/`union` only build a DAG, and the whole boolean is evaluated by the
  first call that needs the result. Timing the ops themselves reports ~0 ms and blames `getMesh()`.
  `buildShade()` forces evaluation with `numTri()` so its phase split means something.
- Manifold accepts a _uniformly inverted_ mesh with `status: NoError` and negative volume. The kit's
  `fromMesh()` now guards the sign, because the unsigned `volume()` helper reports such a solid as
  perfectly healthy while the STL is inside-out.
- Twisting a non-circular section **adds** shell material (~23% at 180°): the lobe ridges trace
  helices, so the surface is longer and a constant-thickness wall over it holds more. Flutes do the
  same thing for the same reason, despite cutting inward.

## Rebuild pipeline

Dragging a control must not wait on a boolean that takes 130 ms at default settings and 6.6 s at
4608 holes. Three things keep the app live, in order of how much they buy:

1. **Everything builds in a worker** (`build-worker.ts`, `parametric-kit/worker`) with latest-wins
   scheduling — one build in flight, mid-drag requests dropped rather than queued. The main thread
   blocks for **0 ms** per input event, measured; it was 170 ms.
2. **Draft while you drag — active layer only.** Every change asks for `DRAFT` — no perforation
   cut, reduced resolution, and just the layer being edited; the other shells keep their settled
   meshes. The settled `PREVIEW` rebuilds every layer, but the worker caches each layer's build
   keyed on its RESOLVED inputs (params + derived curve), so untouched layers cost a cache hit and
   a multi-layer drag settles at single-shade cost. A draft is **0.8 ms**
   because with no cutters there is no boolean, and therefore no reason to enter the kernel at all:
   `buildShade()` returns the shell triangles directly as a `BufferGeometry`. Anything that becomes
   an STL still goes through Manifold and is still validated.
   The perforation stays visible anyway: `perf-texture.ts` rasterises the same `(u, v)` placements
   into an alpha map that is alpha-tested onto the draft (surface, depth and distance materials, so
   lamp-mode shadows stay truthful too). Preview cost is therefore independent of hole count — a
   4608-hole scatter drags at draft speed with every hole live — and the settled build swaps in the
   real cut geometry, so nothing alpha-mapped is ever exported.
3. **Preview cutters are coarser than export cutters.** `Quality.cut` is 8 for preview and 16 for
   export, which halves the boolean. A 6 mm hole is ~20 px on screen, where the difference is
   invisible; the ratios in `cutterSegments()` reproduce the old 12/10/16 exactly at `cut = 16`, so
   **exported geometry is unchanged**.
4. **Drafts skip the fitter entirely.** It cannot change enough mid-drag to matter for the ~180 ms
   until the settled preview lands, and building it would double the cost of the one build that has
   to fit inside a frame. The readout's rebuild time is the whole worker round trip (shade + fitter),
   not just the shade's phase split.

Exports run on a **second, dedicated worker** (same `build-worker.ts` entry, spawned twice): a
seconds-long dense export neither freezes the tab nor queues against live drag rebuilds. The worker
builds at `EXPORT` quality, stamps provenance (STL header / 3MF metadata) and transfers the bytes;
the main thread only turns them into a download.

Derived values are kept off the hot path too: the geometry builders take `effectiveWall(p)` rather
than calling the expensive `dims()` for one field, `dims()` memoises its hole count (it materialises
every placement to count them), and `warnings()` accepts an already-computed `Dims`.

```bash
node bench/bench.ts          # phase-split rebuild benchmark
node bench/bench.ts --json   # machine-readable, for diffing two revisions
BENCH_ONLY=dense BENCH_RUNS=3 node bench/bench.ts   # one case while iterating
```

## Development

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # geometry probes; use pnpm, never a global vp (it drags in a second vitest)
pnpm run build  # tsc && vp build
```

The dev build publishes `window.__app` (`params`, `design`, `active`, `setActive()`,
`addInnerLayer()`, `curve`, `shades()`, `rebuild()`, `rebuildSync()`, `render()`, `dims()` — the
assembly — `viewer`, `lighting`, `curveEditor`). Don't screenshot the viewer directly — rAF pauses while the window
is occluded, so a capture can be a stale frame. Instead: set params → `rebuildSync()` → `render()` →
`canvas.toDataURL()`. Use `rebuildSync()`, not `rebuild()`: the normal path is a worker round trip,
so it would photograph the previous mesh.

`resolve.dedupe: ["three"]` is required: the kit is a `link:` dependency with its own
`node_modules`, so `three` otherwise resolves twice and every `instanceof` across the boundary breaks.

## Not done yet

- STEP export still builds on the main thread (rare, deliberate click; OCCT loads lazily anyway).
- Variant gallery (render N thumbnails across one axis, click to adopt).
- Clip-on fitter arms are modelled as straight cantilevers; a real sprung clip needs flex that
  geometry alone can't express. Print in PETG and expect to tune the grip radius.
