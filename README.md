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
  perforation. Eight silhouettes times six sections times seven patterns is thousands of distinct
  shades from a small amount of code, and exploring them is a slider drag rather than 20 edits.

What it deliberately gives up: it makes the shades it was programmed to make. Anything outside that
envelope is a code change, not a click.

## Architecture

```
curve.ts        silhouette as control points + Catmull-Rom sampler + families (pure)
section.ts      cross-section radial functions, normalised to max radius 1 (pure)
perforation.ts  patterns -> placements in (u,v) parameter space (pure, deterministic)
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
- A 128×80 shell plus 360 batched perforations is ~130 ms (1 ms mesh generation, 18 ms `ofMesh`,
  ~109 ms booleans). Rebuilds are rAF-coalesced on the main thread; if a fast drag feels bad this
  moves to `parametric-kit/worker` with no change to the builders.
- Manifold accepts a _uniformly inverted_ mesh with `status: NoError` and negative volume. The kit's
  `fromMesh()` now guards the sign, because the unsigned `volume()` helper reports such a solid as
  perfectly healthy while the STL is inside-out.
- Twisting a non-circular section **adds** shell material (~23% at 180°): the lobe ridges trace
  helices, so the surface is longer and a constant-thickness wall over it holds more. Flutes do the
  same thing for the same reason, despite cutting inward.

## Development

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # geometry probes; use pnpm, never a global vp (it drags in a second vitest)
pnpm run build  # tsc && vp build
```

The dev build publishes `window.__app` (`params`, `curve`, `rebuild()`, `render()`, `dims()`,
`viewer`, `lighting`). Don't screenshot the viewer directly — rAF pauses while the window is
occluded, so a capture can be a stale frame. Instead: set params → `rebuild()` → `render()`
(synchronous) → `canvas.toDataURL()`.

`resolve.dedupe: ["three"]` is required: the kit is a `link:` dependency with its own
`node_modules`, so `three` otherwise resolves twice and every `instanceof` across the boundary breaks.

## Not done yet

- 3MF export (button disabled; STL covers the same slicers).
- Worker-backed rebuilds — measured as not yet necessary, wired for it if it becomes so.
- Variant gallery (render N thumbnails across one axis, click to adopt).
- Clip-on fitter arms are modelled as straight cantilevers; a real sprung clip needs flex that
  geometry alone can't express. Print in PETG and expect to tune the grip radius.
