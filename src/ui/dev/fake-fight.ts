// Harness-only fake fight: two kinematic fighters built from the real designs circle,
// punch and fall, emitting the same frames, events, telemetry and minds the physics
// worker and brain would. Lets the broadcast (UI, camera, replay, audio) run alone.
import type { JointState, JointTelemetry, PartTelemetry, RobotTelemetry, SimEvent, Tactic, TargetZone, WorldMeta } from '../../core/protocol';
import type { Corner, MatchSetup, Quat, RobotDesign, Vec3 } from '../../core/types';
import { mulberry32 } from '../../physics/sim-context';
import { design as getDesign } from '../../robots/designs';
import { addV, mulQ } from '../../robots/compile-mjcf';
import type { FrameMsg } from '../broadcast';
import { axisAngle, partPoses } from '../kinematics';
import type { MindView, Minds } from '../minds';

export type FakeTrigger = 'bigHit' | 'headOff' | 'kneeFail' | 'fall' | 'ko' | 'smoke' | 'leak' | 'offline';

const FRAME_DT = 1 / 60;
const GRAVITY = 9.81;
const PARK: Vec3 = [40, 40, 2];
const PUNCH_EVERY_S = 1.3;
const PUNCH_S = 0.32;
const FALL_S = 0.6;
const MIND_EVERY_S = 0.7;
const MOVES: Tactic[] = ['hold_range', 'close_distance', 'circle_left', 'circle_right', 'retreat', 'guard', 'feint', 'sidestep_counter'];
const ZONES: TargetZone[] = ['head', 'torso', 'left_arm', 'right_arm', 'left_leg', 'right_leg'];

interface Fighter {
  corner: Corner;
  design: RobotDesign;
  bodies: Map<string, number>;
  debris: Map<string, number>;
  hp: Map<string, number>;
  smoke: Map<string, number>;
  leak: Map<string, number>;
  attached: Map<string, boolean>;
  joints: Map<string, { health: number; state: JointState }>;
  pos: Vec3;
  prevPos: Vec3;
  heading: number;
  down: number; // 0 standing .. 1 flat
  downTarget: number;
  punchT: number; // time since punch start, Infinity when idle
  punchSide: 'l' | 'r';
  nextPunch: number;
  battery: number;
  logits: Record<string, number>;
  mind: MindView | null;
  nextMind: number;
}

interface DebrisBody { body: number; pos: Vec3; vel: Vec3; quat: Quat; spin: Vec3 }

export class FakeFight {
  readonly meta: WorldMeta;
  paused = false;
  released = false;
  offline = false;
  time = 0;
  private tick = 0;
  private fighters: [Fighter, Fighter];
  private flying: DebrisBody[] = [];
  private pending: SimEvent[] = [];
  private rng: () => number;
  private frameAcc = 0;
  private script: Array<{ at: number; fn: () => void }>;

  constructor(private setup: MatchSetup) {
    this.rng = mulberry32(setup.seed);
    let next = 1;
    const make = (c: Corner): Fighter => {
      const d = getDesign(setup.fighters[c].design);
      const bodies = new Map<string, number>();
      for (const p of d.parts) bodies.set(p.id, next++);
      return {
        corner: c, design: d, bodies, debris: new Map(), hp: new Map(d.parts.map((p) => [p.id, 1])),
        smoke: new Map(), leak: new Map(), attached: new Map(d.parts.map((p) => [p.id, true])),
        joints: new Map(d.parts.flatMap((p) => (p.joints ?? []).map((j) => [j.name, { health: 1, state: 'ok' as JointState }]))),
        pos: [c === 0 ? -2.1 : 2.1, 0, d.rootHeight], prevPos: [0, 0, 0], heading: c === 0 ? 0 : Math.PI,
        down: 0, downTarget: 0, punchT: Infinity, punchSide: 'l', nextPunch: 1 + c * 0.6, battery: 1,
        logits: {}, mind: null, nextMind: 0,
      };
    };
    this.fighters = [make(0), make(1)];
    for (const f of this.fighters) for (const p of f.design.parts) if (p.detachable) f.debris.set(p.id, next++);
    this.meta = {
      nbody: next, timestep: setup.timestep,
      robots: this.fighters.map((f) => ({
        corner: f.corner, design: f.design.id, prefix: `r${f.corner}_`,
        parts: f.design.parts.map((p) => ({ id: p.id, body: f.bodies.get(p.id)!, debrisBody: f.debris.get(p.id) ?? null })),
      })),
      props: [],
    };
    this.script = [
      { at: 9, fn: () => this.trigger('kneeFail') },
      { at: 11, fn: () => this.trigger('smoke') },
      { at: 13, fn: () => this.trigger('leak') },
      { at: 19, fn: () => this.trigger('fall') },
    ];
  }

  release(): void {
    this.released = true;
  }

  trigger(kind: FakeTrigger): void {
    const [a, b] = this.fighters;
    switch (kind) {
      case 'bigHit': this.hit(a, b, 'head', 520); break;
      case 'headOff': this.detach(b, 'head'); break;
      case 'kneeFail': this.degrade(b, 'knee_l'); break;
      case 'fall': this.fall(b); break;
      case 'ko': this.detach(b, 'head'); this.pending.push({ kind: 'ko', corner: 1, reason: 'head' }); break;
      case 'smoke': a.smoke.set('torso', 0.6); a.hp.set('torso', Math.min(a.hp.get('torso')!, 0.35)); break;
      case 'leak': for (const p of a.design.parts) if (p.tags.includes('hydraulic')) a.leak.set(p.id, 0.12); break;
      case 'offline': this.offline = !this.offline; break;
    }
  }

  /** Advance wall time; returns a frame at ~60 Hz (null between frames). */
  step(dtWall: number): { frame: FrameMsg; minds: Minds } | null {
    if (!this.paused && this.released) {
      this.time += dtWall;
      this.tick += Math.round(dtWall / this.setup.timestep);
      for (const s of this.script) if (s.at >= 0 && this.time >= s.at) { s.fn(); s.at = -1; }
      for (const f of this.fighters) this.animate(f, dtWall);
      this.flyDebris(dtWall);
    }
    this.frameAcc += dtWall;
    if (this.frameAcc < FRAME_DT) return null;
    this.frameAcc = 0;
    const events = this.pending;
    this.pending = [];
    const poses = this.poses();
    return {
      frame: { type: 'frame', tick: this.tick, time: this.time, poses, events, telemetry: [this.telemetry(this.fighters[0]), this.telemetry(this.fighters[1])], stepMs: 0.12 },
      minds: [this.fighters[0].mind, this.fighters[1].mind],
    };
  }

  // ---------------------------------------------------------------- motion
  private animate(f: Fighter, dt: number): void {
    const other = this.fighters[f.corner === 0 ? 1 : 0];
    const t = this.time;
    const sep = 1.5 + 0.45 * Math.sin(t * 0.7);
    const theta = t * 0.22;
    const mid: Vec3 = [Math.sin(t * 0.13) * 0.9, Math.cos(t * 0.17) * 0.7, 0];
    const s = f.corner === 0 ? -1 : 1;
    f.prevPos = f.pos;
    const bob = f.down > 0 ? 0 : Math.abs(Math.sin(t * 5.5)) * 0.03;
    const z = f.design.rootHeight * (1 - f.down) + 0.28 * f.down + bob;
    f.pos = f.down > 0.05 ? [f.pos[0], f.pos[1], z] : [mid[0] + Math.cos(theta) * sep * 0.5 * s, mid[1] + Math.sin(theta) * sep * 0.5 * s, z];
    f.heading = Math.atan2(other.pos[1] - f.pos[1], other.pos[0] - f.pos[0]);
    f.down += Math.sign(f.downTarget - f.down) * Math.min(Math.abs(f.downTarget - f.down), dt / FALL_S);
    f.battery = Math.max(0, f.battery - dt * 0.004);
    for (const [id, v] of f.smoke) f.smoke.set(id, Math.min(1, v + dt * 0.02));
    this.punch(f, other, dt);
    this.think(f, other);
  }

  private punch(f: Fighter, other: Fighter, dt: number): void {
    f.punchT += dt;
    if (f.down > 0 || other.down > 0.5) return;
    if (this.time >= f.nextPunch && f.punchT > PUNCH_S) {
      f.punchT = 0;
      f.punchSide = this.rng() < 0.5 ? 'l' : 'r';
      f.nextPunch = this.time + PUNCH_EVERY_S * (0.6 + this.rng() * 0.9);
    }
    if (f.punchT < PUNCH_S * 0.5 && f.punchT + dt >= PUNCH_S * 0.5) {
      const zone = this.rng() < 0.6 ? 'head' : 'torso';
      this.hit(f, other, other.attached.get('head') ? zone : 'torso', 60 + this.rng() ** 2 * 420);
    }
  }

  private hit(striker: Fighter, victim: Fighter, part: string, energyJ: number): void {
    const poses = partPoses(victim.design, {}, { pos: victim.pos, quat: yawQuat(victim.heading) });
    const p = poses.get(part)?.pos ?? victim.pos;
    const pos: Vec3 = addV(p, [0, 0, part === 'head' ? 0.12 : 0.3]);
    victim.hp.set(part, Math.max(0.02, (victim.hp.get(part) ?? 1) - energyJ / 2200));
    this.pending.push({
      kind: 'impact', pos, normal: [Math.cos(striker.heading), Math.sin(striker.heading), 0], impulseNs: energyJ / 5,
      speed: 4 + energyJ / 80, energyJ, striker: striker.corner, victim: victim.corner, part, metal: true,
    });
  }

  private degrade(f: Fighter, joint: string): void {
    const j = f.joints.get(joint);
    if (!j) return;
    const next: JointState = j.state === 'ok' ? 'degraded' : j.state === 'degraded' ? 'limp' : 'seized';
    f.joints.set(joint, { health: next === 'degraded' ? 0.45 : next === 'limp' ? 0.15 : 0, state: next });
    this.pending.push({ kind: 'joint', corner: f.corner, joint, health: f.joints.get(joint)!.health, state: next });
  }

  private fall(f: Fighter): void {
    if (f.downTarget === 1) return;
    f.downTarget = 1;
    this.pending.push({ kind: 'fall', corner: f.corner });
    setTimeout(() => {
      if (f.attached.get('head')) { f.downTarget = 0; this.pending.push({ kind: 'getup', corner: f.corner }); }
    }, 3000);
  }

  private detach(f: Fighter, part: string): void {
    if (!f.attached.get(part)) return;
    const debrisBody = f.debris.get(part);
    if (debrisBody === undefined) return;
    const poses = partPoses(f.design, this.angles(f), { pos: f.pos, quat: this.rootQuat(f) });
    const pose = poses.get(part)!;
    const back: Vec3 = [-Math.cos(f.heading) * 3.2, -Math.sin(f.heading) * 3.2, 4.2];
    f.attached.set(part, false);
    f.hp.set(part, 0);
    this.flying.push({ body: debrisBody, pos: pose.pos, vel: back, quat: pose.quat, spin: [6, 3, 9] });
    this.pending.push({ kind: 'detach', corner: f.corner, part, debrisBody, pos: pose.pos, vel: back });
    const other = this.fighters[f.corner === 0 ? 1 : 0];
    this.pending.push({ kind: 'impact', pos: pose.pos, normal: [0, 0, 1], impulseNs: 300, speed: 12, energyJ: 1400, striker: other.corner, victim: f.corner, part, metal: true });
    this.fall(f);
  }

  private flyDebris(dt: number): void {
    for (const d of this.flying) {
      d.vel = [d.vel[0], d.vel[1], d.vel[2] - GRAVITY * dt];
      d.pos = addV(d.pos, [d.vel[0] * dt, d.vel[1] * dt, d.vel[2] * dt]);
      if (d.pos[2] < 0.12) {
        d.pos = [d.pos[0], d.pos[1], 0.12];
        d.vel = [d.vel[0] * 0.6, d.vel[1] * 0.6, Math.abs(d.vel[2]) * 0.35];
        d.spin = [d.spin[0] * 0.6, d.spin[1] * 0.6, d.spin[2] * 0.6];
      }
      const w = Math.hypot(...d.spin);
      if (w > 1e-3) d.quat = mulQ(axisAngle([d.spin[0] / w, d.spin[1] / w, d.spin[2] / w], w * dt), d.quat);
    }
  }

  // ---------------------------------------------------------------- brain
  private think(f: Fighter, other: Fighter): void {
    if (this.time < f.nextMind) return;
    f.nextMind = this.time + MIND_EVERY_S * (0.7 + this.rng() * 0.6);
    const tactics = [...MOVES, ...f.design.abilities.filter((a) => a !== 'sprint' && a !== 'spinner')] as string[];
    for (const t of tactics) f.logits[t] = (f.logits[t] ?? 0) * 0.6 + (this.rng() - 0.5) * 2.4;
    const temp = this.setup.fighters[f.corner].temperament;
    const exps = tactics.map((t) => Math.exp(f.logits[t] / temp));
    const z = exps.reduce((a, b) => a + b, 0);
    const probs = Object.fromEntries(tactics.map((t, i) => [t, exps[i] / z]));
    const chosen = tactics.reduce((best, t) => (probs[t] > probs[best] ? t : best), tactics[0]);
    const weak = [...other.joints].find(([, j]) => j.state !== 'ok');
    const target = weak ? (weak[0].endsWith('_l') ? 'left_leg' : 'right_leg') : ZONES[Math.floor(this.rng() * 2)];
    f.mind = {
      source: this.offline ? 'fallback' : 'jev', tactic: chosen, target, aggression: 0.35 + this.rng() * 0.6,
      tacticProbs: probs, oppCommit: other.punchT < PUNCH_S ? 0.7 + this.rng() * 0.25 : this.rng() * 0.35,
      latencyMs: this.offline ? null : 140 + this.rng() * 260, confidence: probs[chosen],
      mode: probs[chosen] > 0.3 ? 'commit' : 'probe', reason: weak ? 'their knee is failing: attack that side' : 'probing for range',
    };
  }

  // ---------------------------------------------------------------- output
  private rootQuat(f: Fighter): Quat {
    return mulQ(yawQuat(f.heading), axisAngle([0, 1, 0], -f.down * Math.PI * 0.48));
  }

  private angles(f: Fighter): Record<string, number> {
    const a: Record<string, number> = { ...f.design.stance };
    const gait = Math.sin(this.time * 5.5);
    for (const side of ['l', 'r'] as const) {
      const g = side === 'l' ? gait : -gait;
      a[`hip_pitch_${side}`] = (a[`hip_pitch_${side}`] ?? 0) + g * 0.22 * (1 - f.down);
      a[`knee_${side}`] = (a[`knee_${side}`] ?? 0) + Math.max(0, g) * 0.35 * (1 - f.down);
      const j = f.joints.get(`knee_${side}`);
      if (j && j.state !== 'ok') a[`knee_${side}`] = (a[`knee_${side}`] ?? 0) + 0.35 * (1 - j.health); // sagging knee
    }
    if (f.punchT < PUNCH_S) {
      const u = Math.sin((f.punchT / PUNCH_S) * Math.PI);
      a[`shoulder_pitch_${f.punchSide}`] = -0.85 - u * 0.75;
      a[`elbow_${f.punchSide}`] = -1.95 + u * 1.8;
    }
    return a;
  }

  private poses(): Float32Array {
    const out = new Float32Array(this.meta.nbody * 7);
    const write = (body: number, pos: Vec3, q: Quat) => {
      out.set([pos[0], pos[1], pos[2], q[0], q[1], q[2], q[3]], body * 7);
    };
    write(0, [0, 0, 0], [1, 0, 0, 0]);
    for (const f of this.fighters) {
      const poses = partPoses(f.design, this.angles(f), { pos: f.pos, quat: this.rootQuat(f) });
      for (const [id, body] of f.bodies) {
        const p = poses.get(id)!;
        write(body, f.attached.get(id) ? p.pos : PARK, p.quat);
      }
      for (const [, body] of f.debris) write(body, PARK, [1, 0, 0, 0]);
    }
    for (const d of this.flying) write(d.body, d.pos, d.quat);
    return out;
  }

  private telemetry(f: Fighter): RobotTelemetry {
    const parts: PartTelemetry[] = f.design.parts.map((p) => ({
      id: p.id, hp: f.hp.get(p.id)!, smoke: f.smoke.get(p.id) ?? 0, heat: Math.min(1, 0.25 + (f.smoke.get(p.id) ?? 0)),
      attached: f.attached.get(p.id)!, leak: f.leak.get(p.id) ?? 0,
    }));
    const punching = f.punchT < PUNCH_S;
    const joints: JointTelemetry[] = [...f.joints].map(([name, j]) => ({
      name, health: j.health, state: j.state, tempC: 40 + (1 - j.health) * 60,
      torqueFrac: punching && name.endsWith(`_${f.punchSide}`) && /shoulder|elbow/.test(name) ? 0.85 : 0.2 + Math.abs(Math.sin(this.time * 5.5)) * 0.2,
    }));
    const hpMean = parts.reduce((s, p) => s + p.hp, 0) / parts.length;
    const hyd = f.design.hydraulics ?? [];
    const leaking = [...f.leak.values()].some((v) => v > 0);
    return {
      corner: f.corner, upright: 1 - f.down, balance: 0.8, down: f.down > 0.5, comWorld: [f.pos[0], f.pos[1], f.pos[2] + 0.25 * (1 - f.down)],
      heading: f.heading, velocity: [(f.pos[0] - f.prevPos[0]) * 60, (f.pos[1] - f.prevPos[1]) * 60, 0], battery: f.battery,
      gyroHealth: f.design.gyro ? 1 : 0, gyroSaturation: f.design.gyro ? 0.3 + Math.abs(Math.sin(this.time * 0.9)) * 0.5 : 0,
      hydraulicPressure: Object.fromEntries(hyd.map((h) => [h.id, leaking ? Math.max(0.1, 1 - this.time * 0.01) : 1])),
      skill: punching ? `jab_${f.punchSide}` : 'stance', skillPhase: punching ? f.punchT / PUNCH_S : 0, windup: punching ? 1 - f.punchT / PUNCH_S : 0,
      parts, joints, damageTotal: 1 - hpMean, intent: null,
    };
  }
}

function yawQuat(yaw: number): Quat {
  return [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
}

