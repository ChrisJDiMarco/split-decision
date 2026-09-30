// Test doubles for the LOCAL mind bridge: a tiny Ollama that answers /api/generate with option-letter
// log probabilities (the protocol server/local-mind.ts targets), a tiny native /v1/systemone server,
// and the bridge itself mounted at /api/local-jev on a real HTTP port.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LocalMind, localMindHandler, type LocalMindConfig } from '../../server/local-mind';

export interface Listening { url: string; close: () => Promise<void> }

async function listen(server: Server): Promise<Listening> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
}

export interface ParsedPrompt { question: string; labels: string[]; options: string[]; proposed: string | null }

/** Reads the last question block of a decider prompt ("Question: ...\nOptions:\n(A) ...\nAnswer: ("). */
export function parsePrompt(prompt: string): ParsedPrompt {
  const q = prompt.slice(prompt.lastIndexOf('\n\nQuestion: ') + '\n\nQuestion: '.length);
  const [question, rest = ''] = q.split('\nOptions:');
  const labels: string[] = [];
  const options: string[] = [];
  for (const m of rest.matchAll(/\n\(([A-Z]{1,2})\) ([^\n]*)/g)) { labels.push(m[1]); options.push(m[2]); }
  const p = /\nProposed answer: ([^\n]*)\n/.exec(question);
  return { question, labels, options, proposed: p ? p[1] : null };
}

export interface MockOllamaOptions {
  model?: string;
  delayMs?: number;
  /** Index of the option the model favours; default: the option starting with `favour`, else 0. */
  pick?: (p: ParsedPrompt) => number;
  favour?: string;
  status?: number; // force an HTTP error on /api/generate
  noLogprobs?: boolean;
}

export interface MockOllama extends Listening {
  requests: Array<Record<string, unknown>>;
  maxConcurrent: number;
  opts: MockOllamaOptions;
}

/** Log probabilities: the favourite at −0.1, the other letters from −3 down, and some non-letter tokens. */
export function topFor(labels: string[], fav: number, k = 20) {
  const letters = labels.map((l, i) => ({ token: l, logprob: i === fav ? -0.1 : -3 - 0.25 * i }));
  const noise = [{ token: ' the', logprob: -6 }, { token: '\n', logprob: -7 }, { token: 'a', logprob: -8 }];
  return [...letters, ...noise].sort((a, b) => b.logprob - a.logprob).slice(0, k);
}

export async function startMockOllama(opts: MockOllamaOptions = {}): Promise<MockOllama> {
  const model = opts.model ?? 'hf.co/Mapika/decider-4b-GGUF:Q4_K_M';
  let running = 0;
  const mock = { requests: [] as Array<Record<string, unknown>>, maxConcurrent: 0, opts } as MockOllama;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/version') { json(res, 200, { version: '0.33.0' }); return; }
    if (req.method !== 'POST' || req.url !== '/api/generate') { json(res, 404, { error: 'not found' }); return; }
    const b = JSON.parse(await body(req)) as Record<string, unknown>;
    mock.requests.push(b);
    running++;
    mock.maxConcurrent = Math.max(mock.maxConcurrent, running);
    try {
      if (mock.opts.delayMs) await new Promise((r) => setTimeout(r, mock.opts.delayMs));
      if (b.model !== model) { json(res, 404, { error: `model '${String(b.model)}' not found` }); return; }
      if (mock.opts.status) { json(res, mock.opts.status, { error: 'mock failure' }); return; }
      const p = parsePrompt(String(b.prompt));
      const favourite = mock.opts.pick?.(p)
        ?? Math.max(0, mock.opts.favour ? p.options.findIndex((o) => o.startsWith(mock.opts.favour as string)) : 0);
      const top = topFor(p.labels, favourite, Number(b.top_logprobs ?? 0));
      const pick = top[0];
      json(res, 200, {
        model, response: pick.token, done: true,
        prompt_eval_count: Math.ceil(String(b.prompt).length / 4), eval_count: 1,
        ...(mock.opts.noLogprobs ? {} : { logprobs: [{ token: pick.token, logprob: pick.logprob, top_logprobs: top }] }),
      });
    } finally {
      running--;
    }
  });
  return Object.assign(mock, await listen(server));
}

/** A server that already speaks /v1/systemone (decider-ai's decider.serve, Kev's kev.serve). */
export async function startMockSystemOne(answers: (q: Record<string, { type: string }>) => Record<string, unknown>): Promise<Listening & { requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') { json(res, 200, { ok: true, model: 'Mapika/decider-2b' }); return; }
    if (req.method === 'POST' && req.url === '/v1/systemone') {
      const b = JSON.parse(await body(req)) as { questions: Record<string, { type: string }> };
      requests.push(b as unknown as Record<string, unknown>);
      json(res, 200, { model: 'decider-2b-v11', answers: answers(b.questions), usage: { input_tokens: 321, output_tokens: 0 } });
      return;
    }
    json(res, 404, { detail: 'not found' });
  });
  return Object.assign({ requests }, await listen(server));
}

/** The bridge on a real port, mounted at /api/local-jev as vite mounts it. */
export async function startBridge(cfg: LocalMindConfig): Promise<Listening & { mind: LocalMind }> {
  const mind = new LocalMind(cfg);
  const handle = localMindHandler(mind);
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (!url.startsWith('/api/local-jev')) { json(res, 404, { error: 'not found' }); return; }
    req.url = url.slice('/api/local-jev'.length) || '/';
    void handle(req, res);
  });
  return Object.assign({ mind }, await listen(server));
}

export function config(over: Partial<LocalMindConfig> = {}): LocalMindConfig {
  return {
    backend: 'ollama', url: 'http://127.0.0.1:1', model: 'hf.co/Mapika/decider-4b-GGUF:Q4_K_M',
    timeoutMs: 3000, maxConcurrent: 1, maxQueue: 4, isolatedLevels: true,
    temperatures: { choice: 1.11, noul: 1.56, score: 1.287 }, topLogprobs: 20, healthCacheMs: 0,
    ...over,
  };
}
