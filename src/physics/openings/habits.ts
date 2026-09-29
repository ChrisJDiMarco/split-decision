// Habit model: what one fighter has learned about its opponent this fight, counted in physics.
//   bites       per feint level: how often he bit (FeintRead.bit)
//   counters    how often he threw back at a feint
//   circles     under pressure (you walking him down) which way he circles, or backs straight up
//   drops_hand  after throwing a punch, whether that hand drops below his chin before it comes home
//   landed      your strikes that landed on each of his zones (feeds the weak-spot map)
// Everything here is from MuJoCo state, the controllers and impact events; nothing his builder wrote.
import type { FeintLevel, FeintRead, Habit, TargetZone } from '../../core/protocol';
import type { Vec3 } from '../../core/types';
import type { SkillRun } from '../control/skills/types';

// pressure episodes
export const PRESSURE_SPEED_MPS = 0.35; // you moving at him this fast
export const PRESSURE_RANGE_M = 2.4;
export const PRESSURE_MIN_S = 0.6; // an episode shorter than this is not counted
export const PRESSURE_GAP_S = 0.25; // pressure lapsing this long ends the episode
export const CIRCLE_MIN_M = 0.2; // sideways travel that counts as circling
export const STRAIGHT_BACK_M = 0.3; // straight-back travel that counts as backing up
// dropped hands
export const DROP_WATCH_S = 0.5; // after his punch ends
export const DROP_BELOW_CHIN_M = 0.12;
// landed shots
export const LANDED_ENERGY_J = 8;
export const LANDED_DEBOUNCE_S = 0.3;
// what is published
const MIN_OF = 2;
const MAX_HABITS = 4;

type Side = 'left' | 'right';

export interface HabitState {
  bites: Record<FeintLevel, { n: number; of: number }>;
  counters: { n: number; of: number };
  episodes: number;
  circles: Record<Side, number>;
  straightBack: number;
  pressure: { since: number; lastOn: number; lat: number; away: number } | null;
  drops: Map<string, { n: number; of: number }>; // `${side}:${skill}`
  dropWatch: { prev: SkillRun | null; key: string | null; until: number; side: 'l' | 'r' | null; dropped: boolean };
  landed: Partial<Record<TargetZone, number>>;
  lastLanded: number;
}

export function newHabitState(): HabitState {
  return {
    bites: { high: { n: 0, of: 0 }, body: { n: 0, of: 0 }, low: { n: 0, of: 0 } },
    counters: { n: 0, of: 0 },
    episodes: 0, circles: { left: 0, right: 0 }, straightBack: 0, pressure: null,
    drops: new Map(), dropWatch: { prev: null, key: null, until: -Infinity, side: null, dropped: false },
    landed: {}, lastLanded: -Infinity,
  };
}

/** A feint of yours resolved: count his answer. */
export function onRead(h: HabitState, read: FeintRead): void {
  const b = h.bites[read.level];
  h.bites[read.level] = { n: b.n + (read.bit ? 1 : 0), of: b.of + 1 };
  h.counters = { n: h.counters.n + (read.reactions.includes('countered') ? 1 : 0), of: h.counters.of + 1 };
}

/** One of your strikes landed on his `zone` (debounced: one strike touches with several geoms). */
export function onLanded(h: HabitState, zone: TargetZone | null, energyJ: number, time: number): void {
  if (!zone || energyJ < LANDED_ENERGY_J || time - h.lastLanded < LANDED_DEBOUNCE_S) return;
  h.lastLanded = time;
  h.landed = { ...h.landed, [zone]: (h.landed[zone] ?? 0) + 1 };
}

export interface PressureSample {
  t: number;
  dt: number;
  me: Vec3; // your COM
  meVel: Vec3;
  him: Vec3;
  himVel: Vec3;
  eitherDown: boolean;
}

/** Pressure episodes: while you walk him down, where does he go? */
export function onPressure(h: HabitState, s: PressureSample): void {
  const dx = s.him[0] - s.me[0], dy = s.him[1] - s.me[1];
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d; // from you to him
  const pressing = !s.eitherDown && d <= PRESSURE_RANGE_M && s.meVel[0] * ux + s.meVel[1] * uy >= PRESSURE_SPEED_MPS;
  const p = h.pressure;
  if (pressing) {
    const next = p ?? { since: s.t, lastOn: s.t, lat: 0, away: 0 };
    // His left, facing you: z × (you − him) = z × (−u) = (uy, −ux).
    const lat = (s.himVel[0] * uy - s.himVel[1] * ux) * s.dt;
    const away = (s.himVel[0] * ux + s.himVel[1] * uy) * s.dt;
    h.pressure = { since: next.since, lastOn: s.t, lat: next.lat + lat, away: next.away + away };
    return;
  }
  if (p && s.t - p.lastOn > PRESSURE_GAP_S) {
    h.pressure = null;
    if (p.lastOn - p.since < PRESSURE_MIN_S) return;
    h.episodes++;
    if (Math.abs(p.lat) >= CIRCLE_MIN_M) {
      const side: Side = p.lat > 0 ? 'left' : 'right';
      h.circles = { ...h.circles, [side]: h.circles[side] + 1 };
    } else if (p.away >= STRAIGHT_BACK_M) h.straightBack++;
  }
}

/** His punches: after one ends, does that hand drop below his chin before it comes home? */
export function onHisHands(h: HabitState, t: number, run: SkillRun | null, fistZ: { l: number; r: number } | null, chinZ: number | null): void {
  const w = h.dropWatch;
  const newPunch = !!run && run !== w.prev && run.def.kind === 'arm';
  if (w.key && (t > w.until || newPunch)) {
    const cur = h.drops.get(w.key) ?? { n: 0, of: 0 };
    h.drops.set(w.key, { n: cur.n + (w.dropped ? 1 : 0), of: cur.of + 1 });
    w.key = null;
  }
  const prev = w.prev;
  if (prev && run !== prev && prev.def.side && prev.phase !== 'windup') {
    // The punch he was throwing just ended (it reached its strike): watch that hand for a moment.
    Object.assign(w, { key: `${prev.def.side === 'l' ? 'left' : 'right'}:${prev.def.id}`, side: prev.def.side, until: t + DROP_WATCH_S, dropped: false });
  }
  if (w.key && w.side && fistZ && chinZ !== null && fistZ[w.side] < chinZ - DROP_BELOW_CHIN_M) w.dropped = true;
  w.prev = run && run.def.kind === 'arm' ? run : null;
}

function strength(n: number, of: number): number {
  return (n / of) * Math.min(1, of / 4);
}

/** His habits worth telling, strongest first. */
export function habitsOf(h: HabitState): Habit[] {
  const out: Array<Habit & { s: number }> = [];
  for (const level of ['high', 'body', 'low'] as const) {
    const b = h.bites[level];
    if (b.of >= MIN_OF) out.push({ kind: 'bites', level, n: b.n, of: b.of, s: Math.abs(strength(b.n, b.of) - 0.5) * 2 });
  }
  if (h.counters.n >= MIN_OF) out.push({ kind: 'counters', n: h.counters.n, of: h.counters.of, s: strength(h.counters.n, h.counters.of) });
  if (h.episodes >= MIN_OF) {
    const side: Side = h.circles.left >= h.circles.right ? 'left' : 'right';
    const n = h.circles[side];
    if (n >= MIN_OF && n / h.episodes >= 0.5) out.push({ kind: 'circles', side, n, of: h.episodes, s: strength(n, h.episodes) });
    if (h.straightBack >= MIN_OF && h.straightBack / h.episodes >= 0.5) out.push({ kind: 'retreats_straight', n: h.straightBack, of: h.episodes, s: strength(h.straightBack, h.episodes) });
  }
  for (const [key, d] of h.drops) {
    if (d.of < MIN_OF || d.n / d.of < 0.5) continue;
    const [side, after] = key.split(':') as [Side, string];
    out.push({ kind: 'drops_hand', side, after, n: d.n, of: d.of, s: strength(d.n, d.of) });
  }
  return out.sort((a, b) => b.s - a.s).slice(0, MAX_HABITS).map(({ s: _s, ...habit }) => habit);
}
