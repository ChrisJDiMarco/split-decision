// Dev-server bridge for the LOCAL mind: an open-source Jev-compatible decision model running on
// this Mac. The browser posts the same /v1/systemone body it sends to /api/jev, to /api/local-jev;
// this process forwards it to a local runtime and answers in Jev's shape.
//
//   backend 'ollama'    (default) Ollama at LOCAL_JEV_URL (http://127.0.0.1:11434) running a decider
//                       GGUF; Ollama is a text runtime, so server/systemone-adapter.ts builds decider's
//                       prompts and reads the option-letter log probabilities.
//   backend 'systemone' a server that already speaks /v1/systemone (decider-ai's `decider.serve`,
//                       Kev's `kev.serve`): the body is passed through unchanged.
//
// It never talks to the cloud: LOCAL_JEV_URL must be a loopback address (127.0.0.1, localhost, ::1),
// and nothing here reads the Jev key. GET /api/local-jev/health → { ok, model, backend, latencyMs? }.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  AdapterError, assemble, labelProbabilities, planRows, shortModelName, temperaturesFor,
  type Row, type SystemOneRequest, type Temperatures, type TokenLogprob,
} from './systemone-adapter';

export type LocalBackend = 'ollama' | 'systemone';

export interface LocalMindConfig {
  backend: LocalBackend;
  url: string; // runtime base URL (loopback only)
  model: string; // runtime model name
  timeoutMs: number; // whole request, queue wait included
  maxConcurrent: number; // requests running on the runtime at once
  maxQueue: number; // requests waiting beyond that; more get 429
  isolatedLevels: boolean; // decider's released configs judge each score level on its own row
  primeContext: boolean; // run the rows' shared state prefix once first, so every row resumes from it
  temperatures: Temperatures;
  topLogprobs: number; // Ollama allows 0..20
  healthCacheMs: number;
  answerCache: number; // recent decisions kept by exact request (0: off); the model is deterministic here
  fetchImpl?: typeof fetch;
}

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_SYSTEMONE_URL = 'http://127.0.0.1:8000';
export const DEFAULT_OLLAMA_MODEL = 'hf.co/Mapika/decider-4b-GGUF:Q4_K_M';
export const DEFAULT_SYSTEMONE_MODEL = 'decider-2b';
const MAX_BODY_BYTES = 64 * 1024;
const OLLAMA_NUM_CTX = 4096;
const OLLAMA_KEEP_ALIVE = '30m';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const int = (v: string | undefined, d: number) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : d;
};

/** Configuration from the environment (LOCAL_JEV_BACKEND, LOCAL_JEV_URL, LOCAL_JEV_MODEL, ...). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): LocalMindConfig {
  const backend: LocalBackend = env.LOCAL_JEV_BACKEND === 'systemone' ? 'systemone' : 'ollama';
  const model = env.LOCAL_JEV_MODEL?.trim() || (backend === 'ollama' ? DEFAULT_OLLAMA_MODEL : DEFAULT_SYSTEMONE_MODEL);
  return {
    backend,
    url: (env.LOCAL_JEV_URL?.trim() || (backend === 'ollama' ? DEFAULT_OLLAMA_URL : DEFAULT_SYSTEMONE_URL)).replace(/\/+$/, ''),
    model,
    timeoutMs: int(env.LOCAL_JEV_TIMEOUT_MS, 3400), // just under the brain's LOCAL_TIMEOUT_MS (3500), so the 504 still arrives first
    maxConcurrent: int(env.LOCAL_JEV_MAX_CONCURRENT, 1),
    maxQueue: int(env.LOCAL_JEV_MAX_QUEUE, 4),
    isolatedLevels: env.LOCAL_JEV_ISOLATED_LEVELS !== '0',
    primeContext: env.LOCAL_JEV_PRIME !== '0',
    temperatures: temperaturesFor(model, env.LOCAL_JEV_TEMPERATURES),
    topLogprobs: Math.min(20, int(env.LOCAL_JEV_TOP_LOGPROBS, 20)),
    healthCacheMs: int(env.LOCAL_JEV_HEALTH_CACHE_MS, 1500),
    answerCache: env.LOCAL_JEV_ANSWER_CACHE === '0' ? 0 : int(env.LOCAL_JEV_ANSWER_CACHE, 64),
  };
}

/** True only for http(s) URLs on a loopback host: the local route must never reach the network. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

export interface Health { ok: boolean; model: string; backend: LocalBackend; latencyMs?: number; error?: string }

class BridgeError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** A counting semaphore with a bounded queue. */
class Gate {
  private running = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly max: number, private readonly maxQueue: number) {}
  get load() { return { running: this.running, waiting: this.waiting.length }; }
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.running >= this.max) {
      if (this.waiting.length >= this.maxQueue) throw new BridgeError('local mind busy', 429);
      await new Promise<void>((resolve, reject) => {
        const go = () => { signal.removeEventListener('abort', onAbort); resolve(); };
        const onAbort = () => {
          this.waiting = this.waiting.filter((w) => w !== go);
          reject(new BridgeError('local mind timed out in the queue', 504));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        this.waiting.push(go);
      });
    }
    this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      this.waiting.shift()?.();
    };
  }
}

interface OllamaGenerate {
  logprobs?: Array<{ token: string; logprob: number; top_logprobs?: TokenLogprob[] }>;
  prompt_eval_count?: number;
  error?: string;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
}

export class LocalMind {
  readonly cfg: LocalMindConfig;
  private readonly gate: Gate;
  private readonly fetch: typeof fetch;
  private healthCache: { at: number; value: Promise<Health> } | null = null;
  private readonly answers = new Map<string, SystemOneResponse>(); // insertion order = least recently used first

  constructor(cfg: LocalMindConfig) {
    this.cfg = cfg;
    this.gate = new Gate(cfg.maxConcurrent, cfg.maxQueue);
    this.fetch = cfg.fetchImpl ?? fetch;
  }

  get label(): string { return shortModelName(this.cfg.model); }

  private checkUrl() {
    if (!isLoopbackUrl(this.cfg.url)) throw new BridgeError(`LOCAL_JEV_URL must be a loopback address (got ${this.cfg.url})`, 500);
  }

  /** One /v1/systemone decision on the local runtime. Throws BridgeError/AdapterError with an HTTP status. */
  async decide(body: SystemOneRequest, signal: AbortSignal): Promise<{ res: SystemOneResponse; backendMs: number }> {
    this.checkUrl();
    const plan = this.cfg.backend === 'ollama' ? planRows(body, this.cfg.isolatedLevels) : null; // validate before queueing
    // The serializer speaks in coarse words, so a fighter often asks about the very same state twice:
    // temperature-0 letter probabilities make the earlier answer the answer.
    const key = this.cfg.answerCache > 0 ? JSON.stringify([body.state, body.questions]) : '';
    const hit = key ? this.answers.get(key) : undefined;
    if (hit) {
      this.answers.delete(key);
      this.answers.set(key, hit);
      return { res: hit, backendMs: 0 };
    }
    const release = await this.gate.acquire(signal);
    const t0 = performance.now();
    try {
      const res = plan ? await this.runOllama(plan.rows, plan.rendered, signal) : await this.runSystemOne(body, signal);
      if (key) {
        this.answers.set(key, res);
        if (this.answers.size > this.cfg.answerCache) this.answers.delete(this.answers.keys().next().value as string);
      }
      return { res, backendMs: performance.now() - t0 };
    } catch (e) {
      if (signal.aborted) throw new BridgeError('local mind timed out', 504);
      throw e;
    } finally {
      release();
    }
  }

  private async post(path: string, payload: unknown, signal: AbortSignal): Promise<{ status: number; json: unknown; text: string }> {
    let r: Response;
    try {
      r = await this.fetch(`${this.cfg.url}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal,
        redirect: 'error', // a loopback runtime must not be able to bounce the request off the machine
      });
    } catch (e) {
      if (signal.aborted) throw new BridgeError('local mind timed out', 504);
      throw new BridgeError(`local runtime unreachable at ${this.cfg.url} (${(e as Error).message})`, 503);
    }
    const text = await r.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body: reported below */ }
    return { status: r.status, json, text };
  }

  private generate(prompt: string, logprobs: boolean, signal: AbortSignal) {
    return this.post('/api/generate', {
      model: this.cfg.model, prompt, raw: true, stream: false, keep_alive: OLLAMA_KEEP_ALIVE,
      ...(logprobs ? { logprobs: true, top_logprobs: this.cfg.topLogprobs } : {}),
      options: { num_predict: 1, temperature: 0, num_ctx: OLLAMA_NUM_CTX }, // same options every call: a change reloads the model
    }, signal);
  }

  /**
   * Rows run one after another on Ollama's single slot. decider is Qwen3.5, whose DeltaNet layers keep
   * a recurrent state that llama.cpp cannot rewind: a row can only resume from a context checkpoint,
   * and llama.cpp saves those just before the end of each prompt it runs. Row after row therefore
   * re-reads the whole state (~350 tokens each, ~5,200 per decision). Running the shared prefix on its
   * own first puts a checkpoint at the end of the state, and every row then pays only for its question.
   */
  private async runOllama(rows: Row[], rendered: ReturnType<typeof planRows>['rendered'], signal: AbortSignal): Promise<SystemOneResponse> {
    const probs: number[][] = [];
    let inputTokens = 0;
    const prefix = this.cfg.primeContext ? sharedPrefix(rows.map((r) => r.prompt)) : '';
    if (prefix) {
      const { status, json } = await this.generate(prefix, false, signal);
      if (status !== 200) throw new BridgeError(`ollama ${status}: ${(json as OllamaGenerate | null)?.error ?? 'error'}`, status === 404 ? 503 : 502);
    }
    for (const row of rows) {
      const { status, json } = await this.generate(row.prompt, true, signal);
      const g = json as OllamaGenerate | null;
      if (status !== 200) throw new BridgeError(`ollama ${status}: ${g?.error ?? 'error'}`, status === 404 ? 503 : 502);
      const top = g?.logprobs?.[0]?.top_logprobs;
      if (!top?.length) throw new BridgeError('ollama returned no logprobs (needs Ollama 0.12.11 or newer)', 502);
      probs.push(labelProbabilities(top, row.labels, this.cfg.temperatures[row.type]));
      inputTokens += g?.prompt_eval_count ?? 0;
    }
    return { model: this.label, answers: assemble(rows, rendered, probs), usage: { input_tokens: inputTokens, output_tokens: 0 } };
  }

  private async runSystemOne(body: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> {
    const { status, json, text } = await this.post('/v1/systemone', { ...body, model: this.cfg.model }, signal);
    if (status !== 200 || !json || typeof json !== 'object') {
      const err = (json as { detail?: unknown; error?: unknown } | null);
      throw new BridgeError(`local systemone ${status}: ${txtErr(err?.detail ?? err?.error ?? text.slice(0, 200))}`, status === 422 ? 422 : 502);
    }
    const j = json as Partial<SystemOneResponse>;
    return { model: this.label, answers: j.answers ?? {}, usage: { input_tokens: j.usage?.input_tokens ?? 0, output_tokens: 0 } };
  }

  /** Is the runtime up with the model loaded? Cached for healthCacheMs so two fighters share one probe. */
  health(now = performance.now()): Promise<Health> {
    if (this.healthCache && now - this.healthCache.at < this.cfg.healthCacheMs) return this.healthCache.value;
    const value = this.probe();
    this.healthCache = { at: now, value };
    return value;
  }

  private async probe(): Promise<Health> {
    const base: Health = { ok: false, model: this.label, backend: this.cfg.backend };
    if (!isLoopbackUrl(this.cfg.url)) return { ...base, error: 'LOCAL_JEV_URL must be a loopback address' };
    const signal = AbortSignal.timeout(this.cfg.timeoutMs);
    const t0 = performance.now();
    try {
      if (this.cfg.backend === 'systemone') {
        const r = await this.fetch(`${this.cfg.url}/health`, { signal, redirect: 'error' });
        const j = (await r.json().catch(() => ({}))) as { model?: string };
        if (!r.ok) return { ...base, error: `health ${r.status}` };
        return { ...base, ok: true, model: j.model ? shortModelName(j.model) : base.model, latencyMs: Math.round(performance.now() - t0) };
      }
      // Ollama: one tiny decision, which also loads the model into memory after a cold start.
      const { status, json } = await this.post('/api/generate', {
        model: this.cfg.model, prompt: 'Context:\nping\n\nQuestion: Is this a connection test?\nOptions:\n(A) no\n(B) yes\nAnswer: (',
        raw: true, stream: false, keep_alive: OLLAMA_KEEP_ALIVE, logprobs: true, top_logprobs: this.cfg.topLogprobs,
        options: { num_predict: 1, temperature: 0, num_ctx: OLLAMA_NUM_CTX },
      }, signal);
      const g = json as OllamaGenerate | null;
      if (status === 404) return { ...base, error: `model ${this.cfg.model} is not pulled (ollama pull ${this.cfg.model})` };
      if (status !== 200) return { ...base, error: `ollama ${status}: ${g?.error ?? 'error'}` };
      const top = g?.logprobs?.[0]?.top_logprobs;
      if (!top?.length) return { ...base, error: 'ollama returned no logprobs (needs Ollama 0.12.11 or newer)' };
      if (!top.some((t) => ['A', 'B'].includes(t.token.trim()))) return { ...base, error: 'model does not answer with option letters (not a decider model?)' };
      return { ...base, ok: true, latencyMs: Math.round(performance.now() - t0) };
    } catch (e) {
      const msg = e instanceof BridgeError ? e.message : signal.aborted ? 'health probe timed out' : (e as Error).message;
      return { ...base, error: msg };
    }
  }
}

/** Shortest prefix worth a priming call (characters; the state is ~1,300). */
const MIN_PRIME_CHARS = 256;

/**
 * The rows' common prefix, cut back to its last line break so it ends on the same tokens as in every
 * row ("...}\n\n" before "Question: "), or '' when there is one row or too little shared to pay off.
 */
export function sharedPrefix(prompts: readonly string[]): string {
  if (prompts.length < 2) return '';
  let n = prompts[0].length;
  for (const p of prompts.slice(1)) {
    let i = 0;
    while (i < n && i < p.length && p.charCodeAt(i) === prompts[0].charCodeAt(i)) i++;
    n = i;
  }
  const cut = prompts[0].lastIndexOf('\n', n - 1) + 1;
  return cut >= MIN_PRIME_CHARS ? prompts[0].slice(0, cut) : '';
}

const txtErr = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

/** The connect-style handler mounted at /api/local-jev (req.url is relative to the mount). */
export function localMindHandler(mind: LocalMind) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      const h = await mind.health();
      send(res, 200, h);
      return;
    }
    if (req.method !== 'POST' || (path !== '/' && path !== '/v1/systemone')) { send(res, 405, { error: 'POST /api/local-jev, or GET /api/local-jev/health' }); return; }
    const t0 = performance.now();
    let body: SystemOneRequest;
    try {
      body = JSON.parse(await readBody(req)) as SystemOneRequest;
    } catch {
      send(res, 400, { error: 'invalid JSON body' });
      return;
    }
    // Give up at the timeout, or as soon as the brain hangs up (it has fallen back to the House Mind),
    // so a stale decision does not hold the runtime while the next one waits.
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableEnded) gone.abort(); });
    const signal = AbortSignal.any([AbortSignal.timeout(mind.cfg.timeoutMs), gone.signal]);
    try {
      const { res: out, backendMs } = await mind.decide(body, signal);
      const total = performance.now() - t0;
      send(res, 200, out, {
        'X-Local-Jev-Latency-Ms': String(Math.round(backendMs)),
        'X-Local-Jev-Bridge-Ms': (total - backendMs).toFixed(2),
      });
    } catch (e) {
      const status = e instanceof BridgeError || e instanceof AdapterError ? e.status : 502;
      send(res, status, { error: (e as Error).message });
    }
  };
}

export function localMind(cfg: LocalMindConfig = configFromEnv()): Plugin {
  const handle = localMindHandler(new LocalMind(cfg));
  return {
    name: 'local-mind',
    configureServer(server) {
      server.middlewares.use('/api/local-jev', (req, res) => { void handle(req, res); });
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/local-jev', (req, res) => { void handle(req, res); });
    },
  };
}
