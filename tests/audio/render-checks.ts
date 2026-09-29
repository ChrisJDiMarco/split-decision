// OfflineAudioContext render checks for the fight audio. Runs in a real browser (Web Audio is not
// in Node): tests/audio/audio.test.ts drives it in headless Chrome, and harness/audio.html has a
// button for it. Every render is seeded, so runs are repeatable.
import { BroadcastAudio, type AudioScene } from '../../src/audio/broadcast-audio';
import { SampleBank, type Pick } from '../../src/audio/samples';
import type { RobotTelemetry, SimEvent } from '../../src/core/protocol';
import type { Corner, Vec3 } from '../../src/core/types';

export interface CheckResult { name: string; pass: boolean; detail: string }

const SR = 48000;
const QUANTUM = 128 / SR;
const MINUS_1_DBFS = Math.pow(10, -1 / 20);
const AUDIBLE_DBFS = -45;
const SILENT_DBFS = -80;

type Impact = Extract<SimEvent, { kind: 'impact' }>;

export function impact(over: Partial<Impact> = {}): Impact {
  return { kind: 'impact', pos: [0, 0.3, 1.4], normal: [1, 0, 0], impulseNs: 40, speed: 7, energyJ: 300, striker: 0, victim: 1, part: 'head', metal: true, ...over };
}

interface SceneOpts { mass?: [number, number]; gloved?: [boolean, boolean] }

/** Robot 0's root is body 0, its foot body 1; robot 1's root is body 2. */
export function scene(o: SceneOpts = {}): AudioScene {
  const gloved = o.gloved ?? [false, false];
  return {
    pan: (p: Vec3) => Math.max(-1, Math.min(1, p[1] / 2)),
    material: (corner: Corner, part: string | null) => (part?.startsWith('fist') && gloved[corner] ? 'glove' : 'ar500'),
    massKg: o.mass ?? [70, 70],
    feet: [{ corner: 0, body: 1 }],
    limbs: [],
    roots: [0, 2],
  };
}

interface Cue {
  t: number;
  events?: SimEvent[];
  rate?: number;
  frame?: { poses: Float32Array | null; telemetry: RobotTelemetry[] | null; dt: number; time?: number };
}

interface RenderOpts { seconds: number; scene?: AudioScene; bank?: SampleBank; seed?: number }

let sharedBank: SampleBank | null = null;

/** The real pack, decoded once and shared by every render. */
async function loadedBank(): Promise<SampleBank> {
  if (!sharedBank) {
    const bank = new SampleBank();
    await bank.load(new OfflineAudioContext(2, SR, SR));
    sharedBank = bank;
  }
  return sharedBank;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Render `cues` through a full BroadcastAudio graph; returns the stereo output. */
export async function render(cues: Cue[], o: RenderOpts): Promise<[Float32Array, Float32Array]> {
  const random = Math.random;
  Math.random = mulberry32(o.seed ?? 7);
  try {
    const ctx = new OfflineAudioContext(2, Math.ceil(o.seconds * SR), SR);
    const bank = o.bank ?? (await loadedBank());
    bank.resetRotation();
    const audio = new BroadcastAudio({ ctx, bank });
    await audio.start();
    audio.setScene(o.scene ?? scene());
    const byQuantum = new Map<number, Cue[]>();
    for (const c of cues) {
      const q = Math.max(1, Math.round(c.t / QUANTUM));
      byQuantum.set(q, [...(byQuantum.get(q) ?? []), c]);
    }
    for (const [q, group] of byQuantum) {
      ctx.suspend(q * QUANTUM).then(() => {
        for (const c of group) {
          if (c.frame) audio.onFrame(c.frame.poses, c.frame.telemetry, c.frame.dt, c.frame.time);
          if (c.events) audio.onEvents(c.events, c.rate ?? 1);
        }
        return ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    return [buf.getChannelData(0), buf.getChannelData(1)];
  } finally {
    Math.random = random;
  }
}

// ---------------------------------------------------------------- measurements

export function peak(ch: readonly Float32Array[]): number {
  let p = 0;
  for (const d of ch) for (let i = 0; i < d.length; i++) p = Math.max(p, Math.abs(d[i]));
  return p;
}

export function rmsDb(ch: readonly Float32Array[], t0: number, t1: number): number {
  const a = Math.floor(t0 * SR), b = Math.min(ch[0].length, Math.floor(t1 * SR));
  let sum = 0;
  for (const d of ch) for (let i = a; i < b; i++) sum += d[i] * d[i];
  const rms = Math.sqrt(sum / Math.max(1, (b - a) * ch.length));
  return 20 * Math.log10(Math.max(1e-9, rms));
}

const db = (x: number) => 20 * Math.log10(Math.max(1e-9, x));

/** Spectral centroid (Hz) of the mono mix over [t0, t0 + 16384 samples), Hann-windowed. */
export function centroid(ch: readonly Float32Array[], t0: number): number {
  const { freqs, mags } = spectrum(ch, t0);
  let num = 0, den = 0;
  for (let k = 0; k < freqs.length; k++) {
    num += freqs[k] * mags[k];
    den += mags[k];
  }
  return den > 0 ? num / den : 0;
}

/** Share (0..1) of spectral power above `fc` Hz: how much sizzle and crack a hit has. */
export function highShare(ch: readonly Float32Array[], t0: number, fc = 3000): number {
  const { freqs, mags } = spectrum(ch, t0);
  let hi = 0, all = 0;
  for (let k = 0; k < freqs.length; k++) {
    const p = mags[k] * mags[k];
    all += p;
    if (freqs[k] >= fc) hi += p;
  }
  return all > 0 ? hi / all : 0;
}

function spectrum(ch: readonly Float32Array[], t0: number): { freqs: number[]; mags: number[] } {
  const N = 16384;
  const re = new Float64Array(N), im = new Float64Array(N);
  const a = Math.floor(t0 * SR);
  for (let i = 0; i < N; i++) {
    const s = (ch[0][a + i] ?? 0) + (ch[1][a + i] ?? 0);
    re[i] = s * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  fft(re, im);
  const freqs: number[] = [], mags: number[] = [];
  for (let k = 1; k < N / 2; k++) {
    const f = (k * SR) / N;
    if (f < 20 || f > 20000) continue;
    freqs.push(f);
    mags.push(Math.hypot(re[k], im[k]));
  }
  return { freqs, mags };
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

// ---------------------------------------------------------------- fixtures

function telemetry(corner: Corner): RobotTelemetry {
  return { corner, down: false, joints: [], parts: [] } as unknown as RobotTelemetry;
}

/** A foot swinging up and stamping down twice: two footfalls through the real pose path. */
function footfallFrames(t0: number): Cue[] {
  const cues: Cue[] = [];
  const dt = 1 / 60;
  for (let i = 0; i < 60; i++) {
    const phase = (i % 30) / 30; // two 0.5 s steps
    const z = 0.02 + 0.12 * Math.sin(Math.PI * Math.min(1, phase / 0.8)); // lift, then plant and hold
    const poses = new Float32Array(3 * 7);
    poses.set([0, 0, 0.9], 0);
    poses.set([0.1, 0.1, z], 7);
    poses.set([1, 0, 0.9], 14);
    cues.push({ t: t0 + i * dt, frame: { poses, telemetry: [telemetry(0), telemetry(1)], dt, time: i * dt } });
  }
  return cues;
}

const EVENT_CASES: Array<{ name: string; events: SimEvent[]; opts?: SceneOpts; frames?: boolean }> = [
  { name: 'bare knuckle cross (impact, metal)', events: [impact()] },
  { name: 'glove jab (impact, glove)', events: [impact({ metal: false, energyJ: 120, part: 'head' })], opts: { gloved: [true, true] } },
  { name: 'shin low kick (impact, thigh)', events: [impact({ part: 'thigh_l', energyJ: 450 })] },
  { name: 'composite hit (impact, carbon)', events: [impact({ metal: false })], opts: { gloved: [false, false] } },
  { name: 'body on canvas (impact, floor)', events: [impact({ striker: null, part: 'torso', energyJ: 180, metal: false })] },
  { name: 'debris bounce (impact, loose piece)', events: [impact({ striker: null, victim: null, part: null, energyJ: 20, metal: false })] },
  { name: 'fence (cage)', events: [{ kind: 'cage', corner: 1, pos: [2.8, 0, 1], speed: 3.5 }] },
  { name: 'head knockoff (detach)', events: [{ kind: 'detach', corner: 1, part: 'head', debrisBody: 9, pos: [0, 0, 1.7], vel: [2, 0, 3] }] },
  { name: 'arm knockoff (detach)', events: [{ kind: 'detach', corner: 1, part: 'forearm_l', debrisBody: 9, pos: [0, 0, 1.2], vel: [1, 0, 1] }] },
  { name: 'fall', events: [{ kind: 'fall', corner: 1 }] },
  { name: 'getup', events: [{ kind: 'getup', corner: 1 }] },
  { name: 'ko', events: [{ kind: 'ko', corner: 1, reason: 'down' }] },
  { name: 'joint degraded', events: [{ kind: 'joint', corner: 0, joint: 'knee_l', health: 0.4, state: 'degraded' }] },
  { name: 'joint seized', events: [{ kind: 'joint', corner: 0, joint: 'knee_l', health: 0, state: 'seized' }] },
  { name: 'footsteps (poses → footfall)', events: [], frames: true },
];

function gloveScene(o?: SceneOpts): AudioScene {
  const s = scene(o);
  // The 'composite' case: bare striker on carbon armour.
  return o && o.gloved?.[0] === false && o.gloved[1] === false ? { ...s, material: (_c, p) => (p?.startsWith('fist') ? 'ar500' : 'carbon') } : s;
}

// ---------------------------------------------------------------- checks

export async function runRenderChecks(): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const bank = await loadedBank();
  out.push({ name: 'samples load', pass: bank.loaded === bank.total, detail: `${bank.loaded}/${bank.total} decoded` });

  const silent = await render([], { seconds: 1 });
  const floor = rmsDb(silent, 0, 1);
  out.push({ name: 'no events = silence', pass: floor < SILENT_DBFS, detail: `${floor.toFixed(1)} dBFS` });

  for (const c of EVENT_CASES) {
    const cues: Cue[] = c.frames ? footfallFrames(0.1) : [{ t: 0.1, events: c.events }];
    const y = await render(cues, { seconds: 1.6, scene: gloveScene(c.opts) });
    const level = rmsDb(y, 0.1, c.frames ? 1.1 : 0.6);
    out.push({ name: `sound: ${c.name}`, pass: level > AUDIBLE_DBFS, detail: `${level.toFixed(1)} dBFS rms, peak ${db(peak(y)).toFixed(1)} dBFS` });
  }

  const synth = await render([{ t: 0.1, events: [impact()] }], { seconds: 1, bank: new SampleBank('/no-such-dir/') });
  const synthLevel = rmsDb(synth, 0.1, 0.6);
  out.push({ name: 'synthesis covers missing samples', pass: synthLevel > AUDIBLE_DBFS, detail: `${synthLevel.toFixed(1)} dBFS rms with an empty bank` });

  out.push(await denseExchange());
  out.push(await variantRotation());
  out.push(...(await brightnessChecks()));
  out.push(...(await placementChecks()));
  return out;
}

/** Sampled hits pan at constant power; a punch into a glove guard is padding, not a steel ring. */
async function placementChecks(): Promise<CheckResult[]> {
  const at = async (y: number) => rmsDb(await render([{ t: 0.1, events: [impact({ pos: [0, y, 1.4] })] }], { seconds: 1 }), 0.1, 0.5);
  const centre = await at(0), side = await at(1.6);
  const guard: AudioScene = { ...scene(), material: (c, p) => (p?.startsWith('fist') && c === 1 ? 'glove' : 'ar500') };
  const intoGlove = centroid(await render([{ t: 0.1, events: [impact({ part: 'fist_l', metal: false })] }], { seconds: 1, scene: guard }), 0.1);
  const bare = centroid(await render([{ t: 0.1, events: [impact()] }], { seconds: 1 }), 0.1);
  return [
    { name: 'pan law: a hit at the side is as loud as centred', pass: Math.abs(side - centre) < 1.5, detail: `pan 0.8 ${side.toFixed(1)} dBFS vs centre ${centre.toFixed(1)} dBFS rms` },
    { name: 'glove guard: bare knuckle into a glove duller than bare metal', pass: intoGlove < bare * 0.6, detail: `centroid ${intoGlove.toFixed(0)} Hz vs ${bare.toFixed(0)} Hz` },
  ];
}

/** 5 s of a brawl: ~14 contacts/s including haymakers, a knockoff, a fall and fence hits, crowd running. */
async function denseExchange(): Promise<CheckResult> {
  const rng = mulberry32(99);
  const cues: Cue[] = [];
  for (let t = 0.05; t < 5; t += 1 / 30) cues.push({ t, frame: { poses: null, telemetry: null, dt: 1 / 30 } });
  for (let t = 0.1; t < 4.8; t += 0.03 + rng() * 0.08) {
    const energyJ = rng() < 0.2 ? 800 + rng() * 2500 : 40 + rng() * 500;
    const r = rng();
    const ev: SimEvent = r < 0.55 ? impact({ energyJ, part: rng() < 0.5 ? 'head' : 'torso', pos: [0, rng() * 2 - 1, 1.3] })
      : r < 0.7 ? impact({ energyJ, part: 'thigh_r' })
      : r < 0.8 ? impact({ striker: null, part: 'torso', energyJ, metal: false })
      : r < 0.9 ? { kind: 'cage', corner: 1, pos: [2.8, 0, 1], speed: 2 + rng() * 5 }
      : impact({ striker: 1, victim: 0, energyJ, part: 'fist_l' });
    cues.push({ t, events: [ev] });
  }
  cues.push({ t: 2.5, events: [{ kind: 'detach', corner: 1, part: 'head', debrisBody: 9, pos: [0, 0, 1.7], vel: [2, 0, 3] }, impact({ energyJ: 4000 })] });
  cues.push({ t: 3.2, events: [{ kind: 'fall', corner: 1 }, { kind: 'ko', corner: 1, reason: 'head' }] });
  const y = await render(cues, { seconds: 5.5, scene: scene({ mass: [105, 105] }) });
  const p = peak(y);
  let hot = 0;
  for (const d of y) for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.62) hot++;
  const hits = cues.filter((c) => c.events).length;
  return {
    name: 'dense 5 s exchange peaks under -1 dBFS',
    pass: p <= MINUS_1_DBFS,
    detail: `${hits} event batches; peak ${db(p).toFixed(2)} dBFS; ${((100 * hot) / (y[0].length * 2)).toFixed(2)}% of samples in the ceiling knee (> -4.2 dBFS); loudness ${rmsDb(y, 0, 5).toFixed(1)} dBFS rms`,
  };
}

async function variantRotation(): Promise<CheckResult> {
  const bank = await loadedBank();
  const trace: Pick[] = [];
  bank.trace = trace;
  try {
    const cues = Array.from({ length: 10 }, (_, i) => ({ t: 0.1 + i * 0.12, events: [impact({ energyJ: 300 })] }));
    await render(cues, { seconds: 1.6 });
  } finally {
    bank.trace = null;
  }
  const byGroup = new Map<string, number[]>();
  for (const p of trace) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p.variant]);
  let repeats = 0;
  const seqs: string[] = [];
  for (const [g, v] of byGroup) {
    for (let i = 1; i < v.length; i++) if (v[i] === v[i - 1]) repeats++;
    seqs.push(`${g}: ${v.join('')}`);
  }
  return { name: '10 identical hits never repeat a variant back to back', pass: repeats === 0 && trace.length >= 10, detail: seqs.join('; ') };
}

async function brightnessChecks(): Promise<CheckResult[]> {
  const hit = [{ t: 0.1, events: [impact({ energyJ: 400 })] }];
  const heavy = centroid(await render(hit, { seconds: 1, scene: scene({ mass: [105, 105] }) }), 0.1);
  const light = centroid(await render(hit, { seconds: 1, scene: scene({ mass: [38, 38] }) }), 0.1);
  const jab = [{ t: 0.1, events: [impact({ energyJ: 300, metal: false })] }];
  const bareHit = [{ t: 0.1, events: [impact({ energyJ: 300 })] }];
  const glove = centroid(await render(jab, { seconds: 1, scene: scene({ gloved: [true, true] }) }), 0.1);
  const bare = centroid(await render(bareHit, { seconds: 1 }), 0.1);
  const slow = centroid(await render([{ t: 0.1, events: [impact({ energyJ: 400 })], rate: 0.62 }], { seconds: 1.5 }), 0.1);
  const live = centroid(await render(hit, { seconds: 1 }), 0.1);
  const power = highShare(await render([{ t: 0.1, events: [impact({ energyJ: 2500 })] }], { seconds: 1 }), 0.1);
  const solid = highShare(await render([{ t: 0.1, events: [impact({ energyJ: 280 })] }], { seconds: 1 }), 0.1);
  return [
    { name: 'heavy robot (105 kg) lower than light (38 kg)', pass: heavy < light, detail: `centroid ${heavy.toFixed(0)} Hz vs ${light.toFixed(0)} Hz` },
    { name: 'glove duller than bare metal', pass: glove < bare, detail: `centroid ${glove.toFixed(0)} Hz vs ${bare.toFixed(0)} Hz` },
    { name: 'slow-motion replay (0.62x) lower than live', pass: slow < live, detail: `centroid ${slow.toFixed(0)} Hz vs ${live.toFixed(0)} Hz` },
    { name: 'same layers, more energy = brighter', pass: power > solid * 1.5, detail: `power above 3 kHz: 2500 J ${(100 * power).toFixed(2)}% vs 280 J ${(100 * solid).toFixed(2)}% (${(10 * Math.log10(power / solid)).toFixed(1)} dB brighter)` },
  ];
}
