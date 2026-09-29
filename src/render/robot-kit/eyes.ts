// Eyes and head lights. Every frame, per robot:
//   gaze   where to look: RobotTelemetry.gaze when the physics publishes it, else derived from
//          the bodies (track the opponent's head, snap to his striking fist when he winds up,
//          glance at the target before throwing, look down when getting up), else an idle scan.
//          The neck servo turns the head; the optics cover the rest inside the head with
//          saccades: hold a fixation, then snap (catch-up saccades when the target moves).
//   mood   brightness from aggression and Jev's confidence; a lock-on flare while committing to
//          a big shot, a flourish or an opening reflex; a white flash when hit; flicker and
//          brown-outs as the head and body take damage; hot red when badly hurt; dim and die on a
//          KO or a flat battery.
// Optics stay small emissives: GLOW_CAP bounds every boost so nothing blooms into glare.
import * as THREE from 'three/webgpu';
import { FLASHY_MOVES, type RobotTelemetry } from '../../core/protocol';
import type { TargetZone } from '../../core/protocol';
import type { EyeElement, EyeState, GazeInput, GazeMode, KitPart, RobotKitView } from './types';

const YAW_RANGE = 0.62; // rad of eye travel either side (the neck covers the rest)
const PITCH_RANGE = 0.48;
const SIN_RANGE = Math.sin(0.55); // lens-plane projection that maps to a pupil's full travel
const SACCADE_RATE = 40; // 1/s: a saccade lands in ~60 ms
const THREAT_SACCADE_RATE = 75;
const SLIDER_RATE = 16; // bar and slit hotspots sweep rather than jump
const FIXATION_MIN_S = 0.25;
const FIXATION_MAX_S = 0.95;
const CATCH_UP_RAD = 0.1; // target drift that forces a catch-up saccade
const MICRO_RAD = 0.035; // fixation jitter picked at each saccade
const SCAN_TARGETS: Array<[number, number]> = [[-0.5, 0.05], [0.1, -0.12], [0.55, 0.08], [-0.15, 0.2], [0.35, -0.2], [-0.6, -0.08]];

const LEVEL_IDLE = 0.8;
const LEVEL_BASE = 0.6;
const LEVEL_AGGRESSION = 0.24;
const LEVEL_CONFIDENCE = 0.16;
const LEVEL_RATE = 3;
const RING_SHARE = 0.55; // static rings and strips burn at this share of the moving optics
const GLOW_CAP = 1.4; // no optic ever exceeds 1.4x the design's normal eye level
const FLARE_GAIN = 0.4;
const FLARE_WHITE = 0.45;
const FLARE_FOCUS = 0.28; // pupils and hotspots tighten this much on a lock-on
const FLARE_ATTACK = 20; // 1/s
const FLARE_RELEASE = 3.5;
const FLASH_GAIN = 0.25;
const FLASH_DECAY = 7; // 1/s
const HEAD_FLASH_J = 60; // a head hit this hard flashes white fully
const BODY_FLASH_J = 300;
const BODY_FLASH_MAX = 0.45;
const FLICKER_HP = 0.5; // head hp below which the optics drop out
const FLICKER_DAMAGE = 0.35; // overall damage above which they start to stutter
const TINT_FROM = 0.5; // hurt level where the optics start to run red
const TINT_TO = 0.85;
const KO_FADE_S = 1.4;
const KO_SAG_RAD = 0.4; // a knocked-out robot's optics droop this far down
const KO_SAG_RATE = 2.5;
const POWER_UP_RATE = 3;
const LOW_BATTERY = 0.15;
const DEAD_BATTERY = 0.02;
const DOWN_DIM = 0.85;
const EYE_DEATH_S = 2.6; // seconds for a severed head's optics to die

/** Committing strikes that earn a lock-on flare by themselves. */
const BIG_SHOTS = new Set<string>(['overhand', 'rocket_punch', 'head_kick', 'hammer_smash', 'jaw_crush', 'lunge', ...FLASHY_MOVES]);

export function newEyeState(seed: number): EyeState {
  return {
    seed: (seed % 997) / 997, yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0, nextSaccade: 0, scanPhase: 0, mode: 'scan',
    level: LEVEL_IDLE, flare: 0, flash: 0, power: 1, tint: 0, lastFlashAt: -1, override: {},
  };
}

/** Cheap deterministic noise in 0..1. */
function hash(t: number, seed: number): number {
  const s = Math.sin(t * 12.9898 + seed * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function flick(t: number, rate: number, seed: number): number {
  return hash(Math.floor(t * rate), seed);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function approach(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/** A hit on the robot: white flash on the optics (full on the head, softer on the body). */
export function noteHit(view: RobotKitView, partId: string, energyJ: number): void {
  const kit = view.parts.get(partId);
  if (!kit || !(energyJ > 0)) return;
  const head = kit.def.tags.includes('head');
  const amount = head ? Math.min(1, energyJ / HEAD_FLASH_J) : Math.min(BODY_FLASH_MAX, energyJ / BODY_FLASH_J);
  if (amount > view.eyes.flash) view.eyes.flash = amount;
  view.eyes.lastFlashAt = view.time;
}

// ---------------------------------------------------------------- gaze

/** The physics gaze if this telemetry carries a usable one (RobotTelemetry.gaze). */
export function telemetryGaze(tel: RobotTelemetry | undefined): GazeInput | null {
  const g = tel?.gaze;
  if (!g || !Array.isArray(g.point) || g.point.length !== 3 || !g.point.every((v) => Number.isFinite(v))) return null;
  return { point: [g.point[0], g.point[1], g.point[2]], mode: g.mode };
}

const ZONE_PART: Record<TargetZone, string[]> = {
  head: ['head'], torso: ['torso'], left_arm: ['forearm_l', 'upperarm_l'], right_arm: ['forearm_r', 'upperarm_r'],
  left_leg: ['shin_l', 'thigh_l'], right_leg: ['shin_r', 'thigh_r'], weapon: ['fist_r', 'fist_l'],
};

function partPos(view: RobotKitView, ids: string[]): THREE.Vector3 | null {
  for (const id of ids) {
    const k = view.parts.get(id);
    if (k?.state.attached) return k.attached.position;
  }
  return null;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

/** The opponent's fist nearest to us (what is coming in). */
function incomingFist(opp: RobotKitView, from: THREE.Vector3): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null;
  let bestD = Infinity;
  for (const k of opp.parts.values()) {
    if (!k.def.tags.includes('fist') || !k.state.attached) continue;
    const d = k.attached.position.distanceToSquared(from);
    if (d < bestD) {
      bestD = d;
      best = k.attached.position;
    }
  }
  return best;
}

const THREAT_WINDUP = 0.45;
const THREAT_RANGE_M = 2.2;
const AIM_WINDUP = 0.25;

/** Gaze from the bodies when the physics does not publish one. */
function derivedGaze(head: KitPart, tel: RobotTelemetry | undefined, opp: RobotKitView | undefined, oppTel: RobotTelemetry | undefined): GazeInput | null {
  const h = head.attached.position;
  if (tel && (tel.down || /^(getup|rise|kip)/.test(tel.skill))) {
    // Look at the canvas just ahead, where a hand is about to plant.
    tmpA.set(1, 0, 0).applyQuaternion(head.attached.quaternion).setZ(0);
    if (tmpA.lengthSq() < 1e-6) tmpA.set(1, 0, 0);
    tmpA.normalize();
    return { point: [h.x + tmpA.x * 0.45, h.y + tmpA.y * 0.45, 0], mode: 'down' };
  }
  if (!opp) return null;
  const oppHead = partPos(opp, ['head', 'torso']);
  if (!oppHead) return null;
  if (oppTel && oppTel.windup > THREAT_WINDUP && oppHead.distanceTo(h) < THREAT_RANGE_M) {
    const fist = incomingFist(opp, h) ?? oppHead;
    return { point: [fist.x, fist.y, fist.z], mode: 'threat' };
  }
  if (tel && tel.windup > AIM_WINDUP) {
    const aim = partPos(opp, ZONE_PART[tel.intent?.target ?? 'head'] ?? ['head']) ?? oppHead;
    return { point: [aim.x, aim.y, aim.z], mode: 'aim' };
  }
  return { point: [oppHead.x, oppHead.y, oppHead.z], mode: 'track' };
}

/** Yaw / pitch of a physics-space point seen from the head, in the head frame. */
function lookAngles(head: KitPart, eyeOrigin: THREE.Vector3, p: [number, number, number]): [number, number] {
  tmpQ.copy(head.attached.quaternion).invert();
  tmpA.set(p[0], p[1], p[2]).sub(head.attached.position).applyQuaternion(tmpQ).sub(eyeOrigin);
  const yaw = Math.atan2(tmpA.y, tmpA.x);
  const pitch = Math.atan2(tmpA.z, Math.hypot(tmpA.x, tmpA.y));
  return [THREE.MathUtils.clamp(yaw, -YAW_RANGE, YAW_RANGE), THREE.MathUtils.clamp(pitch, -PITCH_RANGE, PITCH_RANGE)];
}

function eyeOrigin(view: RobotKitView, head: KitPart): THREE.Vector3 {
  const els = view.animated.eyes.filter((e) => e.part === head.id && e.kind !== 'beacon');
  const o = new THREE.Vector3();
  for (const e of els) o.add(e.rest);
  return els.length ? o.divideScalar(els.length) : o;
}

const origins = new WeakMap<RobotKitView, THREE.Vector3>();

function updateLook(view: RobotKitView, head: KitPart, gaze: GazeInput | null, dt: number): void {
  const e = view.eyes;
  const t = view.time;
  let origin = origins.get(view);
  if (!origin) {
    origin = eyeOrigin(view, head);
    origins.set(view, origin);
  }
  const mode: GazeMode = gaze ? gaze.mode : 'scan';
  let ty: number;
  let tp: number;
  if (gaze && gaze.mode !== 'scan') [ty, tp] = lookAngles(head, origin, gaze.point);
  else {
    const [sy, sp] = SCAN_TARGETS[e.scanPhase % SCAN_TARGETS.length];
    ty = sy * YAW_RANGE;
    tp = sp * PITCH_RANGE;
  }
  const drift = Math.hypot(ty - e.targetYaw, tp - e.targetPitch);
  const snapNow = (mode === 'threat' && e.mode !== 'threat') || (mode !== 'scan' && drift > CATCH_UP_RAD);
  if (t >= e.nextSaccade || snapNow) {
    if (mode === 'scan' && t >= e.nextSaccade) {
      e.scanPhase = (e.scanPhase + 1 + Math.floor(hash(t, e.seed) * 2)) % SCAN_TARGETS.length;
      const [sy, sp] = SCAN_TARGETS[e.scanPhase];
      ty = sy * YAW_RANGE;
      tp = sp * PITCH_RANGE;
    }
    const jitter = mode === 'threat' ? 0 : MICRO_RAD;
    e.targetYaw = ty + (hash(t, e.seed + 1) - 0.5) * 2 * jitter;
    e.targetPitch = tp + (hash(t, e.seed + 2) - 0.5) * 2 * jitter;
    const fix = FIXATION_MIN_S + (FIXATION_MAX_S - FIXATION_MIN_S) * hash(t, e.seed + 3);
    e.nextSaccade = t + (mode === 'threat' ? fix * 0.5 : fix);
  }
  e.mode = mode;
  const rate = mode === 'threat' ? THREAT_SACCADE_RATE : SACCADE_RATE;
  e.yaw = approach(e.yaw, e.targetYaw, rate, dt);
  e.pitch = approach(e.pitch, e.targetPitch, rate, dt);
}

// ---------------------------------------------------------------- mood

/** Lock-on target 0..1: the physics gaze lock when published, else read from the body. */
function lockTarget(e: EyeState, tel: RobotTelemetry | undefined): number {
  if (e.override.flare !== undefined) return e.override.flare ? 1 : 0;
  const lock = tel?.gaze?.lock;
  if (typeof lock === 'number' && Number.isFinite(lock)) return THREE.MathUtils.clamp(lock, 0, 1);
  return lockOn(tel) ? 1 : 0;
}

function lockOn(tel: RobotTelemetry | undefined): boolean {
  if (!tel) return false;
  const skill = tel.skill;
  let big = false;
  for (const m of BIG_SHOTS) if (skill === m || skill.startsWith(`${m}_`)) big = true;
  const committing = tel.windup > 0.3 || (big && tel.skillPhase > 0 && tel.skillPhase < 0.55);
  if (!committing) return false;
  if (big) return true;
  const intent = tel.intent;
  if (!intent) return false;
  if (intent.flourish) return true;
  const armed = intent.onOpening;
  if (armed && tel.openings?.some((o) => {
    const move = armed[o];
    return !!move && (skill === move || skill.startsWith(move));
  })) return true;
  return intent.aggression > 0.85 && tel.windup > 0.5;
}

function headOf(view: RobotKitView): KitPart | undefined {
  return view.parts.get('head') ?? [...view.parts.values()].find((k) => k.def.tags.includes('head'));
}

function hurtLevel(view: RobotKitView, head: KitPart | undefined, tel: RobotTelemetry | undefined): { hurt: number; headHp: number; damage: number } {
  const headHp = head?.state.hp ?? 1;
  let damage = tel?.damageTotal;
  if (damage === undefined) {
    let sum = 0;
    for (const k of view.parts.values()) sum += k.state.hp;
    damage = 1 - sum / Math.max(1, view.parts.size);
  }
  const forced = view.eyes.override.hurt;
  if (forced !== undefined) return { hurt: forced, headHp: Math.min(headHp, 1 - forced * 0.8), damage: Math.max(damage, forced) };
  return { hurt: Math.max(damage, (1 - headHp) * 0.9), headHp, damage };
}

function powerTarget(e: EyeState, tel: RobotTelemetry | undefined): { target: number; ko: boolean; battery: number } {
  const ko = e.override.ko ?? tel?.skill === 'out';
  const battery = e.override.battery ?? tel?.battery ?? 1;
  if (ko || battery <= DEAD_BATTERY) return { target: 0, ko: true, battery };
  if (battery < LOW_BATTERY) return { target: 0.35 + 0.65 * (battery / LOW_BATTERY), ko: false, battery };
  return { target: 1, ko: false, battery };
}

function elementPose(el: EyeElement, e: EyeState, dt: number, sliders: Map<EyeElement, number>): void {
  if (el.kind === 'beacon') return;
  // How far the gaze is off the head's straight-ahead, in the head frame; each optic shows that
  // on its own lens plane, so every pupil on a head (even a canted side lens) shifts the same way.
  const cp = Math.cos(e.pitch);
  tmpB.set(cp * Math.cos(e.yaw) - 1, cp * Math.sin(e.yaw), Math.sin(e.pitch));
  if (el.kind === 'pupil') {
    const du = THREE.MathUtils.clamp(tmpB.dot(el.u) / SIN_RANGE, -1, 1);
    const dv = THREE.MathUtils.clamp(tmpB.dot(el.v) / SIN_RANGE, -1, 1);
    // Keep the pupil inside the round lens.
    const m = Math.hypot(du, dv);
    const k = m > 1 ? 1 / m : 1;
    el.object.position.copy(el.rest).addScaledVector(el.u, du * k * el.travel).addScaledVector(el.v, dv * k * el.travel);
    return;
  }
  // Hotspots run with the gaze angle along their strip: a slit across (yaw), a bar up (pitch).
  const target = THREE.MathUtils.clamp((Math.sin(e.yaw) * el.u.y + Math.sin(e.pitch) * el.u.z) / SIN_RANGE, -1, 1);
  const cur = approach(sliders.get(el) ?? 0, target, SLIDER_RATE, dt);
  sliders.set(el, cur);
  if (el.path && el.path.length > 1) {
    samplePath(el.path, 0.5 + 0.5 * cur, el.object.position);
    return;
  }
  el.object.position.copy(el.rest).addScaledVector(el.u, cur * el.travel);
}

function samplePath(path: THREE.Vector3[], t: number, out: THREE.Vector3): void {
  const f = THREE.MathUtils.clamp(t, 0, 1) * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(f));
  out.copy(path[i]).lerp(path[i + 1], f - i);
}

const sliderState = new WeakMap<RobotKitView, Map<EyeElement, number>>();

/** Advance one robot's optics. `opp` / `oppTel` are the other corner (null in a lone showroom). */
export function updateEyes(view: RobotKitView, tel: RobotTelemetry | undefined, opp: RobotKitView | undefined, oppTel: RobotTelemetry | undefined, dt: number): void {
  const e = view.eyes;
  const t = view.time;
  const head = headOf(view);
  if (head && !head.state.attached) {
    // A severed head's optics stutter and die on the debris.
    if (head.debrisObj) {
      const since = t - head.detachedAt;
      const fade = Math.max(0, 1 - since / EYE_DEATH_S);
      const stutter = flick(t, 11, head.obj.seed + 3) < 0.35 ? 0.1 : 1;
      head.debrisObj.glow = fade * fade * stutter;
      head.debrisObj.flash = 0;
    }
    return;
  }

  // Gaze and saccades. Knocked out, the optics sag down as they die.
  const ko = e.override.ko ?? tel?.skill === 'out';
  if (head && ko) {
    e.targetYaw = 0;
    e.targetPitch = -KO_SAG_RAD;
    e.yaw = approach(e.yaw, e.targetYaw, KO_SAG_RATE, dt);
    e.pitch = approach(e.pitch, e.targetPitch, KO_SAG_RATE, dt);
  } else if (head) {
    const forced = e.override.gaze;
    const gaze = forced !== undefined ? forced : telemetryGaze(tel) ?? derivedGaze(head, tel, opp, oppTel);
    updateLook(view, head, gaze, dt);
  }

  // Mood: level, lock-on, flash, damage, power.
  const intent = tel?.intent;
  const levelTarget = intent ? LEVEL_BASE + LEVEL_AGGRESSION * intent.aggression + LEVEL_CONFIDENCE * intent.confidence : LEVEL_IDLE;
  e.level = approach(e.level, levelTarget, LEVEL_RATE, dt);
  const lock = lockTarget(e, tel);
  e.flare = approach(e.flare, lock, lock > e.flare ? FLARE_ATTACK : FLARE_RELEASE, dt);
  e.flash *= Math.exp(-FLASH_DECAY * dt);
  const { hurt, headHp, damage } = hurtLevel(view, head, tel);
  e.tint = approach(e.tint, smoothstep(TINT_FROM, TINT_TO, hurt), 2, dt);
  const pw = powerTarget(e, tel);
  if (pw.target < e.power) e.power = Math.max(pw.target, e.power - dt / KO_FADE_S);
  else e.power = approach(e.power, pw.target, POWER_UP_RATE, dt);

  const flickerP = THREE.MathUtils.clamp((FLICKER_HP - headHp) * 1.6 + (damage - FLICKER_DAMAGE) * 0.9, 0, 0.55);
  let out = Math.min(GLOW_CAP, e.level * (1 + FLARE_GAIN * e.flare + FLASH_GAIN * e.flash));
  if (flickerP > 0 && flick(t, 16, e.seed) < flickerP) out *= 0.08;
  if (damage > 0.5) out *= 1 - 0.15 * (0.5 + 0.5 * Math.sin(t * 19 + e.seed * 9)); // brown-out sag
  if (tel?.down && !pw.ko) out *= DOWN_DIM;
  if (pw.ko && e.power > 0 && e.power < 1 && flick(t, 11, e.seed + 5) < 0.35) out *= 0.15; // dying stutter
  if (!pw.ko && pw.battery < LOW_BATTERY) out *= 0.7 + 0.3 * (Math.sin(t * 7.5) > 0 ? 1 : 0);
  out *= e.power;
  const white = Math.min(1, e.flash + FLARE_WHITE * e.flare);

  if (head) {
    head.obj.glow = out * RING_SHARE;
    head.obj.flash = white;
    head.obj.tint = e.tint;
  }
  let sliders = sliderState.get(view);
  if (!sliders) {
    sliders = new Map();
    sliderState.set(view, sliders);
  }
  for (const el of view.animated.eyes) {
    elementPose(el, e, dt, sliders);
    let g = out * el.gain;
    if (el.kind === 'beacon') {
      const rate = 1.5 + 5 * (intent?.aggression ?? 0.3);
      const pulse = 0.5 + 0.5 * Math.sin(t * rate * Math.PI * 2);
      g *= Math.max(e.flare, 0.25 + 0.75 * pulse * pulse);
    }
    if (el.kind !== 'beacon') el.object.scale.setScalar(1 - FLARE_FOCUS * e.flare);
    el.obj.glow = Math.min(GLOW_CAP, g);
    el.obj.flash = white;
    el.obj.tint = e.tint;
  }
}
