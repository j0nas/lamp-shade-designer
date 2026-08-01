// Three ways to look at a shade, because a lamp has more than one truth.
//
// "cad"      — the kit's default studio lighting: read the FORM, crisp edges, neutral grey.
// "lamp"     — dark room, an emissive bulb at the real socket height inside the shade, shadows
//              cast THROUGH the actual perforations onto a floor and back wall.
// "overhang" — the studio look with a printability heatmap as vertex colours: where the wall
//              out-slopes what FDM can print unsupported. The colours themselves are computed in
//              overhang.ts and written by main.ts; this module only flips the material.
//
// The lamp mode is the reason this app beats a CAD package for this particular object: you are
// designing a light, and a grey solid tells you nothing about what it throws on a wall.

import {
  AmbientLight,
  type BufferGeometry,
  Color,
  type Light,
  type Material,
  Mesh,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  Plane,
  PlaneGeometry,
  PointLight,
  RGBADepthPacking,
  type Scene,
  SphereGeometry,
  type Texture,
  Vector3,
} from "three";
import { BULBS, type GlobalParams } from "./params.ts";

export type ViewMode = "cad" | "lamp" | "overhang";

// The shade's base colour, shared with the overhang ramp's neutral stop so a safe surface in the
// heatmap view looks exactly like the familiar shade.
export const SHADE_COLOR = 0xf3ece0;

// What a layer looks like, as far as materials care: its colour, how see-through it previews, and
// its wall (which drives the lit-mode glow — thin walls glow, thick ones read solid).
export type LayerLook = { color: string; opacity: number; wall: number };

export type Lighting = {
  setMode: (m: ViewMode) => void;
  setRoomBrightness: (x: number) => void;
  update: (g: GlobalParams, assemblyHeightMm: number, maxRmm: number) => void;
  setShowBulb: (on: boolean) => void;
  // One physical material per layer, managed here so every view mode restyles all of them at
  // once. The returned array is the SAME live array each call — main.ts indexes into it.
  syncLayerMaterials: (looks: LayerLook[]) => MeshPhysicalMaterial[];
  layerMaterials: MeshPhysicalMaterial[];
  fitterMaterial: MeshStandardMaterial;
  dispose: () => void;
};

// Rough CCT -> RGB for the bulb tint. Not colorimetric; enough to tell warm from neutral.
function kelvinish(watts: number): Color {
  // Small LED lamps read warm; higher power in this app implies a bigger, whiter source.
  const t = Math.min(1, Math.max(0, (watts - 4) / 40));
  return new Color().setRGB(1, 0.78 + 0.14 * t, 0.55 + 0.35 * t);
}

export function createLighting(scene: Scene): Lighting {
  // The kit's viewer already added its own lights and a shadow-catcher ground. We don't get handles,
  // so find them once and remember their studio intensities to restore when switching back to CAD.
  const studio: { light: Light; intensity: number }[] = [];
  const catchers: Object3D[] = [];
  scene.traverse((o) => {
    const asLight = o as Light;
    if (asLight.isLight) studio.push({ light: asLight, intensity: asLight.intensity });
    // Duck-typed on .type rather than `instanceof ShadowMaterial`: the kit is a linked package, so a
    // second three.js copy would make instanceof silently false and leave the catcher visible in
    // lamp mode. resolve.dedupe fixes that, but this check costs nothing and cannot regress.
    const mat = (o as Mesh).material;
    const type = Array.isArray(mat) ? mat[0]?.type : mat?.type;
    if ((o as Mesh).isMesh && type === "ShadowMaterial") catchers.push(o);
  });
  const studioEnv = scene.environment;
  // Remember the viewer's background rather than clearing it for CAD mode: `background = null` falls
  // through to the renderer's black clear colour, which made CAD look like the dark room and left
  // lamp mode with nothing to switch FROM. Allocated once — apply() runs on every param change.
  const studioBg = scene.background;
  const lampBg = new Color(0x0b0a0f);

  // --- lamp-mode fixtures, added once and toggled by visibility ---
  const room = new AmbientLight(0xffffff, 0.12);
  room.visible = false;
  scene.add(room);

  const bulbLight = new PointLight(0xffd9a0, 0, 0, 2);
  bulbLight.castShadow = true;
  bulbLight.shadow.mapSize.set(2048, 2048);
  bulbLight.shadow.bias = -0.002; // perforation edges are thin; bias down to kill shadow acne
  bulbLight.visible = false;
  scene.add(bulbLight);

  const bulbMesh = new Mesh(
    new SphereGeometry(1, 24, 16),
    new MeshStandardMaterial({ emissive: 0xffe6b8, emissiveIntensity: 2.5, color: 0x000000 }),
  );
  bulbMesh.visible = false;
  scene.add(bulbMesh);

  // Floor and back wall to catch the cast pattern. Standard lit surfaces rather than the kit's
  // shadow-catcher, because here we want to see the LIGHT, not just the shadow. Kept mid-grey, not
  // near-black: the whole point is that the perforation pattern is legible where it lands.
  // ONE unit plane, shared and scaled per frame in apply() — apply() runs on every param change,
  // so sizing by geometry reallocation would churn two GPU buffers per drag frame.
  const surfaceMat = new MeshStandardMaterial({ color: 0x59545f, roughness: 0.95 });
  const planeGeom = new PlaneGeometry(1, 1);
  const floor = new Mesh(planeGeom, surfaceMat);
  floor.receiveShadow = true;
  floor.visible = false;
  scene.add(floor);

  const wall = new Mesh(planeGeom, surfaceMat);
  wall.receiveShadow = true;
  wall.visible = false;
  scene.add(wall);

  // Shade materials, one per layer: physical so thin walls can actually transmit light the way
  // printed PLA does, and per-layer so a translucent outer skin can wrap a coloured inner
  // diffuser — the whole point of stacking shells.
  const layerMaterials: MeshPhysicalMaterial[] = [];
  let looks: LayerLook[] = [];

  const makeShadeMaterial = () =>
    new MeshPhysicalMaterial({
      color: SHADE_COLOR,
      roughness: 0.72,
      metalness: 0,
      transmission: 0,
      thickness: 2,
      side: 2, // DoubleSide: a perforated shell is seen from inside through its own holes
    });

  const fitterMaterial = new MeshStandardMaterial({
    color: 0x3d3a45,
    roughness: 0.55,
    metalness: 0.35,
  });

  let mode: ViewMode = "cad";
  let brightness = 0.12;
  let showBulb = true;
  let lastG: GlobalParams | null = null;
  let lastH = 200;
  let lastR = 130;

  // Scratch colours: apply() runs on every param change, so per-call allocation would churn.
  const tintScratch = new Color();
  const layerScratch = new Color();

  function apply(): void {
    const lamp = mode === "lamp";
    for (const s of studio) s.light.intensity = lamp ? s.intensity * 0.04 : s.intensity;
    for (const c of catchers) c.visible = !lamp;
    scene.environment = lamp ? null : studioEnv;
    scene.background = lamp ? lampBg : studioBg;

    room.visible = lamp;
    // Ambient is not distance-attenuated, so it needs no unit gain — but it must be able to reach a
    // genuinely lit room, otherwise the slider only ever moves between black and slightly-less-black.
    room.intensity = brightness * 1.6;
    bulbLight.visible = lamp;
    bulbMesh.visible = lamp && showBulb;
    floor.visible = lamp;
    wall.visible = lamp;

    if (lamp && lastG) {
      const g = lastG;
      const bulb = BULBS[g.bulbKind];
      const z = g.bulbZ * lastH;

      // CRITICAL: the scene is in MILLIMETRES and this light uses physical decay = 2, so illuminance
      // falls as intensity / d² with d in mm. A "realistic" 96 cd therefore lands at 96/400² ≈ 0.0006
      // on a wall 400 mm away — visually black. Scale by the square of the unit ratio so a typical
      // bulb-to-wall distance lands near 1.0: at 150 mm, watts·5600/150² ≈ 2 for an 8 W lamp.
      const MM_UNIT_GAIN = 5600;
      bulbLight.intensity = g.watts * MM_UNIT_GAIN;
      bulbLight.color = kelvinish(g.watts);
      bulbLight.position.set(0, 0, z);
      bulbLight.distance = 0; // no cutoff; decay alone shapes the falloff
      bulbMesh.position.set(0, 0, z);
      bulbMesh.scale.setScalar(bulb.dia / 2);

      const reach = Math.max(lastR * 6, lastH * 3);
      floor.scale.set(reach, reach, 1);
      floor.position.set(0, 0, -0.4); // just under the shade so it never z-fights the bottom rim
      wall.scale.set(reach, reach * 0.8, 1);
      wall.rotation.set(Math.PI / 2, 0, 0);
      wall.position.set(0, lastR * 2.6, (reach * 0.8) / 2 - 0.4);
    }

    // Per-layer material pass. Overhang heatmap: vertex colours multiply the base colour, so the
    // base flips to white while the ramp is on and back to the layer's own colour when it isn't.
    // The vertexColors flip is CHANGE-GUARDED because apply() runs on every param change, and
    // vertexColors/needsUpdate recompile the shader — an unconditional toggle would recompile the
    // program on every frame of a drag. The depth and distance materials are untouched: shadows
    // don't care what colour the surface is, and the drag preview's alpha map is an orthogonal
    // shader feature that keeps working here.
    const overhang = mode === "overhang";
    for (let i = 0; i < layerMaterials.length; i++) {
      const mat = layerMaterials[i];
      const look = looks[i] ?? { color: "#f3ece0", opacity: 1, wall: 2 };
      const translucent = look.opacity < 0.999;
      mat.transparent = translucent;
      mat.opacity = look.opacity;
      // depthWrite off for translucent shells so an outer skin blends over its inner layers
      // instead of z-fighting its own far side.
      mat.depthWrite = !translucent;

      if (lamp && lastG) {
        // Thin walls glow; thick ones read as solid. Transmission alone does NOT produce the glow —
        // it is refraction, showing what is behind the surface, not light escaping from within. The
        // glow a real shade has comes from its inner surface being lit, so drive `emissive` from
        // wall thinness and power — TINTED BY THE LAYER'S COLOUR, which is what makes a coloured
        // diffuser inside a translucent skin read the way the printed thing does.
        const w = look.wall;
        const thinness = Math.min(1, Math.max(0, 1 - (w - 0.4) / 2.8)); // 0.4 mm -> 1, 3.2 mm -> 0
        mat.transmission = 0.15 + thinness * 0.45;
        mat.thickness = w;
        mat.emissive
          .copy(tintScratch.copy(kelvinish(lastG.watts)))
          .multiply(layerScratch.set(look.color));
        // Power raises the glow but saturates — doubling the wattage does not double how lit it
        // reads.
        mat.emissiveIntensity =
          (0.12 + thinness * 0.75) * Math.min(2.2, 0.45 + Math.sqrt(lastG.watts) / 3.4);
      } else {
        mat.transmission = 0;
        mat.thickness = 2;
        mat.emissiveIntensity = 0; // CAD mode reads form, not mood
      }

      if (mat.vertexColors !== overhang) {
        mat.vertexColors = overhang;
        mat.needsUpdate = true;
      }
      mat.color.set(overhang ? "#ffffff" : look.color);
    }
  }

  return {
    layerMaterials,
    fitterMaterial,
    syncLayerMaterials(next) {
      looks = next;
      while (layerMaterials.length < next.length) layerMaterials.push(makeShadeMaterial());
      while (layerMaterials.length > next.length) layerMaterials.pop()!.dispose();
      apply();
      return layerMaterials;
    },
    setMode(m) {
      mode = m;
      apply();
    },
    setRoomBrightness(x) {
      brightness = x;
      apply();
    },
    setShowBulb(on) {
      showBulb = on;
      apply();
    },
    update(g, assemblyHeightMm, maxRmm) {
      lastG = g;
      lastH = assemblyHeightMm;
      lastR = maxRmm;
      apply();
    },
    dispose() {
      for (const o of [room, bulbLight, bulbMesh, floor, wall]) scene.remove(o);
      bulbMesh.geometry.dispose();
      (bulbMesh.material as MeshStandardMaterial).dispose();
      planeGeom.dispose();
      surfaceMat.dispose();
      for (const m of layerMaterials) m.dispose();
      fitterMaterial.dispose();
    },
  };
}

// Both meshes cast and receive so the shade shadows itself — the inside of a lobed or twisted shade
// darkening its own far wall is a real part of how these look lit.
export function shadeMesh(geom: BufferGeometry, material: MeshPhysicalMaterial): Mesh {
  const m = new Mesh(geom, material);
  m.castShadow = true;
  m.receiveShadow = true;
  // Shadow passes render with their own materials, so the drag preview's alpha-tested holes need
  // equivalents there — otherwise lamp mode would cast a solid shadow while the surface shows holes.
  // With no alphaMap set these behave exactly like the renderer's built-in defaults.
  m.customDepthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  m.customDistanceMaterial = new MeshDistanceMaterial();
  return m;
}

// The section-cut view: a fixed vertical plane through the axis, clipping away half the model so
// wall thickness, the fitter seat and the bulb clearance can be inspected in true section. One
// shared immutable plane — Z-up, so a vertical cut is a plane whose normal lies in XY; the user
// orbits rather than the plane moving.
const SECTION_PLANE = new Plane(new Vector3(0, -1, 0), 0); // keeps y ≤ 0

// Applied to every material each mesh renders with — surface, depth pass, distance pass, exactly
// the set setShadePerfPreview touches — plus clipShadows, so lamp mode's cast light shows the cut
// too instead of the shadow of the whole shade. Change-guarded: toggling clipping recompiles the
// shader, and this runs from a UI listener that can fire repeatedly.
export function setSectionCut(meshes: Mesh[], on: boolean): void {
  for (const mesh of meshes) {
    const mats = [mesh.material, mesh.customDepthMaterial, mesh.customDistanceMaterial] as (
      | Material
      | undefined
    )[];
    for (const mat of mats) {
      if (!mat || (mat.clippingPlanes?.length ?? 0) === (on ? 1 : 0)) continue;
      mat.clippingPlanes = on ? [SECTION_PLANE] : null;
      mat.clipShadows = on;
      mat.needsUpdate = true; // the clipping-plane count changes the compiled program
    }
  }
}

// Toggle the drag preview's perforation on the shade: the alpha map + test go on every material the
// mesh renders with — the surface, the directional-shadow depth pass, and the point-light-shadow
// distance pass, so the cast pattern stays truthful mid-drag. null restores the solid materials
// (the settled build has real holes and needs no help).
export function setShadePerfPreview(mesh: Mesh, texture: Texture | null): void {
  const mats = [mesh.material, mesh.customDepthMaterial, mesh.customDistanceMaterial] as (
    | MeshPhysicalMaterial
    | MeshDepthMaterial
    | MeshDistanceMaterial
    | undefined
  )[];
  for (const mat of mats) {
    if (!mat || mat.alphaMap === texture) continue;
    mat.alphaMap = texture;
    mat.alphaTest = texture ? 0.5 : 0;
    mat.needsUpdate = true; // alphaMap/alphaTest presence changes the compiled program
  }
}
