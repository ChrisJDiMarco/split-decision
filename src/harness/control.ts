// Control harness: the real arena and robot kit, with MuJoCo stepping on the main thread through
// intents → control → motors → damage, so the control module can be watched and poked directly.
// Open http://localhost:5297/harness/control.html
//   ?d0=striker&d1=bruiser   designs          ?scene=spar|idle|getup   ?speed=0.5   ?damage=0
// Keys: Space pause · R reset · K knock robot 0 over · P shove robot 0 · 1-9 robot 0 throws its
// n-th ability · S toggle sparring. window.controlHarness exposes the context for scripting.
import * as THREE from 'three/webgpu';
import loadMujoco from '@mujoco/mujoco';
import type { Intent } from '../core/protocol';
import type { MatchSetup, SkinId } from '../core/types';
import { availableSkills, controllerOf, controlSystem, sparringIntent } from '../physics/control';
import { SKILLS } from '../physics/control/skills';
import { damageSystem } from '../physics/damage';
import { buildContext } from '../physics/runtime';
import type { SimContext, SimSystem } from '../physics/sim-context';
import { intentSystem } from '../physics/systems/intents';
import { motorSystem } from '../physics/systems/motors';
import { buildTelemetry } from '../physics/systems/telemetry';
import { compileWorld } from '../physics/world';
import { buildArenaView } from '../render/arena';
import { buildRobotKitViews, updateRobotKit } from '../render/robot-kit';
import type { RobotKitView } from '../render/robot-kit';
import { applyPoses } from '../render/robot-view';
import { createStage } from '../render/stage';
import { DESIGNS } from '../robots/designs';

const MAX_STEPS_PER_FRAME = 40;
const INTENT_PERIOD_S = 0.4;
const KNOCK_ACCEL = 12; // m/s² × mass for 0.25 s
const SHOVE_ACCEL = 6;

const params = new URLSearchParams(location.search);
const pick = (key: string, fallback: string) => (DESIGNS[params.get(key) ?? ''] ? params.get(key)! : fallback);
const designs: [string, string] = [pick('d0', 'striker'), pick('d1', 'bruiser')];
const scene = params.get('scene') ?? 'spar';
const speed = Math.max(0.05, Math.min(2, Number(params.get('speed') ?? 1)));
const withDamage = params.get('damage') !== '0';

const hud = document.getElementById('hud') as HTMLDivElement;
const stage = await createStage(document.getElementById('stage') as HTMLCanvasElement);
buildArenaView(stage);
stage.camera.position.set(0, 3.2, 7.5);
stage.controls.target.set(0, 1.0, 0);

const mj = await loadMujoco();
const systems: SimSystem[] = [intentSystem, controlSystem, motorSystem, ...(withDamage ? [damageSystem] : [])];

let ctx: SimContext;
let views: RobotKitView[] = [];
let bodyGroups = new Map<number, THREE.Group>();
let paused = false;
let sparring = scene === 'spar';
let nextIntentAt = 0;
let knockAt = scene === 'getup' ? 2.5 : -1;
let push: { corner: 0 | 1; accel: [number, number, number]; until: number } | null = null;
const log: string[] = [];

function setupFor(): MatchSetup {
  const skins: SkinId[] = ['neon', 'factory'];
  return {
    fighters: [
      { design: designs[0], skin: skins[0], plan: 'Control harness.', temperament: 1 },
      { design: designs[1], skin: skins[1], plan: 'Control harness.', temperament: 1 },
    ],
    seed: 7,
    timestep: 0.001,
    reactionDelayS: 0,
  };
}

function reset(): void {
  if (ctx) {
    ctx.data.delete();
    ctx.model.delete();
  }
  for (const v of views) v.dispose();
  const setup = setupFor();
  ctx = buildContext(mj, compileWorld(setup), setup);
  for (const s of systems) s.init?.(ctx);
  const meta = {
    nbody: ctx.model.nbody, timestep: ctx.dt, props: [],
    robots: ctx.robots.map((r) => ({ corner: r.corner, design: r.design.id, prefix: r.compiled.prefix, parts: [...r.parts.values()].map((p) => ({ id: p.id, body: p.body, debrisBody: p.debrisBody })) })),
  };
  ({ views, bodyGroups } = buildRobotKitViews(meta, stage.physicsRoot, [setup.fighters[0].skin, setup.fighters[1].skin]));
  nextIntentAt = 0;
  knockAt = scene === 'getup' ? 2.5 : -1;
  log.length = 0;
}

function step(): void {
  for (const s of systems) s.pre?.(ctx);
  applyPush();
  mj.mj_step(ctx.model, ctx.data);
  ctx.tick++;
  ctx.time += ctx.dt;
  for (const s of systems) s.post?.(ctx);
  if (!ctx.released && ctx.time > 0.6) {
    for (const r of ctx.robots) ctx.setEqActive(ctx.eqIndex(r.compiled.gantryWeld), false);
    ctx.released = true;
  }
  if (sparring && ctx.released && ctx.time >= nextIntentAt) {
    nextIntentAt = ctx.time + INTENT_PERIOD_S;
    for (const r of ctx.robots) r.intent = sparringIntent(ctx, r);
  }
  if (knockAt > 0 && ctx.time >= knockAt) {
    knockAt = -1;
    knock(0, KNOCK_ACCEL);
  }
  for (const e of ctx.events) if (e.kind !== 'impact' || e.impulseNs > 200) log.unshift(`${ctx.time.toFixed(2)} ${describe(e)}`);
  log.length = Math.min(log.length, 8);
  ctx.events = [];
}

function describe(e: SimContext['events'][number]): string {
  switch (e.kind) {
    case 'impact': return `impact ${e.striker ?? '-'}→${e.victim ?? '-'} ${e.part ?? ''} ${e.impulseNs.toFixed(0)} N·s`;
    case 'joint': return `joint r${e.corner} ${e.joint} ${e.state}`;
    case 'detach': return `detach r${e.corner} ${e.part}`;
    default: return `${e.kind} r${'corner' in e ? e.corner : ''}`;
  }
}

function applyPush(): void {
  if (!push) return;
  const r = ctx.robots[push.corner];
  const body = r.parts.get('torso')!.body;
  const m = ctx.model.body_subtreemass[r.rootBody];
  const xf = ctx.data.xfrc_applied;
  const on = ctx.time < push.until;
  // xfrc is shared with the gyro: add this step's shove and take it off after the step.
  for (let a = 0; a < 3; a++) xf[body * 6 + a] = on ? push.accel[a] * m : 0;
  if (!on) push = null;
}

/** Shove robot `corner` in the direction it faces away from its opponent. */
function knock(corner: 0 | 1, accel: number): void {
  const r = ctx.robots[corner];
  const o = ctx.robots[corner === 0 ? 1 : 0];
  const a = ctx.data.subtree_com, b = r.rootBody * 3, c = o.rootBody * 3;
  const dx = a[b] - a[c], dy = a[b + 1] - a[c + 1];
  const n = Math.hypot(dx, dy) || 1;
  push = { corner, accel: [(dx / n) * accel, (dy / n) * accel, 0], until: ctx.time + 0.25 };
}

function throwAbility(n: number): void {
  const r = ctx.robots[0];
  const c = controllerOf(r);
  const ids = availableSkills(r);
  const id = ids[n];
  if (!c || !id) return;
  const def = SKILLS[id];
  if (def) c.startSkill(def, def.defaultZone, 0.7);
}

function frame(): void {
  const n = ctx.model.nbody;
  const poses = new Float32Array(n * 7);
  const xpos = ctx.data.xpos, xquat = ctx.data.xquat;
  for (let b = 0; b < n; b++) {
    poses.set([xpos[b * 3], xpos[b * 3 + 1], xpos[b * 3 + 2], xquat[b * 4], xquat[b * 4 + 1], xquat[b * 4 + 2], xquat[b * 4 + 3]], b * 7);
  }
  applyPoses(poses, bodyGroups);
  updateRobotKit(views, ctx.robots.map((r) => buildTelemetry(ctx, r, systems)), 1 / 60);
  hud.textContent = hudText();
}

function hudText(): string {
  const lines = [`t=${ctx.time.toFixed(2)}  ${paused ? 'PAUSED' : `×${speed}`}  ${sparring ? 'sparring' : 'manual'}   [space] pause [R] reset [K] knock [P] shove [1-9] skill [S] spar`];
  for (const r of ctx.robots) {
    const c = controllerOf(r);
    const intent: Intent | null = r.intent;
    lines.push(
      `r${r.corner} ${r.design.id.padEnd(8)} ${r.skill.padEnd(12)} ${(r.windup * 100).toFixed(0).padStart(3)}%  ${c ? c.gait.phase.padEnd(6) : ''}` +
      ` ${r.down ? 'DOWN ' : ''}${r.koReason ? `KO:${r.koReason} ` : ''}gyro ${((r.gyro?.saturation ?? 0) * 100).toFixed(0)}%  landed ${c?.skills.stats.landed ?? 0}/${c?.skills.stats.thrown ?? 0}` +
      `  ${intent ? `${intent.tactic}@${intent.aggression.toFixed(1)}` : ''}`,
    );
  }
  lines.push(`abilities r0: ${availableSkills(ctx.robots[0]).map((s, i) => `${i + 1}:${s}`).join(' ')}`);
  return [...lines, '', ...log].join('\n');
}

let last = performance.now();
let debt = 0;
function loop(now: number): void {
  const wall = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused) {
    debt += wall * speed;
    let steps = 0;
    while (debt >= ctx.dt && steps < MAX_STEPS_PER_FRAME) {
      step();
      debt -= ctx.dt;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) debt = 0;
  }
  frame();
  stage.render();
  requestAnimationFrame(loop);
}

window.addEventListener('keydown', (e) => {
  if (e.key === ' ') paused = !paused;
  else if (e.key === 'r' || e.key === 'R') reset();
  else if (e.key === 'k' || e.key === 'K') knock(0, KNOCK_ACCEL);
  else if (e.key === 'p' || e.key === 'P') knock(0, SHOVE_ACCEL);
  else if (e.key === 's' || e.key === 'S') sparring = !sparring;
  else if (/^[1-9]$/.test(e.key)) throwAbility(Number(e.key) - 1);
});

reset();
(window as unknown as Record<string, unknown>).controlHarness = {
  get ctx() { return ctx; },
  controller: (i: 0 | 1) => controllerOf(ctx.robots[i]),
  pause: (p = true) => { paused = p; },
  steps: (n: number) => { for (let i = 0; i < n; i++) step(); frame(); },
  knock: (corner: 0 | 1 = 0, accel = KNOCK_ACCEL) => knock(corner, accel),
  throw: throwAbility,
  spar: (on = true) => { sparring = on; },
  reset,
};
requestAnimationFrame(loop);
