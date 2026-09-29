// Robot kit showroom: every design in every skin on a studio turntable, with a lineup view of
// all six skins and buttons that exercise the damage path (dents, heat, knocked-off head).
// Physics mode runs the real MuJoCo worker through the production contract.
// Open http://localhost:5297/harness/showroom.html
//   ?design=goliath&skin=chrome   ?mode=lineup   ?mode=physics&d0=bruiser&d1=goliath   ?webgl=1
import * as THREE from 'three/webgpu';
import type { SkinId } from '../core/types';
import { DESIGNS } from '../robots/designs';
import { SKIN_IDS, SKINS, updateRobotKit } from '../render/robot-kit';
import { startPhysicsShow, type PhysicsShow } from '../render/robot-kit/showroom/physics-mode';
import { ShowroomRobot } from '../render/robot-kit/showroom/puppet';
import { createStudio } from '../render/robot-kit/showroom/studio';

type Mode = 'single' | 'lineup' | 'physics';

const PLINTH_TOP_M = 0.07;

const LINEUP_SPACING_M = 1.25;
const TURN_RATE = 0.22; // rad/s

const params = new URLSearchParams(location.search);
const state = {
  design: params.get('design') && DESIGNS[params.get('design')!] ? params.get('design')! : 'bruiser',
  skin: (SKIN_IDS as readonly string[]).includes(params.get('skin') ?? '') ? (params.get('skin') as SkinId) : 'factory',
  mode: (['lineup', 'physics'].includes(params.get('mode') ?? '') ? params.get('mode') : 'single') as Mode,
  pair: [DESIGNS[params.get('d0') ?? ''] ? params.get('d0')! : 'bruiser', DESIGNS[params.get('d1') ?? ''] ? params.get('d1')! : 'goliath'] as [string, string],
  spin: params.get('spin') !== '0',
  pump: params.get('pump') !== '0',
  gyro: Number(params.get('gyro') ?? 0.25),
};

const statusEl = document.getElementById('stats')!;
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

function startPhysics(): void {
  studio.turntable.rotation.y = 0;
  studio.physicsRoot.position.y = 0; // the physics canvas is the studio floor
  const skins = state.pair.map((id) => DESIGNS[id].defaultSkin) as [SkinId, SkinId];
  physics = startPhysicsShow(studio.physicsRoot, state.pair, skins);
  studio.camera.position.set(0.4, 1.7, 7.5);
  studio.controls.target.set(0, 1.0, 0);
}

function rebuild(): void {
  for (const r of robots) r.dispose();
  robots = [];
  physics?.dispose();
  physics = null;
  studio.physicsRoot.position.y = PLINTH_TOP_M;
  const design = DESIGNS[state.design];
  if (state.mode === 'physics') {
    startPhysics();
  } else if (state.mode === 'single') {
    robots.push(new ShowroomRobot(design, state.skin, studio.physicsRoot, new THREE.Vector3(0, 0, 0)));
    studio.controls.target.set(0, 1.0, 0);
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
  }
  renderTag();
  renderUi();
}

// ---------------------------------------------------------------- UI

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
  ui.append(row('DESIGN', Object.keys(DESIGNS).map((id) => button(DESIGNS[id].name, id === state.design, () => { state.design = id; rebuild(); }))));
  ui.append(row('SKIN', SKIN_IDS.map((s) => button(SKINS[s].name, s === state.skin && state.mode === 'single', () => { state.skin = s; state.mode = 'single'; rebuild(); }))));
  ui.append(row('VIEW', [
    button('Turntable', state.mode === 'single', () => { state.mode = 'single'; rebuild(); }),
    button('All skins', state.mode === 'lineup', () => { state.mode = 'lineup'; rebuild(); }),
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
  if (state.spin && state.mode === 'single') studio.turntable.rotation.y += dt * TURN_RATE;
  for (const r of robots) r.update(dt, true);
  if (robots.length) updateRobotKit(robots.map((r) => r.view), robots.map((r) => r.telemetry()), dt);
  physics?.update(dt);
  studio.render();
}

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  tick(dt);
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

// Handy for automated checks from the console.
Object.assign(window, { showroom: { studio, robots: () => robots, physics: () => physics, state, rebuild, step, renderUi } });
