# parametric-kit (frozen copy)

This is a frozen copy of the parametric-kit modules that lamp-shade-designer uses: `csg`,
`export`, `params`, `readout`, `testkit`, `viewer` and `worker`. Tests, the build and the other
modules (`bambu`, `laser`, `gridfinity`, `shapes`, `text`) are left out.

It was copied on 2026-10-13 from `packages/parametric-kit/src` in the formeriet repo at commit
`421b986`. The kit now lives inside formeriet, and it was dissolved there. This copy is the lamp's
own from here on, so change it here freely. Nothing needs to be kept in sync.

`package.json` points `exports` straight at the `src` files, so there is no build step. `three`
and `manifold-3d` resolve from the lamp's own `node_modules`.
