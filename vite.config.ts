import { execSync } from "node:child_process";
import { defineConfig } from "vite-plus";

// Version stamp for provenance: build date + short commit, baked in at build time so every
// exported design file, STL header and 3MF metadata block says exactly which app produced it.
// Date rather than package version because this app is unpublished — its version field sat at
// 0.0.0 forever, so "0.0.0+abc1234" told a human nothing while "2026-07-31+abc1234" answers the
// question a year-old file actually raises. The try/catch covers builds outside a git checkout;
// designs.ts additionally guards with typeof so plain-Node tests never need the define at all.
let sha = "dev";
try {
  sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
} catch {
  /* tarball build — the date alone still identifies the vintage */
}
const buildDate = new Date().toISOString().slice(0, 10);

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(`${buildDate}+${sha}`) },
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
