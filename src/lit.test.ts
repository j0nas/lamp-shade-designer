// Lighting mode switching. No renderer here — createLighting only mutates the scene graph and
// materials, so a bare Scene stands in for the viewer's.
import { describe, expect, test } from "vite-plus/test";
import { AmbientLight, Color, DirectionalLight, Scene } from "three";
import { defaults } from "parametric-kit/params";
import { createLighting, SHADE_COLOR } from "./lit.ts";
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

  test("lamp mode drives the shade's glow from wall thinness; CAD leaves it unlit", () => {
    const scene = studioScene();
    const lighting = createLighting(scene);

    lighting.update(params({ wall: 0.8, watts: 8 }), 200, 130);
    lighting.setMode("lamp");
    const thin = lighting.shadeMaterial.emissiveIntensity;

    lighting.update(params({ wall: 3.2, watts: 8 }), 200, 130);
    const thick = lighting.shadeMaterial.emissiveIntensity;
    expect(thin).toBeGreaterThan(thick);

    lighting.setMode("cad");
    expect(lighting.shadeMaterial.emissiveIntensity).toBe(0);
    expect(lighting.shadeMaterial.transmission).toBe(0);
  });

  test("overhang mode keeps the studio look and flips vertex colours on, exactly once", () => {
    const scene = studioScene();
    const before = scene.children
      .filter((o) => "isLight" in o)
      .map((o) => (o as AmbientLight).intensity);
    const lighting = createLighting(scene);
    lighting.update(params(), 200, 130);

    lighting.setMode("overhang");
    // Studio look intact: this is CAD-with-a-heatmap, not a mood.
    expect((scene.background as Color).getHex()).toBe(STUDIO);
    const intensities = scene.children
      .filter((o) => "isLight" in o)
      .map((o) => (o as AmbientLight).intensity);
    expect(intensities.slice(0, before.length)).toEqual(before);
    // The material multiplies vertex colours against white, and stays unlit-from-within.
    expect(lighting.shadeMaterial.vertexColors).toBe(true);
    expect(lighting.shadeMaterial.color.getHex()).toBe(0xffffff);
    expect(lighting.shadeMaterial.emissiveIntensity).toBe(0);

    // apply() runs on every param change; the toggle must be change-guarded or every drag frame
    // recompiles the shader. Material.version only moves when needsUpdate is set.
    const version = lighting.shadeMaterial.version;
    lighting.update(params(), 200, 130);
    lighting.update(params({ wall: 2.4 }), 220, 140);
    lighting.setRoomBrightness(0.5);
    expect(lighting.shadeMaterial.version).toBe(version);

    lighting.setMode("cad");
    expect(lighting.shadeMaterial.vertexColors).toBe(false);
    expect(lighting.shadeMaterial.color.getHex()).toBe(SHADE_COLOR);
  });
});
