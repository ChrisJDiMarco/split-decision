// The scouting report in words: the weak-spot map, his habits and the last feint read, all computed
// in physics (src/physics/openings) and published in telemetry. Each weak spot comes with the strike
// this fighter would use on it ("his left knee at 40%, his lead leg: low kick"). Short on purpose:
// every word here is paid on every Jev call.
import type { BiteReaction, FeintRead, Habit, RobotTelemetry, Tactic, TargetZone, WeakReason, WeakSpot } from '../core/protocol';
import type { RobotDesign } from '../core/types';
import { jointGroupName, partName, percentWords } from './bands';
import { moveReady } from './limbs';
import { canThrow } from './style';
import { tacticWords } from './tactics';

/** A read this recent is still news (the HUD's READ line and the state's last_read). */
export const READ_FRESH_S = 2.5;
const SPOTS_IN_STATE = 3;
const HABITS_IN_STATE = 3;

const ZONE_NAME: Record<TargetZone, string> = {
  head: 'head', torso: 'body', left_arm: 'left arm', right_arm: 'right arm', left_leg: 'left leg', right_leg: 'right leg', weapon: 'weapon',
};

export function zoneName(z: TargetZone): string {
  return ZONE_NAME[z];
}

function reasonWords(r: WeakReason): string | null {
  switch (r.kind) {
    case 'joint_failing': return r.part ? `his ${jointGroupName(r.part)} at ${percentWords(r.value ?? 1)}` : null;
    case 'joint_slop': return r.part ? `his ${jointGroupName(r.part)} gears loose` : null;
    case 'joint_hot': return r.part ? `his ${jointGroupName(r.part)} overheating` : null;
    case 'armor_cracked': return r.part ? `his ${partName(r.part)} shell at ${percentWords(r.value ?? 1)}` : null;
    case 'soft_armor': return `thin ${r.part === 'carbon' ? 'carbon' : r.part === 'polycarb' ? 'polycarbonate' : r.part ?? ''} shell`.replace(/\s+/g, ' ');
    case 'glass_jaw': return 'glass jaw, a clean shot pops his head';
    case 'narrow_base': return 'narrow base';
    case 'light_frame': return 'lighter than you';
    case 'slow_legs': return 'slow legs';
    case 'gyro_drained': return 'gyro drained';
    case 'guard_open': return r.side ? `guard open on his ${r.side}` : 'guard open';
    case 'lead_leg': return 'lead leg';
    case 'keeps_landing': return (r.value ?? 0) >= 3 ? 'keeps getting hit there' : 'you landed there';
  }
}

/** The strike this design would use on `spot`, among what it can throw right now (null: none). */
export function strikeFor(design: RobotDesign, me: RobotTelemetry, spot: WeakSpot): Tactic | null {
  const kinds = new Set(spot.reasons.map((r) => r.kind));
  let prefs: Tactic[];
  switch (spot.zone) {
    case 'head':
      // His left side open: your right hand (cross, overhand); his right side: your lead hook.
      if (spot.side === 'left') prefs = ['overhand', 'cross', 'head_kick', 'hook'];
      else if (spot.side === 'right') prefs = ['hook', 'head_kick', 'jab', 'cross'];
      else if (kinds.has('glass_jaw')) prefs = ['cross', 'overhand', 'head_kick', 'hook', 'uppercut'];
      else prefs = ['cross', 'hook', 'head_kick', 'jab', 'uppercut', 'overhand'];
      break;
    case 'torso':
      prefs = kinds.has('light_frame') || kinds.has('narrow_base') ? ['front_kick', 'hook', 'cross', 'uppercut'] : ['hook', 'uppercut', 'cross', 'front_kick'];
      break;
    case 'left_leg':
    case 'right_leg':
      prefs = ['low_kick', 'front_kick'];
      break;
    default:
      prefs = ['cross', 'jab'];
  }
  return prefs.find((t) => canThrow(design, t) && moveReady(me, t)) ?? null;
}

const ARM_JOINT = /^(shoulder|elbow)/;

/** "his left knee at 40%, his lead leg: low kick". */
export function weakSpotWords(spot: WeakSpot, strike: Tactic | null): string {
  // On the head, a failing arm drive is his guard sagging on that side.
  const words = (r: WeakReason) => (spot.zone === 'head' && r.kind === 'joint_failing' && r.part && ARM_JOINT.test(r.part)
    ? `his ${jointGroupName(r.part)} at ${percentWords(r.value ?? 1)}, that guard sags` : reasonWords(r));
  const why = spot.reasons.map(words).filter((w): w is string => !!w);
  const head = why.length ? why.join(', ') : `his ${zoneName(spot.zone)}`;
  const where = spot.reasons.some((r) => r.kind === 'joint_failing' || r.kind === 'armor_cracked') || spot.zone === 'head' || spot.zone === 'torso' ? '' : ` (${zoneName(spot.zone)})`;
  return `${head}${where}${strike ? `: ${tacticWords(strike)}` : ''}`;
}

/** The ranked weak-spot line for the state: "1) ...; 2) ...". Null when there is none. */
export function weakSpotsWords(design: RobotDesign, me: RobotTelemetry): string | null {
  const spots = me.weakSpots?.slice(0, SPOTS_IN_STATE) ?? [];
  if (!spots.length) return null;
  return spots.map((s, i) => `${i + 1}) ${s.zone === 'torso' ? 'body: ' : s.zone === 'head' ? 'head: ' : ''}${weakSpotWords(s, strikeFor(design, me, s))}`).join('; ');
}

/** The short note the HUD puts after a payoff zone ("LEFT KNEE 40%"), from the matching weak spot. */
export function zoneNote(spots: readonly WeakSpot[] | undefined, zone: TargetZone): string | null {
  const spot = spots?.find((s) => s.zone === zone);
  if (!spot) return null;
  const r = spot.reasons.find((x) => x.kind === 'joint_failing' || x.kind === 'armor_cracked') ?? spot.reasons[0];
  if (!r) return null;
  if (r.kind === 'joint_failing' && r.part) return `${jointGroupName(r.part)} ${percentWords(r.value ?? 1)}`;
  if (r.kind === 'armor_cracked' && r.part) return `${partName(r.part)} ${percentWords(r.value ?? 1)}`;
  if (r.kind === 'glass_jaw') return 'glass jaw';
  if (r.kind === 'guard_open') return r.side ? `open ${r.side} side` : 'guard open';
  if (r.kind === 'narrow_base') return 'narrow base';
  if (r.kind === 'light_frame') return 'light frame';
  if (r.kind === 'gyro_drained') return 'gyro drained';
  if (r.kind === 'slow_legs') return 'slow legs';
  if (r.kind === 'keeps_landing') return 'keeps landing';
  return null;
}

const LEVEL_WORDS = { high: 'high', body: 'body', low: 'low' } as const;

function countWords(n: number, of: number): string {
  return `${n} of ${of}`;
}

export function habitWords(h: Habit): string {
  switch (h.kind) {
    case 'bites': return h.n === 0 ? `never bites on ${LEVEL_WORDS[h.level ?? 'high']} feints (0 of ${h.of})` : `bites on ${LEVEL_WORDS[h.level ?? 'high']} feints ${countWords(h.n, h.of)}`;
    case 'counters': return `throws back at feints ${countWords(h.n, h.of)}`;
    case 'circles': return `circles ${h.side} when pressured ${countWords(h.n, h.of)}`;
    case 'retreats_straight': return `backs straight up when pressured ${countWords(h.n, h.of)}`;
    case 'drops_hand': return `drops his ${h.side} hand after the ${tacticWords((h.after ?? 'punch') as Tactic)} ${countWords(h.n, h.of)}`;
  }
}

export function habitsWords(habits: readonly Habit[] | undefined): string | null {
  const list = habits?.slice(0, HABITS_IN_STATE) ?? [];
  return list.length ? list.map(habitWords).join('; ') : null;
}

const REACTION_WORDS: Record<BiteReaction, string> = {
  covered: 'covered up', retreated: 'stepped away', flinched: 'flinched', countered: 'threw back',
};

/** "he bit your high feint: covered up" / "he ignored your low feint". */
export function readWords(r: FeintRead): string {
  const what = `your ${LEVEL_WORDS[r.level]} feint`;
  return r.bit ? `he bit ${what}: ${r.reactions.map((x) => REACTION_WORDS[x]).join(', ')}` : `he ignored ${what}`;
}

/** The newest read, if it is still fresh at `now`. */
export function freshRead(me: RobotTelemetry, now: number): FeintRead | null {
  const r = me.reads?.[me.reads.length - 1];
  return r && now - r.time <= READ_FRESH_S ? r : null;
}

const HUD_REACTION: Record<BiteReaction, string> = {
  covered: 'COVERED', retreated: 'STEPPED BACK', flinched: 'FLINCHED', countered: 'THREW BACK',
};

/** "HE BIT: COVERED HIGH" / "NO BITE: LOW FEINT". */
export function readHud(r: FeintRead): string {
  if (!r.bit) return `NO BITE: ${r.level.toUpperCase()} FEINT`;
  const first = r.reactions[0];
  const level = first === 'covered' ? ` ${r.level === 'body' ? 'BODY' : r.level.toUpperCase()}` : '';
  return `HE BIT: ${HUD_REACTION[first]}${level}${r.reactions.length > 1 ? ` + ${HUD_REACTION[r.reactions[1]]}` : ''}`;
}
