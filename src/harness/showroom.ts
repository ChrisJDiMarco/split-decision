// Robot kit showroom: every design in every skin on a studio turntable, with a lineup view of
// all skins, a roster view of the modern fighters side by side, and buttons that exercise the
// damage path (dents, heat, knocked-off head). Physics mode runs the real MuJoCo worker through
// the production contract.
// Loadouts, eyes and hands: a HANDS row swaps the hands slot (stock / gloves / knuckle plates /
// dexterous, via applyLoadout, so the showroom builds exactly what the physics compiles), HAND POSE
// holds fist / open / brace, GAZE makes the head and optics scan or track a moving orb, MOOD plays
// the optics states (fired up, lock-on flare, hit flash, damaged flicker, hurt red, KO, battery).
// Open http://localhost:5297/harness/showroom.html
//   ?design=savate&skin=livery   ?mode=lineup   ?mode=roster   ?mode=physics&d0=firecracker&d1=haymaker
//   ?turn=35&spin=0 (fixed turntable angle, degrees)   ?still=1 (hold the stance)   ?webgl=1
//   ?era=iron (roster of the iron age)   ?hands=dexterous   ?pose=fist|open|brace   ?gaze=scan|orb
//   ?mood=lockon|hit|damaged|hurt|ko|lowbatt|deadbatt|fired   ?cam=head|hands   ?ui=0 (clean screenshots)
import * as THREE from 'three/webgpu';
import type { HandsOption, Loadout, RobotDesign, SkinId } from '../core/types';
import { DESIGNS } from '../robots/designs';
import { HANDS_LABEL, HANDS_OPTIONS, applyLoadout } from '../robots/loadout';
import { HAND_POSES, SKIN_IDS, SKINS, noteHit, setPartState, updateRobotKit, type HandPose } from '../render/robot-kit';
import { startPhysicsShow, type PhysicsShow } from '../render/robot-kit/showroom/physics-mode';
import { ShowroomRobot } from '../render/robot-kit/showroom/puppet';
import { createStudio } from '../render/robot-kit/showroom/studio';

type Mode = 'single' | 'lineup' | 'roster' | 'physics';
type PoseId = 'auto' | 'fist' | 'open' | 'brace';
type GazeId = 'free' | 'scan' | 'orb';
type MoodId = 'normal' | 'fired' | 'lockon' | 'hit' | 'damaged' | 'hurt' | 'ko' | 'lowbatt' | 'deadbatt';
type CamId = 'body' | 'head' | 'hands';

const POSES: Record<Exclude<PoseId, 'auto'>, HandPose> = { fist: HAND_POSES.fist, open: HAND_POSES.open, brace: HAND_POSES.brace };
const MOODS: Array<[MoodId, string]> = [
  ['normal', 'Normal'], ['fired', 'Fired up'], ['lockon', 'Lock-on'], ['hit', 'Hit flash'], ['damaged', 'Damaged'],
  ['hurt', 'Hurt red'], ['ko', 'KO'], ['lowbatt', 'Low batt'], ['deadbatt', 'Dead batt'],
];
const HIT_FLASH_J = 90;
const HIT_REPEAT_S = 1.2; // the hit-flash demo re-fires so a still frame can catch it
const ORB_RADIUS_M = 0.035;

const PLINTH_TOP_M = 0.07;

const LINEUP_SPACING_M = 1.25;
const ROSTER_SPACING_M = 1.1;
const DEFAULT_DESIGN = 'firecracker';
const TURN_RATE = 0.22; // rad/s

const params = new URLSearchParams(location.search);
const initialDesign = params.get('design') && DESIGNS[params.get('design')!] ? params.get('design')! : DEFAULT_DESIGN;
const state = {
  design: initialDesign,
  skin: (SKIN_IDS as readonly string[]).includes(params.get('skin') ?? '') ? (params.get('skin') as SkinId) : DESIGNS[initialDesign].defaultSkin,
  mode: (['lineup', 'roster', 'physics'].includes(params.get('mode') ?? '') ? params.get('mode') : 'single') as Mode,
  pair: [DESIGNS[params.get('d0') ?? ''] ? params.get('d0')! : 'firecracker', DESIGNS[params.get('d1') ?? ''] ? params.get('d1')! : 'haymaker'] as [string, string],
  spin: params.get('spin') !== '0',
  pump: params.get('pump') !== '0',
  gyro: Number(params.get('gyro') ?? 0.25),
  still: params.get('still') === '1',
  era: params.get('era') === 'iron' ? 'iron' : 'modern',
  hands: (HANDS_OPTIONS as readonly string[]).includes(params.get('hands') ?? '') ? (params.get('hands') as HandsOption) : 'stock' as HandsOption,
  pose: (['fist', 'open', 'brace'].includes(params.get('pose') ?? '') ? params.get('pose') : 'auto') as PoseId,
  gaze: (['scan', 'orb'].includes(params.get('gaze') ?? '') ? params.get('gaze') : 'free') as GazeId,
  mood: (MOODS.some(([m]) => m === params.get('mood')) ? params.get('mood') : 'normal') as MoodId,
  cam: (['head', 'hands'].includes(params.get('cam') ?? '') ? params.get('cam') : 'body') as CamId,
};

const statusEl = document.getElementById('stats')!;
if (params.get('ui') === '0') for (const id of ['ui', 'tag']) document.getElementById(id)!.style.display = 'none';
function status(msg: string): void {
  statusEl.textContent = msg;
  (window as unknown as { showroomStatus: string }).showroomStatus = msg;
}

status('starting renderer…');
const studio = await createStudio(document.getElementById('c') as HTMLCanvasElement, params.get('webgl') === '1').catch((e: unknown) => {
  status(`renderer failed: ${e instanceof Error ? e.message : String(e)}`);
  throw e;
});
let robots: ShowroomRobot[] = [];
let physics: PhysicsShow | null = null;
let clock = 0;
let lastHit = -Infinity;
let frozen = false; // automated screenshots hold the last stepped frame

// The gaze orb: a small glowing ball that wanders in front of the robots.
const orb = new THREE.Mesh(new THREE.SphereGeometry(ORB_RADIUS_M, 20, 14), new THREE.MeshStandardNodeMaterial({ color: 0x222222, emissive: 0x7fd4ff, emissiveIntensity: 1.2 }));
orb.visible = false;
studio.physicsRoot.add(orb);

function loadoutFor(id: string): Loadout {
  return { design: id, hands: state.hands };
}

/** The design with the selected hands slot, exactly as the physics would compile it. */
function loaded(id: string): RobotDesign {
  try {
    return applyLoadout(DESIGNS[id], loadoutFor(id));
  } catch {
    return DESIGNS[id];
  }
}

function startPhysics(): void {
  studio.turntable.rotation.y = 0;
  studio.physicsRoot.position.y = 0; // the physics canvas is the studio floor
  const skins = state.pair.map((id) => DESIGNS[id].defaultSkin) as [SkinId, SkinId];
  physics = startPhysicsShow(studio.physicsRoot, state.pair, skins, [loadoutFor(state.pair[0]), loadoutFor(state.pair[1])]);
  studio.camera.position.set(0.4, 1.7, 7.5);
  studio.controls.target.set(0, 1.0, 0);
}

function rebuild(): void {
  for (const r of robots) r.dispose();
  robots = [];
  physics?.dispose();
  physics = null;
  studio.physicsRoot.position.y = PLINTH_TOP_M;
  const design = loaded(state.design);
  if (state.mode === 'physics') {
    startPhysics();
  } else if (state.mode === 'single') {
    robots.push(new ShowroomRobot(design, state.skin, studio.physicsRoot, new THREE.Vector3(0, 0, 0)));
    studio.controls.target.set(0, 1.0, 0);
    if (params.has('turn')) studio.turntable.rotation.y = (Number(params.get('turn')) * Math.PI) / 180;
  } else if (state.mode === 'roster') {
    const ids = state.era === 'iron' ? ironIds() : modernIds();
    ids.forEach((id, i) => {
      const x = (i - (ids.length - 1) / 2) * ROSTER_SPACING_M * (state.era === 'iron' ? 1.35 : 1);
      robots.push(new ShowroomRobot(loaded(id), state.skin === 'livery' ? DESIGNS[id].defaultSkin : state.skin, studio.physicsRoot, new THREE.Vector3(x, 0, 0), -Math.PI / 2 + 0.45, i * 0.9));
    });
    studio.turntable.rotation.y = 0;
    studio.camera.position.set(0.3, 1.5, 7.6);
    studio.controls.target.set(0, 0.95, 0);
  } else {
    SKIN_IDS.forEach((skin, i) => {
      const x = (i - (SKIN_IDS.length - 1) / 2) * LINEUP_SPACING_M;
      // Physics +x is world +x; yaw -90° turns each robot to face world +z (the camera).
      robots.push(new ShowroomRobot(design, skin, studio.physicsRoot, new THREE.Vector3(x, 0, 0), -Math.PI / 2, i * 0.7));
    });
    studio.turntable.rotation.y = 0;
    studio.camera.position.set(0.6, 1.6, 8.8);
    studio.controls.target.set(0, 1.0, 0);
  }
  for (const r of robots) {
    r.pump = state.pump;
    r.gyroLoad = state.gyro;
    r.still = state.still;
    r.hand = state.pose === 'auto' ? 'auto' : POSES[state.pose];
  }
  applyMood();
  aimCamera();
  renderTag();
  renderUi();
}

// ---------------------------------------------------------------- eyes and hands demos

/** Put every robot's optics and telemetry in the selected mood. */
function applyMood(): void {
  for (const r of robots) {
    const eyes = r.view.eyes;
    eyes.override = {};
    r.demo = {};
    const head = r.view.parts.get('head');
    if (head?.state.attached) setPartState(r.view, 'head', { hp: 1 });
    switch (state.mood) {
      case 'fired':
        r.demo = { intent: { tactic: 'close_distance', target: 'head', aggression: 1, confidence: 1, source: 'jev' } };
        break;
      case 'lockon':
        r.demo = { skill: 'overhand', skillPhase: 0.3, windup: 0.8, intent: { tactic: 'overhand', target: 'head', aggression: 0.9, confidence: 0.9, source: 'jev' } };
        break;
      case 'damaged':
        if (head?.state.attached) setPartState(r.view, 'head', { hp: 0.3 });
        r.demo = { damageTotal: 0.42 };
        break;
      case 'hurt':
        eyes.override.hurt = 0.95;
        r.demo = { damageTotal: 0.9 };
        break;
      case 'ko':
        r.demo = { skill: 'out', down: true };
        break;
      case 'lowbatt':
        r.demo = { battery: 0.07 };
        break;
      case 'deadbatt':
        r.demo = { battery: 0 };
        break;
      default:
        break;
    }
  }
  lastHit = -Infinity;
}

/** Gaze demo: the orb wanders in front; heads track it (neck snaps, optics saccade). */
function updateGaze(): void {
  orb.visible = state.gaze === 'orb' && state.mode !== 'physics';
  if (state.mode === 'physics') return;
  const t = clock;
  // Physics-space point in front of the lineup (the robots face the camera, world +z).
  const span = state.mode === 'single' ? 1.2 : 2.6;
  orb.position.set(Math.sin(t * 0.7) * span, -1.0 - Math.sin(t * 0.43) * 0.3, 1.25 + Math.sin(t * 1.1) * 0.45);
  if (state.mode === 'single') orb.position.set(1.0 + Math.sin(t * 0.43) * 0.3, Math.sin(t * 0.7) * span, 1.3 + Math.sin(t * 1.1) * 0.45);
  orb.updateMatrixWorld(true);
  const world = orb.getWorldPosition(new THREE.Vector3());
  for (const r of robots) {
    if (state.gaze === 'free') {
      r.gazeTarget = null;
      delete r.view.eyes.override.gaze;
      continue;
    }
    if (state.gaze === 'scan') {
      r.gazeTarget = null;
      r.view.eyes.override.gaze = null;
      continue;
    }
    const local = r.root.worldToLocal(world.clone());
    r.gazeTarget = local;
    r.view.eyes.override.gaze = { point: [local.x, local.y, local.z], mode: 'track' };
  }
}

function updateMood(): void {
  if (state.mood !== 'hit' || clock - lastHit < HIT_REPEAT_S) return;
  lastHit = clock;
  for (const r of robots) noteHit(r.view, 'head', HIT_FLASH_J);
}

/** Frame the heads or the fists of the robots on show. */
function aimCamera(): void {
  if (state.cam === 'body' || robots.length === 0) return;
  studio.turntable.rotation.y = state.mode === 'single' && !params.has('turn') ? 0 : studio.turntable.rotation.y;
  for (const r of robots) r.update(0, false);
  studio.physicsRoot.updateWorldMatrix(true, true);
  const pts: THREE.Vector3[] = [];
  const fwd = new THREE.Vector3();
  for (const r of robots) {
    const ids = state.cam === 'head' ? ['head'] : robots.length > 1 ? ['fist_l', 'fist_r'] : ['fist_l'];
    for (const id of ids) {
      const kit = r.view.parts.get(id);
      if (kit) pts.push(new THREE.Box3().setFromObject(kit.content).getCenter(new THREE.Vector3()));
    }
    // Look at the fighters from where they face (the torso's +x).
    const torso = r.view.parts.get('torso')?.attached;
    if (torso) fwd.add(new THREE.Vector3(1, 0, 0).transformDirection(torso.matrixWorld));
  }
  if (!pts.length) return;
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
  fwd.normalize();
  if (robots.length > 1) fwd.set(0, 0, 1); // lineups face the camera side (world +z)
  const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const box = new THREE.Box3().setFromPoints(pts);
  const c = box.getCenter(new THREE.Vector3());
  const w = Math.max(box.getSize(new THREE.Vector3()).length(), 0.25);
  const dist = (state.cam === 'head' ? (robots.length > 1 ? 0.78 : 0.5) : robots.length > 1 ? 0.7 : 0.36) + w * (robots.length > 1 ? 1.05 : 0.62);
  studio.controls.target.copy(c);
  studio.camera.position.copy(c).addScaledVector(fwd, dist).addScaledVector(side, dist * 0.18).add(new THREE.Vector3(0, state.cam === 'head' ? 0.04 : 0.1, 0));
  studio.controls.update();
}

// ---------------------------------------------------------------- UI

function modernIds(): string[] {
  return Object.keys(DESIGNS).filter((id) => DESIGNS[id].era !== 'iron');
}

function ironIds(): string[] {
  return Object.keys(DESIGNS).filter((id) => DESIGNS[id].era === 'iron');
}

function pickDesign(id: string): void {
  state.design = id;
  state.skin = DESIGNS[id].defaultSkin;
  if (state.mode === 'roster') state.mode = 'single';
  rebuild();
}

const ui = document.getElementById('ui')!;
const tag = document.getElementById('tag')!;
const stats = document.getElementById('stats')!;

function button(label: string, on: boolean, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.className = `${on ? 'on' : ''} ${cls}`.trim();
  b.addEventListener('click', onClick);
  return b;
}

function row(label: string, children: HTMLElement[]): HTMLDivElement {
  const r = document.createElement('div');
  r.className = 'row';
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = label;
  r.append(l, ...children);
  return r;
}

function renderUi(): void {
  ui.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'title';
  title.innerHTML = 'ROBOT KIT <small>SPLIT DECISION · SHOWROOM</small>';
  ui.append(title);
  ui.append(row('MODERN', modernIds().map((id) => button(DESIGNS[id].name, id === state.design && state.mode !== 'roster', () => pickDesign(id)))));
  ui.append(row('IRON AGE', ironIds().map((id) => button(DESIGNS[id].name, id === state.design && state.mode !== 'roster', () => pickDesign(id)))));
  ui.append(row('SKIN', SKIN_IDS.map((s) => button(SKINS[s].name, s === state.skin && state.mode === 'single', () => { state.skin = s; state.mode = 'single'; rebuild(); }))));
  ui.append(row('VIEW', [
    button('Turntable', state.mode === 'single', () => { state.mode = 'single'; rebuild(); }),
    button('All skins', state.mode === 'lineup', () => { state.mode = 'lineup'; rebuild(); }),
    button('Roster', state.mode === 'roster' && state.era === 'modern', () => { state.mode = 'roster'; state.era = 'modern'; state.skin = 'livery'; rebuild(); }),
    button('Iron roster', state.mode === 'roster' && state.era === 'iron', () => { state.mode = 'roster'; state.era = 'iron'; state.skin = 'factory'; rebuild(); }),
    button('Physics', state.mode === 'physics', () => { state.mode = 'physics'; rebuild(); }),
    button(state.spin ? 'Spin on' : 'Spin off', state.spin, () => { state.spin = !state.spin; renderUi(); }),
    button(state.pump ? 'Pistons on' : 'Pistons off', state.pump, () => { state.pump = !state.pump; for (const r of robots) r.pump = state.pump; renderUi(); }),
  ]));
  const gyro = document.createElement('input');
  gyro.type = 'range';
  gyro.min = '0';
  gyro.max = '1';
  gyro.step = '0.01';
  gyro.value = String(state.gyro);
  gyro.addEventListener('input', () => {
    state.gyro = Number(gyro.value);
    for (const r of robots) r.gyroLoad = state.gyro;
  });
  ui.append(row('GYRO', [gyro]));
  ui.append(row('HANDS', HANDS_OPTIONS.map((h) => button(HANDS_LABEL[h], h === state.hands, () => { state.hands = h; rebuild(); }))));
  ui.append(row('HAND POSE', (['auto', 'fist', 'open', 'brace'] as PoseId[]).map((p) => button(p, p === state.pose, () => {
    state.pose = p;
    for (const r of robots) r.hand = p === 'auto' ? 'auto' : POSES[p];
    renderUi();
  }))));
  ui.append(row('GAZE', ([['free', 'Free'], ['scan', 'Idle scan'], ['orb', 'Track orb']] as Array<[GazeId, string]>).map(([g, label]) => button(label, g === state.gaze, () => { state.gaze = g; renderUi(); }))));
  ui.append(row('MOOD', MOODS.map(([m, label]) => button(label, m === state.mood, () => { state.mood = m; applyMood(); renderUi(); }))));
  ui.append(row('CAMERA', ([['body', 'Body'], ['head', 'Heads'], ['hands', 'Hands']] as Array<[CamId, string]>).map(([c, label]) => button(label, c === state.cam, () => { state.cam = c; aimCamera(); renderUi(); }))));
  if (state.mode === 'physics') {
    ui.append(row('FIGHT', [
      button('Release', false, () => physics?.release(), 'act'),
      button('Reset', false, () => physics?.reset()),
    ]));
    return;
  }
  ui.append(row('DAMAGE', [
    button('Damage test', false, () => { for (const r of robots) r.damageTest(); }, 'act'),
    button('Knock head off', false, () => { for (const r of robots) r.knockOff('head'); }, 'act'),
    button('Reset', false, () => rebuild()),
  ]));
}

function renderTag(): void {
  if (state.mode === 'physics') {
    tag.innerHTML = `<div class="n">${DESIGNS[state.pair[0]].name} vs ${DESIGNS[state.pair[1]].name}</div><div class="t">Live MuJoCo bodies, kit views, telemetry and impacts.</div>`;
    return;
  }
  if (state.mode === 'roster') {
    tag.innerHTML = state.era === 'iron'
      ? '<div class="n">IRON AGE</div><div class="t">The hydraulic heavyweights.</div>'
      : '<div class="n">THE ROSTER</div><div class="t">All-electric, 1.3 to 1.9 m, 38 to 103 kg.</div>';
    return;
  }
  const d = DESIGNS[state.design];
  tag.innerHTML = `<div class="n">${d.name}</div><div class="t">${d.tagline}</div>`;
}

// ---------------------------------------------------------------- loop

try {
  status('building robots…');
  rebuild();
  status('rendering…');
} catch (e) {
  status(`build failed: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`);
  throw e;
}
let last = performance.now();
let frames = 0;
let fpsT = last;
let fps = 0;

function tick(dt: number): void {
  clock += dt;
  if (state.spin && state.mode === 'single' && state.cam === 'body') studio.turntable.rotation.y += dt * TURN_RATE;
  updateGaze();
  updateMood();
  for (const r of robots) r.update(dt, true);
  if (robots.length) updateRobotKit(robots.map((r) => r.view), robots.map((r) => r.telemetry()), dt);
  physics?.update(dt);
  studio.render();
}

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (frozen) studio.render();
  else tick(dt);
  frames++;
  if (now - fpsT > 500) {
    fps = (frames * 1000) / (now - fpsT);
    frames = 0;
    fpsT = now;
    const info = studio.renderer.info;
    const tris = robots[0]?.view.triangles ?? physics?.views()[0]?.triangles ?? 0;
    const extra = physics ? `\n${physics.status()}` : '';
    stats.textContent = `${studio.isWebGPU ? 'WebGPU' : 'WebGL2'} · ${fps.toFixed(0)} fps\n${(tris / 1000).toFixed(1)}k tris/robot · ${info.render.drawCalls} draws · ${(info.render.triangles / 1000).toFixed(0)}k tris drawn${extra}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** Render frames without requestAnimationFrame (hidden tabs, automated screenshots). */
async function step(n = 1, dt = 1 / 60): Promise<void> {
  for (let i = 0; i < n; i++) {
    tick(dt);
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Automated checks: show one design in a gaze / mood / hands state and report the optics. */
async function shot(o: { design?: string; mood?: MoodId; gaze?: GazeId; hands?: HandsOption; pose?: PoseId; cam?: CamId; mode?: Mode; era?: 'modern' | 'iron'; frames?: number }): Promise<Record<string, unknown>> {
  if (o.design) state.design = o.design;
  if (o.mode) state.mode = o.mode;
  if (o.era) state.era = o.era;
  if (o.hands) state.hands = o.hands;
  if (o.pose) state.pose = o.pose;
  if (o.gaze) state.gaze = o.gaze;
  if (o.mood) state.mood = o.mood;
  if (o.cam) state.cam = o.cam;
  state.skin = state.mode === 'roster' && state.era === 'iron' ? 'factory' : DESIGNS[state.design].defaultSkin;
  rebuild();
  frozen = true;
  await step(o.frames ?? 40, 1 / 30);
  aimCamera();
  await step(2, 1 / 30);
  const r = robots[0];
  const e = r?.view.eyes;
  return e ? {
    flare: +e.flare.toFixed(2), flash: +e.flash.toFixed(2), power: +e.power.toFixed(2), tint: +e.tint.toFixed(2),
    yaw: +e.yaw.toFixed(2), pitch: +e.pitch.toFixed(2), optics: r.view.animated.eyes.map((x) => `${x.kind}:${x.obj.glow.toFixed(2)}`).join(' '),
    grip: r.view.hands.pose, tris: r.view.triangles,
  } : {};
}

// Handy for automated checks from the console.
Object.assign(window, { showroom: { studio, robots: () => robots, physics: () => physics, state, rebuild, step, renderUi, applyMood, aimCamera, shot, unfreeze: () => { frozen = false; } } });
