// Arena harness: the cage, lights, crowd and post chain alone, with two stand-in capsules
// for scale and a slow fly-around. URL params: ?q=high|medium|low, ?webgl=1, ?cam=fly|wide|close|fence|crowd|top|mat|bow|bowtop.
// Keys: 1/2/3 quality, B bow a random panel, H hold the front panel bowed, Space pause the fly-around.
// ?hold=1 starts with the front panel held bowed (for screenshots).
import * as THREE from 'three/webgpu';
import { ARENA, panels } from '../core/arena-spec';
import { buildArenaView, installPostProcessing, type Quality } from '../render/arena';
import { physicsToWorld } from '../render/arena/util';
import { createStage } from '../render/stage';

const FLY_SPEED = 0.07; // rad/s
const FLY_RADIUS = 10.5;
const AUTO_BOW_S = 3.5;

const params = new URLSearchParams(location.search);
const q0 = (params.get('q') as Quality | null) ?? 'high';
const camMode = params.get('cam') ?? 'fly';

// ?webgl=1 hides WebGPU so the renderer takes its automatic WebGL2 fallback path.
if (params.get('webgl') === '1') Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });

const stage = await createStage(document.getElementById('stage') as HTMLCanvasElement);
const arena = buildArenaView(stage);
const post = installPostProcessing(stage, arena, q0);

function standIn(color: number, x: number): THREE.Mesh {
  const height = 1.75;
  const r = 0.26;
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(r, height - 2 * r, 8, 24),
    new THREE.MeshPhysicalNodeMaterial({ color, metalness: 0.85, roughness: 0.32, clearcoat: 0.5 }),
  );
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, 0, height / 2);
  mesh.castShadow = mesh.receiveShadow = true;
  stage.physicsRoot.add(mesh);
  return mesh;
}
standIn(0xb0341f, -ARENA.SPAWN_OFFSET_M);
standIn(0x1f4fb0, ARENA.SPAWN_OFFSET_M);
const debris = new THREE.Mesh(
  new THREE.BoxGeometry(0.22, 0.14, 0.08),
  new THREE.MeshStandardNodeMaterial({ color: 0x3a3c40, metalness: 0.9, roughness: 0.4 }),
);
debris.position.set(0.4, -0.9, 0.04);
debris.rotation.z = 0.6;
debris.castShadow = true;
stage.physicsRoot.add(debris);

const fixedCams: Record<string, [THREE.Vector3, THREE.Vector3]> = {
  wide: [new THREE.Vector3(0, 6.5, 12.5), new THREE.Vector3(0, 0.6, 0)],
  close: [new THREE.Vector3(-0.2, 1.1, 3.2), new THREE.Vector3(-2.1, 0.8, -0.6)],
  fence: [new THREE.Vector3(1.2, 1.2, 2.4), new THREE.Vector3(1.6, 1.0, 4.3)],
  crowd: [new THREE.Vector3(0, 1.8, -1.5), new THREE.Vector3(0, 2.5, 15)],
  top: [new THREE.Vector3(0, 6.4, 0.6), new THREE.Vector3(0, 0, 0)],
  bow: [new THREE.Vector3(-2.3, 1.1, 3.7), new THREE.Vector3(2.0, 0.9, 4.35)],
  mat: [new THREE.Vector3(-1.2, 0.55, 1.0), new THREE.Vector3(-0.6, 0, -0.2)],
  bowtop: [new THREE.Vector3(0.3, 4.2, 3.9), new THREE.Vector3(0.3, 1.0, 4.25)],
};

let flying = camMode === 'fly';
let holdBow = params.get('hold') === '1';
const FRONT_PANEL_POS: [number, number, number] = [0.3, -4.1, 1.0]; // physics frame, the -y side
let flyAngle = 0.35;
if (!flying) {
  const [pos, target] = fixedCams[camMode] ?? fixedCams.wide;
  stage.camera.position.copy(pos);
  stage.controls.target.copy(target);
}

function bowRandom(): void {
  const ps = panels();
  const p = ps[Math.floor(Math.random() * ps.length)];
  const along = (Math.random() - 0.5) * p.length * 0.6;
  const x = p.center[0] - Math.sin(p.normalAngle) * along;
  const y = p.center[1] + Math.cos(p.normalAngle) * along;
  arena.bowFence([x, y, 0.6 + Math.random() * 0.8], 0.6 + Math.random() * 0.6);
}

const hud = document.getElementById('hud') as HTMLDivElement;
hud.innerHTML = '<div class="hud-help">1/2/3 quality · B bow fence · H hold bow · SPACE pause fly-around</div><div class="hud-perf" id="perf"></div>';
const perf = document.getElementById('perf') as HTMLDivElement;

window.addEventListener('keydown', (e) => {
  if (e.code === 'Digit1') post.setQuality('high');
  if (e.code === 'Digit2') post.setQuality('medium');
  if (e.code === 'Digit3') post.setQuality('low');
  if (e.code === 'KeyB') bowRandom();
  if (e.code === 'KeyH') holdBow = !holdBow;
  if (e.code === 'Space') flying = !flying;
});

const clock = new THREE.Timer();
let frames = 0;
let fpsT = performance.now();
let bowT = 0;
const tmp = new THREE.Vector3();
(window as unknown as { arenaHarness: unknown }).arenaHarness = { arena, post, stage, fps: 0 };

function frame(): void {
  clock.update();
  const dt = Math.min(clock.getDelta(), 0.1);
  if (flying) {
    flyAngle += dt * FLY_SPEED;
    stage.camera.position.set(Math.cos(flyAngle) * FLY_RADIUS, 3.2 + Math.sin(flyAngle * 1.7) * 0.7, Math.sin(flyAngle) * FLY_RADIUS);
    stage.controls.target.copy(physicsToWorld(0, 0, 0.9, tmp));
  }
  bowT += dt;
  if (holdBow) arena.bowFence(FRONT_PANEL_POS, 0.5); // keeps pumping the spring against its clamp
  else if (bowT > AUTO_BOW_S) { bowT = 0; bowRandom(); }
  arena.update(dt);
  post.render();

  frames++;
  const now = performance.now();
  if (now - fpsT > 500) {
    const fps = (frames * 1000) / (now - fpsT);
    (window as unknown as { arenaHarness: { fps: number } }).arenaHarness.fps = fps;
    frames = 0;
    fpsT = now;
    const px = stage.renderer.getDrawingBufferSize(new THREE.Vector2());
    perf.textContent = `${stage.isWebGPU ? 'WebGPU' : 'WebGL2'} · ${fps.toFixed(0)} fps · ${post.quality} · ${px.x}×${px.y}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
