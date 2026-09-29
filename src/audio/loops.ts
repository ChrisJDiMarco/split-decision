// Continuous procedural layers: servo whine per fighter, hydraulic hiss per fighter and
// the crowd bed. Each exposes a `set...` method called every frame with smoothed targets.
import type { AudioEngine } from './engine';

const SMOOTH_S = 0.06;

export class ServoWhine {
  private osc: OscillatorNode;
  private osc2: OscillatorNode;
  private filter: BiquadFilterNode;
  private gain: GainNode;
  private pan: StereoPannerNode;

  constructor(private e: AudioEngine, detune: number) {
    const ctx = e.ctx;
    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    this.osc.detune.value = detune;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.Q.value = 5;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    this.osc.connect(this.filter);
    this.osc2.connect(g2).connect(this.filter);
    this.filter.connect(this.gain).connect(this.pan).connect(e.master);
    this.osc.start();
    this.osc2.start();
  }

  /** torque 0..1 (share of available torque), speed 0..1 (limb speed), pan -1..1. */
  set(torque: number, speed: number, pan: number): void {
    const t = this.e.now;
    const f = 150 + speed * 560 + torque * 240;
    this.osc.frequency.setTargetAtTime(f, t, SMOOTH_S);
    this.osc2.frequency.setTargetAtTime(f * 2.01, t, SMOOTH_S);
    this.filter.frequency.setTargetAtTime(f * 2.4, t, SMOOTH_S);
    const level = Math.min(1, torque * 0.7 + speed * 0.6);
    this.gain.gain.setTargetAtTime(0.004 + level * level * 0.07, t, SMOOTH_S);
    this.pan.pan.setTargetAtTime(pan, t, SMOOTH_S);
  }

  silence(): void {
    this.gain.gain.setTargetAtTime(0, this.e.now, 0.1);
  }
}

export class HydraulicHiss {
  private gain: GainNode;
  private pan: StereoPannerNode;
  private bp: BiquadFilterNode;

  constructor(private e: AudioEngine, offset: number) {
    const ctx = e.ctx;
    const src = e.noiseSource(true, offset);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    this.bp.frequency.value = 5200;
    this.bp.Q.value = 0.7;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    src.connect(hp).connect(this.bp).connect(this.gain).connect(this.pan).connect(e.master);
  }

  /** leak in L/s summed over the robot. */
  set(leakLps: number, pan: number): void {
    const t = this.e.now;
    const level = Math.min(1, leakLps / 0.3);
    const flutter = 0.8 + Math.random() * 0.4; // spurting, not a steady tone
    this.gain.gain.setTargetAtTime(level * 0.22 * flutter, t, 0.04);
    this.bp.frequency.setTargetAtTime(4200 + level * 2400 * flutter, t, 0.05);
    this.pan.pan.setTargetAtTime(pan, t, SMOOTH_S);
  }

  silence(): void {
    this.gain.gain.setTargetAtTime(0, this.e.now, 0.1);
  }
}

const CROWD_VOICES = 8;
const CROWD_BASE = 0.14; // idle excitement
const CROWD_DECAY_S = 3.2;
const CROWD_RETARGET_S = 0.12;

/** Arena crowd: many band-limited murmurs with random syllable-rate swells, plus a roar. */
export class Crowd {
  private layers: Array<{ gain: GainNode; base: number }> = [];
  private bus: GainNode;
  private tone: BiquadFilterNode;
  private roar: GainNode;
  private ducker: GainNode; // sidechain: huge impacts punch a hole in the crowd bed
  private excitement = CROWD_BASE;
  private retarget = 0;

  constructor(private e: AudioEngine) {
    const ctx = e.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 1200;
    this.ducker = ctx.createGain();
    this.bus.connect(this.tone).connect(this.ducker).connect(e.master);
    const send = ctx.createGain();
    send.gain.value = 0.6;
    this.ducker.connect(send).connect(e.reverbSend);
    for (let i = 0; i < CROWD_VOICES; i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 280 + Math.random() * 1800;
      bp.Q.value = 1.1 + Math.random();
      const g = ctx.createGain();
      g.gain.value = 0;
      const p = ctx.createStereoPanner();
      p.pan.value = (i / (CROWD_VOICES - 1)) * 1.6 - 0.8;
      e.noiseSource(true, Math.random() * 3).connect(bp).connect(g).connect(p).connect(this.bus);
      this.layers.push({ gain: g, base: 0.5 + Math.random() * 0.5 });
    }
    const roarBp = ctx.createBiquadFilter();
    roarBp.type = 'bandpass';
    roarBp.frequency.value = 1100;
    roarBp.Q.value = 0.6;
    this.roar = ctx.createGain();
    this.roar.gain.value = 0;
    e.noiseSource(true, 1.3).connect(roarBp).connect(this.roar).connect(this.bus);
  }

  /** Raise excitement (0..1 added). A KO is ~1, a big hit ~0.35. */
  swell(amount: number): void {
    this.excitement = Math.min(1, this.excitement + amount);
  }

  /** Duck the bed by `depth` (0..1) for a beat, so a huge hit lands in a moment of relative quiet. */
  duck(depth: number, at = this.e.now): void {
    const g = this.ducker.gain;
    const floor = 1 - Math.max(0, Math.min(0.85, depth));
    g.cancelScheduledValues(at);
    g.setTargetAtTime(floor, at, 0.008); // ~25 ms attack
    g.setTargetAtTime(1, at + 0.09, 0.28); // then breathe back over ~0.8 s
  }

  update(dt: number): void {
    const t = this.e.now;
    this.excitement += (CROWD_BASE - this.excitement) * (1 - Math.exp(-dt / CROWD_DECAY_S));
    const x = this.excitement;
    this.bus.gain.setTargetAtTime(0.08 + x * 0.5, t, 0.15);
    this.tone.frequency.setTargetAtTime(900 + x * 3600, t, 0.2);
    this.roar.gain.setTargetAtTime(x * x * 0.55, t, 0.2);
    this.retarget -= dt;
    if (this.retarget > 0) return;
    this.retarget = CROWD_RETARGET_S;
    for (const l of this.layers) {
      const syllable = Math.random() < 0.35 ? 0.2 : 1; // gaps between voices read as murmur
      l.gain.gain.setTargetAtTime(l.base * syllable * (0.25 + Math.random() * 0.2), t, 0.05);
    }
  }
}
