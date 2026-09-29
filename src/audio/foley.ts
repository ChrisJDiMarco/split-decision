// Realistic fight foley: each contact is a layered one-shot built from what actually touched what.
// Recorded Kenney impacts (samples.ts) carry the realism; the modal synthesis in sounds.ts tunes
// the ring to the struck part and covers any sample that hasn't loaded. Everything is physical:
// bigger robots pitch down, harder hits get louder AND brighter (log curve), variants rotate with
// small pitch/time jitter, and each hit is panned, distance-filtered and sent to the arena reverb.
import type { MaterialId } from '../core/types';
import type { AudioEngine } from './engine';
import type { SampleBank, SampleGroup } from './samples';
import { boom, cageRattle, clang, grind, powerDown, servoEffort, sizePitch, tear, thud, thump } from './sounds';

// ---------------------------------------------------------------- physical mapping (pure)

export type HitKind = 'bare' | 'kick' | 'glove' | 'composite';

/** Reference build: a 70 kg robot plays the samples at their recorded pitch. */
export const REF_KG = 70;
const METALLIC: ReadonlySet<MaterialId> = new Set<MaterialId>(['ar500', 'steel', 'ti6al4v', 'al7075', 'al6061']);
/** Victim parts a kick lands on (a punch to the legs is rare): the heavier shin-on-plate layers. */
const LOW_PART = /thigh|shin|leg|knee|foot|pelvis/;
const HEAVY_LEVEL = 0.66; // ~250 J and up: a committed power shot
const MEDIUM_LEVEL = 0.4; // ~40 J and up
/** Impact energies span ~2 J (a graze) to ~3000 J (a knockoff haymaker); the level is log energy over that. */
const LEVEL_MIN_LOG = 0.3;
const LEVEL_SPAN_LOG = 3.2;
/** dB of range across the level: 32 dB over 3.2 decades is pressure ∝ √energy. */
const DYNAMIC_DB = 32;

/**
 * Size → pitch. Plate and shell modes scale with 1/length and length with mass^(1/3), so a 105 kg
 * robot rings ~0.87× and a 38 kg one ~1.23× the reference.
 */
export function massPitch(kg: number): number {
  return Math.max(0.62, Math.min(1.45, Math.cbrt(REF_KG / Math.max(1, kg))));
}

/** 0..1 level for an impact of `energyJ` joules: log energy, like hearing. */
export function impactLevel(energyJ: number): number {
  return Math.max(0.03, Math.min(1, (Math.log10(Math.max(1, energyJ)) - LEVEL_MIN_LOG) / LEVEL_SPAN_LOG));
}

/** Linear gain for a 0..1 level: DYNAMIC_DB of range, so sound pressure goes as √energy. */
export function hitGain(level: number): number {
  return Math.pow(10, ((Math.max(0, Math.min(1, level)) - 1) * DYNAMIC_DB) / 20);
}

/** Low-pass cutoff for a 0..1 level: soft contacts are dull, big hits open right up. */
export function brightness(level: number): number {
  return Math.min(18000, 900 * Math.pow(2, Math.max(0, Math.min(1, level)) * 4.2));
}

/** High-shelf (dB above 3.5 kHz) for a 0..1 level: a hard strike excites the plate's high modes. */
export function crackDb(level: number): number {
  return Math.max(-6, Math.min(8, (Math.max(0, Math.min(1, level)) - 0.55) * 18));
}

export function isMetallic(m: MaterialId): boolean {
  return METALLIC.has(m);
}

export function tier(level: number): 'heavy' | 'medium' | 'light' {
  return level >= HEAVY_LEVEL ? 'heavy' : level >= MEDIUM_LEVEL ? 'medium' : 'light';
}

/**
 * What kind of strike landed. The event names the victim part and whether both surfaces are
 * spark-throwing metal; the striker's gloves come from its fist material. A glove guard is padding
 * whatever lands on it. Legs take kicks: the `metal` flag can't tell a glove from a kick there,
 * because aluminium thighs never spark and the gloved designs' composite shins never do either.
 */
export function classifyStrike(o: { metal: boolean; part: string | null; victimMaterial: MaterialId; strikerGloved: boolean }): HitKind {
  if (o.victimMaterial === 'glove') return 'glove';
  const low = !!o.part && LOW_PART.test(o.part);
  if (!isMetallic(o.victimMaterial)) return o.strikerGloved && !low ? 'glove' : 'composite';
  if (low) return 'kick';
  if (o.strikerGloved && !o.metal) return 'glove';
  return 'bare';
}

// ---------------------------------------------------------------- playback

/** Where the listener hears a sound from, and how fast the world is running (replays < 1). */
export interface Placement {
  pan: number; // -1..1
  distance: number; // metres from the camera
  rate: number; // 1 live, < 1 slow-motion replay (lower pitch, longer)
  at?: number; // context time (default now)
}

export interface HitParams extends Placement {
  kind: HitKind;
  energyJ: number;
  part: string | null; // struck part
  material: MaterialId; // struck part's surface
  massKg: number; // effective size of the pair, for pitch
}

interface Layer {
  group: SampleGroup;
  gain: number;
  pitch?: number; // on top of the hit's pitch
  lowpass?: number;
  delay?: number; // seconds after the hit
}

const DIST_REF_M = 4.5;
/** An equal-power panner sends a centred mono source -3 dB to each side: this restores unity. */
const MONO_CENTRE = Math.SQRT2;
const MASTER_HIT = 0.8; // a full-energy layered hit reaches the limiter; a 100 J shot sits ~10 dB over the crowd
/** Padding stretches the contact out and lowers peak force: a glove lands quieter than bare metal at equal energy. */
const GLOVE_GAIN = 0.75;
const PITCH_JITTER = 0.035;
const TIME_JITTER_S = 0.006;
const GAIN_JITTER_DB = 1.5;
const DUCK_ENERGY_J = 300;
const MAX_SAMPLE_S = 1.8;
const DEBRIS_LIFT = 1.8;
const SHELF_HZ = 3500;

type Hooks = { duck?: (depth: number, at: number) => void };

export class Foley {
  constructor(private e: AudioEngine, private bank: SampleBank, private hooks: Hooks = {}) {}

  /** A strike between the two robots. */
  hit(p: HitParams): void {
    const level = impactLevel(p.energyJ);
    const at = p.at ?? this.e.now;
    if (!this.e.claimVoice(1.4 / p.rate, level > 0.8, at)) return;
    const pitch = massPitch(p.massKg) * Math.pow(sizePitch(p.part), 0.3);
    const bus = this.bus(p, 0.22 + level * 0.45);
    const gain = hitGain(level) * MASTER_HIT * (p.kind === 'glove' ? GLOVE_GAIN : 1);
    const bright = brightness(level) * pitch; // bandwidth follows size, like the modes
    const t = tier(level);
    const layers = STRIKE_LAYERS[p.kind][t];
    const sampled = this.layers(bus, layers, { at, rate: p.rate, pitch, gain, lowpass: bright, shelfDb: crackDb(level) });
    switch (p.kind) {
      case 'bare':
      case 'kick':
        // The modal ring tuned to the struck part: this is what makes a head sound like a head.
        clang(this.e, { material: p.material, part: p.part, level: level * (sampled ? 0.5 : 1), pan: p.pan, rate: p.rate, at, pitch: massPitch(p.massKg), out: bus });
        if (p.kind === 'kick') thump(this.e, bus, level * 0.6, 80 * pitch * p.rate, 0.16 / p.rate, at);
        break;
      case 'glove':
        if (!sampled) thud(this.e, level * 0.8, p.pan, false, at, pitch);
        break;
      case 'composite':
        clang(this.e, { material: p.material, part: p.part, level: level * 0.7, pan: p.pan, rate: p.rate, at, pitch, out: bus });
        if (!sampled) thud(this.e, level * 0.7, p.pan, false, at, pitch);
        break;
    }
    if (p.energyJ > DUCK_ENERGY_J) this.hooks.duck?.(Math.min(0.6, 0.2 + level * 0.4), at);
  }

  /** A robot part slamming the canvas (the mat over a steel deck). */
  canvas(energyJ: number, massKg: number, where: Placement): void {
    const level = impactLevel(energyJ);
    const at = where.at ?? this.e.now;
    if (!this.e.claimVoice(1 / where.rate, false, at)) return;
    const pitch = massPitch(massKg);
    const bus = this.bus(where, 0.25 + level * 0.3);
    const gain = hitGain(level) * MASTER_HIT;
    const plate: SampleGroup = level >= HEAVY_LEVEL ? 'plateHeavy' : level >= MEDIUM_LEVEL ? 'plateMedium' : 'plateLight';
    const sampled = this.layers(bus, [{ group: plate, gain: 0.8, lowpass: 3200 }, { group: 'softHeavy', gain: 0.7 }],
      { at, rate: where.rate, pitch, gain, lowpass: brightness(level) });
    boom(this.e, bus, level * 0.7, pitch, where.rate, at);
    if (!sampled) thud(this.e, level, where.pan, level > 0.6, at, pitch);
  }

  /** A whole robot going down: plate crash, mat slap, a boom from the deck, loose bits settling. */
  fall(massKg: number, speedMs: number, where: Placement): void {
    const at = where.at ?? this.e.now;
    const energyJ = 0.25 * massKg * speedMs * speedMs; // about half the body's KE goes into one slam
    const level = Math.max(0.5, impactLevel(energyJ));
    if (!this.e.claimVoice(1.6 / where.rate, true, at)) return;
    const pitch = massPitch(massKg);
    const bus = this.bus(where, 0.45 + level * 0.3);
    const gain = hitGain(level) * MASTER_HIT;
    const sampled = this.layers(bus, [
      { group: 'plateHeavy', gain: 1, lowpass: 4200 },
      { group: 'softHeavy', gain: 0.9 },
      { group: 'metalLight', gain: 0.3, pitch: 1.3, delay: 0.07 + Math.random() * 0.05 },
      { group: 'tin', gain: 0.22, pitch: 1.2, delay: 0.16 + Math.random() * 0.08 },
    ], { at, rate: where.rate, pitch, gain, lowpass: brightness(level) });
    boom(this.e, bus, level, pitch, where.rate, at);
    if (!sampled) thud(this.e, 1, where.pan, true, at, pitch);
    this.hooks.duck?.(0.45, at);
  }

  /** A robot driven into the chain-link: tin jingles rattling along the fence, a clank from the post. */
  fence(speedMs: number, where: Placement): void {
    const level = Math.max(0.1, Math.min(1, speedMs / 5));
    const at = where.at ?? this.e.now;
    if (!this.e.claimVoice(0.9 / where.rate, false, at)) return;
    const bus = this.bus(where, 0.5);
    const gain = hitGain(level) * MASTER_HIT;
    const n = 3 + Math.round(level * 4);
    const rattle: Layer[] = [];
    let delay = 0;
    for (let i = 0; i < n; i++) {
      rattle.push({ group: 'tin', gain: 0.85 * Math.pow(0.72, i), pitch: 1.05 + Math.random() * 0.45, lowpass: 12000, delay });
      delay += 0.028 + Math.random() * 0.03;
    }
    if (level > 0.5) rattle.push({ group: 'plateLight', gain: 0.45, pitch: 0.9 });
    const sampled = this.layers(bus, rattle, { at, rate: where.rate, pitch: 1, gain, lowpass: 16000 });
    cageRattle(this.e, level * (sampled ? 0.45 : 1), where.pan, at);
  }

  /** A loose piece bouncing: small, bright ticks. `size` is the part's pitch factor (sizePitch). */
  debris(energyJ: number, size: number, where: Placement): void {
    const level = impactLevel(energyJ);
    const at = where.at ?? this.e.now;
    if (!this.e.claimVoice(0.6 / where.rate, false, at)) return;
    const bus = this.bus(where, 0.3);
    const group: SampleGroup = Math.random() < 0.5 ? 'tin' : 'metalLight';
    const pitch = Math.pow(size, 0.4) * (1.15 + Math.random() * 0.3);
    // Ticks are tiny but carry the clatter: lift them over the √E curve so they read under a brawl.
    const sampled = this.layers(bus, [{ group, gain: DEBRIS_LIFT }], { at, rate: where.rate, pitch, gain: hitGain(level) * MASTER_HIT, lowpass: Math.max(6000, brightness(level)) });
    clang(this.e, { material: 'steel', part: 'fist', level: level * (sampled ? 0.2 : 0.6), pan: where.pan, rate: where.rate, at, out: bus });
  }

  /** A foot landing on the canvas, pitched and weighted by the robot's mass. */
  footstep(level: number, massKg: number, where: Placement): void {
    const at = where.at ?? this.e.now;
    if (!this.e.claimVoice(0.35 / where.rate, false, at)) return;
    const pitch = Math.pow(massPitch(massKg), 1.3) * 0.8;
    const weight = 0.45 + 0.55 * Math.min(1, massKg / 100);
    const bus = this.bus(where, 0.12);
    const sampled = this.layers(bus, [{ group: 'footstep', gain: 1 }], { at, rate: where.rate, pitch, gain: level * weight * MASTER_HIT, lowpass: 1800 + 2600 * level });
    thud(this.e, level * (sampled ? 0.5 : 1), where.pan, false, at, massPitch(massKg));
  }

  /** A part ripped off: a big layered crack, a ringing shell, the tear, and the piece clattering away. */
  detach(part: string, material: MaterialId, massKg: number, where: Placement): void {
    const at = where.at ?? this.e.now;
    const head = /head/.test(part);
    if (!this.e.claimVoice(2.2 / where.rate, true, at)) return;
    const pitch = massPitch(massKg);
    const bus = this.bus(where, 0.7);
    const gain = MASTER_HIT;
    const layers: Layer[] = head
      ? [{ group: 'crack', gain: 1, pitch: 0.9 }, { group: 'metalHeavy', gain: 1 }, { group: 'plateHeavy', gain: 0.8 }, { group: 'bell', gain: 0.55, pitch: 0.78 }]
      : [{ group: 'crack', gain: 0.8 }, { group: 'metalMedium', gain: 0.8 }, { group: 'plateMedium', gain: 0.5 }];
    // Bouncing clatter: each bounce lower and sooner than the last.
    let delay = 0.26 + Math.random() * 0.06;
    let gap = head ? 0.26 : 0.2;
    for (let i = 0; i < (head ? 7 : 4); i++) {
      layers.push({ group: i % 2 ? 'tin' : 'metalLight', gain: 0.5 * Math.pow(0.72, i), pitch: 1.25 + Math.random() * 0.3, delay });
      delay += gap * (0.85 + Math.random() * 0.3);
      gap *= 0.72;
    }
    const sampled = this.layers(bus, layers, { at, rate: where.rate, pitch, gain, lowpass: 18000 });
    tear(this.e, sampled ? 0.7 : 1, where.pan, where.rate, at);
    clang(this.e, { material: head ? 'ti6al4v' : material, part, level: sampled ? 0.7 : 1, pan: where.pan, rate: where.rate, at, pitch, out: bus });
    this.hooks.duck?.(head ? 0.7 : 0.45, at);
  }

  /** Straining back up: servos and hydraulics pushing, a foot planting, a scuff on the mat. */
  getup(massKg: number, where: Placement): void {
    const at = where.at ?? this.e.now;
    servoEffort(this.e, where.pan, massPitch(massKg), where.rate, at);
    this.footstep(0.6, massKg, { ...where, at: at + 0.32 / where.rate });
    const bus = this.bus(where, 0.1);
    this.layers(bus, [{ group: 'softMedium', gain: 0.5, lowpass: 2500 }], { at, rate: where.rate, pitch: massPitch(massKg), gain: 0.4 * MASTER_HIT, lowpass: 2500 });
  }

  /** Knocked out: the loser's servos spin down. */
  ko(massKg: number, where: Placement): void {
    powerDown(this.e, where.pan, massPitch(massKg), where.rate, where.at ?? this.e.now);
  }

  /** A joint failing: grinding gears, and a hard clack when it seizes solid. */
  joint(seized: boolean, level: number, where: Placement): void {
    const at = where.at ?? this.e.now;
    grind(this.e, level, where.pan, at);
    if (!seized) return;
    const bus = this.bus(where, 0.2);
    this.layers(bus, [{ group: 'metalLight', gain: 0.5, pitch: 1.3 }], { at, rate: where.rate, pitch: 1, gain: 0.5 * MASTER_HIT, lowpass: 9000 });
  }

  // ---------------------------------------------------------------- plumbing

  /**
   * Per-hit output: distance gain and air absorption → pan → master, plus the arena reverb send.
   * The bus is mono so the panner pans every layer at constant power (a stereo input gets folded
   * into one side, +3 dB at the edges), and √2 puts a centred hit at unity on each side.
   */
  private bus(where: Placement, reverb: number): AudioNode {
    const ctx = this.e.ctx;
    const d = Math.max(0.5, where.distance);
    const near = DIST_REF_M / d;
    const g = ctx.createGain();
    g.channelCount = 1;
    g.channelCountMode = 'explicit';
    g.gain.value = MONO_CENTRE * Math.max(0.35, Math.min(1.15, Math.pow(near, 0.8)));
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = Math.max(4000, Math.min(20000, 20000 * Math.pow(near, 0.7)));
    const out = this.e.output(where.pan, Math.min(1, reverb + Math.max(0, Math.min(0.3, (d - DIST_REF_M) * 0.04))));
    g.connect(air).connect(out);
    return g;
  }

  /** Plays each layer that has a sample. Returns false when none did (caller synthesizes instead). */
  private layers(bus: AudioNode, layers: readonly Layer[], o: { at: number; rate: number; pitch: number; gain: number; lowpass: number; shelfDb?: number }): boolean {
    let any = false;
    let input = bus;
    if (o.shelfDb) {
      const shelf = this.e.ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = SHELF_HZ;
      shelf.gain.value = o.shelfDb;
      shelf.connect(bus);
      input = shelf;
    }
    for (const l of layers) {
      const s = this.bank.pick(l.group);
      if (!s) continue;
      any = true;
      const ctx = this.e.ctx;
      const src = ctx.createBufferSource();
      src.buffer = s.buffer;
      src.playbackRate.value = o.rate * o.pitch * (l.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * PITCH_JITTER);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.min(o.lowpass, l.lowpass ?? Infinity);
      lp.Q.value = 0.5;
      const g = ctx.createGain();
      const jitterDb = (Math.random() * 2 - 1) * GAIN_JITTER_DB;
      g.gain.value = o.gain * l.gain * s.norm * Math.pow(10, jitterDb / 20);
      src.connect(lp).connect(g).connect(input);
      const start = o.at + ((l.delay ?? 0) + Math.random() * TIME_JITTER_S) / o.rate;
      src.start(start);
      src.stop(start + MAX_SAMPLE_S / o.rate);
    }
    return any;
  }
}

/** Which recorded layers make each strike, by how hard it landed. */
const STRIKE_LAYERS: Record<HitKind, Record<'heavy' | 'medium' | 'light', Layer[]>> = {
  // Bare knuckle plate on armour: the steel crack plus the plate body ringing under it.
  bare: {
    heavy: [{ group: 'metalHeavy', gain: 1 }, { group: 'plateHeavy', gain: 0.7 }],
    medium: [{ group: 'metalMedium', gain: 0.9 }, { group: 'plateMedium', gain: 0.55 }],
    light: [{ group: 'metalLight', gain: 0.75 }, { group: 'plateLight', gain: 0.4 }],
  },
  // Shin on plate: more body, lower.
  kick: {
    heavy: [{ group: 'plateHeavy', gain: 1, pitch: 0.92 }, { group: 'metalHeavy', gain: 0.8, pitch: 0.92 }],
    medium: [{ group: 'plateHeavy', gain: 0.8, pitch: 0.95 }, { group: 'metalMedium', gain: 0.7 }],
    light: [{ group: 'plateMedium', gain: 0.7 }, { group: 'metalLight', gain: 0.5 }],
  },
  // Leather and foam: a punch-bag thwack, a soft body thud and only a muffled knock of the metal under it.
  glove: {
    heavy: [{ group: 'punchHeavy', gain: 1, lowpass: 5500 }, { group: 'softHeavy', gain: 0.55, lowpass: 3000 }, { group: 'metalLight', gain: 0.16, pitch: 0.8, lowpass: 900 }],
    medium: [{ group: 'punchMedium', gain: 1, lowpass: 4500 }, { group: 'softMedium', gain: 0.5, lowpass: 3000 }, { group: 'metalLight', gain: 0.12, pitch: 0.8, lowpass: 800 }],
    light: [{ group: 'punchMedium', gain: 0.8, lowpass: 3500 }, { group: 'softMedium', gain: 0.45, lowpass: 2500 }],
  },
  // Metal on carbon / polycarbonate: a dull composite knock.
  composite: {
    heavy: [{ group: 'punchHeavy', gain: 0.75, lowpass: 5000 }, { group: 'plateMedium', gain: 0.35, lowpass: 2500 }],
    medium: [{ group: 'punchMedium', gain: 0.7, lowpass: 4000 }, { group: 'plateLight', gain: 0.3, lowpass: 2500 }],
    light: [{ group: 'punchMedium', gain: 0.6, lowpass: 3500 }],
  },
};
