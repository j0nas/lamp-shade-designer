import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";

// Version stamp for provenance: package version + short commit, baked in at build time so every
// exported design file and STL header says exactly which app produced it. The try/catch covers
// builds outside a git checkout; designs.ts additionally guards with typeof so plain-Node tests
// never need the define at all.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};
let sha = "dev";
try {
  sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
} catch {
  /* tarball build — the package version alone still identifies the release */
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(`${pkg.version}+${sha}`) },
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
