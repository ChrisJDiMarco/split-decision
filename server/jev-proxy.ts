// Dev-server proxy for Jev. The browser posts to /api/jev; this process adds the key
// (read once from the macOS Keychain, or TYPESAFE_API_KEY) and forwards to TypeSafe.
// The key never reaches the browser.
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
const KEYCHAIN_SERVICE = 'com.chrisdimarco.cabinet.api-keys';
const KEYCHAIN_ACCOUNT = 'typesafe-jev';
const KEY_TIMEOUT_MS = 120_000;
const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_REQUESTS_PER_MIN = 600; // TypeSafe allows 1,200/min per account; keep headroom

let keyPromise: Promise<string> | null = null;
let recent: number[] = [];

function readKey(): Promise<string> {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return Promise.resolve(fromEnv);
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { timeout: KEY_TIMEOUT_MS }, (err, stdout) => {
        if (err) reject(new Error('Jev key unavailable: allow Keychain access for typesafe-jev, or set TYPESAFE_API_KEY'));
        else resolve(stdout.trim());
      });
  });
}

function key(): Promise<string> {
  keyPromise ??= readKey().catch((e) => { keyPromise = null; throw e; });
  return keyPromise;
}

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

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'GET') {
    // Status probe: does not read the key, so it never triggers a Keychain prompt.
    send(res, 200, { ok: true, keyLoaded: keyPromise !== null });
    return;
  }
  if (req.method !== 'POST') { send(res, 405, { error: 'POST only' }); return; }
  const now = Date.now();
  recent = recent.filter((t) => now - t < 60_000);
  if (recent.length >= MAX_REQUESTS_PER_MIN) { send(res, 429, { error: 'local rate limit' }); return; }
  recent.push(now);
  let body: string;
  try {
    body = await readBody(req);
    JSON.parse(body);
  } catch {
    send(res, 400, { error: 'invalid JSON body' });
    return;
  }
  let apiKey: string;
  try {
    apiKey = await key();
  } catch (e) {
    send(res, 503, { error: (e as Error).message });
    return;
  }
  const t0 = performance.now();
  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await upstream.text();
    res.setHeader('X-Jev-Latency-Ms', String(Math.round(performance.now() - t0)));
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(text);
  } catch (e) {
    send(res, 502, { error: `upstream failed: ${(e as Error).name}` });
  }
}

export function jevProxy(): Plugin {
  return {
    name: 'jev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/jev', (req, res) => { void handle(req, res); });
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/jev', (req, res) => { void handle(req, res); });
    },
  };
}
