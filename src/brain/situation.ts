// Per-fighter static context (designs, reach, motor limits) and the per-frame
// "situation": the coarse read that rules, cadence and the stale check share.
import type { RobotTelemetry, Tactic } from '../core/protocol';
import type { Corner, FighterSetup, RobotDesign } from '../core/types';
import { motor } from '../robots/catalog';
import { balanceClass, distanceBand } from './bands';
import { computeGeometry, designReach, type Geometry } from './geometry';
import { WINDUP_ALERT } from './observer';
import { readRange, type RangeRead } from './ranges';
import { isStrike, skillAction } from './tactics';
import type { BrainFrame, DistanceBand, OpponentPhaseClass } from './types';

const DEFAULT_MAX_TEMP_C = 120;
const STAGGER_UPRIGHT = 0.75;
const STAGGER_BALANCE = 0.35;

export interface FighterContext {
  corner: Corner;
  design: RobotDesign;
  oppDesign: RobotDesign;
  setup: FighterSetup; // this fighter's own setup only; the opponent's plan never reaches the brain
  reach: number;
  oppReach: number;
  maxTempC: Map<string, number>; // joint name → motor max temperature
}

function jointMaxTemps(design: RobotDesign): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of design.parts) {
    for (const j of p.joints ?? []) {
      let max = DEFAULT_MAX_TEMP_C;
      try { max = motor(j.motor).maxTempC; } catch { /* unknown motor: keep the default */ }
      out.set(j.name, max);
    }
  }
  return out;
}

export function makeFighterContext(corner: Corner, design: RobotDesign, oppDesign: RobotDesign, setup: FighterSetup): FighterContext {
  return {
    corner, design, oppDesign, setup,
    reach: designReach(design),
    oppReach: designReach(oppDesign),
    maxTempC: jointMaxTemps(design),
  };
}

export interface Situation {
  me: RobotTelemetry;
  opp: RobotTelemetry;
  geometry: Geometry;
  band: DistanceBand;
  insideOppReach: boolean;
  /** Which weapons land from this gap, both ways, from the body's own skill ranges (null: a body without them). */
  range: RangeRead | null;
  oppPhase: OpponentPhaseClass;
  oppAction: Tactic | null;
  myBalance: 'down' | 'unsteady' | 'steady';
  time: number;
  tick: number;
}

export function opponentPhase(opp: RobotTelemetry): OpponentPhaseClass {
  if (opp.down) return 'down';
  if (opp.windup >= WINDUP_ALERT) return 'windup';
  const action = skillAction(opp.skill);
  if (action && isStrike(action) && opp.skillPhase < 1) return 'striking';
  if (opp.upright < STAGGER_UPRIGHT || opp.balance < STAGGER_BALANCE) return 'staggered';
  return 'neutral';
}

export function readSituation(fc: FighterContext, frame: BrainFrame): Situation {
  const me = frame.telemetry[fc.corner];
  const opp = frame.telemetry[fc.corner === 0 ? 1 : 0];
  const geometry = computeGeometry(me, opp);
  return {
    me, opp, geometry,
    band: distanceBand(geometry.distance, fc.reach),
    insideOppReach: geometry.distance < fc.oppReach + 0.15,
    range: readRange(fc.design, me, fc.oppDesign, opp, geometry.distance, geometry.closingSpeed),
    oppPhase: opponentPhase(opp),
    oppAction: skillAction(opp.skill),
    myBalance: balanceClass(me.down, me.upright, me.balance),
    time: frame.time,
    tick: frame.tick,
  };
}

const RANGE_GROUP: Record<DistanceBand, string> = {
  clinch: 'close', 'striking range': 'close', 'just outside reach': 'edge', 'mid range': 'open', far: 'open',
};
const PHASE_GROUP: Record<OpponentPhaseClass, string> = {
  down: 'down', windup: 'attacking', striking: 'attacking', staggered: 'open', neutral: 'open',
};

/**
 * The coarse state an answer must still match when it lands; otherwise it is stale.
 * Deliberately coarse (range group, opponent attacking or not, me down or up): strikes
 * cycle windup → release → recover faster than a round trip, and a finer key starves
 * the fighter of answers.
 */
export function coarseKey(s: Situation): string {
  return `${RANGE_GROUP[s.band]}|${PHASE_GROUP[s.oppPhase]}|${s.myBalance === 'down' ? 'down' : 'up'}`;
}
