// Lighting mode switching. No renderer here — createLighting only mutates the scene graph and
// materials, so a bare Scene stands in for the viewer's.
import { describe, expect, test } from "vite-plus/test";
import { AmbientLight, BufferGeometry, Color, DirectionalLight, Scene } from "three";
import { defaults } from "parametric-kit/params";
import { createLighting, setSectionCut, SHADE_COLOR, shadeMesh } from "./lit.ts";
import { type Params, schema } from "./params.ts";

const STUDIO = 0xeef1f4; // the kit viewer's background

// A stand-in for what createViewer() leaves in the scene: a background, an environment and lights
// whose intensities lamp mode dims and CAD mode must restore.
function studioScene(): Scene {
  const scene = new Scene();
  scene.background = new Color(STUDIO);
  scene.add(new AmbientLight(0xffffff, 0.55));
  scene.add(new DirectionalLight(0xffffff, 2.2));
  return scene;
}

const params = (over: Partial<Params> = {}): Params => ({ ...defaults(schema), ...over });

// One layer with the classic look — materials now come from syncLayerMaterials, one per layer.
const look = (wall = 1.6, over: Partial<{ color: string; opacity: number }> = {}) => ({
  color: "#f3ece0",
  opacity: 1,
  wall,
  ...over,
});

describe("view modes", () => {
  test("CAD keeps the viewer's studio background; lamp swaps in the dark room", () => {
    const scene = studioScene();
    const lighting = createLighting(scene);

    // Regression: this used to be `background = null`, which falls through to the renderer's black
    // clear colour — CAD looked like a dark room and switching to lamp mode barely read as a change.
    lighting.setMode("cad");
    expect((scene.background as Color).getHex()).toBe(STUDIO);

    lighting.setMode("lamp");
    expect((scene.background as Color).getHex()).toBe(0x0b0a0f);

    lighting.setMode("cad");
    expect((scene.background as Color).getHex()).toBe(STUDIO);
  });

  test("the background object is not reallocated on every update", () => {
    const scene = studioScene();
    const lighting = createLighting(scene);
    lighting.setMode("lamp");
    const first = scene.background;
    lighting.update(params(), 200, 130);
    expect(scene.background).toBe(first);
  });

  test("studio lights are dimmed for lamp mode and restored for CAD", () => {
    const scene = studioScene();
    const before = scene.children
      .filter((o) => "isLight" in o)
      .map((o) => (o as AmbientLight).intensity);
    const lighting = createLighting(scene);

    lighting.setMode("lamp");
    const dimmed = scene.children.filter((o) => "isLight" in o && o.visible !== false);
    expect(dimmed.some((o) => (o as AmbientLight).intensity === before[0])).toBe(false);

    lighting.setMode("cad");
    const restored = scene.children
      .filter((o) => "isLight" in o)
      .map((o) => (o as AmbientLight).intensity);
    expect(restored.slice(0, before.length)).toEqual(before);
  });

  test("lamp mode drives each layer's glow from ITS wall thinness; CAD leaves them unlit", () => {
    const scene = studioScene();
    const lighting = createLighting(scene);

    const [mat] = lighting.syncLayerMaterials([look(0.8)]);
    lighting.update(params({ watts: 8 }), 200, 130);
    lighting.setMode("lamp");
    const thin = mat.emissiveIntensity;

    lighting.syncLayerMaterials([look(3.2)]);
    const thick = mat.emissiveIntensity;
    expect(thin).toBeGreaterThan(thick);

    lighting.setMode("cad");
    expect(mat.emissiveIntensity).toBe(0);
    expect(mat.transmission).toBe(0);
  });

  test("layers carry their own colour, translucency and tinted glow", () => {
    const scene = studioScene();
    const lighting = createLighting(scene);
    const [outer, inner] = lighting.syncLayerMaterials([
      look(0.8, { opacity: 0.5 }),
      look(1.6, { color: "#e01010" }),
    ]);

    // CAD: colours and translucency straight from the looks.
    expect(outer.transparent).toBe(true);
    expect(outer.opacity).toBe(0.5);
    expect(inner.transparent).toBe(false);
    expect(inner.color.getHexString()).toBe("e01010");

    // Lamp: the glow is tinted by the layer's own colour — a red diffuser glows red, which is the
    // whole reason to stack a coloured inner behind a translucent outer.
    lighting.update(params({ watts: 8 }), 200, 130);
    lighting.setMode("lamp");
    expect(inner.emissiveIntensity).toBeGreaterThan(0);
    expect(inner.emissive.r).toBeGreaterThan(inner.emissive.b * 4);

    // Shrinking the stack disposes the dropped material and keeps the survivor.
    const mats = lighting.syncLayerMaterials([look(0.8)]);
    expect(mats).toHaveLength(1);
    expect(mats[0]).toBe(outer);
  });

  test("overhang mode keeps the studio look and flips vertex colours on, exactly once", () => {
    const scene = studioScene();
    const before = scene.children
      .filter((o) => "isLight" in o)
      .map((o) => (o as AmbientLight).intensity);
    const lighting = createLighting(scene);
    const [mat] = lighting.syncLayerMaterials([look()]);
    lighting.update(params(), 200, 130);

    lighting.setMode("overhang");
    // Studio look intact: this is CAD-with-a-heatmap, not a mood.
    expect((scene.background as Color).getHex()).toBe(STUDIO);
    const intensities = scene.children
      .filter((o) => "isLight" in o)
      .map((o) => (o as AmbientLight).intensity);
    expect(intensities.slice(0, before.length)).toEqual(before);
    // The material multiplies vertex colours against white, and stays unlit-from-within.
    expect(mat.vertexColors).toBe(true);
    expect(mat.color.getHex()).toBe(0xffffff);
    expect(mat.emissiveIntensity).toBe(0);

    // apply() runs on every param change; the toggle must be change-guarded or every drag frame
    // recompiles the shader. Material.version only moves when needsUpdate is set.
    const version = mat.version;
    lighting.update(params(), 200, 130);
    lighting.update(params({ wall: 2.4 }), 220, 140);
    lighting.setRoomBrightness(0.5);
    expect(mat.version).toBe(version);

    lighting.setMode("cad");
    expect(mat.vertexColors).toBe(false);
    expect(mat.color.getHex()).toBe(SHADE_COLOR);
  });
});

describe("section cut", () => {
  test("clips every render path of the shade — surface, depth and distance — change-guarded", () => {
    const lighting = createLighting(studioScene());
    const [mat] = lighting.syncLayerMaterials([look()]);
    const mesh = shadeMesh(new BufferGeometry(), mat);

    setSectionCut([mesh], true);
    expect(mat.clippingPlanes).toHaveLength(1);
    // The shadow passes render with their own materials; an unclipped depth pass would cast the
    // WHOLE shade's shadow while the surface shows half — lamp mode's one job is truthful light.
    expect(mesh.customDepthMaterial?.clippingPlanes).toHaveLength(1);
    expect(mesh.customDistanceMaterial?.clippingPlanes).toHaveLength(1);
    expect(mat.clipShadows).toBe(true);

    // Re-applying the same state must not recompile (version only moves via needsUpdate).
    const version = mat.version;
    setSectionCut([mesh], true);
    expect(mat.version).toBe(version);

    setSectionCut([mesh], false);
    expect(mat.clippingPlanes).toBeNull();
    expect(mat.version).toBe(version + 1);
  });
});
