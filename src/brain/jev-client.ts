// Thin client for Jev's /v1/systemone wire format via the local proxy (/api/jev).
// Question types (docs.typesafe.ai): choice, noul (P(yes)), score (ordered levels).

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'noul'; instructions: string }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface JevChoiceAnswer { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevNoulAnswer { type: 'noul'; noul: number }
export interface JevScoreAnswer { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> }
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

export interface JevResult {
  answers: Record<string, JevAnswer>;
  latencyMs: number;
  inputTokens: number;
}

export const JEV_MODEL = 'jev-1.13.0';
const TIMEOUT_MS = 2500;

export class JevError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function askJev(state: unknown, questions: Record<string, JevQuestion>, signal?: AbortSignal): Promise<JevResult> {
  const t0 = performance.now();
  const res = await fetch('/api/jev', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new JevError(json?.error ?? json?.message ?? `HTTP ${res.status}`, res.status);
  return {
    answers: json.answers ?? {},
    latencyMs: performance.now() - t0,
    inputTokens: json.usage?.input_tokens ?? 0,
  };
}
