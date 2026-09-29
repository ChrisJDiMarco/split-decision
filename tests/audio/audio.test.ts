// Fight audio tests. The mapping (what touched what → which sound, how loud, how bright, what pitch)
// is pure and runs here in Node. Web Audio isn't in Node, so the OfflineAudioContext renders
// (tests/audio/render-checks.ts) run in headless Chrome against a private Vite server.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { brightness, classifyStrike, crackDb, hitGain, impactLevel, massPitch, tier } from '../../src/audio/foley';
import { SampleBank, SAMPLE_GROUPS, VARIANTS } from '../../src/audio/samples';
import type { CheckResult } from './render-checks';

describe('physical mapping', () => {
  test('bigger robots pitch down: 105 kg HAYMAKER below 38 kg FIRECRACKER', () => {
    expect(massPitch(105)).toBeLessThan(massPitch(70));
    expect(massPitch(70)).toBeCloseTo(1, 6);
    expect(massPitch(38)).toBeGreaterThan(massPitch(70));
    expect(massPitch(105) / massPitch(38)).toBeCloseTo(Math.cbrt(38 / 105), 3);
    expect(massPitch(10_000)).toBeGreaterThanOrEqual(0.62);
    expect(massPitch(1)).toBeLessThanOrEqual(1.45);
  });

  test('level is log energy, bounded, and gain follows √energy (sound pressure)', () => {
    const energies = [1, 3, 10, 30, 100, 300, 1000, 3000];
    const levels = energies.map(impactLevel);
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1]);
    expect(impactLevel(0)).toBeGreaterThan(0);
    expect(impactLevel(1e6)).toBe(1);
    expect(hitGain(1)).toBe(1);
    expect(hitGain(impactLevel(30)) / hitGain(impactLevel(3000))).toBeCloseTo(Math.sqrt(30 / 3000), 2);
  });

  test('brightness and crack rise with energy', () => {
    for (let l = 0.1; l < 1; l += 0.1) {
      expect(brightness(l + 0.1)).toBeGreaterThan(brightness(l));
      expect(crackDb(l + 0.1)).toBeGreaterThanOrEqual(crackDb(l));
    }
    expect(crackDb(0.1)).toBeLessThan(0);
    expect(crackDb(1)).toBeGreaterThan(0);
  });

  test('tiers: taps light, solid shots medium, power shots heavy', () => {
    expect(tier(impactLevel(8))).toBe('light');
    expect(tier(impactLevel(100))).toBe('medium');
    expect(tier(impactLevel(600))).toBe('heavy');
  });

  test('classifies what touched what', () => {
    const c = (metal: boolean, part: string | null, victimMaterial: 'ar500' | 'carbon' | 'glove' | 'al7075' | 'polycarb', strikerGloved: boolean) =>
      classifyStrike({ metal, part, victimMaterial, strikerGloved });
    expect(c(true, 'head', 'ar500', false)).toBe('bare'); // knuckle plate on armour
    expect(c(false, 'head', 'ar500', true)).toBe('glove'); // glove on armour
    expect(c(true, 'thigh_l', 'ar500', false)).toBe('kick'); // shin on a thigh plate
    expect(c(true, 'shin_r', 'ar500', true)).toBe('kick'); // a gloved fighter's shin is still metal
    expect(c(true, 'torso', 'carbon', false)).toBe('composite');
    expect(c(false, 'torso', 'carbon', true)).toBe('glove');
    expect(c(false, 'fist_l', 'glove', false)).toBe('glove'); // bare knuckle into a glove guard: padding, no steel ring
    expect(c(false, 'thigh_l', 'al7075', true)).toBe('kick'); // FIRECRACKER's polycarb shin on an aluminium thigh (never sparks)
    expect(c(false, 'shin_l', 'polycarb', true)).toBe('composite'); // HAYMAKER checking a kick: shin on shin, not a glove
  });
});

type FakeCtx = { decodeAudioData(b: ArrayBuffer): Promise<AudioBuffer> };

function fakeCtx(): FakeCtx {
  const buffer = { numberOfChannels: 1, getChannelData: () => new Float32Array([0.25, -0.5, 0.1]) } as unknown as AudioBuffer;
  return { decodeAudioData: async () => buffer };
}

describe('sample bank', () => {
  test('loads every variant and never plays the same variant twice in a row', async () => {
    const bank = new SampleBank('/x/');
    await bank.load(fakeCtx() as unknown as BaseAudioContext, async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    expect(bank.loaded).toBe(Object.keys(SAMPLE_GROUPS).length * VARIANTS);
    bank.trace = [];
    for (let i = 0; i < 300; i++) bank.pick('metalHeavy');
    const v = bank.trace.map((p) => p.variant);
    for (let i = 1; i < v.length; i++) expect(v[i]).not.toBe(v[i - 1]);
    expect(new Set(v).size).toBe(VARIANTS); // every variant gets used
    expect(bank.pick('metalHeavy')!.norm).toBeCloseTo(2, 6); // peak 0.5 → normalised to 1
  });

  test('dual-mono stereo files are kept as one channel (half the memory)', async () => {
    const ch = new Float32Array([0.25, -0.5, 0.1]);
    const stereo = { numberOfChannels: 2, length: 3, sampleRate: 48000, getChannelData: () => ch } as unknown as AudioBuffer;
    let made = 0;
    const ctx = {
      decodeAudioData: async () => stereo,
      createBuffer: (n: number, len: number, rate: number) => {
        made++;
        const d = new Float32Array(len);
        return { numberOfChannels: n, length: len, sampleRate: rate, getChannelData: () => d, copyToChannel: (s: Float32Array) => d.set(s) } as unknown as AudioBuffer;
      },
    };
    const bank = new SampleBank('/x/');
    await bank.load(ctx as unknown as BaseAudioContext, async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    const s = bank.pick('metalHeavy')!;
    expect(made).toBe(bank.total);
    expect(s.buffer.numberOfChannels).toBe(1);
    expect(s.norm).toBeCloseTo(2, 6); // peak 0.5 → normalised to 1
  });

  test('missing files leave the group empty so synthesis covers it', async () => {
    const bank = new SampleBank('/x/');
    await bank.load(fakeCtx() as unknown as BaseAudioContext, async (url) => ({ ok: !url.includes('impactBell'), arrayBuffer: async () => new ArrayBuffer(8) }));
    expect(bank.has('bell')).toBe(false);
    expect(bank.pick('bell')).toBeNull();
    expect(bank.has('metalHeavy')).toBe(true);
  });
});

// ---------------------------------------------------------------- OfflineAudioContext renders in headless Chrome

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p): p is string => !!p && existsSync(p));

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RENDER_TIMEOUT_MS = 180_000;

describe.skipIf(!CHROME)('offline renders (headless Chrome)', () => {
  let server: ViteDevServer | null = null;
  let chrome: ChildProcess | null = null;
  let profile = '';
  let results: CheckResult[] = [];

  beforeAll(async () => {
    server = await createServer({ configFile: false, root: ROOT, logLevel: 'silent', server: { host: '127.0.0.1', port: 5391, strictPort: false } });
    await server.listen();
    const base = server.resolvedUrls?.local[0];
    if (!base) throw new Error('vite did not report a URL');
    profile = mkdtempSync(join(tmpdir(), 'audio-test-chrome-'));
    chrome = spawn(CHROME!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await devtoolsUrl(chrome);
    const cdp = await Cdp.connect(wsUrl);
    try {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: `${base}harness/audio.html` });
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      await waitForLoad(cdp, sessionId);
      const res = await cdp.send<{ result: { value?: CheckResult[] }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
        expression: `import('/tests/audio/render-checks.ts').then((m) => m.runRenderChecks())`,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId);
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
      results = res.result.value ?? [];
      await cdp.send('Browser.close').catch(() => undefined);
    } finally {
      cdp.close();
    }
  }, RENDER_TIMEOUT_MS);

  afterAll(async () => {
    if (chrome && !(await exited(chrome, 5000))) {
      chrome.kill(); // only the browser this test started
      await exited(chrome, 5000);
    }
    await server?.close();
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const expectCheck = (pattern: RegExp) => {
    const hits = results.filter((r) => pattern.test(r.name));
    expect(hits.length, `no check matched ${pattern}`).toBeGreaterThan(0);
    for (const r of hits) expect(r.pass, `${r.name}: ${r.detail}`).toBe(true);
  };

  test('the real sample pack decodes', () => expectCheck(/^samples load/));
  test('every event kind produces sound', () => {
    expectCheck(/^sound: /);
    expectCheck(/^no events = silence/);
  });
  test('synthesis covers missing samples', () => expectCheck(/^synthesis covers/));
  test('a dense 5 s exchange never exceeds -1 dBFS', () => expectCheck(/^dense 5 s exchange/));
  test('consecutive identical hits choose different variants', () => expectCheck(/never repeat a variant/));
  test('heavy robots render a lower spectral centroid than light ones', () => expectCheck(/^heavy robot/));
  test('gloves are duller than bare metal', () => {
    expectCheck(/^glove duller/);
    expectCheck(/^glove guard/);
  });
  test('sampled hits pan at constant power', () => expectCheck(/^pan law/));
  test('slow-motion replays pitch down; harder hits are brighter', () => {
    expectCheck(/^slow-motion replay/);
    expectCheck(/more energy = brighter/);
  });
  test('report', () => {
    for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
    expect(results.every((r) => r.pass)).toBe(true);
  });
});

function exited(proc: ChildProcess, ms: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((ok) => {
    const timer = setTimeout(() => ok(false), ms);
    proc.once('exit', () => { clearTimeout(timer); ok(true); });
  });
}

function devtoolsUrl(proc: ChildProcess): Promise<string> {
  return new Promise((ok, fail) => {
    let err = '';
    const timer = setTimeout(() => fail(new Error(`chrome did not start: ${err.slice(-400)}`)), 20_000);
    proc.stderr!.on('data', (chunk: Buffer) => {
      err += chunk.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(timer); ok(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); fail(new Error(`chrome exited (${code}): ${err.slice(-400)}`)); });
  });
}

async function waitForLoad(cdp: Cdp, sessionId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await cdp.send<{ result: { value?: string } }>('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
    if (r.result.value === 'complete') return;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error('harness page did not load');
}

/** Just enough Chrome DevTools Protocol: request/response over the browser's WebSocket. */
class Cdp {
  private next = 1;
  private pending = new Map<number, { ok(v: unknown): void; fail(e: Error): void }>();

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.fail(new Error(msg.error.message));
      else p.ok(msg.result);
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => ok(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => fail(new Error(`cannot reach ${url}`)), { once: true });
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.next++;
    return new Promise<T>((ok, fail) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.ws.close();
  }
}
