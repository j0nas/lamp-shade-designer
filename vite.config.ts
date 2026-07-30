import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  // Relative base so the built bundle works from any path — standalone at "/" and embedded under a
  // subdirectory on jonas-jensen.com. The dev server ignores a relative base and still serves at "/".
  base: "./",
  // parametric-kit is linked from a sibling checkout and has its own node_modules, so `three`
  // resolved twice — "Multiple instances of Three.js being imported". Two copies break every
  // instanceof across the boundary (and doubles the bundle), so force one.
  resolve: { dedupe: ["three"] },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  // Vitest config, bundled with vite-plus and run via `vp test`. Pure Node: the geometry probes
  // build the real Manifold solids (initCSG() finds the wasm next to its own module), and the
  // curve/section/perforation math needs no DOM.
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
