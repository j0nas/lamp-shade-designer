# lamp-shade-designer

A browser parametric designer for 3D-printable lamp shades, built on
[parametric-kit](../parametric-kit). Design by dragging the silhouette and watching what the shade
throws on a wall, then export STL for the shade and true B-rep **STEP** for the fitter.

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
perforation.ts  patterns -> placements in (u,v) parameter space; hole-shape ids (pure, deterministic)
perf-texture.ts placements -> drag-preview alpha map (pure polygon math + a CanvasTexture)
params.ts       schema + dims() + printability/electrical lint
shade.ts        S(u,v) shell -> indexed mesh -> Manifold via fromMesh() -> batched perforation cut
fitter.ts       fitter in Manifold (preview + STL) + fitterSpec() shared with the STEP builder
fitter-step.ts  the SAME spec in replicad/OCCT -> true analytic STEP (lazily imported)
lit.ts          CAD vs lamp lighting modes
curve-editor.ts draggable silhouette canvas
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
2. **Draft while you drag.** Every change asks for `DRAFT` — no perforation cut, reduced
   resolution — and a 180 ms settle timer then asks for the full `PREVIEW`. A draft is **0.8 ms**
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

The dev build publishes `window.__app` (`params`, `curve`, `rebuild()`, `rebuildSync()`, `render()`,
`dims()`, `viewer`, `lighting`). Don't screenshot the viewer directly — rAF pauses while the window
is occluded, so a capture can be a stale frame. Instead: set params → `rebuildSync()` → `render()` →
`canvas.toDataURL()`. Use `rebuildSync()`, not `rebuild()`: the normal path is a worker round trip,
so it would photograph the previous mesh.

`resolve.dedupe: ["three"]` is required: the kit is a `link:` dependency with its own
`node_modules`, so `three` otherwise resolves twice and every `instanceof` across the boundary breaks.

## Not done yet

- 3MF export (button disabled; STL covers the same slicers).
- STL/STEP export still builds on the main thread, so a dense export blocks the tab for seconds. It
  is a deliberate click rather than an interactive frame, and the worker client is fire-and-forget
  (latest-wins would let an export be superseded), so it needs its own request path.
- Variant gallery (render N thumbnails across one axis, click to adopt).
- Clip-on fitter arms are modelled as straight cantilevers; a real sprung clip needs flex that
  geometry alone can't express. Print in PETG and expect to tune the grip radius.
