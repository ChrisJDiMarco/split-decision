// One-shot procedural sounds. Metal hits are modal synthesis: a sum of inharmonic plate
// modes, each with its own decay, pitched by material and part size, driven by energy.
import type { MaterialId } from '../core/types';
import type { AudioEngine } from './engine';

/** Inharmonic mode ratios of a thick clamped steel plate (close to measured plate modes). */
const PLATE_MODES = [1, 1.59, 2.14, 2.3, 2.65, 3.16, 3.5, 4.15];
const BELL_MODES = [1, 2.03, 2.76, 3.9, 5.4, 6.7];

interface MaterialVoice { f0: number; decay: number; brightness: number }

const MATERIAL_VOICE: Partial<Record<MaterialId, MaterialVoice>> = {
  ar500: { f0: 380, decay: 0.95, brightness: 1 },
  steel: { f0: 340, decay: 0.8, brightness: 0.9 },
  ti6al4v: { f0: 470, decay: 1.2, brightness: 1.1 },
  al7075: { f0: 560, decay: 0.45, brightness: 0.8 },
  al6061: { f0: 540, decay: 0.4, brightness: 0.75 },
  carbon: { f0: 300, decay: 0.12, brightness: 0.4 },
  polycarb: { f0: 260, decay: 0.1, brightness: 0.35 },
  uhmw: { f0: 220, decay: 0.08, brightness: 0.3 },
  rubber: { f0: 180, decay: 0.05, brightness: 0.2 },
};

/** Smaller parts ring higher. */
const SIZE_PITCH: Array<[RegExp, number]> = [
  [/fist|jaw|claw/, 1.75], [/head|sensor/, 1.5], [/foot|wheel/, 1.3], [/forearm|shin/, 1.2],
  [/upperarm|thigh|leg/, 1.05], [/pelvis/, 0.85], [/torso|chassis|shield/, 0.7], [/hammer|spinner/, 0.9],
];

export function sizePitch(part: string | null): number {
  if (!part) return 1;
  return SIZE_PITCH.find(([re]) => re.test(part))?.[1] ?? 1;
}

/** 0..1 loudness for an impact of `energyJ` joules (log scale, like hearing). */
export function energyLevel(energyJ: number): number {
  return Math.max(0.03, Math.min(1, (Math.log10(Math.max(1, energyJ)) - 0.4) / 2.2));
}

export interface ClangOpts {
  material: MaterialId;
  part: string | null;
  level: number; // 0..1
  pan: number;
  rate?: number; // playback rate, < 1 for slow-motion replays
  at?: number; // context time to strike (default now)
  pitch?: number; // extra pitch factor: < 1 for bigger, heavier robots
  out?: AudioNode; // shared output of a layered hit (skips the voice claim)
}

export function clang(e: AudioEngine, o: ClangOpts): void {
  const voice = MATERIAL_VOICE[o.material] ?? MATERIAL_VOICE.steel!;
  const rate = o.rate ?? 1;
  const f0 = voice.f0 * sizePitch(o.part) * (o.pitch ?? 1) * (0.96 + Math.random() * 0.08) * rate;
  const decay = (voice.decay * (0.7 + o.level * 0.6)) / rate;
  if (!o.out && !e.claimVoice(decay + 0.2, false, o.at)) return;
  const t = o.at ?? e.now;
  const out = o.out ?? e.output(o.pan, 0.35 + o.level * 0.3);
  const modes = Math.round(3 + voice.brightness * o.level * 5);
  for (let k = 0; k < Math.min(modes, PLATE_MODES.length); k++) {
    const f = f0 * PLATE_MODES[k];
    if (f > 16000) break;
    const osc = e.ctx.createOscillator();
    osc.frequency.value = f;
    const g = e.ctx.createGain();
    const amp = (o.level * 0.22 * (0.6 + Math.random() * 0.4)) / Math.pow(k + 1, 0.7);
    const tau = decay / (1 + 0.55 * k);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.002);
    g.gain.setTargetAtTime(0, t + 0.002, tau / 3);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + tau * 1.6 + 0.05);
  }
  transient(e, out, o.level, rate * (o.pitch ?? 1), t); // a bigger contact patch clicks lower
  if (o.level > 0.45) thump(e, out, o.level * 0.8, 95 * rate * (o.pitch ?? 1), 0.14 / rate, t);
}

/** Contact click: a few ms of bright noise, band-limited so its colour follows the contact's size. */
function transient(e: AudioEngine, out: AudioNode, level: number, rate: number, t = e.now): void {
  const src = e.noiseSource(false, Math.random() * 2, t);
  const hp = e.ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1400 * rate;
  const lp = e.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(20000, 6500 * rate);
  const g = e.ctx.createGain();
  g.gain.setValueAtTime(level * 0.5, t);
  g.gain.setTargetAtTime(0, t, 0.006 / rate);
  src.connect(hp).connect(lp).connect(g).connect(out);
  src.stop(t + 0.08 / rate);
}

/** Low body thump: a falling sine, the weight under the clang. */
export function thump(e: AudioEngine, out: AudioNode, level: number, f0: number, dur: number, t = e.now): void {
  const osc = e.ctx.createOscillator();
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, f0 * 0.4), t + dur);
  const g = e.ctx.createGain();
  g.gain.setValueAtTime(level * 0.7, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur * 1.8);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur * 2);
}

/** Heavy footfall or body slam: sub thump plus a dull, low-passed scuff. */
export function thud(e: AudioEngine, level: number, pan: number, heavy = false, at = e.now, pitch = 1): void {
  const dur = heavy ? 0.45 : 0.13;
  if (!e.claimVoice(dur * 2 + 0.1, false, at)) return;
  const t = at;
  const out = e.output(pan, heavy ? 0.4 : 0.15);
  thump(e, out, level * (heavy ? 1.2 : 1.8), (heavy ? 70 : 105) * pitch, dur, t); // lows read quieter: push them
  const src = e.noiseSource(false, Math.random() * 2, t);
  const lp = e.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = heavy ? 260 : 420;
  const g = e.ctx.createGain();
  g.gain.setValueAtTime(level * (heavy ? 0.9 : 0.5), t);
  g.gain.setTargetAtTime(0, t, dur / 3);
  src.connect(lp).connect(g).connect(out);
  src.stop(t + dur * 1.5);
}

/** Chain-link fence rattle: a cluster of tiny bright jingles. */
export function cageRattle(e: AudioEngine, level: number, pan: number, at = e.now): void {
  if (!e.claimVoice(0.8, false, at)) return;
  const t = at;
  const out = e.output(pan, 0.5);
  const src = e.noiseSource(false, Math.random() * 2, t);
  const bp = e.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 3200;
  bp.Q.value = 2.5;
  const g = e.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  for (let i = 0; i < 12; i++) {
    const ti = t + i * 0.045 + Math.random() * 0.02;
    const a = level * 0.95 * Math.pow(0.8, i);
    g.gain.setValueAtTime(a, ti);
    g.gain.setTargetAtTime(0, ti + 0.004, 0.01);
  }
  src.connect(bp).connect(g).connect(out);
  src.stop(t + 0.75);
  thud(e, level * 0.6, pan, false, t);
}

/** Metal tearing loose: a falling, resonant screech. */
export function tear(e: AudioEngine, level: number, pan: number, rate = 1, at = e.now): void {
  const dur = 0.4 / rate;
  if (!e.claimVoice(dur + 0.2, true, at)) return;
  const t = at;
  const out = e.output(pan, 0.5);
  const src = e.noiseSource(false, Math.random() * 2, t);
  const bp = e.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 7;
  bp.frequency.setValueAtTime(3200 * rate, t);
  bp.frequency.exponentialRampToValueAtTime(500 * rate, t + dur);
  const saw = e.ctx.createOscillator();
  saw.type = 'sawtooth';
  saw.frequency.setValueAtTime(820 * rate, t);
  saw.frequency.exponentialRampToValueAtTime(260 * rate, t + dur);
  const sg = e.ctx.createGain();
  sg.gain.value = 0.12 * level;
  const g = e.ctx.createGain();
  g.gain.setValueAtTime(level * 0.9, t);
  g.gain.setTargetAtTime(0, t + dur * 0.6, dur / 4);
  src.connect(bp).connect(g);
  saw.connect(sg).connect(bp);
  g.connect(out);
  saw.start(t);
  saw.stop(t + dur * 1.4);
  src.stop(t + dur * 1.4);
}

/** A failing joint: short gritty crunch. */
export function grind(e: AudioEngine, level: number, pan: number, at = e.now): void {
  if (!e.claimVoice(0.5, false, at)) return;
  const t = at;
  const out = e.output(pan, 0.2);
  const src = e.noiseSource(false, Math.random() * 2, t);
  const bp = e.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 900;
  bp.Q.value = 1.5;
  const am = e.ctx.createGain();
  am.gain.value = 0;
  const lfo = e.ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = 38;
  const lfoGain = e.ctx.createGain();
  lfoGain.gain.value = level * 0.4;
  lfo.connect(lfoGain).connect(am.gain);
  const env = e.ctx.createGain();
  env.gain.setValueAtTime(1, t);
  env.gain.setTargetAtTime(0, t + 0.2, 0.08);
  src.connect(bp).connect(am).connect(env).connect(out);
  lfo.start(t);
  lfo.stop(t + 0.5);
  src.stop(t + 0.5);
}

/** Boxing bell: long-ringing inharmonic partials, struck `strikes` times. */
export function bell(e: AudioEngine, strikes = 1): void {
  const f0 = 740;
  for (let s = 0; s < strikes; s++) {
    const t = e.now + s * 0.3;
    if (!e.claimVoice(3.2, true)) return;
    const out = e.output(0, 0.5);
    BELL_MODES.forEach((ratio, k) => {
      const osc = e.ctx.createOscillator();
      osc.frequency.value = f0 * ratio;
      const g = e.ctx.createGain();
      const tau = 2.6 / (1 + k * 0.7);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.16 / (k + 1), t + 0.003);
      g.gain.setTargetAtTime(0, t + 0.003, tau / 3);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + tau * 1.5);
    });
  }
}

/**
 * Canvas boom: the deck under the mat taking a body. A falling sub sine pitched by the robot's
 * size plus a short low-passed noise burst, both scaled by `level`.
 */
export function boom(e: AudioEngine, out: AudioNode, level: number, pitch: number, rate = 1, t = e.now): void {
  const f0 = 62 * pitch * rate;
  const dur = (0.32 + level * 0.25) / rate;
  const osc = e.ctx.createOscillator();
  osc.frequency.setValueAtTime(f0 * 1.6, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, f0 * 0.55), t + dur);
  const g = e.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level * 0.95, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur * 1.6);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur * 1.7);
  const src = e.noiseSource(false, Math.random() * 2, t);
  const lp = e.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 220 * pitch * rate;
  const ng = e.ctx.createGain();
  ng.gain.setValueAtTime(level * 0.8, t);
  ng.gain.setTargetAtTime(0, t, dur / 5);
  src.connect(lp).connect(ng).connect(out);
  src.stop(t + dur);
}

/** Servos winding down when the power goes: a falling, darkening whine and a relay click. */
export function powerDown(e: AudioEngine, pan: number, pitch = 1, rate = 1, at = e.now): void {
  const dur = 1.5 / rate;
  if (!e.claimVoice(dur + 0.2, true, at)) return;
  const t = at;
  const out = e.output(pan, 0.35);
  const osc = e.ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(760 * pitch * rate, t);
  osc.frequency.exponentialRampToValueAtTime(38 * pitch * rate, t + dur);
  const lp = e.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 4;
  lp.frequency.setValueAtTime(2600 * rate, t);
  lp.frequency.exponentialRampToValueAtTime(160 * rate, t + dur);
  const g = e.ctx.createGain();
  g.gain.setValueAtTime(0.14, t);
  g.gain.setTargetAtTime(0, t + dur * 0.55, dur / 5);
  osc.connect(lp).connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur * 1.2);
  transient(e, out, 0.35, rate, t); // the relay dropping out
}

/** Hydraulics and servos straining to lift a robot off the canvas: a rising, buzzing push. */
export function servoEffort(e: AudioEngine, pan: number, pitch = 1, rate = 1, at = e.now): void {
  const dur = 0.55 / rate;
  if (!e.claimVoice(dur + 0.1, false, at)) return;
  const t = at;
  const out = e.output(pan, 0.2);
  const osc = e.ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(170 * pitch * rate, t);
  osc.frequency.exponentialRampToValueAtTime(430 * pitch * rate, t + dur);
  const bp = e.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 3;
  bp.frequency.setValueAtTime(700 * rate, t);
  bp.frequency.exponentialRampToValueAtTime(1500 * rate, t + dur);
  const g = e.ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.1, t + dur * 0.3);
  g.gain.setTargetAtTime(0, t + dur * 0.8, dur / 6);
  osc.connect(bp).connect(g).connect(out);
  osc.start(t);
  osc.stop(t + dur * 1.4);
}
