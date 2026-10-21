// Weapon sounds, synthesised with WebAudio (no samples). Silent unless SOUND is on in settings.
import { settings } from '../../core/settings';

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let master: GainNode | null = null;

function ac(): AudioContext | null {
  if (!settings().soundOn) return null;
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function burst(c: AudioContext, dur: number, filter: BiquadFilterType, f0: number, f1: number, gain: number, q = 0.8): void {
  const src = c.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const bq = c.createBiquadFilter();
  bq.type = filter;
  bq.Q.value = q;
  const t = c.currentTime;
  bq.frequency.setValueAtTime(f0, t);
  bq.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bq).connect(g).connect(master!);
  src.start(t, Math.random());
  src.stop(t + dur + 0.05);
}

function thump(c: AudioContext, f0: number, f1: number, dur: number, gain: number): void {
  const o = c.createOscillator();
  o.type = 'sine';
  const t = c.currentTime;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master!);
  o.start(t);
  o.stop(t + dur + 0.05);
}

export const sfx = {
  gatling(): void {
    const c = ac();
    if (!c) return;
    burst(c, 0.05, 'bandpass', 2600, 900, 0.5, 1.2);
    thump(c, 160, 60, 0.05, 0.35);
  },
  cannon(): void {
    const c = ac();
    if (!c) return;
    burst(c, 0.9, 'lowpass', 3000, 120, 1.2);
    burst(c, 0.12, 'highpass', 4000, 2000, 0.5);
    thump(c, 90, 28, 0.6, 1.1);
  },
  explosion(scale = 1): void {
    const c = ac();
    if (!c) return;
    burst(c, 1.4 * scale, 'lowpass', 1800, 60, 1.3 * scale);
    thump(c, 70, 22, 0.9, 1.2 * scale);
  },
  missile(): void {
    const c = ac();
    if (!c) return;
    burst(c, 0.7, 'bandpass', 600, 3200, 0.55, 1.5);
  },
  flame(dur: number): void {
    const c = ac();
    if (!c) return;
    burst(c, dur, 'lowpass', 900, 500, 0.7, 0.5);
    burst(c, dur, 'bandpass', 220, 180, 0.6, 0.7);
  },
  deploy(): void {
    const c = ac();
    if (!c) return;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    const t = c.currentTime;
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(620, t + 0.35);
    const g = c.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g).connect(master!);
    o.start(t);
    o.stop(t + 0.45);
    burst(c, 0.08, 'bandpass', 1200, 800, 0.4, 2); // the hatch clunk
  },
  ricochet(): void {
    const c = ac();
    if (!c) return;
    burst(c, 0.12, 'bandpass', 5000, 2500, 0.18, 6);
  },
};
