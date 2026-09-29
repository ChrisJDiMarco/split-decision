// Per-frame kit animation: joint frames follow the body poses, pistons and hoses track their
// two bodies, the gyro rotor spins and its core glows with saturation, the optics look, flare,
// flash, flicker and die (eyes.ts), dexterous fingers take the hand pose (hands.ts), torn wires
// spark. Telemetry (if given) drives part and joint state.
import * as THREE from 'three/webgpu';
import type { RobotTelemetry } from '../../core/protocol';
import { motor } from '../../robots/catalog';
import { setPartState } from './damage';
import { updateEyes } from './eyes';
import { updateHands } from './hands';
import { jointAngles, poseFrames } from './rig/joints';
import { updateLinkage } from './rig/linkages';
import type { KitPart, RigFrame, RobotKitView } from './types';

const GLOW_START_C = 55; // motors below this temperature do not glow
const SAT_RATE = 6; // 1/s smoothing of gyro saturation
const SPARK_RATE_HZ = 22;
const CORE_IDLE = 0.15;
const ROTOR_WOBBLE = 0.08;
const RAM_FIRE_AT = 0.38; // skill phase where the ram fires
const RAM_FIRE_LEN = 0.06;
const RAM_RETRACT_AT = 0.7;
const RAM_BLEED_RATE = 8; // 1/s

const DEFAULT_MAX_TEMP_C = 120;

const angles: number[] = [];
const maxTemps = new WeakMap<RobotKitView, Map<string, number>>();
const partMaxTemps = new WeakMap<RobotKitView, Map<string, number>>();

function jointMaxTemps(view: RobotKitView): Map<string, number> {
  let m = maxTemps.get(view);
  if (m) return m;
  m = new Map();
  for (const p of view.design.parts) for (const j of p.joints ?? []) m.set(j.name, motor(j.motor).maxTempC);
  maxTemps.set(view, m);
  return m;
}

/** Lowest motor rating among a part's joints (the part's heat is tempC / maxTempC of its hottest). */
function partMaxTemp(view: RobotKitView, partId: string): number {
  let m = partMaxTemps.get(view);
  if (!m) {
    m = new Map();
    for (const p of view.design.parts) {
      const ratings = (p.joints ?? []).map((j) => motor(j.motor).maxTempC);
      m.set(p.id, ratings.length ? Math.min(...ratings) : DEFAULT_MAX_TEMP_C);
    }
    partMaxTemps.set(view, m);
  }
  return m.get(partId) ?? DEFAULT_MAX_TEMP_C;
}

/** 0..1 glow ramp from an absolute temperature: dark below GLOW_START_C, full at the rating. */
function glowRamp(tempC: number, maxTempC: number): number {
  return Math.min(1, Math.max(0, (tempC - GLOW_START_C) / Math.max(1, maxTempC - GLOW_START_C)));
}

const frameIndex = new WeakMap<RobotKitView, Map<string, RigFrame>>();

/** Joint name → the rig frame holding that joint's stator housing. */
function jointFrames(view: RobotKitView): Map<string, RigFrame> {
  let m = frameIndex.get(view);
  if (m) return m;
  m = new Map();
  for (const kit of view.parts.values()) for (const f of kit.frames) m.set(f.joint, f);
  frameIndex.set(view, m);
  return m;
}

/** Cheap deterministic noise in 0..1 for flicker patterns. */
function flick(t: number, rate: number, seed: number): number {
  const s = Math.sin(Math.floor(t * rate) * 12.9898 + seed * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function syncTelemetry(view: RobotKitView, tel: RobotTelemetry, dt: number): void {
  for (const p of tel.parts) {
    const kit = view.parts.get(p.id);
    if (!kit) continue;
    const s = kit.state;
    // Telemetry heat is tempC / maxTempC; a 90 °C hydraulic idles at 0.31. Put the armor on the
    // same absolute ramp as the joint housings so it only glows when the motors overheat.
    const maxT = partMaxTemp(view, p.id);
    const heat = glowRamp(p.heat * maxT, maxT);
    if (p.attached !== s.attached || Math.abs(p.hp - s.hp) > 1e-3 || Math.abs(heat - s.heat) > 1e-3) {
      setPartState(view, p.id, { hp: p.hp, heat, attached: p.attached });
    }
  }
  const temps = jointMaxTemps(view);
  const frames = jointFrames(view);
  for (const j of tel.joints) {
    const max = temps.get(j.name) ?? DEFAULT_MAX_TEMP_C;
    view.jointHeat.set(j.name, glowRamp(j.tempC, max));
    // A failing actuator looks it: scuffed, chipped housing, scorched when seized.
    const f = frames.get(j.name);
    if (f) f.obj.wear = Math.max(f.obj.wear, 1 - j.health, j.state === 'seized' ? 0.9 : 0);
  }
  view.gyroSaturation += (tel.gyroSaturation - view.gyroSaturation) * Math.min(1, dt * SAT_RATE);
  view.gyroHealth = tel.gyroHealth;
}

function updateRig(view: RobotKitView, kit: KitPart): void {
  for (const f of kit.frames) f.obj.heat = Math.max(view.jointHeat.get(f.joint) ?? 0, 0);
  if (kit.frames.length < 2 || !kit.state.attached || !kit.def.parent) return;
  const parent = view.parts.get(kit.def.parent);
  if (!parent) return;
  jointAngles(kit.chain, parent.attached.quaternion, kit.attached.quaternion, angles);
  poseFrames(kit.frames, kit.chain, angles);
}

function updateSparks(view: RobotKitView, kit: KitPart): void {
  if (!kit.stumpObj) return;
  const since = view.time - kit.detachedAt;
  const activity = Math.max(0.15, 1 - since / 20);
  const f = flick(view.time, SPARK_RATE_HZ, kit.obj.seed + 7);
  kit.stumpObj.glow = f > 1 - 0.35 * activity ? 1 + f * 2 : 0;
}

function updateGyro(view: RobotKitView, dt: number): void {
  const torso = [...view.parts.values()].find((k) => k.def.tags.includes('gyro'));
  const health = view.gyroHealth;
  if (torso) {
    const flickerDead = health < 0.35 && flick(view.time, 9, 0.7) < 0.4 ? 0.2 : 1;
    torso.obj.core = (CORE_IDLE + view.gyroSaturation) * Math.max(0.05, health) * flickerDead;
  }
  for (const r of view.animated.rotors) {
    const wobble = (1 - health) * ROTOR_WOBBLE * Math.sin(view.time * 31);
    r.object.rotateOnAxis(r.axis, r.speed * Math.max(0.05, health) * dt);
    r.object.position.set(0, 0, 0).addScaledVector(r.axis, wobble * 0.02);
  }
}

/** Ram stroke over a strike skill: hold back through the windup, fire, hold, retract. */
function ramStroke(phase: number): number {
  if (phase < RAM_FIRE_AT) return 0;
  if (phase < RAM_FIRE_AT + RAM_FIRE_LEN) return (phase - RAM_FIRE_AT) / RAM_FIRE_LEN;
  if (phase < RAM_RETRACT_AT) return 1;
  return Math.max(0, 1 - (phase - RAM_RETRACT_AT) / (1 - RAM_RETRACT_AT));
}

const fwd = new THREE.Vector3();
const reach = new THREE.Vector3();

/** The punching arm: a side named in the skill wins, else the fist furthest forward. */
function strikingPart(view: RobotKitView, skill: string): string | null {
  const rams = view.animated.rams;
  const named = rams.find((r) => (skill.endsWith('_l') && r.part.endsWith('_l')) || (skill.endsWith('_r') && r.part.endsWith('_r')));
  if (named) return named.part;
  const torso = view.parts.get('torso') ?? view.parts.get(view.design.parts[0].id);
  if (!torso) return rams[0]?.part ?? null;
  fwd.set(1, 0, 0).applyQuaternion(torso.attached.quaternion);
  let best: string | null = null;
  let bestReach = -Infinity;
  for (const r of rams) {
    const fist = view.parts.get(r.part);
    if (!fist) continue;
    const d = reach.copy(fist.attached.position).sub(torso.attached.position).dot(fwd);
    if (d > bestReach) {
      bestReach = d;
      best = r.part;
    }
  }
  return best;
}

function updateRams(view: RobotKitView, tel: RobotTelemetry | undefined, dt: number): void {
  if (view.animated.rams.length === 0) return;
  const firing = !!tel && view.animated.rams.some((r) => tel.skill.includes(r.skill));
  const striker = firing ? strikingPart(view, tel!.skill) : null;
  for (const ram of view.animated.rams) {
    const target = firing && ram.part === striker ? ramStroke(tel!.skillPhase) : 0;
    // Pneumatic rams snap out and bleed back; ease only the retraction.
    ram.stroke = target > ram.stroke ? target : ram.stroke + (target - ram.stroke) * Math.min(1, dt * RAM_BLEED_RATE);
    ram.object.position.copy(ram.dir).multiplyScalar(ram.travel * ram.stroke);
  }
}

const groundPos = new THREE.Vector3();

/** Tell the skins where the physics canvas is in scene space (for floor dust). */
function updateGround(view: RobotKitView): void {
  const root = view.parts.values().next().value?.attached.parent;
  if (!root) return;
  const y = root.getWorldPosition(groundPos).y;
  for (const m of Object.values(view.materials)) {
    const u = m.userData.groundUniform as { value: number } | undefined;
    if (u) u.value = y;
  }
}

/** Advance the kit one render frame. `telemetry` may be null (showroom). */
export function updateRobotKit(views: readonly RobotKitView[], telemetry: readonly RobotTelemetry[] | null, dt: number): void {
  for (const view of views) {
    view.time += dt;
    const tel = telemetry?.find((t) => t.corner === view.corner);
    if (tel) syncTelemetry(view, tel, dt);
    for (const kit of view.parts.values()) {
      updateRig(view, kit);
      updateSparks(view, kit);
    }
    const opp = views.find((v) => v.corner !== view.corner);
    updateEyes(view, tel, opp, opp ? telemetry?.find((t) => t.corner === opp.corner) : undefined, dt);
    updateHands(view, tel, dt);
    for (const l of view.linkages) {
      const parent = view.parts.get(l.parent);
      const child = view.parts.get(l.child);
      if (!parent || !child || !child.state.attached) continue;
      updateLinkage(l, parent.attached, child.attached);
    }
    updateGyro(view, dt);
    updateRams(view, tel, dt);
    updateGround(view);
  }
}
