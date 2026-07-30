// Toolchain smoke test: the linked kit resolves through its built dist, its subpath exports work,
// the Manifold wasm loads under plain Node, and the new fromMesh() op is reachable from the app.
// Superseded by the real geometry suites once shade.ts lands.
import { beforeAll, expect, test } from "vite-plus/test";
import { initCSG, scope } from "parametric-kit/csg";
import { bbox, signedVolume, volume } from "parametric-kit/testkit";

beforeAll(async () => {
  await initCSG();
});

test("kit csg builds a solid under Node", () => {
  const s = scope();
  const g = s.finish(s.box(10, 20, 30));
  expect(volume(g)).toBeCloseTo(10 * 20 * 30, 3);
  const b = bbox(g);
  expect(b.max[0] - b.min[0]).toBeCloseTo(10, 6);
  expect(b.max[2] - b.min[2]).toBeCloseTo(30, 6);
});

test("fromMesh adopts a hand-generated tube, right way out", () => {
  // Minimal stand-in for the real shade shell: a square-section tube, outer + inner skin + two cap
  // annuli. Topologically a torus, so genus 1 — the same signature the 128x80 shell must have.
  const N = 4;
  const H = 10;
  const RO = 5;
  const RI = 4;
  const verts: number[] = [];
  const tris: number[] = [];
  for (const r of [RO, RI]) {
    for (const z of [0, H]) {
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        verts.push(r * Math.cos(a), r * Math.sin(a), z);
      }
    }
  }
  const o = (i: number, top: number) => top * N + (i % N); // outer rings 0..7
  const n = (i: number, top: number) => 2 * N + top * N + (i % N); // inner rings 8..15
  for (let i = 0; i < N; i++) {
    // outer skin faces out
    tris.push(o(i, 0), o(i + 1, 0), o(i + 1, 1), o(i, 0), o(i + 1, 1), o(i, 1));
    // inner skin faces in (reversed)
    tris.push(n(i, 0), n(i + 1, 1), n(i + 1, 0), n(i, 0), n(i, 1), n(i + 1, 1));
    // bottom annulus (normal −Z) and top annulus (normal +Z)
    tris.push(o(i, 0), n(i, 0), n(i + 1, 0), o(i, 0), n(i + 1, 0), o(i + 1, 0));
    tris.push(o(i, 1), o(i + 1, 1), n(i + 1, 1), o(i, 1), n(i + 1, 1), n(i, 1));
  }

  const s = scope();
  const g = s.finish(s.fromMesh(new Float32Array(verts), new Uint32Array(tris)));
  // Square-section prism ring: outer 2*RO^2 minus inner 2*RI^2, times height.
  const expected = (2 * RO * RO - 2 * RI * RI) * H;
  expect(signedVolume(g)).toBeCloseTo(expected, 3); // signed: proves it is not inside-out
  const b = bbox(g);
  expect(b.min[2]).toBeCloseTo(0, 6);
  expect(b.max[2]).toBeCloseTo(H, 6);
});
