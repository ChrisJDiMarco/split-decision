// Fight state → the words Jev reads. Rules: bands, never raw floats; the fighter's own
// plan and temperament go in; nothing the opponent's builder wrote ever does (the
// opponent is described only from its physics telemetry and its part catalog).
import type { RobotTelemetry, Tactic } from '../core/protocol';
import type { RobotDesign } from '../core/types';
import * as B from './bands';
import { designFlashy, openingsWords, riskBand } from './gambles';
import type { RecentAction } from './observer';
import { freshRead, habitsWords, readWords, weakSpotsWords } from './scouting';
import { fromHereWords, hisWeaponsWords, meetWords, reachEdgeWords } from './ranges';
import type { FighterContext, Situation } from './situation';
import { styleOf } from './style';
import { abilityTactics, tacticWords } from './tactics';
import type { DistanceBand, MatchClock } from './types';

export const PLAN_MAX_WORDS = 150;
const MY_DAMAGE_ITEMS = 5;
const OPP_DAMAGE_ITEMS = 4;
const LEAK_THRESHOLD_LS = 0.001;
const SMOKE_THRESHOLD = 0.25;
const JOINT_OK_HEALTH = 0.9;

export interface FightState {
  you: Record<string, string>;
  opponent: Record<string, string>;
  geometry: Record<string, string>;
  round: Record<string, string>;
  plan: string;
  personality: string;
  /** Per-fight memory: how your gambles went, what of his keeps landing. Absent until something happened. */
  record?: Record<string, string>;
}

interface DamageItem { sev: number; text: string }

function jointDamage(tel: RobotTelemetry, maxTemp: Map<string, number> | null): DamageItem[] {
  const groups = new Map<string, { health: number; state: string; heat: string | null; heatSev: number }>();
  for (const j of tel.joints) {
    const name = B.jointGroupName(j.name);
    const g = groups.get(name) ?? { health: 1, state: 'ok', heat: null, heatSev: 0 };
    const stateRank = { ok: 0, degraded: 1, limp: 2, seized: 3 } as const;
    const next = { ...g, health: Math.min(g.health, j.health) };
    if (stateRank[j.state] > stateRank[g.state as keyof typeof stateRank]) next.state = j.state;
    const max = maxTemp?.get(j.name);
    const heat = max !== undefined ? B.heatWords(j.tempC, max) : null;
    const heatSev = max !== undefined ? j.tempC / max : 0;
    if (heat && heatSev > g.heatSev) { next.heat = heat; next.heatSev = heatSev; }
    groups.set(name, next);
  }
  const out: DamageItem[] = [];
  for (const [name, g] of groups) {
    if (g.state === 'seized') out.push({ sev: 0.95, text: `${name} seized solid` });
    else if (g.state === 'limp') out.push({ sev: 0.9, text: `${name} limp, no drive` });
    else if (g.state === 'degraded' || g.health < JOINT_OK_HEALTH) out.push({ sev: 1 - g.health, text: `${name} actuator at ${B.percentWords(g.health)} torque` });
    if (g.heat) out.push({ sev: 0.4 + g.heatSev * 0.3, text: `${name} ${g.heat}` });
  }
  return out;
}

function partDamage(tel: RobotTelemetry): DamageItem[] {
  const out: DamageItem[] = [];
  for (const p of tel.parts) {
    const name = B.partName(p.id);
    if (!p.attached) { out.push({ sev: 1, text: `${name} torn off` }); continue; }
    const hp = B.hpWords(p.hp);
    if (hp) out.push({ sev: 1 - p.hp, text: `${name} armor ${hp}` });
    if (p.leak > LEAK_THRESHOLD_LS) out.push({ sev: 0.8, text: `${name} leaking hydraulic oil` });
    if (p.smoke > SMOKE_THRESHOLD) out.push({ sev: 0.5 + p.smoke * 0.3, text: `${name} smoking` });
  }
  return out;
}

export function damageWords(tel: RobotTelemetry, maxTemp: Map<string, number> | null, limit: number): string {
  const items = [...partDamage(tel), ...jointDamage(tel, maxTemp)].sort((a, b) => b.sev - a.sev).slice(0, limit);
  return items.length ? items.map((i) => i.text).join('; ') : 'no damage';
}

function buildWords(design: RobotDesign): string {
  const extras = [design.hydraulics?.length ? 'hydraulic power' : '', design.gyro ? 'gyro stabilized' : ''].filter(Boolean);
  return [design.bodyType, ...extras].join(', ');
}

function movesWords(design: RobotDesign): string {
  return abilityTactics(design).map(tacticWords).join(', ');
}

function powerWords(tel: RobotTelemetry, design: RobotDesign): string {
  const parts = [B.batteryWords(tel.battery)];
  if (design.gyro) parts.push(B.gyroWords(tel.gyroHealth, tel.gyroSaturation));
  for (const [id, p] of Object.entries(tel.hydraulicPressure)) parts.push(B.pressureWords(id, p));
  return parts.join('; ');
}

function opponentPhaseWords(s: Situation): string {
  const { opp, geometry } = s;
  const action = s.oppAction ? tacticWords(s.oppAction) : 'strike';
  switch (s.oppPhase) {
    case 'down': return /get|rise|stand/.test(opp.skill.toLowerCase()) ? 'down on the canvas, getting up' : 'down on the canvas';
    case 'windup': return `winding up a ${action}, ${B.windupWords(opp.windup)}`;
    case 'striking': return `throwing a ${action}`;
    case 'staggered': return 'staggering, off balance';
    default:
      if (geometry.oppApproachSpeed > 0.4) return 'advancing on you';
      if (geometry.oppApproachSpeed < -0.4) return 'backing away';
      if (geometry.lateralSpeed > 0.6) return 'circling';
      return 'standing his ground';
  }
}

function recentWords(recent: RecentAction[], now: number): string {
  if (!recent.length) return 'nothing thrown lately';
  return recent.map((r) => `${tacticWords(r.action)} ${B.agoWords(now - r.time)}`).join(', ');
}

/** The builder's own plan, trimmed to the word budget and stripped of control characters. */
export function planWords(plan: string): string {
  const words = plan.replace(/[\u0000-\u001f\u007f]+/g, ' ').split(/\s+/).filter(Boolean);
  return words.slice(0, PLAN_MAX_WORDS).join(' ') || 'No plan: fight on instinct.';
}

const CORNER_NAMES = ['red', 'blue'] as const;

/** 'orthodox, squared up' / 'southpaw, angled off' from the stance and the shoulders' angle off square. */
export function stanceWords(tel: RobotTelemetry): string | null {
  if (!tel.stance) return null;
  const off = Math.abs(tel.facingOffDeg ?? 0);
  const angle = off < 15 ? 'squared up' : off < 35 ? 'slightly bladed' : off < 60 ? 'angled off' : off < 120 ? 'turned side-on' : 'turned away';
  return `${tel.stance}, ${angle}`;
}

/** 'tornado kick: high fall risk; kip-up: moderate fall risk' for the moves this design can attempt. */
export function flashyRiskWords(design: RobotDesign, tel: RobotTelemetry): string | null {
  const risk = tel.moveRisk;
  if (!risk) return null;
  const items = designFlashy(design).filter((m) => Number.isFinite(risk[m])).map((m) => `${m === 'kip_up' ? 'kip-up' : tacticWords(m)}: ${riskBand(risk[m])}`);
  return items.length ? items.join('; ') : null;
}

/**
 * Range in words, from the body's own skill ranges: which of my weapons land from here, whether his
 * reach me, the reach edge. Bodies without skill ranges keep the coarse inside/outside-his-reach line.
 */
function rangeGeometry(s: Situation): Array<[string, string | null]> {
  const r = s.range;
  if (!r) return [['reach', s.insideOppReach ? 'you are inside his reach' : 'you are outside his reach']];
  return [
    ['from_here', fromHereWords(r.mine)],
    ['his_weapons', hisWeaponsWords(r.his)],
    ['reach', reachEdgeWords(r.myLongest, r.hisLongest)],
  ];
}

/**
 * The distance band as Jev reads it. With skill ranges it follows the weapons (striking range = one of
 * mine lands, just outside = one step in), so it never contradicts `from_here`; the brain's own rules keep
 * s.band (reach-based) for cadence and menus.
 */
export function distanceWords(s: Situation): DistanceBand {
  const r = s.range;
  if (!r || !r.mine.length || s.band === 'clinch' || s.band === 'far') return s.band;
  if (r.mine.some((w) => w.fit === 'lands') || r.mine.every((w) => w.fit === 'close')) return 'striking range';
  if (r.mine.some((w) => w.fit === 'step')) return 'just outside reach';
  return 'mid range';
}

function closingWords(s: Situation): string {
  const band = B.closingBand(s.geometry.closingSpeed);
  const meet = meetWords(s.range?.meetS ?? null);
  return meet ? `${band}, ${meet}` : band;
}

function lastReadWords(me: RobotTelemetry, now: number): string | null {
  const r = freshRead(me, now);
  return r ? readWords(r) : null;
}

function optional(entries: Array<[string, string | null]>): Record<string, string> {
  return Object.fromEntries(entries.filter((e): e is [string, string] => e[1] !== null));
}

export function serializeState(
  fc: FighterContext,
  s: Situation,
  recent: RecentAction[],
  clock: MatchClock,
  lastTactic: Tactic | null,
  record: { yours: string; his: string } | null = null,
): FightState {
  const { me, opp, geometry } = s;
  const oppCorner = CORNER_NAMES[fc.corner === 0 ? 1 : 0];
  const state: FightState = {
    you: {
      name: `${fc.design.name} (${CORNER_NAMES[fc.corner]} corner)`,
      build: `${buildWords(fc.design)}. ${fc.design.tagline}`,
      moves: movesWords(fc.design),
      condition: B.damageTotalWords(me.damageTotal),
      balance: B.balanceWords(me.down, me.upright, me.balance),
      damage: damageWords(me, fc.maxTempC, MY_DAMAGE_ITEMS),
      power: powerWords(me, fc.design),
      doing: lastTactic ? `running ${tacticWords(lastTactic)}` : 'squared up, no tactic yet',
      style: styleOf(fc.design).words,
      ...optional([['stance', stanceWords(me)], ['flashy_risk', flashyRiskWords(fc.design, me)]]),
    },
    opponent: {
      name: `the ${oppCorner} corner fighter`,
      build: buildWords(fc.oppDesign),
      moves: movesWords(fc.oppDesign),
      condition: B.damageTotalWords(opp.damageTotal),
      phase: opponentPhaseWords(s),
      facing: B.facingWords(geometry.oppBearingRad),
      damage: damageWords(opp, null, OPP_DAMAGE_ITEMS),
      recent: recentWords(recent, s.time),
      ...optional([
        ['openings', me.openings ? openingsWords(me.openings, opp) : null],
        ['weak_spots', weakSpotsWords(fc.design, me)],
        ['habits', habitsWords(me.habits)],
        ['last_read', lastReadWords(me, s.time)],
      ]),
    },
    geometry: {
      distance: distanceWords(s),
      ...optional(rangeGeometry(s)),
      closing: closingWords(s),
      bearing: `opponent at your ${B.clockWords(geometry.bearingRad)}`,
      cage: B.cageWords(geometry.cageGap, geometry.cageBearingRad),
      opponent_cage: B.opponentCageWords(geometry.oppCageGap),
    },
    round: {
      round: `${clock.round} of ${clock.rounds}`,
      clock: B.clockRemainingWords(clock.remainingS),
    },
    plan: planWords(fc.setup.plan),
    personality: B.temperamentWords(fc.setup.temperament),
  };
  if (record) state.record = { yours: record.yours, his: record.his };
  return state;
}
