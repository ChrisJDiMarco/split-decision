// Acceptance (move-polish.md §6): replay each stored polish in the full game scene (compileWorld: the
// cage, both robots, the opponent parked on his gantry) through the same player and motor model, and
// compare with the one-robot rollout it was optimised in. Gate: joint RMS < 0.5°.
//   npx tsx tools/polish/accept.ts --workers 2 [--only savate/cross.13_17.1024,...]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePolish } from '../../src/robots/motions/polish/format';
import { compatHash } from '../../src/robots/motions/polish/hash';
import { readPolishFromDisk } from '../../src/robots/motions/polish/load';
import { PlanState } from './plan';
import { Pool } from './pool';
import type { PlanData } from './protocol';
import { QUEUES } from './queues';
import { TRACE_STRIDE } from './rollout';
import { getupUp } from './measure';
import { MoveSession } from './session';
import { POLISHED_DIR, readIndex, writeIndex } from './store';

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

export interface Acceptance {
  repoRmsDeg: number;
  repoMaxDeg: number;
  fullWorldFell: boolean;
  samples: number;
  stale: boolean;
}

export async function acceptMove(pool: Pool, design: string, moveId: string): Promise<Acceptance | null> {
  const json = readPolishFromDisk(design, moveId);
  if (!json || json.status !== 'polished') return null;
  const pm = decodePolish(json);
  const ses = await MoveSession.create(design, moveId);
  const base = new PlanState(ses.spec);
  const plan: PlanData = {
    dq: Float64Array.from(pm.dq), warp: new Float64Array(base.warp.length), gyroFF: pm.gyroFF ? Float64Array.from(pm.gyroFF) : null,
    fb: pm.fb, deadband: pm.deadband, rates: Float64Array.from(pm.rates),
  };
  const task = { type: 'full' as const, design, moveId, plan, nominal: Float64Array.from(pm.nominal), nominalSamples: pm.nominalSamples, feedback: true, perturbs: [], trace: true, recordNominal: false };
  const [one, full] = await Promise.all([pool.full(task, 'accept'), pool.full({ ...task, fullWorld: true }, 'accept')]);
  const a = one.runs[0], b = full.runs[0];
  const n = Math.min(a.traceN, b.traceN);
  let sum = 0, cnt = 0, max = 0, fell = false;
  const getup = ses.ref.kind === 'getup';
  if (getup) {
    // A get-up starts on the canvas: it failed if it does not end upright and standing tall.
    const o = (b.traceN - 1) * TRACE_STRIDE;
    fell = !getupUp(ses.ref, b.trace![o + 53], b.trace![o + 69], ses.w.stancePelvisZ);
  }
  for (let i = 0; i < n; i++) {
    if (!getup && b.trace![i * TRACE_STRIDE + 53] < 0.5) fell = true;
    for (let k = 10; k < 33; k++) {
      const d = a.trace![i * TRACE_STRIDE + k] - b.trace![i * TRACE_STRIDE + k];
      sum += d * d;
      cnt++;
      max = Math.max(max, Math.abs(d));
    }
  }
  return { repoRmsDeg: +(Math.sqrt(sum / Math.max(1, cnt)) * 57.2958).toFixed(4), repoMaxDeg: +(max * 57.2958).toFixed(3), fullWorldFell: fell, samples: n, stale: json.hash !== compatHash(design) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = (arg('only') ?? QUEUES[arg('queue', 'poc')!].join(',')).split(',');
  const pool = new Pool(Math.min(5, Number(arg('workers', '2'))), null);
  for (const id of list) {
    const [design, moveId] = id.split('/');
    const r = await acceptMove(pool, design, moveId);
    if (!r) {
      console.log(`${id}: no polished file`);
      continue;
    }
    console.log(`${id}: full-world replay vs one-robot rollout: joint RMS ${r.repoRmsDeg}° (max ${r.repoMaxDeg}°) over ${r.samples} samples${r.fullWorldFell ? ', FELL in the full world' : ''}${r.stale ? ' [STALE]' : ''} → ${r.repoRmsDeg < 0.5 && !r.fullWorldFell ? 'PASS' : 'FAIL'}`);
    const f = join(POLISHED_DIR, design, `${moveId}.json`);
    const json = JSON.parse(readFileSync(f, 'utf8'));
    json.validation = { ...(json.validation ?? {}), acceptance: r };
    writeFileSync(f, JSON.stringify(json) + '\n');
    const ix = readIndex(design);
    if (ix.moves[moveId]) ix.moves[moveId].validation = { ...(ix.moves[moveId].validation ?? {}), acceptance: r };
    writeIndex(ix);
  }
  pool.close();
}
