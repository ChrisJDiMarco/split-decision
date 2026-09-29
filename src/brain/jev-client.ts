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
  outputTokens: number;
}

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_ENDPOINT = '/api/jev';
const TIMEOUT_MS = 2500;

export interface JevClientOptions {
  /** Proxy URL. Relative in the browser; absolute (http://localhost:5297/api/jev) from Node. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class JevError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** The proxy sends { error: string }; upstream may send { error: { message } } or { message }. */
function errorMessage(json: unknown): string | null {
  const j = json as { error?: unknown; message?: unknown } | null;
  const e = j?.error;
  if (typeof e === 'string') return e;
  const nested = (e as { message?: unknown } | undefined)?.message;
  if (typeof nested === 'string') return nested;
  return typeof j?.message === 'string' ? j.message : null;
}

export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
  opts: JevClientOptions = {},
): Promise<JevResult> {
  const t0 = performance.now();
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(opts.endpoint ?? JEV_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: signal ?? AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as Error)?.name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    throw new JevError(timedOut ? 'Jev request timed out' : `Jev network error: ${(e as Error)?.message ?? e}`, timedOut ? 408 : 0);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new JevError(errorMessage(json) ?? `HTTP ${res.status}`, res.status);
  return {
    answers: json.answers ?? {},
    latencyMs: performance.now() - t0,
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
  };
}
