// Messages between the polish run (master) and its worker processes.
import type { DeadBands, FeedbackGains } from '../../src/robots/motions/polish/format';
import type { Var } from './plan';
import type { Perturb } from './rollout';
import type { ClockState } from './session';
import type { Snapshot } from './world';

export interface PlanData {
  dq: Float64Array;
  warp: Float64Array;
  gyroFF: Float64Array | null;
  fb: FeedbackGains;
  deadband: DeadBands;
  /** Frozen per-frame rates (as stored); absent: from the warp knots. */
  rates?: Float64Array | null;
}

/** Where a rollout starts: the clip's first frame placed (the settle runs first), or a clock snapshot. */
export type From = { kind: 'placed' } | { kind: 'point'; snap: Snapshot; clock: ClockState };

export interface WindowCtx {
  key: string;
  design: string;
  moveId: string;
  from: From;
  base: PlanData;
  /** Committed nominal so far (feedback reference before this window); null: feedback has none. */
  nominal: Float64Array | null;
  nominalSamples: number;
  vars: Var[];
  fromTau: number; // cost counted from here
  lookaheadTau: number; // samples past this count half
  untilTau: number; // rollout end
  endTau: number; // move + tail (terminal cost)
  scenarios: Perturb[]; // [0] is the nominal (no perturbation)
  poseScale: number;
}

export type Task =
  | { type: 'eval'; ctxKey: string; ctx?: WindowCtx; cands: Float64Array[]; robust: boolean }
  | { type: 'commit'; ctxKey: string; ctx?: WindowCtx; x: Float64Array; snapAtTau: number | null; trace: boolean }
  | { type: 'full'; design: string; moveId: string; plan: PlanData; nominal: Float64Array | null; nominalSamples: number; feedback: boolean; perturbs: Perturb[]; trace: boolean; recordNominal: boolean; fullWorld?: boolean; costFrom?: number };

export interface EvalReply {
  costs: number[][]; // per candidate, per scenario
  fell: boolean[][];
}

export interface CommitReply {
  cost: number;
  terms: Record<string, number>;
  fell: boolean;
  snap: Snapshot | null;
  clock: ClockState | null;
  nominal: Float64Array; // the window's copy with this rollout's samples written
  trace: Float64Array | null; // rows: tau, q[nLib] (library order)
  traceN: number;
}

export interface FullReply {
  runs: Array<{
    cost: number;
    terms: Record<string, number>;
    fell: boolean;
    fellTau: number;
    impactErr: number;
    impactSpeed: number;
    wallS: number;
    trace: Float64Array | null;
    traceN: number;
    nominal: Float64Array | null;
    nominalSamples: number;
    honesty: string | null;
  }>;
}

export type Reply = { ok: true; cpuMs: number; data: EvalReply | CommitReply | FullReply } | { ok: false; error: string };
