// VFX harness: a canvas-colored floor under arena-like light with a stand-in robot.
// Buttons fire the same SimEvents and telemetry the physics worker sends, in physics
// (z-up) coordinates, so the real conversion path is exercised.
// ?webgl=1 forces the WebGL2 backend (oil falls back to droplets + decals).
// Console helpers (work in a hidden tab too): await advance(seconds), look(x, y, z, tx, ty, tz),
// await profile(frames), window.vfx, window.vfxState.
import * as THREE from 'three/webgpu';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { pass } from 'three/tsl';
import type { PartTelemetry, RobotTelemetry, SimEvent } from '../core/protocol';
import type { Vec3 } from '../core/types';
import { VFX_REQUIRED_LIMITS, createVfx, type Vfx } from '../render/vfx';

const params = new URLSearchParams(location.search);
const forceWebGL = params.has('webgl');

async function makeRenderer(canvas: HTMLCanvasElement): Promise<THREE.WebGPURenderer> {
  const base = { canvas, antialias: true, forceWebGL, trackTimestamp: true };
  let renderer = new THREE.WebGPURenderer({ ...base, requiredLimits: forceWebGL ? {} : VFX_REQUIRED_LIMITS });
  try {
    await renderer.init();
  } catch (err) {
    console.warn('[vfx harness] device refused the fluid limits, retrying without them', err);
    renderer = new THREE.WebGPURenderer(base);
    await renderer.init();
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  return renderer;
}

function buildSet(scene: THREE.Scene, renderer: THREE.WebGPURenderer): THREE.Group {
  scene.background = new THREE.Color(0x07080a);
  scene.fog = new THREE.FogExp2(0x07080a, 0.03);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.06;
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(9, 96),
    new THREE.MeshStandardNodeMaterial({ color: 0xcfc8ba, roughness: 0.92 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  scene.add(new THREE.HemisphereLight(0x8899aa, 0x080808, 0.35));
  const key = new THREE.SpotLight(0xfff4e6, 160, 40, Math.PI / 5, 0.55, 1.6);
  key.position.set(0, 12, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  scene.add(key, key.target);
  const rim = new THREE.SpotLight(0x9fb8ff, 40, 30, Math.PI / 7, 0.6, 1.6);
  rim.position.set(-6, 7, -5);
  scene.add(rim, rim.target);
  const bot = standInRobot();
  scene.add(bot);
  return bot;
}

/** A blocky dark-metal humanoid so the effects have something to come off. */
function standInRobot(): THREE.Group {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x2c2e33, metalness: 0.85, roughness: 0.42 });
  const plate = new THREE.MeshStandardNodeMaterial({ color: 0x7a5a1a, metalness: 0.6, roughness: 0.5 });
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material = metal) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
  };
  box(0.34, 0.5, 0.5, 0, 1.3, 0, plate); // torso
  box(0.26, 0.2, 0.36, 0, 0.98, 0); // pelvis
  box(0.22, 0.24, 0.22, 0, 1.7, 0); // head
  for (const s of [-1, 1]) {
    box(0.14, 0.44, 0.14, 0, 0.66, s * 0.12); // thigh
    box(0.13, 0.44, 0.13, 0, 0.24, s * 0.12); // shin
    box(0.26, 0.06, 0.14, 0.05, 0.03, s * 0.12); // foot
    box(0.12, 0.3, 0.12, 0, 1.36, s * 0.33); // upper arm
    box(0.11, 0.28, 0.11, 0.12, 1.12, s * 0.33); // forearm
  }
  return g;
}

// ---------------------------------------------------------------- synthetic sim data

const VENT_ARM: Vec3 = [0.1, -0.33, 1.05]; // physics coords: right forearm
const VENT_TORSO: Vec3 = [-0.1, 0.1, 1.45];
const HIT_POS: Vec3 = [0.3, 0.0, 1.55];

function part(id: string, over: Partial<PartTelemetry>): PartTelemetry {
  return { id, hp: 1, smoke: 0, heat: 0, attached: true, leak: 0, ...over };
}

function robot(corner: 0 | 1, parts: PartTelemetry[]): RobotTelemetry {
  return {
    corner, upright: 1, balance: 1, down: false, comWorld: corner === 0 ? [0, 0, 1.0] : [2, 0, 1.0],
    heading: 0, velocity: [0, 0, 0], battery: 1, gyroHealth: 1, gyroSaturation: 0,
    hydraulicPressure: { arms: 1 }, skill: 'idle', skillPhase: 0, windup: 0, parts, joints: [],
    damageTotal: 0, intent: null,
  };
}

function impact(energyJ: number, metal = true, pos: Vec3 = HIT_POS, normal: Vec3 = [1, 0, 0]): SimEvent {
  const speed = Math.sqrt((2 * energyJ) / 8);
  return { kind: 'impact', pos, normal, impulseNs: energyJ / speed, speed, energyJ, striker: 1, victim: 0, part: 'head', metal };
}

// ---------------------------------------------------------------- UI

interface HarnessState {
  smoke: number;
  leak: number;
  torsoSmoke: number;
  /** The stand-in walks a slow circle, dragging its vents (and the oil trail) with it. */
  walk: boolean;
  walkAngle: number;
}

const WALK_RADIUS_M = 1.3;
const WALK_RAD_PER_S = 0.35;

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function button(panel: HTMLElement, label: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => onClick(b));
  panel.appendChild(b);
  return b;
}

function slider(panel: HTMLElement, label: string, value: number, onInput: (v: number) => void): void {
  const l = document.createElement('label');
  l.textContent = label;
  const s = document.createElement('input');
  s.type = 'range';
  s.min = '0';
  s.max = '1';
  s.step = '0.01';
  s.value = String(value);
  s.addEventListener('input', () => onInput(Number(s.value)));
  l.appendChild(s);
  panel.appendChild(l);
}

function buildPanel(vfx: Vfx, state: HarnessState): void {
  const panel = document.createElement('div');
  panel.className = 'vfx-panel';
  panel.innerHTML = '<h1>VFX HARNESS</h1>';
  document.getElementById('hud')!.appendChild(panel);
  button(panel, 'Spark burst (jab, 60 J)', () => vfx.onEvents([impact(60)]));
  button(panel, 'Spark burst (haymaker, 900 J)', () => vfx.onEvents([impact(900)]));
  button(panel, 'Heavy hit + debris (1600 J)', () => vfx.onEvents([impact(1600)]));
  button(panel, 'Head knocked off', () => vfx.onEvents([
    { kind: 'detach', corner: 0, part: 'head', debrisBody: 0, pos: [0, 0, 1.72], vel: [1.5, 0.4, 2.5] },
  ]));
  button(panel, 'Body slams canvas (dust)', () => vfx.onEvents([
    { kind: 'impact', pos: [0.9, 0.5, 0.05], normal: [0, 0, 1], impulseNs: 900, speed: 4.2, energyJ: 400, striker: null, victim: 0, part: 'torso', metal: false },
  ]));
  button(panel, 'Drop debris (bolts + shards)', () => vfx.onEvents([impact(2400, false, [0.2, 0.2, 1.8], [0, 0, 1])]));
  button(panel, 'Walk while damaged', (b) => {
    state.walk = !state.walk;
    b.setAttribute('aria-pressed', String(state.walk));
  });
  const smokeBtn = button(panel, 'Smoke plume (arm)', (b) => {
    state.smoke = state.smoke > 0 ? 0 : 0.85;
    b.setAttribute('aria-pressed', String(state.smoke > 0));
  });
  const leakBtn = button(panel, 'Oil leak (arm hydraulics)', (b) => {
    state.leak = state.leak > 0 ? 0 : 0.6;
    b.setAttribute('aria-pressed', String(state.leak > 0));
  });
  slider(panel, 'arm smoke level', 0.85, (v) => { state.smoke = v; smokeBtn.setAttribute('aria-pressed', String(v > 0)); });
  slider(panel, 'torso smoke level', 0, (v) => { state.torsoSmoke = v; });
  slider(panel, 'leak L/s', 0.6, (v) => { state.leak = v; leakBtn.setAttribute('aria-pressed', String(v > 0)); });
  button(panel, 'Stress test (everything)', () => {
    state.smoke = 1; state.torsoSmoke = 1; state.leak = 1.2;
    for (let i = 0; i < 6; i++) setTimeout(() => vfx.onEvents([impact(1200 + i * 200)]), i * 150);
  });
  button(panel, 'Clear', () => {
    state.smoke = 0; state.leak = 0; state.torsoSmoke = 0; state.walk = false; state.walkAngle = 0;
    vfx.clear();
  });
}

// ---------------------------------------------------------------- boot

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = await makeRenderer(canvas);
const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.05, 400);
camera.position.set(3.2, 1.9, 3.9);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.8, 0);
controls.enableDamping = true;
const standIn = buildSet(scene, renderer);

const vfx = createVfx({ renderer, scene, camera, isWebGPU });
const state: HarnessState = { smoke: 0, leak: 0, torsoSmoke: 0, walk: false, walkAngle: 0 };
buildPanel(vfx, state);
(window as unknown as { vfx: Vfx; vfxState: HarnessState }).vfx = vfx;
(window as unknown as { vfxState: HarnessState }).vfxState = state;
(window as unknown as { harness: object }).harness = { scene, camera, renderer };

const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const color = scenePass.getTextureNode('output');
pipeline.outputNode = color.add(bloom(color, 0.55, 0.3, 0.95));

const statsEl = document.createElement('div');
statsEl.className = 'vfx-stats';
document.getElementById('hud')!.appendChild(statsEl);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const poses = new Float32Array(0);

/** Feed telemetry and advance every effect by dt. */
function tick(dt: number): void {
  if (state.walk) state.walkAngle += WALK_RAD_PER_S * dt;
  const a = state.walkAngle;
  // Physics-frame offset of the walking stand-in (z-up), and its world placement.
  const offset: Vec3 = [Math.sin(a) * WALK_RADIUS_M, (1 - Math.cos(a)) * WALK_RADIUS_M, 0];
  standIn.position.set(offset[0], offset[2], -offset[1]);
  const r0 = robot(0, [
    part('forearm_r', { smoke: state.smoke, heat: state.smoke, leak: state.leak, ventWorld: add(VENT_ARM, offset), hp: 0.2 }),
    part('torso', { smoke: state.torsoSmoke, heat: state.torsoSmoke, ventWorld: add(VENT_TORSO, offset) }),
  ]);
  r0.comWorld = add(r0.comWorld, offset);
  const tel: [RobotTelemetry, RobotTelemetry] = [r0, robot(1, [])];
  vfx.onTelemetry(tel, poses);
  vfx.update(dt);
}

/**
 * Deterministic stepping for screenshots in a hidden tab (rAF is throttled there):
 * advance `seconds` of effect time at 60 Hz, then render one frame. Waits for the GPU
 * every few steps so a long advance never floods the queue (the fluid solver submits
 * real compute work per step).
 */
async function advance(seconds: number): Promise<void> {
  const steps = Math.round(seconds * 60);
  const device = (renderer.backend as { device?: GPUDevice }).device;
  for (let i = 0; i < steps; i++) {
    tick(1 / 60);
    if (device && i % 4 === 3) await device.queue.onSubmittedWorkDone();
  }
  controls.update();
  pipeline.render();
  if (device) await device.queue.onSubmittedWorkDone();
}
(window as unknown as { advance: typeof advance }).advance = advance;
/**
 * Average frame cost (ms) over `frames` frames: GPU timestamps for render and compute,
 * plus wall time from the start of the frame's CPU work until the GPU finishes it
 * (an upper bound on the frame's GPU time that does not depend on timestamp queries).
 */
async function profile(frames: number): Promise<{ render: number; compute: number; wall: number }> {
  const device = (renderer.backend as { device?: GPUDevice }).device;
  let render = 0;
  let compute = 0;
  let wall = 0;
  for (let i = 0; i < frames; i++) {
    if (device) await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    tick(1 / 60);
    controls.update();
    pipeline.render();
    if (device) await device.queue.onSubmittedWorkDone();
    wall += performance.now() - t0;
    render += (await renderer.resolveTimestampsAsync('render')) ?? 0;
    compute += (await renderer.resolveTimestampsAsync('compute')) ?? 0;
  }
  return { render: render / frames, compute: compute / frames, wall: wall / frames };
}
(window as unknown as { profile: typeof profile }).profile = profile;
/** Camera shortcut for inspection: look from (x, y, z) at (tx, ty, tz). */
(window as unknown as { look: (...v: number[]) => void }).look = (x, y, z, tx, ty, tz) => {
  camera.position.set(x, y, z);
  controls.target.set(tx, ty, tz);
  controls.update();
};

let last = performance.now();
let frames = 0;
let fpsT = last;
let gpuMs = 0;
function updateStats(now: number): void {
  const fps = (frames * 1000) / (now - fpsT);
  frames = 0;
  fpsT = now;
  if (isWebGPU) {
    void Promise.all([renderer.resolveTimestampsAsync('render'), renderer.resolveTimestampsAsync('compute')])
      .then(([r, c]) => { gpuMs = (r ?? 0) + (c ?? 0); })
      .catch(() => { gpuMs = -1; });
  }
  const s = vfx.stats;
  statsEl.textContent = [
    `${isWebGPU ? 'WebGPU' : 'WebGL2'} · ${fps.toFixed(0)} fps · gpu ${gpuMs.toFixed(2)} ms`,
    `vfx cpu ${s.cpuMs.toFixed(2)} ms`,
    `sparks ${s.sparks} · smoke ${s.smokePuffs}`,
    `debris ${s.debris} (${s.debrisMoving} moving)`,
    `oil ${s.oilMode} · ${s.oilParticles} particles`,
  ].join('\n');
}

function frame(): void {
  const now = performance.now();
  tick((now - last) / 1000);
  last = now;
  controls.update();
  pipeline.render();
  frames++;
  if (now - fpsT > 500) updateStats(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
