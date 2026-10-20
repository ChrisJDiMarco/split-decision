// Writing polished moves (move-polish.md §8) and each design's index.json (compat hash, status and
// summary per move, and the source hashes a test re-checks to mark a design's polish stale).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compatHash } from '../../src/robots/motions/polish/hash';
import {
  encodeDq, encodeGyro, encodeNominal, encodeRates, encodeTrack, PLAYER_VERSION, POLISH_FORMAT, type PolishEvent, type PolishJson, type PolishStatus,
} from '../../src/robots/motions/polish/format';
import { KNOT_S, SETTLE_S, TAIL_S } from './plan';
import { TRACE_STRIDE } from './rollout';
import type { PolishOutcome } from './optimise';
import { ROOT } from './world';

export const POLISHED_DIR = join(ROOT, 'src', 'robots', 'motions', 'data', 'polished');

/** Source files whose arithmetic the stored rollouts depend on (a change marks the polish stale). */
export const SOURCE_FILES = [
  'src/physics/systems/motors.ts',
  'src/physics/control/gyro.ts',
  'src/robots/motions/polish/player.ts',
  'src/robots/motions/polish/spline.ts',
  'src/robots/motions/sampler.ts',
];

export function sourceHashes(): Record<string, string> {
  return Object.fromEntries(SOURCE_FILES.map((f) => [f, createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex').slice(0, 16)]));
}

export interface IndexJson {
  design: string;
  hash: string;
  player: string;
  sources: Record<string, string>;
  moves: Record<string, { status: PolishStatus; reason?: string; rate: number; wallS: number; clipS: number; cpuS: number; validation?: Record<string, unknown> }>;
}

export function readIndex(design: string): IndexJson {
  const p = join(POLISHED_DIR, design, 'index.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as IndexJson;
  return { design, hash: compatHash(design), player: PLAYER_VERSION, sources: sourceHashes(), moves: {} };
}

export function writeIndex(ix: IndexJson): void {
  mkdirSync(join(POLISHED_DIR, ix.design), { recursive: true });
  writeFileSync(join(POLISHED_DIR, ix.design, 'index.json'), JSON.stringify(ix, null, 1) + '\n');
}

/** Lift/land events from a dense trace (columns 45/46: soles down; 39-44 soles). */
function eventsOf(trace: Float64Array | null, n: number): PolishEvent[] {
  if (!trace) return [];
  const out: PolishEvent[] = [];
  for (let i = 1; i < n; i++) {
    for (let f = 0; f < 2; f++) {
      const S = TRACE_STRIDE;
      const a = trace[(i - 1) * S + 45 + f], b = trace[i * S + 45 + f];
      if (a === b) continue;
      out.push({ side: f === 0 ? 'l' : 'r', kind: b ? 'land' : 'lift', t: +trace[i * S].toFixed(3), x: +trace[i * S + 39 + 3 * f].toFixed(4), y: +trace[i * S + 40 + 3 * f].toFixed(4) });
    }
  }
  return out;
}

export function storePolish(o: PolishOutcome, trace: Float64Array | null, traceN: number, impact: PolishJson['impact']): PolishJson {
  const { spec, plan } = o;
  const move = spec.move;
  const rates = plan.rates();
  let rs = 0;
  for (let f = 0; f < rates.length; f++) rs += rates[f];
  const json: PolishJson = {
    format: POLISH_FORMAT,
    design: spec.design,
    move: spec.moveId,
    status: o.status,
    ...(o.reason ? { reason: o.reason } : {}),
    hash: compatHash(spec.design),
    player: PLAYER_VERSION,
    knotS: KNOT_S,
    segments: spec.segments,
    tailS: TAIL_S,
    settleS: SETTLE_S,
    rates: encodeRates(rates),
    dq: encodeDq(plan.dq),
    ...(plan.gyroFF ? { gyroFF: encodeGyro(plan.gyroFF) } : {}),
    fb: plan.fb,
    deadband: plan.deadband,
    nominal: encodeNominal(o.nominal.subarray(0, o.nominalSamples * 18)),
    nominalSamples: o.nominalSamples,
    track: encodeTrack(plan.track ?? new Float64Array(0)),
    trackFrames: plan.track ? plan.track.length / 6 : 0,
    events: eventsOf(trace, traceN),
    rate: +(rs / rates.length).toFixed(3),
    wallS: +(o.wallS - TAIL_S).toFixed(3),
    clipS: +move.duration.toFixed(3),
    impact,
    envelope: { comSpeed: 0.3, tilt: 0.09, gyroReserve: 0.5, battery: 0.5, minHealth: 0.7 },
    validation: {},
    cpuS: +o.cpuS.toFixed(0),
  };
  mkdirSync(join(POLISHED_DIR, spec.design), { recursive: true });
  writeFileSync(join(POLISHED_DIR, spec.design, `${spec.moveId}.json`), JSON.stringify(json) + '\n');
  const ix = readIndex(spec.design);
  ix.hash = json.hash;
  ix.player = PLAYER_VERSION;
  ix.sources = sourceHashes();
  ix.moves[spec.moveId] = { status: json.status, ...(json.reason ? { reason: json.reason } : {}), rate: json.rate, wallS: json.wallS, clipS: json.clipS, cpuS: json.cpuS ?? 0 };
  writeIndex(ix);
  return json;
}
