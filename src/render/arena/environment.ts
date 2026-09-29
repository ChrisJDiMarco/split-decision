// Venue atmosphere (three.js world, y-up): haze fog, a dark gradient backdrop dome, and a
// PMREM environment built from a small stand-in venue (overhead light banks, a glowing
// canvas below, a warm ring of house light) so metal armour has something to reflect.
import * as THREE from 'three/webgpu';
import { clamp, mix, normalize, positionLocal, smoothstep, vec3 } from 'three/tsl';

const FOG_COLOR = 0x1a2027;
const FOG_DENSITY = 0.027;
const DOME_RADIUS = 150;
const ENV_INTENSITY = 0.45; // dimmer reflections so robot metal doesn't glare
const ENV_BLUR_SIGMA = 0.02;

function buildDome(): THREE.Mesh {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  mat.fog = false;
  mat.depthWrite = false;
  const dirY = normalize(positionLocal).y;
  const horizon = vec3(0.028, 0.034, 0.045);
  const zenith = vec3(0.006, 0.007, 0.01);
  const ground = vec3(0.01, 0.011, 0.013);
  const up = mix(horizon, zenith, smoothstep(0.05, 0.6, dirY));
  mat.colorNode = mix(ground, up, clamp(dirY.mul(8).add(1), 0, 1));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 16), mat);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  return dome;
}

function emissive(color: THREE.ColorRepresentation, intensity: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide });
  m.fog = false;
  return m;
}

/** A crude venue for image-based lighting, centred at robot chest height. */
function buildEnvScene(): THREE.Scene {
  const s = new THREE.Scene();
  s.add(buildDome());
  const bank = new THREE.BoxGeometry(2.6, 0.1, 0.6);
  const warm = emissive(0xffc38a, 9);
  const cool = emissive(0xdfe8ff, 14);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const m = new THREE.Mesh(bank, i % 2 ? warm : cool);
    m.position.set(Math.cos(a) * 4.5, 6.5, Math.sin(a) * 4.5);
    m.rotation.y = -a;
    s.add(m);
  }
  const key = new THREE.Mesh(new THREE.CircleGeometry(0.9, 24), emissive(0xffffff, 30));
  key.position.set(0, 6.8, 0);
  key.rotation.x = Math.PI / 2;
  s.add(key);
  const canvas = new THREE.Mesh(new THREE.CircleGeometry(4.5, 32), emissive(0xd9d3c6, 0.55));
  canvas.position.y = -1;
  canvas.rotation.x = -Math.PI / 2;
  s.add(canvas);
  const house = new THREE.Mesh(new THREE.TorusGeometry(22, 1.5, 6, 48), emissive(0x7a5a3a, 0.35));
  house.rotation.x = Math.PI / 2;
  house.position.y = 2;
  s.add(house);
  return s;
}

function disposeScene(s: THREE.Scene): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  s.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    geometries.add(o.geometry);
    materials.add(o.material as THREE.Material);
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
}

export interface EnvironmentView {
  dome: THREE.Mesh;
  dispose(): void;
}

export function installEnvironment(renderer: THREE.WebGPURenderer, scene: THREE.Scene): EnvironmentView {
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  scene.background = new THREE.Color(FOG_COLOR).multiplyScalar(0.3);
  const dome = buildDome();
  scene.add(dome);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = buildEnvScene();
  const target = pmrem.fromScene(envScene, ENV_BLUR_SIGMA, 0.1, 200);
  scene.environment = target.texture;
  scene.environmentIntensity = ENV_INTENSITY;
  pmrem.dispose();
  disposeScene(envScene); // captured and submitted; its GPU buffers are no longer needed
  return {
    dome,
    dispose() {
      target.dispose();
      dome.removeFromParent();
    },
  };
}
