// Recorded impact samples (Kenney "Impact Sounds", CC0, public/assets/audio/kenney/). Loaded
// lazily on the first user-gesture start with fetch + decodeAudioData; until a group has
// decoded (or if a file is missing) pick() returns null and callers fall back to synthesis.

/** Sample groups by role → file stem in the pack. Each stem has variants _000 .. _004. */
export const SAMPLE_GROUPS = {
  metalHeavy: 'impactMetal_heavy',
  metalMedium: 'impactMetal_medium',
  metalLight: 'impactMetal_light',
  plateHeavy: 'impactPlate_heavy',
  plateMedium: 'impactPlate_medium',
  plateLight: 'impactPlate_light',
  bell: 'impactBell_heavy',
  punchHeavy: 'impactPunch_heavy',
  punchMedium: 'impactPunch_medium',
  softHeavy: 'impactSoft_heavy',
  softMedium: 'impactSoft_medium',
  tin: 'impactTin_medium',
  crack: 'impactMining',
  footstep: 'footstep_concrete',
} as const;

export type SampleGroup = keyof typeof SAMPLE_GROUPS;
export const VARIANTS = 5;

export interface Sample {
  buffer: AudioBuffer;
  /** Linear gain that brings this variant's peak to 1, so variants swap without level jumps. */
  norm: number;
  variant: number;
}

export interface Pick { group: SampleGroup; variant: number }

type Fetcher = (url: string) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;

function defaultBase(): string {
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `${base}assets/audio/kenney/`;
}

export class SampleBank {
  private samples = new Map<SampleGroup, Sample[]>();
  private last = new Map<SampleGroup, number>();
  private loading: Promise<void> | null = null;
  private failures = 0;
  /** When set, every pick is recorded (tests and the audition harness read it). */
  trace: Pick[] | null = null;

  constructor(readonly baseUrl = defaultBase()) {}

  get loaded(): number {
    let n = 0;
    for (const list of this.samples.values()) n += list.length;
    return n;
  }

  get total(): number {
    return Object.keys(SAMPLE_GROUPS).length * VARIANTS;
  }

  /** Fetch and decode every variant; safe to call repeatedly. Missing files are skipped, not fatal. */
  load(ctx: BaseAudioContext, fetcher: Fetcher = (u) => fetch(u)): Promise<void> {
    if (!this.loading) this.loading = this.loadAll(ctx, fetcher);
    return this.loading;
  }

  /** Forget which variant each group played last (tests start every render from the same state). */
  resetRotation(): void {
    this.last.clear();
  }

  has(group: SampleGroup): boolean {
    return (this.samples.get(group)?.length ?? 0) > 0;
  }

  /** A random variant of `group`, never the one it played last (so rapid exchanges don't machine-gun). */
  pick(group: SampleGroup, rng: () => number = Math.random): Sample | null {
    const list = this.samples.get(group);
    if (!list?.length) return null;
    const prev = this.last.get(group);
    let i = Math.floor(rng() * list.length) % list.length;
    if (list.length > 1 && list[i].variant === prev) {
      i = (i + 1 + Math.floor(rng() * (list.length - 1))) % list.length;
    }
    const s = list[i];
    this.last.set(group, s.variant);
    this.trace?.push({ group, variant: s.variant });
    return s;
  }

  private async loadAll(ctx: BaseAudioContext, fetcher: Fetcher): Promise<void> {
    const jobs: Array<Promise<void>> = [];
    for (const [group, stem] of Object.entries(SAMPLE_GROUPS) as Array<[SampleGroup, string]>) {
      for (let v = 0; v < VARIANTS; v++) jobs.push(this.loadOne(ctx, fetcher, group, stem, v));
    }
    await Promise.all(jobs);
    if (this.failures) console.warn(`[audio] ${this.failures} impact samples unavailable; synthesis covers them`);
  }

  private async loadOne(ctx: BaseAudioContext, fetcher: Fetcher, group: SampleGroup, stem: string, v: number): Promise<void> {
    const url = `${this.baseUrl}${stem}_${String(v).padStart(3, '0')}.ogg`;
    try {
      const res = await fetcher(url);
      if (!res.ok) throw new Error(`HTTP error for ${url}`);
      const buffer = monoIfDual(ctx, await ctx.decodeAudioData(await res.arrayBuffer()));
      const list = this.samples.get(group) ?? [];
      // Replace, don't mutate: pick() may be iterating the old list in the same task.
      this.samples.set(group, [...list, { buffer, norm: 1 / Math.max(1e-4, peakOf(buffer)), variant: v }]
        .sort((a, b) => a.variant - b.variant));
    } catch {
      this.failures++;
    }
  }
}

/** The pack is dual-mono stereo (L == R): keep one channel, half the memory. Hit buses are mono anyway (foley.ts). */
function monoIfDual(ctx: BaseAudioContext, b: AudioBuffer): AudioBuffer {
  if (b.numberOfChannels < 2) return b;
  const left = b.getChannelData(0);
  for (let ch = 1; ch < b.numberOfChannels; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i] - left[i]) > 1e-6) return b;
  }
  const mono = ctx.createBuffer(1, b.length, b.sampleRate);
  mono.copyToChannel(left, 0);
  return mono;
}

function peakOf(buffer: AudioBuffer): number {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}
