// Generic Three.js viewer: renderer, scene, camera, lighting, a shadow-catcher ground, orbit
// controls and the render loop. Knows nothing about the model — the consuming app adds meshes and
// wires the UI. Rendering is on-demand: the loop only draws when something changed (camera,
// geometry, resize), so a static model costs ~zero GPU while idle.
//
// The two source apps (deck-box, stackable-trays) differed only in a handful of tuned numbers —
// light position, shadow frustum, ground size — which are now options (deck-box values as defaults).

import {
  ACESFilmicToneMapping,
  Box3,
  type BufferGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  type Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

// --- options ----------------------------------------------------------------
// Only the numbers that diverged between the two apps are knobs; everything shared (background,
// light intensities, tone mapping, shadow map size, near plane) stays a constant. Defaults are the
// deck-box values.
export type ViewerOptions = {
  sunPosition?: readonly [number, number, number]; // directional key light
  shadowExtent?: number; // half-size of the (symmetric) shadow frustum; grow to fit larger models
  shadowFar?: number; // far plane of the shadow camera
  groundSize?: number; // side length of the shadow-catcher plane
};

export type ResolvedViewerOptions = {
  sunPosition: readonly [number, number, number];
  shadowExtent: number;
  shadowFar: number;
  groundSize: number;
};

export const VIEWER_DEFAULTS: ResolvedViewerOptions = {
  sunPosition: [120, -180, 300],
  shadowExtent: 220,
  shadowFar: 1200,
  groundSize: 3000,
};

export function resolveViewerOptions(options: ViewerOptions = {}): ResolvedViewerOptions {
  return {
    sunPosition: options.sunPosition ?? VIEWER_DEFAULTS.sunPosition,
    shadowExtent: options.shadowExtent ?? VIEWER_DEFAULTS.shadowExtent,
    shadowFar: options.shadowFar ?? VIEWER_DEFAULTS.shadowFar,
    groundSize: options.groundSize ?? VIEWER_DEFAULTS.groundSize,
  };
}

// --- camera framing ---------------------------------------------------------
export type Framing = {
  position: [number, number, number];
  target: [number, number, number];
  near: number;
  far: number;
};

// Pure framing math: fit the camera around a bounding box. Returns null for an empty box so callers
// can bail without touching the camera. Isolated from the camera/controls so it can be unit-tested.
export function framingForBox(box: Box3): Framing | null {
  if (box.isEmpty()) return null;
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 1.9;
  return {
    near: maxDim / 100,
    far: maxDim * 60,
    position: [center.x + dist * 0.75, center.y - dist, center.z + dist * 0.7],
    target: [center.x, center.y, center.z],
  };
}

// --- normals ----------------------------------------------------------------
export const CREASE_ANGLE = Math.PI / 6; // 30°

// manifold-3d returns a properly welded mesh (shared vertices), so a plain computeVertexNormals()
// averages normals across the sharp 90° CAD edges and the model looks soft/melted. Split the normals
// at any edge sharper than the crease angle instead: flat faces stay crisp while rounded corners and
// tessellated arcs still shade smoothly. Positions/triangles are untouched, so the exported STL is
// identical. Disposes the source geometry once creased.
export function creased(src: BufferGeometry, angle: number = CREASE_ANGLE): BufferGeometry {
  const g = toCreasedNormals(src, angle);
  src.dispose();
  g.computeBoundingBox();
  return g;
}

// --- dev automation hook ----------------------------------------------------
export type AppHook = Record<string, unknown>;

export type InstallAppHookOptions = {
  key?: string; // property name on the target; default "__app"
  target?: Record<string, unknown>; // default globalThis (window in the browser)
  enabled?: boolean; // default: only in a Vite dev build
};

// True only under a Vite dev build. Robust when import.meta.env is absent (Node, plain ESM, tests):
// optional chaining keeps it from throwing, and it falls back to false rather than leaking the hook.
function isDevEnv(): boolean {
  try {
    return Boolean((import.meta as unknown as { env?: { DEV?: unknown } }).env?.DEV);
  } catch {
    return false;
  }
}

// Dev-only escape hatch for scripted testing: browser automation can't always rely on rAF firing
// (occluded windows pause it), so the app exposes its params, a rebuild, a synchronous render and a
// canvas handle for headless capture. The consuming app owns the shape; this just publishes it on the
// global in dev. Returns whether it installed.
export function installAppHook(hook: AppHook, options: InstallAppHookOptions = {}): boolean {
  const enabled = options.enabled ?? isDevEnv();
  if (!enabled) return false;
  const target = options.target ?? (globalThis as Record<string, unknown>);
  target[options.key ?? "__app"] = hook;
  return true;
}

// --- viewer -----------------------------------------------------------------
export type Viewer = {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  controls: OrbitControls;
  invalidate: () => void; // request one render (call after any non-camera scene change)
  render: () => void; // force one synchronous render now (automation/capture; bypasses rAF)
  frameCamera: (objects: Object3D[]) => void; // fit the camera around the given objects
  start: () => void; // begin the render loop
  dispose: () => void; // tear down: stop the loop, drop the resize observer, free GPU resources
};

export function createViewer(container: HTMLElement, options: ViewerOptions = {}): Viewer {
  const opts = resolveViewerOptions(options);

  // preserveDrawingBuffer keeps the last frame readable via canvas.toDataURL — headless capture reads
  // it directly because rAF (and thus setAnimationLoop) pauses while the window is occluded.
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  // The canvas must never drive layout: a fixed pixel width (three's default setSize
  // style) becomes the container's min-content size, so one transiently-wide
  // measurement (mobile URL-bar churn, hydration) props the page open forever — the
  // container can grow but never shrink back. CSS-size it to the container and keep
  // setSize() off the style (updateStyle=false in resize()).
  Object.assign(renderer.domElement.style, { display: "block", width: "100%", height: "100%" });
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(0xeef1f4);

  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new PerspectiveCamera(45, 1, 1, 8000);
  camera.up.set(0, 0, 1); // Z up, matching the model / slicer convention

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new HemisphereLight(0xffffff, 0x9098a0, 0.55));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(...opts.sunPosition);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    near: 1,
    far: opts.shadowFar,
    left: -opts.shadowExtent,
    right: opts.shadowExtent,
    top: opts.shadowExtent,
    bottom: -opts.shadowExtent,
  });
  scene.add(sun);

  // shadow-catcher ground (transparent, shows only the contact shadow)
  const ground = new Mesh(
    new PlaneGeometry(opts.groundSize, opts.groundSize),
    new ShadowMaterial({ opacity: 0.16 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  let needsRender = true;
  const invalidate = (): void => {
    needsRender = true;
  };
  // OrbitControls fires 'change' on drag and on every damping step, so interaction re-renders; when
  // motion settles the events stop and the loop goes quiet.
  controls.addEventListener("change", invalidate);

  function render(): void {
    renderer.render(scene, camera);
    needsRender = false;
  }

  function frameCamera(objects: Object3D[]): void {
    const box = new Box3();
    for (const o of objects) box.expandByObject(o);
    const f = framingForBox(box);
    if (!f) return;
    camera.near = f.near;
    camera.far = f.far;
    camera.position.set(...f.position);
    camera.updateProjectionMatrix();
    controls.target.set(...f.target);
    controls.update();
    invalidate();
  }

  function resize(): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return; // display:none / not yet laid out — keep the last good aspect
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    invalidate();
  }
  // Observe the container, not the window: panels, grid tracks and mobile viewports
  // resize the container without any window resize event.
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  function start(): void {
    renderer.setAnimationLoop(() => {
      controls.update(); // advances damping; sets needsRender via the 'change' listener when moving
      if (needsRender) render();
    });
  }

  function dispose(): void {
    renderer.setAnimationLoop(null);
    resizeObserver.disconnect();
    controls.dispose();
    pmrem.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return { scene, camera, renderer, controls, invalidate, render, frameCamera, start, dispose };
}
