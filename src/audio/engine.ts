import { onSettingsChange, settings } from '../core/settings';
// WebAudio graph shared by every sound: master bus → glue compressor → peak limiter → a hard
// soft-knee ceiling at -1 dBFS, an arena reverb (procedural impulse response), a noise buffer
// and a voice budget so a flurry of hits can't pile up hundreds of nodes.

const REVERB_S = 2.2;
const NOISE_S = 3;
const MAX_VOICES = 24;
const MASTER_GAIN = 0.65; // the glue compressor's automatic makeup gain brings this back up
/** Output ceiling: nothing leaves the engine louder than -1 dBFS, however many hits stack up. */
export const CEILING = Math.pow(10, -1.2 / 20);
const CLIP_KNEE = 0.62; // the ceiling curve is linear below this, then bends smoothly into CEILING
const CLIP_CURVE_N = 4096;

export interface EngineOptions {
  /** Live contexts follow the SOUND setting unless this is false (the audio harness). */
  followSettings?: boolean;
}

export class AudioEngine {
  readonly ctx: BaseAudioContext;
  readonly master: GainNode; // everything dry goes here
  readonly reverbSend: GainNode; // and a share of it here
  readonly noise: AudioBuffer;
  private voiceEnds: number[] = []; // context times at which claimed voices free up
  private muted = false;

  /** Pass an OfflineAudioContext to render sounds for tests; defaults to a live context. */
  constructor(ctx?: BaseAudioContext, opts: EngineOptions = {}) {
    this.ctx = ctx ?? new AudioContext({ latencyHint: 'interactive' });
    // Glue: gentle and wide, so a haymaker still towers over a jab (hits carry ~30 dB of range).
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 18;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.005;
    comp.release.value = 0.3;
    // Peak limiter: transparent until the top, fast and hard there.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    // Ceiling: a waveshaper clamps its input to [-1, 1] and maps it through the curve, so the
    // output can never exceed CEILING even if both compressors are overrun.
    const ceiling = this.ctx.createWaveShaper();
    ceiling.curve = ceilingCurve();
    ceiling.oversample = 'none';
    this.master = this.ctx.createGain();
    // Live audio follows the SOUND setting (off by default); offline test renders always play.
    const follow = !ctx && opts.followSettings !== false;
    this.muted = follow && !settings().soundOn;
    this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
    this.master.connect(comp).connect(limiter).connect(ceiling).connect(this.ctx.destination);
    if (follow) onSettingsChange((next) => this.setMuted(!next.soundOn));

    const reverb = this.ctx.createConvolver();
    reverb.buffer = this.impulse(REVERB_S);
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.9;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.32;
    this.reverbSend.connect(reverb).connect(wet).connect(this.master);

    this.noise = this.whiteNoise(NOISE_S);
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  async resume(): Promise<void> {
    if (this.ctx instanceof AudioContext && this.ctx.state !== 'running') await this.ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.master.gain.setTargetAtTime(muted ? 0 : MASTER_GAIN, this.now, 0.05);
  }

  isMuted(): boolean {
    return this.muted;
  }

  /**
   * Reserve a voice for `seconds` of audio time from `at`. Returns false when the budget is spent
   * (skip the sound). Counted in context time, so offline renders and throttled tabs agree.
   */
  claimVoice(seconds: number, force = false, at = this.now): boolean {
    const now = this.now;
    this.voiceEnds = this.voiceEnds.filter((end) => end > now);
    if (!force && this.voiceEnds.length >= MAX_VOICES) return false;
    this.voiceEnds.push(at + seconds + 0.05);
    return true;
  }

  /** Output node for a one-shot at stereo position `pan` (-1..1) with a reverb share. */
  output(pan: number, reverb: number): AudioNode {
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.master);
    if (reverb > 0) {
      const send = this.ctx.createGain();
      send.gain.value = reverb;
      p.connect(send).connect(this.reverbSend);
    }
    return p;
  }

  noiseSource(loop = false, offset = 0, at = this.now): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = loop;
    if (loop) src.loopStart = 0;
    src.start(at, offset % NOISE_S);
    return src;
  }

  private whiteNoise(seconds: number): AudioBuffer {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Stereo decaying noise with a darkening tail: a big concrete-and-steel hall. */
  private impulse(seconds: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const n = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, n, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const env = Math.pow(1 - t, 2.6) * (i < rate * 0.012 ? i / (rate * 0.012) : 1);
        const k = 0.9 - 0.75 * t; // one-pole low-pass that closes over the tail
        lp = lp * (1 - k) + (Math.random() * 2 - 1) * k;
        d[i] = lp * env;
      }
    }
    return buf;
  }
}

/** Identity below CLIP_KNEE, then a tanh bend that reaches CEILING exactly at |x| = 1. */
function ceilingCurve(): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(CLIP_CURVE_N);
  const room = CEILING - CLIP_KNEE;
  const span = 1 - CLIP_KNEE;
  const norm = Math.tanh(span / room);
  for (let i = 0; i < CLIP_CURVE_N; i++) {
    const x = (i / (CLIP_CURVE_N - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= CLIP_KNEE ? a : CLIP_KNEE + (room * Math.tanh((a - CLIP_KNEE) / room)) / norm;
    curve[i] = Math.sign(x) * Math.min(CEILING, y);
  }
  return curve;
}
