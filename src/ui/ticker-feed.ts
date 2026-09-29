// Turns sim events and telemetry changes into broadcast ticker lines. Pure logic (no DOM),
// so it's unit-tested; the ticker view only renders the items.
import type { RobotTelemetry, SimEvent } from '../core/protocol';
import type { Corner } from '../core/types';
import { jointName, partName } from './names';

export type TickerLevel = 'info' | 'hit' | 'alert' | 'huge';

export interface TickerItem {
  text: string;
  level: TickerLevel;
  corner: Corner | null; // whose story it is (colors the chip)
  time: number; // sim seconds
}

export const TICKER = {
  HIT_J: 120, // a strike worth calling
  HUGE_HIT_J: 350,
  HIT_COOLDOWN_S: 1.2, // per striker
  CAGE_SPEED: 2.5, // m/s into the fence
  CAGE_COOLDOWN_S: 2,
  SMOKE_ON: 0.35,
  SMOKE_OFF: 0.15,
  LEAK_ON: 0.01, // L/s
  BATTERY_LOW: 0.15,
  GYRO_SATURATED: 0.95,
  GYRO_FAILING: 0.3,
} as const;

const HIT_PHRASES = [
  (a: string, b: string, p: string) => `${a} lands clean on ${b}'s ${p}`,
  (a: string, _b: string, p: string) => `Big shot from ${a} to the ${p}`,
  (a: string, b: string, p: string) => `${a} rattles ${b}'s ${p}`,
  (_a: string, b: string, p: string) => `${b} eats one to the ${p}`,
];

const KO_REASON: Record<string, string> = {
  head: 'head removed',
  down: 'down for the count',
  power: 'power failure',
  disabled: 'disabled',
};

export class TickerFeed {
  private lastHit: [number, number] = [-Infinity, -Infinity];
  private lastCage: [number, number] = [-Infinity, -Infinity];
  private seen = new Set<string>(); // one-shot callouts: `${corner}:${key}`
  private smoking = new Set<string>();
  private hitCount = 0;

  constructor(private names: readonly [string, string]) {}

  reset(names?: readonly [string, string]): void {
    if (names) this.names = names;
    this.lastHit = [-Infinity, -Infinity];
    this.lastCage = [-Infinity, -Infinity];
    this.seen.clear();
    this.smoking.clear();
    this.hitCount = 0;
  }

  ingest(events: readonly SimEvent[], telemetry: readonly RobotTelemetry[] | null, time: number): TickerItem[] {
    const out: TickerItem[] = [];
    for (const ev of events) {
      const item = this.fromEvent(ev, time);
      if (item) out.push(item);
    }
    if (telemetry) for (const t of telemetry) out.push(...this.fromTelemetry(t, time));
    return out;
  }

  private once(corner: Corner, key: string): boolean {
    const k = `${corner}:${key}`;
    if (this.seen.has(k)) return false;
    this.seen.add(k);
    return true;
  }

  private fromEvent(ev: SimEvent, time: number): TickerItem | null {
    const n = this.names;
    switch (ev.kind) {
      case 'impact': {
        if (ev.striker === null || ev.victim === null || ev.energyJ < TICKER.HIT_J) return null;
        if (time - this.lastHit[ev.striker] < TICKER.HIT_COOLDOWN_S) return null;
        this.lastHit[ev.striker] = time;
        const part = ev.part ? partName(ev.part) : 'body';
        const phrase = HIT_PHRASES[this.hitCount++ % HIT_PHRASES.length];
        const huge = ev.energyJ >= TICKER.HUGE_HIT_J;
        return { text: `${phrase(n[ev.striker], n[ev.victim], part)} · ${Math.round(ev.energyJ)} J`, level: huge ? 'alert' : 'hit', corner: ev.striker, time };
      }
      case 'detach': {
        if (ev.part === 'head') return { text: `HEAD OFF! ${n[ev.corner]} has been decapitated`, level: 'huge', corner: ev.corner, time };
        return { text: `${n[ev.corner]}'s ${partName(ev.part)} is torn off`, level: 'huge', corner: ev.corner, time };
      }
      case 'joint': {
        if (ev.state === 'ok' || !this.once(ev.corner, `joint:${ev.joint}:${ev.state}`)) return null;
        const j = jointName(ev.joint);
        const text = ev.state === 'degraded' ? `${n[ev.corner]}'s ${j} is failing`
          : ev.state === 'limp' ? `${n[ev.corner]}'s ${j} has given out`
          : `${n[ev.corner]}'s ${j} has seized solid`;
        return { text, level: ev.state === 'degraded' ? 'info' : 'alert', corner: ev.corner, time };
      }
      case 'fall':
        return { text: `${n[ev.corner]} is down!`, level: 'alert', corner: ev.corner, time };
      case 'getup':
        return { text: `${n[ev.corner]} is back on its feet`, level: 'info', corner: ev.corner, time };
      case 'ko':
        return { text: `KNOCKOUT · ${n[ev.corner]} ${KO_REASON[ev.reason] ?? ev.reason}`, level: 'huge', corner: ev.corner, time };
      case 'cage': {
        if (ev.speed < TICKER.CAGE_SPEED || time - this.lastCage[ev.corner] < TICKER.CAGE_COOLDOWN_S) return null;
        this.lastCage[ev.corner] = time;
        return { text: `${n[ev.corner]} slammed into the cage`, level: 'hit', corner: ev.corner, time };
      }
    }
  }

  private fromTelemetry(t: RobotTelemetry, time: number): TickerItem[] {
    const out: TickerItem[] = [];
    const name = this.names[t.corner];
    for (const p of t.parts) {
      const key = `${t.corner}:${p.id}`;
      if (p.smoke >= TICKER.SMOKE_ON && !this.smoking.has(key)) {
        this.smoking.add(key);
        out.push({ text: `${name} is smoking from the ${partName(p.id)}`, level: 'alert', corner: t.corner, time });
      } else if (p.smoke < TICKER.SMOKE_OFF) {
        this.smoking.delete(key);
      }
      if (p.leak >= TICKER.LEAK_ON && this.once(t.corner, `leak:${p.id}`)) {
        out.push({ text: `Hydraulic leak in ${name}'s ${partName(p.id)}`, level: 'alert', corner: t.corner, time });
      }
    }
    if (t.battery <= TICKER.BATTERY_LOW && this.once(t.corner, 'battery')) {
      out.push({ text: `${name}'s battery is critical`, level: 'alert', corner: t.corner, time });
    }
    if (t.gyroHealth > 0 && t.gyroSaturation >= TICKER.GYRO_SATURATED && this.once(t.corner, 'gyro-sat')) {
      out.push({ text: `${name}'s gyro is saturated, balance is going`, level: 'info', corner: t.corner, time });
    }
    if (t.gyroHealth > 0 && t.gyroHealth <= TICKER.GYRO_FAILING && this.once(t.corner, 'gyro-fail')) {
      out.push({ text: `${name}'s gyro core is failing`, level: 'alert', corner: t.corner, time });
    }
    return out;
  }
}
