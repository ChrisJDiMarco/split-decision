// A tiny top-down stand-in for the physics worker, so the brain can be watched alone:
// two pucks that walk, circle, wind up and land strikes, producing real BrainFrames.
import { APOTHEM } from '../core/arena-spec';
import type { Intent, RobotTelemetry, SimEvent } from '../core/protocol';
import type { Corner, RobotDesign } from '../core/types';
import { designReach } from '../brain/geometry';
import type { BrainFrame } from '../brain/types';
import { isStrike } from '../brain/tactics';

const DT = 1 / 60;
const WALK = 1.2;
const CIRCLE = 0.9;
const TURN = 5;
const WINDUP_S = 0.35;
const RECOVER_S = 0.35;
const DOWN_S = 1.6;
const KNOCKDOWN_NS = 135;
const CAGE_PAD = 0.3;
const REACTION_S = 0.3;

interface Puck {
  corner: Corner;
  design: RobotDesign;
  reach: number;
  x: number; y: number; heading: number;
  vx: number; vy: number;
  intent: Intent | null;
  pending: Array<{ at: number; intent: Intent }>;
  strikeT: number; // <0 idle, 0..WINDUP windup, then recover
  downT: number;
  tel: RobotTelemetry;
}

function baseTelemetry(design: RobotDesign, corner: Corner): RobotTelemetry {
  return {
    corner, upright: 1, balance: 1, down: false, comWorld: [0, 0, 1], heading: 0, velocity: [0, 0, 0],
    battery: 1, gyroHealth: design.gyro ? 1 : 0, gyroSaturation: 0,
    hydraulicPressure: Object.fromEntries((design.hydraulics ?? []).map((h) => [h.id, 1])),
    skill: 'idle', skillPhase: 0, windup: 0,
    parts: design.parts.map((p) => ({ id: p.id, hp: 1, smoke: 0, heat: 0, attached: true, leak: 0 })),
    joints: design.parts.flatMap((p) => (p.joints ?? []).map((j) => ({ name: j.name, health: 1, state: 'ok' as const, tempC: 30, torqueFrac: 0 }))),
    damageTotal: 0, intent: null,
  };
}

export class PuppetFight {
  time = 0;
  tick = 0;
  readonly pucks: [Puck, Puck];
  private events: SimEvent[] = [];

  constructor(red: RobotDesign, blue: RobotDesign) {
    const mk = (design: RobotDesign, corner: Corner, x: number): Puck => ({
      corner, design, reach: designReach(design), x, y: 0, heading: corner === 0 ? 0 : Math.PI, vx: 0, vy: 0,
      intent: null, pending: [], strikeT: -1, downT: 0, tel: baseTelemetry(design, corner),
    });
    this.pucks = [mk(red, 0, -2.1), mk(blue, 1, 2.1)];
  }

  /** Same contract as the worker: applied after a fixed reaction delay from issuedAtTick. */
  pushIntent(corner: Corner, intent: Intent, issuedAtTick: number) {
    const at = Math.max(this.time, issuedAtTick / 1000 + REACTION_S);
    this.pucks[corner].pending.push({ at, intent });
  }

  step(): BrainFrame {
    this.time += DT;
    this.tick = Math.round(this.time * 1000);
    for (const p of this.pucks) this.stepPuck(p, this.pucks[p.corner === 0 ? 1 : 0]);
    const events = this.events;
    this.events = [];
    return { tick: this.tick, time: this.time, events, telemetry: [this.snapshot(this.pucks[0]), this.snapshot(this.pucks[1])] };
  }

  private stepPuck(p: Puck, o: Puck) {
    const due = p.pending.filter((q) => q.at <= this.time);
    if (due.length) { p.intent = due[due.length - 1].intent; p.pending = p.pending.filter((q) => q.at > this.time); }
    if (p.downT > 0) {
      p.downT -= DT;
      if (p.downT <= 0) this.events.push({ kind: 'getup', corner: p.corner });
      return;
    }
    const dx = o.x - p.x, dy = o.y - p.y;
    const d = Math.hypot(dx, dy) || 1e-6;
    const ux = dx / d, uy = dy / d;
    const want = Math.atan2(dy, dx);
    let dh = want - p.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    p.heading += Math.max(-TURN * DT, Math.min(TURN * DT, dh));
    const [vx, vy] = this.desiredVelocity(p, d, ux, uy);
    p.vx += (vx - p.vx) * 0.15;
    p.vy += (vy - p.vy) * 0.15;
    p.x += p.vx * DT;
    p.y += p.vy * DT;
    this.clampToCage(p);
    this.updateStrike(p, o, d);
  }

  private desiredVelocity(p: Puck, d: number, ux: number, uy: number): [number, number] {
    const t = p.intent?.tactic ?? 'hold_range';
    const agg = p.intent?.aggression ?? 0.5;
    const speed = WALK * (0.6 + agg * 0.6);
    if (p.strikeT >= 0) return [ux * 0.3, uy * 0.3];
    switch (t) {
      case 'close_distance': case 'cage_pin': case 'clinch': return d > 0.55 ? [ux * speed, uy * speed] : [0, 0];
      case 'retreat': return [-ux * WALK, -uy * WALK];
      case 'circle_left': return [-uy * CIRCLE, ux * CIRCLE];
      case 'circle_right': return [uy * CIRCLE, -ux * CIRCLE];
      case 'hold_range': case 'feint': case 'sidestep_counter': {
        const err = d - (p.reach + 0.5);
        return [ux * err * 1.5, uy * err * 1.5];
      }
      case 'guard': return [0, 0];
      default: return d > p.reach ? [ux * speed, uy * speed] : [0, 0];
    }
  }

  private clampToCage(p: Puck) {
    const r = Math.hypot(p.x, p.y);
    const max = APOTHEM - CAGE_PAD;
    if (r <= max) return;
    p.x *= max / r;
    p.y *= max / r;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 0.3) this.events.push({ kind: 'cage', corner: p.corner, pos: [p.x, p.y, 1], speed });
    p.vx *= 0.2;
    p.vy *= 0.2;
  }

  private updateStrike(p: Puck, o: Puck, d: number) {
    const t = p.intent?.tactic;
    if (p.strikeT < 0) {
      if (t && isStrike(t) && d < p.reach + 0.15) p.strikeT = 0;
      return;
    }
    const before = p.strikeT;
    p.strikeT += DT;
    if (before < WINDUP_S && p.strikeT >= WINDUP_S && d < p.reach + 0.2 && o.downT <= 0) this.land(p, o);
    if (p.strikeT > WINDUP_S + RECOVER_S) p.strikeT = -1;
  }

  private land(p: Puck, o: Puck) {
    const impulse = 30 + Math.random() * 90 * (0.5 + (p.intent?.aggression ?? 0.5));
    const zone = p.intent?.target ?? 'torso';
    const victims = o.tel.parts.filter((x) => x.attached && (zone === 'head' ? x.id === 'head' : zone.includes('leg') ? /thigh|shin|foot/.test(x.id) : zone.includes('arm') ? /arm|fist/.test(x.id) : x.id === 'torso'));
    const hitPart = victims[Math.floor(Math.random() * victims.length)] ?? o.tel.parts[0];
    o.tel.parts = o.tel.parts.map((x) => (x === hitPart ? { ...x, hp: Math.max(0, x.hp - impulse / 900), smoke: Math.min(1, x.smoke + impulse / 1500) } : x));
    o.tel.damageTotal = 1 - o.tel.parts.reduce((s, x) => s + x.hp, 0) / o.tel.parts.length;
    this.events.push({ kind: 'impact', pos: [o.x, o.y, 1.2], normal: [1, 0, 0], impulseNs: impulse, speed: 5, energyJ: impulse * 2, striker: p.corner, victim: o.corner, part: hitPart.id, metal: true });
    if (impulse > KNOCKDOWN_NS) { o.downT = DOWN_S; o.strikeT = -1; this.events.push({ kind: 'fall', corner: o.corner }); }
  }

  private snapshot(p: Puck): RobotTelemetry {
    const striking = p.strikeT >= 0;
    return {
      ...p.tel,
      down: p.downT > 0,
      upright: p.downT > 0 ? 0.1 : 1,
      comWorld: [p.x, p.y, p.downT > 0 ? 0.3 : 1],
      heading: p.heading,
      velocity: [p.vx, p.vy, 0],
      skill: p.downT > 0 ? 'getup' : striking ? (p.intent?.tactic ?? 'jab') : 'walk',
      skillPhase: striking ? Math.min(1, p.strikeT / (WINDUP_S + RECOVER_S)) : 0,
      windup: striking && p.strikeT < WINDUP_S ? p.strikeT / WINDUP_S : 0,
      intent: p.intent,
    };
  }
}
