// Two ways to look at a shade, because a lamp has two truths.
//
// "cad"  — the kit's default studio lighting: read the FORM, crisp edges, neutral grey.
// "lamp" — dark room, an emissive bulb at the real socket height inside the shade, shadows cast
//          THROUGH the actual perforations onto a floor and back wall.
//
// The lamp mode is the reason this app beats a CAD package for this particular object: you are
// designing a light, and a grey solid tells you nothing about what it throws on a wall.

import {
  AmbientLight,
  type BufferGeometry,
  Color,
  type Light,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  PointLight,
  type Scene,
  SphereGeometry,
} from "three";
import { BULBS, type Params } from "./params.ts";

export type ViewMode = "cad" | "lamp";

export type Lighting = {
  setMode: (m: ViewMode) => void;
  setRoomBrightness: (x: number) => void;
  update: (p: Params, shadeHeightMm: number, maxRmm: number) => void;
  setShowBulb: (on: boolean) => void;
  shadeMaterial: MeshPhysicalMaterial;
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
  const surfaceMat = new MeshStandardMaterial({ color: 0x59545f, roughness: 0.95 });
  const floor = new Mesh(new PlaneGeometry(1, 1), surfaceMat);
  floor.receiveShadow = true;
  floor.visible = false;
  scene.add(floor);

  const wall = new Mesh(new PlaneGeometry(1, 1), surfaceMat);
  wall.receiveShadow = true;
  wall.visible = false;
  scene.add(wall);

  // Shade material: physical so thin walls can actually transmit light the way printed PLA does.
  const shadeMaterial = new MeshPhysicalMaterial({
    color: 0xf3ece0,
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
  let lastP: Params | null = null;
  let lastH = 200;
  let lastR = 130;

  function apply(): void {
    const lamp = mode === "lamp";
    for (const s of studio) s.light.intensity = lamp ? s.intensity * 0.04 : s.intensity;
    for (const c of catchers) c.visible = !lamp;
    scene.environment = lamp ? null : studioEnv;
    scene.background = lamp ? new Color(0x0b0a0f) : null;

    room.visible = lamp;
    // Ambient is not distance-attenuated, so it needs no unit gain — but it must be able to reach a
    // genuinely lit room, otherwise the slider only ever moves between black and slightly-less-black.
    room.intensity = brightness * 1.6;
    bulbLight.visible = lamp;
    bulbMesh.visible = lamp && showBulb;
    floor.visible = lamp;
    wall.visible = lamp;

    if (lamp && lastP) {
      const p = lastP;
      const bulb = BULBS[p.bulbKind];
      const z = p.bulbZ * lastH;

      // CRITICAL: the scene is in MILLIMETRES and this light uses physical decay = 2, so illuminance
      // falls as intensity / d² with d in mm. A "realistic" 96 cd therefore lands at 96/400² ≈ 0.0006
      // on a wall 400 mm away — visually black. Scale by the square of the unit ratio so a typical
      // bulb-to-wall distance lands near 1.0: at 150 mm, watts·5600/150² ≈ 2 for an 8 W lamp.
      const MM_UNIT_GAIN = 5600;
      bulbLight.intensity = p.watts * MM_UNIT_GAIN;
      bulbLight.color = kelvinish(p.watts);
      bulbLight.position.set(0, 0, z);
      bulbLight.distance = 0; // no cutoff; decay alone shapes the falloff
      bulbMesh.position.set(0, 0, z);
      bulbMesh.scale.setScalar(bulb.dia / 2);

      // Thin walls glow; thick ones read as solid. Transmission alone does NOT produce the glow — it
      // is refraction, showing what is behind the surface, not light escaping from within. The glow a
      // real shade has comes from its inner surface being lit, so drive `emissive` from wall
      // thinness and power, and keep transmission as a secondary see-through cue.
      const w = p.vaseMode ? 0.42 : p.wall;
      const thinness = Math.min(1, Math.max(0, 1 - (w - 0.4) / 2.8)); // 0.4 mm -> 1, 3.2 mm -> 0
      shadeMaterial.transmission = 0.15 + thinness * 0.45;
      shadeMaterial.thickness = w;
      shadeMaterial.emissive = kelvinish(p.watts);
      // Power raises the glow but saturates — doubling the wattage does not double how lit it reads.
      shadeMaterial.emissiveIntensity =
        (0.12 + thinness * 0.75) * Math.min(2.2, 0.45 + Math.sqrt(p.watts) / 3.4);

      const reach = Math.max(lastR * 6, lastH * 3);
      floor.geometry.dispose();
      floor.geometry = new PlaneGeometry(reach, reach);
      floor.position.set(0, 0, -0.4); // just under the shade so it never z-fights the bottom rim
      wall.geometry.dispose();
      wall.geometry = new PlaneGeometry(reach, reach * 0.8);
      wall.rotation.set(Math.PI / 2, 0, 0);
      wall.position.set(0, lastR * 2.6, (reach * 0.8) / 2 - 0.4);
    } else {
      shadeMaterial.transmission = 0;
      shadeMaterial.thickness = 2;
      shadeMaterial.emissiveIntensity = 0; // CAD mode reads form, not mood
    }
  }

  return {
    shadeMaterial,
    fitterMaterial,
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
    update(p, shadeHeightMm, maxRmm) {
      lastP = p;
      lastH = shadeHeightMm;
      lastR = maxRmm;
      apply();
    },
    dispose() {
      for (const o of [room, bulbLight, bulbMesh, floor, wall]) scene.remove(o);
      bulbMesh.geometry.dispose();
      (bulbMesh.material as MeshStandardMaterial).dispose();
      floor.geometry.dispose();
      wall.geometry.dispose();
      surfaceMat.dispose();
      shadeMaterial.dispose();
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
  return m;
}
