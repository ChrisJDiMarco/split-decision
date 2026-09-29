import { onSettingsChange, settings } from '../core/settings';
// WebAudio graph shared by every procedural sound: master bus with a limiter-ish
// compressor, an arena reverb (procedural impulse response), a noise buffer and a
// voice budget so a flurry of hits can't pile up hundreds of nodes.

const REVERB_S = 2.2;
const NOISE_S = 3;
const MAX_VOICES = 18;
const MASTER_GAIN = 0.8;

export class AudioEngine {
  readonly ctx: BaseAudioContext;
  readonly master: GainNode; // everything dry goes here
  readonly reverbSend: GainNode; // and a share of it here
  readonly noise: AudioBuffer;
  private voices = 0;
  private muted = false;

  /** Pass an OfflineAudioContext to render sounds for tests; defaults to a live context. */
  constructor(ctx?: BaseAudioContext) {
    this.ctx = ctx ?? new AudioContext({ latencyHint: 'interactive' });
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 8;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    this.master = this.ctx.createGain();
    // Live audio follows the SOUND setting (off by default); offline test renders always play.
    this.muted = !ctx && !settings().soundOn;
    this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
    this.master.connect(comp).connect(this.ctx.destination);
    if (!ctx) onSettingsChange((next) => this.setMuted(!next.soundOn));

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

  /** Reserve a voice for `seconds`. Returns false when the budget is spent (skip the sound). */
  claimVoice(seconds: number, force = false): boolean {
    if (!force && this.voices >= MAX_VOICES) return false;
    this.voices++;
    setTimeout(() => { this.voices--; }, Math.ceil(seconds * 1000) + 50);
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

  noiseSource(loop = false, offset = 0): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = loop;
    if (loop) src.loopStart = 0;
    src.start(this.now, offset % NOISE_S);
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
