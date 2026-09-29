// Audio harness: audition every kind of fight contact through the real BroadcastAudio path.
// Nothing plays until a click (browsers require a gesture to start an AudioContext).
import { BroadcastAudio, type AudioScene } from '../audio/broadcast-audio';
import { SampleBank } from '../audio/samples';
import type { RobotTelemetry, SimEvent } from '../core/protocol';
import type { Corner, Vec3 } from '../core/types';

type Impact = Extract<SimEvent, { kind: 'impact' }>;

const app = document.getElementById('app')!;
const state = { mass: 70, energy: 1, gloved: false, rate: 1 };
let audio: BroadcastAudio | null = null;
let synthOnly = false;

function impact(over: Partial<Impact>): Impact {
  return { kind: 'impact', pos: [0, 0, 1.4], normal: [1, 0, 0], impulseNs: 40, speed: 7, energyJ: 300, striker: 0, victim: 1, part: 'head', metal: true, ...over };
}

function scene(): AudioScene {
  const gloved = state.gloved;
  return {
    pan: (p: Vec3) => Math.max(-1, Math.min(1, p[1] / 2)),
    material: (_corner: Corner, part: string | null) => (part?.startsWith('fist') && gloved ? 'glove' : 'ar500'),
    massKg: [state.mass, state.mass],
    feet: [{ corner: 0, body: 1 }, { corner: 0, body: 2 }],
    limbs: [],
    roots: [0, 3],
  };
}

async function ready(): Promise<BroadcastAudio> {
  if (!audio) {
    // An empty bank (pointing nowhere) gives the pure-synthesis fallback, for A/B.
    audio = new BroadcastAudio({ followSettings: false, bank: synthOnly ? new SampleBank('/no-samples/') : undefined });
    status('loading samples…');
  }
  await audio.start();
  audio.setScene(scene());
  await audio.samplesReady();
  status(synthOnly ? 'synthesis only' : `samples ${audio.bank.loaded}/${audio.bank.total} loaded`);
  return audio;
}

const E = (j: number) => j * state.energy;

/** Each entry: a label and the events to fire (with an optional offset in seconds). */
const HITS: Array<{ label: string; play(): Array<[number, SimEvent[]]> | 'steps' }> = [
  { label: 'Jab (glove)', play: () => withGloves(() => [[0, [impact({ metal: false, energyJ: E(90), pos: [0, -0.3, 1.5] })]]]) },
  { label: 'Cross (glove, hard)', play: () => withGloves(() => [[0, [impact({ metal: false, energyJ: E(420), pos: [0, 0.4, 1.5] })]]]) },
  { label: 'Bare knuckle cross', play: () => [[0, [impact({ energyJ: E(420), pos: [0, 0.4, 1.5] })]]] },
  { label: 'Bare knuckle to body', play: () => [[0, [impact({ energyJ: E(260), part: 'torso' })]]] },
  { label: 'Shin low kick', play: () => [[0, [impact({ energyJ: E(600), part: 'thigh_l', pos: [0, -0.5, 0.6] })]]] },
  { label: 'Light tap', play: () => [[0, [impact({ energyJ: E(20) })]]] },
  { label: 'Head knockoff', play: () => [[0, [impact({ energyJ: E(1800) }), { kind: 'detach', corner: 1, part: 'head', debrisBody: 9, pos: [0, 0, 1.7], vel: [2, 0, 3] }]]] },
  { label: 'Fall', play: () => [[0, [{ kind: 'fall', corner: 1 }]]] },
  { label: 'Fence', play: () => [[0, [{ kind: 'cage', corner: 1, pos: [2.8, 1.6, 1], speed: 4.5 }]]] },
  { label: 'Debris bounces', play: () => [0, 0.3, 0.52, 0.68, 0.8].map((t, i) => [t, [impact({ striker: null, victim: null, part: null, metal: false, energyJ: 30 * Math.pow(0.6, i) })]]) },
  { label: 'Footsteps', play: () => 'steps' },
  { label: 'Get up', play: () => [[0, [{ kind: 'getup', corner: 1 }]]] },
  { label: 'KO power-down', play: () => [[0, [{ kind: 'ko', corner: 1, reason: 'power' }]]] },
  { label: 'Joint seizes', play: () => [[0, [{ kind: 'joint', corner: 0, joint: 'knee_l', health: 0, state: 'seized' }]]] },
];

function withGloves<T>(fn: () => T): T {
  const prev = state.gloved;
  state.gloved = true;
  audio?.setScene(scene());
  const out = fn();
  setTimeout(() => { state.gloved = prev; audio?.setScene(scene()); }, 50);
  return out;
}

async function play(i: number): Promise<number> {
  const a = await ready();
  const cue = HITS[i].play();
  if (cue === 'steps') return walk(a);
  for (const [t, events] of cue) setTimeout(() => a.onEvents(events, state.rate), (t * 1000) / state.rate);
  return Math.max(...cue.map(([t]) => t)) / state.rate + 1.2;
}

/** Two feet walking for 2 s through the real pose → footfall path. */
function walk(a: BroadcastAudio): number {
  const dt = 1 / 60;
  let i = 0;
  const tel = [{ corner: 0, down: false, joints: [], parts: [] }] as unknown as RobotTelemetry[];
  const id = setInterval(() => {
    const poses = new Float32Array(4 * 7);
    const step = (phase: number) => 0.02 + 0.1 * Math.max(0, Math.sin(Math.PI * 2 * phase));
    poses.set([0, 0, 0.9], 0);
    poses.set([0.15 * i * dt, 0.12, step(i * dt * 1.6)], 7);
    poses.set([0.15 * i * dt, -0.12, step(i * dt * 1.6 + 0.5)], 14);
    poses.set([1.2, 0, 0.9], 21);
    a.onFrame(poses, tel, dt, i * dt);
    if (++i > 120) clearInterval(id);
  }, dt * 1000);
  return 2.2;
}

async function sequence(): Promise<void> {
  const order = ['Jab (glove)', 'Bare knuckle cross', 'Shin low kick', 'Head knockoff', 'Fall', 'Fence', 'Footsteps'];
  for (const label of order) {
    status(`▶ ${label}`);
    const secs = await play(HITS.findIndex((h) => h.label === label));
    await new Promise((r) => setTimeout(r, secs * 1000));
  }
  status('sequence done');
}

// ---------------------------------------------------------------- UI

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
}

function status(text: string): void {
  statusEl.textContent = text;
}

function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, set: (v: number) => void): HTMLLabelElement {
  const out = el('output', {}, fmt(value));
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    set(v);
    out.textContent = fmt(v);
    audio?.setScene(scene());
  });
  return el('label', {}, label, input, out);
}

const statusEl = el('div', { id: 'status' }, 'click anything to start audio');
const seqBtn = el('button', { className: 'primary' }, '▶ Play the sequence');
seqBtn.addEventListener('click', () => void sequence());
const grid = el('div', { className: 'grid' });
HITS.forEach((h, i) => {
  const b = el('button', {}, h.label);
  b.addEventListener('click', () => { status(`▶ ${h.label}`); void play(i); });
  grid.append(b);
});

const presets = el('div', { className: 'grid' });
for (const [name, kg] of [['FIRECRACKER 38 kg', 38], ['Reference 70 kg', 70], ['HAYMAKER 105 kg', 105]] as const) {
  const b = el('button', {}, name);
  b.addEventListener('click', () => {
    state.mass = kg;
    massSlider.querySelector('input')!.value = String(kg);
    massSlider.querySelector('output')!.textContent = `${kg} kg`;
    audio?.setScene(scene());
    status(`robots now ${kg} kg`);
  });
  presets.append(b);
}
const massSlider = slider('Robot mass', 38, 105, 1, state.mass, (v) => `${v} kg`, (v) => { state.mass = v; });
const energySlider = slider('Hit energy', 0.1, 3, 0.05, state.energy, (v) => `${v.toFixed(2)}×`, (v) => { state.energy = v; });
const slowMo = el('input', { type: 'checkbox' });
slowMo.addEventListener('change', () => { state.rate = slowMo.checked ? 0.62 : 1; });
const synth = el('input', { type: 'checkbox' });
synth.addEventListener('change', () => { synthOnly = synth.checked; audio = null; status(synthOnly ? 'synthesis only (next click)' : 'samples (next click)'); });

const results = el('div', { id: 'results' });
const testBtn = el('button', {}, 'Run offline render checks');
testBtn.addEventListener('click', async () => {
  results.textContent = 'rendering…';
  const { runRenderChecks } = await import('../../tests/audio/render-checks');
  const rows = await runRenderChecks();
  results.replaceChildren(...rows.map((r) => el('div', { className: r.pass ? 'pass' : 'fail' }, `${r.pass ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`)));
});

app.append(
  el('section', {}, el('h2', {}, 'Sequence'), seqBtn, el('div', { className: 'status-row' }, statusEl)),
  el('section', {}, el('h2', {}, 'Hits'), grid),
  el('section', {}, el('h2', {}, 'Physics'), presets, massSlider, energySlider,
    el('label', {}, slowMo, 'Slow-motion replay (0.62×)'), el('label', {}, synth, 'Synthesis only (A/B the samples)')),
  el('section', {}, el('h2', {}, 'Checks'), testBtn, results),
);
