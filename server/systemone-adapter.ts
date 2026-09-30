// Translates a Jev /v1/systemone request into decider prompts for a plain GGUF runtime (Ollama)
// and turns the option-letter log probabilities back into a /v1/systemone answer.
//
// Ported from Mapika/decider (Apache-2.0): decider/systemone.py (render_state, render_question,
// isolated score levels, format_answer, TypeSafe's confidence formulas) and decider/prompt.py
// (the plain state-first layout, one question per row):
//
//   Context:\n<state>\n\nQuestion: <instructions>\nOptions:\n(A) <option>\n(B) <option>\nAnswer: (
//
// The model's next-token distribution at the final "(" is read over the option letters only,
// divided by the per-type temperature from the model's decider_config.json and renormalised.
// Pure functions: no I/O here, so the tests drive every branch.

export type QuestionType = 'choice' | 'noul' | 'score';

export interface SystemOneQuestion {
  type?: string;
  instructions?: unknown;
  criteria?: unknown;
}

export interface SystemOneRequest {
  model?: string;
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
}

export interface RenderedQuestion {
  type: QuestionType;
  question: string;
  options: string[];
  names: string[]; // what the answer reports per option (choice names; score levels as '0'..; noul 'false','true')
  legend: string[] | null; // score level descriptions
}

/** One prompt the runtime runs; `answer` says which question (and, for isolated score levels, which level) it feeds. */
export interface Row {
  id: string;
  type: QuestionType;
  prompt: string;
  labels: string[]; // option letters, in option order
  level: number | null; // isolated score level index, or null for a list row
}

export interface Temperatures { choice: number; noul: number; score: number }

export type SystemOneAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> };

export const MAX_CHOICE = 255;
export const MAX_LEVELS = 10;
const ANNOTATE_MIN = 8;
const NOUL_WITHOUT_INSTRUCTIONS = 'Which answer fits the context?';
const ISOLATED = (q: string, level: string) => `${q}\nProposed answer: ${level}\nDoes the proposed answer fit?`;

/** decider_config.json temperature_by_type of the released GGUF models (fetched 2026-09-29). */
export const DECIDER_TEMPERATURES: Record<string, Temperatures> = {
  'decider-4b': { choice: 1.11, noul: 1.56, score: 1.287 },
  'decider-2b': { choice: 1.164, noul: 1.624, score: 1.124 },
};

export class AdapterError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

const txt = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** Long arrays get their positions written in, as decider's server does ({ _index: i, ... }). */
function annotateIndices(x: unknown): unknown {
  if (Array.isArray(x)) {
    if (x.length >= ANNOTATE_MIN) {
      return x.map((v, i) => (v && typeof v === 'object' && !Array.isArray(v)
        ? { _index: i, ...(annotateIndices(v) as Record<string, unknown>) }
        : { _index: i, value: annotateIndices(v) }));
    }
    return x.map(annotateIndices);
  }
  if (x && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, annotateIndices(v)]));
  }
  return x;
}

export function renderState(state: unknown): string {
  return typeof state === 'string' ? state : JSON.stringify(annotateIndices(state));
}

export function renderQuestion(spec: SystemOneQuestion): RenderedQuestion {
  if (!spec || typeof spec !== 'object') throw new AdapterError('question must be an object');
  const t = spec.type ?? 'choice';
  const crit = spec.criteria;
  const raw = spec.instructions;
  let ins: string;
  if (t === 'noul' && (raw === undefined || raw === null || raw === '')) {
    const c = crit as Record<string, unknown> | undefined;
    const described = !!c && typeof c === 'object' && [c.true, c.false].some((d) => d !== undefined && d !== null && d !== '');
    if (!described) throw new AdapterError('noul question without instructions: criteria must describe true or false');
    ins = NOUL_WITHOUT_INSTRUCTIONS;
  } else {
    ins = raw === undefined || raw === null ? '' : txt(raw);
  }
  if (!ins) throw new AdapterError('question without instructions');

  if (t === 'choice') {
    const map: Record<string, unknown> = Array.isArray(crit) ? Object.fromEntries(crit.map((c) => [String(c), null])) : (crit as Record<string, unknown>);
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new AdapterError(`choice criteria: a map of 2..${MAX_CHOICE} options`);
    const names = Object.keys(map);
    if (names.length < 2 || names.length > MAX_CHOICE) throw new AdapterError(`choice criteria: a map of 2..${MAX_CHOICE} options`);
    const options = names.map((n) => (map[n] === null || map[n] === undefined || map[n] === '' ? n : `${n}: ${txt(map[n])}`));
    return { type: 'choice', question: ins, options, names, legend: null };
  }
  if (t === 'score') {
    let levels: unknown[];
    if (Array.isArray(crit)) levels = crit;
    else if (crit && typeof crit === 'object') {
      const m = crit as Record<string, unknown>;
      levels = Object.keys(m).sort((a, b) => Number(a) - Number(b)).map((k) => m[k]);
    } else throw new AdapterError(`score criteria: an ordered list of 2..${MAX_LEVELS} level descriptions`);
    if (levels.length < 2 || levels.length > MAX_LEVELS) throw new AdapterError(`score criteria: an ordered list of 2..${MAX_LEVELS} level descriptions`);
    const legend = levels.map(txt);
    return { type: 'score', question: ins, options: legend.map((l, i) => `${i}: ${l}`), names: legend.map((_, i) => String(i)), legend };
  }
  if (t === 'noul') {
    if (crit !== undefined && crit !== null && (typeof crit !== 'object' || Array.isArray(crit))) throw new AdapterError('noul criteria: a map of optional true/false descriptions');
    const c = (crit ?? {}) as Record<string, unknown>;
    const empty = (v: unknown) => v === undefined || v === null || v === '';
    return {
      type: 'noul', question: ins, names: ['false', 'true'], legend: null,
      options: [empty(c.false) ? 'no' : `no: ${txt(c.false)}`, empty(c.true) ? 'yes' : `yes: ${txt(c.true)}`],
    };
  }
  throw new AdapterError(`unknown question type ${JSON.stringify(t)}`);
}

/** A..Z then AA, AB, ... (decider's wide labels; Qwen tokenises these as one token each). */
export function optionLabel(i: number): string {
  const A = 65;
  if (i < 26) return String.fromCharCode(A + i);
  const j = i - 26;
  return String.fromCharCode(A + Math.floor(j / 26)) + String.fromCharCode(A + (j % 26));
}

export function promptFor(context: string, question: string, options: string[]): string {
  const opts = options.map((o, j) => `\n(${optionLabel(j)}) ${o}`).join('');
  return `Context:\n${context}\n\nQuestion: ${question}\nOptions:${opts}\nAnswer: (`;
}

/** The level text without its leading number ("2: somewhat" → "somewhat"). */
const stripLevelNumber = (s: string) => s.replace(/^\s*-?\d+\s*:\s*/, '');

/**
 * One row per question, in request order (rows share the context, so a runtime with a prefix
 * cache pays for the state once). With isolated levels (decider's released configs) a score
 * question becomes one yes/no row per level.
 */
export function planRows(req: SystemOneRequest, isolatedLevels: boolean): { rows: Row[]; rendered: Record<string, RenderedQuestion> } {
  if (!req || typeof req !== 'object') throw new AdapterError('body must be an object');
  if (req.state === undefined) throw new AdapterError('state is required');
  if (!req.questions || typeof req.questions !== 'object' || Array.isArray(req.questions)) throw new AdapterError('questions must be a map');
  const ids = Object.keys(req.questions);
  if (!ids.length) throw new AdapterError('no questions');
  const context = renderState(req.state);
  const rows: Row[] = [];
  const rendered: Record<string, RenderedQuestion> = {};
  for (const id of ids) {
    const rq = renderQuestion(req.questions[id]);
    rendered[id] = rq;
    if (isolatedLevels && rq.type === 'score' && rq.legend) {
      rq.legend.forEach((l, level) => {
        rows.push({ id, type: 'score', level, labels: ['A', 'B'], prompt: promptFor(context, ISOLATED(rq.question, stripLevelNumber(l)), ['no', 'yes']) });
      });
    } else {
      rows.push({ id, type: rq.type, level: null, labels: rq.options.map((_, j) => optionLabel(j)), prompt: promptFor(context, rq.question, rq.options) });
    }
  }
  return { rows, rendered };
}

export interface TokenLogprob { token: string; logprob: number }

/**
 * Probabilities over a row's labels from the runtime's top log probabilities at the answer slot.
 * logprob = logit - logsumexp(all logits), so exp(logprob / T) keeps decider's softmax(logits / T)
 * over the labels exactly. A label outside the returned top-k gets the smallest returned logprob
 * minus one nat (an upper bound on its true mass, so the result never over-trusts the top). Throws
 * when no label is in the top-k at all (not a decider model, or a broken prompt).
 */
export function labelProbabilities(top: readonly TokenLogprob[], labels: readonly string[], temperature: number): number[] {
  const best = new Map<string, number>();
  for (const t of top) {
    const k = t.token.trim();
    if (!Number.isFinite(t.logprob)) continue;
    const prev = best.get(k);
    if (prev === undefined || t.logprob > prev) best.set(k, t.logprob);
  }
  const found = labels.filter((l) => best.has(l));
  if (!found.length) throw new AdapterError('no option letter in the model\'s top tokens (is LOCAL_JEV_MODEL a decider model?)', 502);
  const floor = Math.min(...top.map((t) => t.logprob).filter(Number.isFinite)) - 1;
  const z = labels.map((l) => (best.get(l) ?? floor) / temperature);
  const m = Math.max(...z);
  const e = z.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

const round = (x: number, nd = 4) => Math.round(x * 10 ** nd) / 10 ** nd;
const clip01 = (x: number) => Math.min(1, Math.max(0, x));
const normalised = (p: number[]) => {
  const tot = p.reduce((a, b) => a + b, 0);
  return tot === 0 ? p.map(() => 1 / p.length) : p.map((x) => x / tot);
};

/** TypeSafe's choice confidence: (n·p_max − 1)/(n − 1). */
export function choiceConfidence(p: number[]): number {
  const n = p.length;
  if (n <= 1) return 1;
  return clip01((n * Math.max(...normalised(p)) - 1) / (n - 1));
}

/** TypeSafe's score confidence: 1 − expected distance from the top level / mean distance from the middle. */
export function scoreConfidence(p: number[]): number {
  const n = p.length;
  if (n <= 1) return 1;
  const q = normalised(p);
  let k = 0;
  q.forEach((x, i) => { if (x > q[k]) k = i; });
  const spread = q.reduce((a, x, i) => a + x * Math.abs(i - k), 0);
  let uniform = 0;
  for (let i = 0; i < n; i++) uniform += Math.abs(i - (n - 1) / 2);
  return clip01(1 - spread / (uniform / n));
}

export function formatAnswer(rq: RenderedQuestion, probs: number[]): SystemOneAnswer {
  const p = normalised(probs.slice(0, rq.options.length));
  let j = 0;
  p.forEach((x, i) => { if (x > p[j]) j = i; });
  if (rq.type === 'noul') return { type: 'noul', noul: round(p[1]) };
  if (rq.type === 'choice') {
    return { type: 'choice', choice: rq.names[j], confidence: round(choiceConfidence(p)), probabilities: Object.fromEntries(rq.names.map((n, i) => [n, round(p[i])])) };
  }
  return {
    type: 'score', score: round(p.reduce((a, x, i) => a + i * x, 0), 2), confidence: round(scoreConfidence(p)),
    probabilities: Object.fromEntries(p.map((x, i) => [String(i), round(x)])),
  };
}

/** Rows' probabilities (row order) → { id: answer }. Isolated levels combine as P(fits) per level, renormalised. */
export function assemble(rows: readonly Row[], rendered: Record<string, RenderedQuestion>, probs: readonly number[][]): Record<string, SystemOneAnswer> {
  const byId = new Map<string, number[][]>();
  rows.forEach((r, i) => {
    const list = byId.get(r.id) ?? [];
    list.push(probs[i]);
    byId.set(r.id, list);
  });
  const out: Record<string, SystemOneAnswer> = {};
  for (const [id, list] of byId) {
    const rq = rendered[id];
    const isolated = rows.some((r) => r.id === id && r.level !== null);
    out[id] = formatAnswer(rq, isolated ? list.map((p) => p[1]) : list[0]);
  }
  return out;
}

/** Temperatures for a model name: env override ("choice=1.1,noul=1.5,score=1.2"), else the decider size in the name. */
export function temperaturesFor(model: string, override?: string): Temperatures {
  const base = model.toLowerCase().includes('decider-2b') ? DECIDER_TEMPERATURES['decider-2b'] : DECIDER_TEMPERATURES['decider-4b'];
  if (!override) return base;
  const t = { ...base };
  for (const part of override.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    const x = Number(v);
    if ((k === 'choice' || k === 'noul' || k === 'score') && Number.isFinite(x) && x > 0) t[k] = x;
  }
  return t;
}

/** 'hf.co/Mapika/decider-4b-GGUF:Q4_K_M' → 'decider-4b' (the short name the HUD shows). */
export function shortModelName(model: string): string {
  const last = model.split('/').pop() ?? model;
  return last.split(':')[0].replace(/-gguf$/i, '').toLowerCase() || model;
}
