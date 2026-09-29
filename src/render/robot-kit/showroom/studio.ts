// Showroom studio: renderer, dark cyclorama, turntable plinth, key / fill / twin rim lights,
// a PMREM room environment for metal reflections and a bloom pass for optics and neon.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { color, float, mix, mx_fractal_noise_float, positionLocal, positionWorld, smoothstep, vec3 } from '../materials/tsl';
import * as TSL from 'three/tsl';

export interface Studio {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  turntable: THREE.Group; // rotates about +y
  physicsRoot: THREE.Group; // z-up → y-up, child of the turntable
  isWebGPU: boolean;
  render(): void;
}

const FLOOR_RADIUS = 14;
const PLINTH_RADIUS = 1.55;

function cyclorama(): THREE.Mesh {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false });
  const h = smoothstep(-0.05, 0.6, positionWorld.y.div(30));
  m.colorNode = mix(color(0x16181c), color(0x07080a), h);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(60, 48, 24), m);
  mesh.name = 'cyclorama';
  return mesh;
}

function floor(): THREE.Mesh {
  const m = new THREE.MeshPhysicalNodeMaterial();
  const n = mx_fractal_noise_float(positionLocal.mul(1.6), 4, 2.0, 0.5).mul(0.5).add(0.5);
  const r = positionLocal.xy.length();
  const vignette = float(1).sub(smoothstep(2.0, FLOOR_RADIUS, r));
  m.colorNode = mix(vec3(0.018, 0.019, 0.021), vec3(0.05, 0.05, 0.052), n).mul(vignette.mul(0.7).add(0.3));
  m.roughnessNode = mix(float(0.38), float(0.72), n);
  m.metalnessNode = float(0.0);
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(FLOOR_RADIUS, 96), m);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.name = 'floor';
  return mesh;
}

function plinth(): THREE.Group {
  const g = new THREE.Group();
  const top = new THREE.MeshPhysicalNodeMaterial({ color: 0x15171a, roughness: 0.34, metalness: 0.6 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(PLINTH_RADIUS, PLINTH_RADIUS + 0.04, 0.07, 96), top);
  body.position.y = 0.035;
  body.receiveShadow = true;
  g.add(body);
  const ringMat = new THREE.MeshBasicNodeMaterial();
  ringMat.colorNode = color(0xffa31a).mul(2.2);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(PLINTH_RADIUS + 0.01, 0.006, 8, 160), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.071;
  g.add(ring);
  return g;
}

/** Dark photo studio for reflections: a charcoal room with softbox strips, so metal reads as
 *  dark metal with crisp highlight bands instead of a mirror of a white room. */
function studioEnvironment(): THREE.Scene {
  const env = new THREE.Scene();
  // Charcoal room with a slightly lighter horizon band, so mirror finishes pick up a gradient.
  const roomMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  const band = smoothstep(-0.35, 0.05, positionWorld.y.div(20)).mul(float(1).sub(smoothstep(0.05, 0.5, positionWorld.y.div(20))));
  roomMat.colorNode = mix(color(0x0b0c0e), color(0x3a3d42), band);
  env.add(new THREE.Mesh(new THREE.SphereGeometry(20, 48, 24), roomMat));
  const fl = new THREE.Mesh(new THREE.CircleGeometry(20, 32), new THREE.MeshBasicMaterial({ color: 0x1a1b1d }));
  fl.rotation.x = -Math.PI / 2;
  fl.position.y = -2;
  env.add(fl);
  const box = (w: number, h: number, pos: [number, number, number], look: [number, number, number], hex: number, gain: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(gain), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(...look);
    env.add(m);
  };
  box(9, 3.5, [0, 9, 2], [0, 0, 0], 0xffffff, 6); // overhead softbox
  box(1.4, 9, [-9, 3, 3], [0, 1, 0], 0xdfe9ff, 5); // left strip
  box(1.4, 9, [9, 3, -2], [0, 1, 0], 0xfff0de, 4); // right strip
  box(7, 1.4, [0, 2, -10], [0, 1, 0], 0xffc890, 3); // warm kicker behind
  box(4, 2.5, [5, 4, 9], [0, 1, 0], 0xffffff, 2.5); // front fill card
  box(3, 6, [-6, 2, -8], [0, 1, 0], 0x9fc4ff, 1.6); // cool back-left card
  box(10, 1.5, [0, 0.3, 11], [0, 1, 0], 0xffffff, 1.2); // low front bounce
  return env;
}

function lights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0x8fa4b8, 0x0a0908, 0.25));
  const key = new THREE.SpotLight(0xfff1e0, 210, 30, Math.PI / 7, 0.6, 2);
  key.position.set(4.5, 7.5, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  key.target.position.set(0, 1, 0);
  const fill = new THREE.DirectionalLight(0x9fb8d8, 0.55);
  fill.position.set(-6, 3, 4);
  scene.add(fill);
  const rimA = new THREE.SpotLight(0x7fd4ff, 220, 30, Math.PI / 8, 0.6, 2);
  rimA.position.set(-4.5, 5.5, -5.5);
  rimA.target.position.set(0, 1.2, 0);
  scene.add(rimA, rimA.target);
  const rimB = new THREE.SpotLight(0xffb070, 180, 30, Math.PI / 8, 0.6, 2);
  rimB.position.set(5, 4.5, -5);
  rimB.target.position.set(0, 1.2, 0);
  scene.add(rimB, rimB.target);
}

/** `forceWebGL` exercises the WebGL2 fallback path the game uses without WebGPU. */
export async function createStudio(canvas: HTMLCanvasElement, forceWebGL = false): Promise<Studio> {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
  await renderer.init();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x07080a, 12, 38);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(studioEnvironment(), 0.02).texture;
  scene.environmentIntensity = 0.9;
  scene.add(cyclorama(), floor());
  lights(scene);

  const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.position.set(3.3, 1.8, 4.6);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.0, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 0.3;
  controls.maxDistance = 25;

  const turntable = new THREE.Group();
  turntable.add(plinth());
  scene.add(turntable);
  const physicsRoot = new THREE.Group();
  physicsRoot.rotation.x = -Math.PI / 2;
  physicsRoot.position.y = 0.07;
  turntable.add(physicsRoot);

  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = TSL.pass(scene, camera);
  const color0 = scenePass.getTextureNode('output');
  pipeline.outputNode = color0.add(bloom(color0, 0.32, 0.3, 1.6));

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  return {
    renderer, scene, camera, controls, turntable, physicsRoot, isWebGPU,
    render() {
      controls.update();
      pipeline.render();
    },
  };
}
