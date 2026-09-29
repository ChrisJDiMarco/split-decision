// Renderer, camera and the z-up physics root. MuJoCo is z-up; three.js is y-up, so every
// physics-driven object lives under `physicsRoot`, which rotates z-up into y-up once.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface Stage {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  physicsRoot: THREE.Group;
  isWebGPU: boolean;
  render(): void;
}

export interface StageOptions {
  /** GPU limits some effects need (the PBF oil fluid). Falls back to defaults if the device refuses. */
  requiredLimits?: Record<string, number>;
  /** MSAA on the canvas. Off when a post-processing pipeline does the final pass. */
  antialias?: boolean;
}

async function makeRenderer(canvas: HTMLCanvasElement, opts: StageOptions): Promise<THREE.WebGPURenderer> {
  const base = { canvas, antialias: opts.antialias ?? true };
  if (opts.requiredLimits) {
    const renderer = new THREE.WebGPURenderer({ ...base, requiredLimits: opts.requiredLimits });
    try {
      await renderer.init();
      return renderer;
    } catch (err) {
      console.warn('[stage] GPU refused the requested limits; effects that need them fall back', err);
      renderer.dispose();
    }
  }
  const renderer = new THREE.WebGPURenderer(base);
  await renderer.init();
  return renderer;
}

export async function createStage(canvas: HTMLCanvasElement, opts: StageOptions = {}): Promise<Stage> {
  const renderer = await makeRenderer(canvas, opts);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07080a);
  scene.fog = new THREE.FogExp2(0x07080a, 0.018);

  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.05, 400);
  camera.position.set(0, 3.6, 10.5);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.1, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 1.5;
  controls.maxDistance = 30;

  const physicsRoot = new THREE.Group();
  physicsRoot.rotation.x = -Math.PI / 2;
  scene.add(physicsRoot);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  return {
    renderer, scene, camera, controls, physicsRoot, isWebGPU,
    render() {
      controls.update();
      renderer.render(scene, camera);
    },
  };
}
