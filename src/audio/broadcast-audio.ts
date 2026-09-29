// Maps the fight to sound: events → layered impact foley (recorded metal + modal synthesis),
// tears and crowd swells; telemetry and poses → servo whine, hydraulic hiss and footfalls.
// Created on a user gesture; the impact samples load lazily once sound is on (start or unmute).
import { onSettingsChange, settings } from '../core/settings';
import type { RobotTelemetry, SimEvent } from '../core/protocol';
import type { Corner, MaterialId, Vec3 } from '../core/types';
import { AudioEngine } from './engine';
import { classifyStrike, Foley, type Placement } from './foley';
import { Crowd, HydraulicHiss, ServoWhine } from './loops';
import { SampleBank } from './samples';
import { bell, sizePitch } from './sounds';

export interface AudioScene {
  pan(p: Vec3): number; // physics-frame point → stereo -1..1
  material(corner: Corner, part: string | null): MaterialId;
  massKg: [number, number];
  /** Bodies whose touchdowns are footfalls, plus bodies that drive the servo-speed estimate. */
  feet: Array<{ corner: Corner; body: number }>;
  limbs: Array<{ corner: Corner; body: number }>;
  roots: [number, number];
  /** Metres from the camera to a physics-frame point. Without it, distance is estimated from the fighters. */
  distance?(p: Vec3): number;
}

export interface BroadcastAudioOptions {
  /** Render into this context (an OfflineAudioContext in tests) instead of a live one. */
  ctx?: BaseAudioContext;
  /** Live audio follows the SOUND setting unless this is false (the audition harness). */
  followSettings?: boolean;
  bank?: SampleBank;
}

const FOOT = {
  CONTACT_MARGIN_M: 0.03,
  MIN_DOWN_SPEED: 0.25, // m/s at touchdown
  COOLDOWN_S: 0.18,
  LEVEL_PER_KG_MS: 1 / 420,
} as const;
const LIMB_FULL_SPEED = 6; // m/s relative to the root = full servo scream
const LEAK_EPS = 1e-3;
/** A jump in displayed sim time bigger than this (a replay starting or ending) is a cut, not motion. */
const MOTION_CUT_S = 0.25;
/** Camera distance when the scene can't say: the broadcast shots sit about this far off the action. */
const NOMINAL_CAM_M = 4.5;
const DEFAULT_FALL_SPEED = 2.2; // m/s, when no poses have been seen yet
const FALL_SPEED_MEMORY_S = 0.6;
const CAGE_MATCH_M = 0.08; // an impact this close to a same-batch cage event is the fence contact
const FOOTFALL_MAX_J = 50; // lighter foot-on-canvas impacts are footfalls, voiced from the poses
const SWELL_HIT_J = 150;

interface FootState { minZ: number; prevZ: number; cooldown: number }

export class BroadcastAudio {
  private engine: AudioEngine | null = null;
  private foley: Foley | null = null;
  private crowd: Crowd | null = null;
  private whine: ServoWhine[] = [];
  private hiss: HydraulicHiss[] = [];
  private scene: AudioScene | null = null;
  private feet = new Map<number, FootState>();
  private prevPoses: Float32Array | null = null;
  private lastPoseTime: number | null = null;
  private poseWallS = 0; // wall time since the displayed poses last changed
  private rootPos: [Vec3 | null, Vec3 | null] = [null, null];
  private fallSpeed: [number, number] = [0, 0]; // recent peak downward root speed, m/s
  private detached: [Set<string>, Set<string>] = [new Set(), new Set()];
  private samplesLoading: Promise<void> | null = null;
  readonly bank: SampleBank;
  private readonly follow: boolean;
  // Follows the SOUND setting (off by default); M toggles it for the session.
  private muted: boolean;
  readonly unsubscribeSettings: () => void;

  constructor(private readonly opts: BroadcastAudioOptions = {}) {
    this.bank = opts.bank ?? new SampleBank();
    this.follow = !opts.ctx && opts.followSettings !== false;
    this.muted = this.follow && !settings().soundOn;
    this.unsubscribeSettings = this.follow ? onSettingsChange((next) => this.setMuted(!next.soundOn)) : () => {};
  }

  get started(): boolean {
    return this.engine !== null;
  }

  /** Must be called from a user gesture (click / key). Safe to call repeatedly. */
  async start(): Promise<void> {
    if (!this.engine) {
      const e = new AudioEngine(this.opts.ctx, { followSettings: this.follow });
      this.engine = e;
      this.crowd = new Crowd(e);
      this.foley = new Foley(e, this.bank, { duck: (depth, at) => this.crowd?.duck(depth, at) });
      this.whine = [new ServoWhine(e, -8), new ServoWhine(e, 11)];
      this.hiss = [new HydraulicHiss(e, 0.4), new HydraulicHiss(e, 1.7)];
      e.setMuted(this.muted);
      if (!this.muted) this.loadSamples(e);
    }
    await this.engine.resume();
  }

  /** Samples stream in behind the synthesis: never block on them. SOUND off (the default) fetches nothing. */
  private loadSamples(e: AudioEngine): void {
    this.samplesLoading ??= this.bank.load(e.ctx).catch((err: unknown) => console.warn('[audio] impact samples unavailable', err));
  }

  /** Resolves once the impact samples have loaded (or failed over to synthesis); at once while muted. */
  samplesReady(): Promise<void> {
    return this.samplesLoading ?? Promise.resolve();
  }

  setScene(scene: AudioScene): void {
    this.scene = scene;
    this.feet.clear();
    this.prevPoses = null;
    this.lastPoseTime = null;
    this.poseWallS = 0;
    this.rootPos = [null, null];
    this.fallSpeed = [0, 0];
    this.detached = [new Set(), new Set()];
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.engine?.setMuted(muted);
    if (!muted && this.engine) this.loadSamples(this.engine);
  }

  isMuted(): boolean {
    return this.muted;
  }

  bell(strikes: number): void {
    if (this.engine) bell(this.engine, strikes);
  }

  swell(amount: number): void {
    this.crowd?.swell(amount);
  }

  /** rate < 1 slows and deepens the sounds (replays). */
  onEvents(events: readonly SimEvent[], rate = 1): void {
    const f = this.foley;
    const s = this.scene;
    if (!f || !s) return;
    // A fence contact arrives as an impact plus a cage event at the same point: the cage event voices it.
    const cagePoints = events.flatMap((ev) => (ev.kind === 'cage' ? [ev.pos] : []));
    for (const ev of events) this.playEvent(f, s, ev, rate, cagePoints);
  }

  private playEvent(f: Foley, s: AudioScene, ev: SimEvent, rate: number, cagePoints: readonly Vec3[]): void {
    switch (ev.kind) {
      case 'impact':
        this.playImpact(f, s, ev, rate, cagePoints);
        return;
      case 'cage':
        f.fence(ev.speed, this.place(s, ev.pos, rate));
        return;
      case 'detach':
        this.detached[ev.corner].add(ev.part);
        f.detach(ev.part, s.material(ev.corner, ev.part), s.massKg[ev.corner], this.place(s, ev.pos, rate));
        this.crowd?.swell(ev.part === 'head' ? 0.9 : 0.55);
        return;
      case 'fall': {
        const speed = this.fallSpeed[ev.corner] > 0.5 ? this.fallSpeed[ev.corner] : DEFAULT_FALL_SPEED;
        f.fall(s.massKg[ev.corner], speed, this.placeCorner(s, ev.corner, rate));
        this.crowd?.swell(0.4);
        return;
      }
      case 'getup':
        f.getup(s.massKg[ev.corner], this.placeCorner(s, ev.corner, rate));
        this.crowd?.swell(0.2);
        return;
      case 'ko':
        f.ko(s.massKg[ev.corner], this.placeCorner(s, ev.corner, rate));
        this.crowd?.swell(1);
        return;
      case 'joint':
        if (ev.state !== 'ok') f.joint(ev.state === 'seized', ev.state === 'degraded' ? 0.5 : 0.9, this.placeCorner(s, ev.corner, rate));
        return;
    }
  }

  private playImpact(f: Foley, s: AudioScene, ev: Extract<SimEvent, { kind: 'impact' }>, rate: number, cagePoints: readonly Vec3[]): void {
    const where = this.place(s, ev.pos, rate);
    if (ev.striker !== null && ev.victim !== null) {
      const material = s.material(ev.victim, ev.part);
      const kind = classifyStrike({ metal: ev.metal, part: ev.part, victimMaterial: material, strikerGloved: this.gloved(s, ev.striker) });
      const massKg = Math.sqrt(s.massKg[ev.striker] * s.massKg[ev.victim]);
      f.hit({ ...where, kind, energyJ: ev.energyJ, part: ev.part, material, massKg });
      if (ev.energyJ > SWELL_HIT_J) this.crowd?.swell(0.08 + ev.energyJ / 1500);
      return;
    }
    if (cagePoints.some((p) => dist(p, ev.pos) < CAGE_MATCH_M)) return;
    // A loose piece (no longer the robot's) or a thrown prop landing: small bright ticks.
    if (ev.victim === null || (ev.part !== null && this.detached[ev.victim].has(ev.part))) {
      f.debris(ev.energyJ, sizePitch(ev.part), where);
      return;
    }
    if (ev.part && /foot/.test(ev.part) && ev.energyJ < FOOTFALL_MAX_J) return; // footfalls come from poses
    f.canvas(ev.energyJ, s.massKg[ev.victim], where);
  }

  private gloved(s: AudioScene, corner: Corner): boolean {
    return s.material(corner, 'fist_r') === 'glove' || s.material(corner, 'fist_l') === 'glove';
  }

  private place(s: AudioScene, p: Vec3, rate: number): Placement {
    return { pan: s.pan(p), distance: this.distanceTo(s, p), rate };
  }

  private placeCorner(s: AudioScene, corner: Corner, rate: number): Placement {
    const p = this.rootPos[corner];
    return p ? this.place(s, p, rate) : { pan: 0, distance: NOMINAL_CAM_M, rate };
  }

  /** Camera distance; failing that, the broadcast framing: nominal range plus the offset from the fighters' midpoint. */
  private distanceTo(s: AudioScene, p: Vec3): number {
    if (s.distance) return s.distance(p);
    const [a, b] = this.rootPos;
    if (!a || !b) return NOMINAL_CAM_M;
    const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    return NOMINAL_CAM_M + dist(mid, p);
  }

  /**
   * Per rendered frame: whine, hiss, footfalls and the crowd bed. `time` is the displayed sim time:
   * physics frames arrive at 60 Hz while rAF can run at 120 Hz, so motion is measured only when the
   * poses actually changed, over the wall time since they last did; a jump in time is a cut.
   */
  onFrame(poses: Float32Array | null, telemetry: readonly RobotTelemetry[] | null, dt: number, time?: number): void {
    const s = this.scene;
    if (!this.engine || !s) return;
    this.crowd?.update(dt);
    if (!poses || !telemetry || dt <= 0) return;
    this.poseWallS += dt;
    if (time !== undefined && time === this.lastPoseTime) return; // same physics frame: nothing moved
    const cut = time !== undefined && this.lastPoseTime !== null && Math.abs(time - this.lastPoseTime) > MOTION_CUT_S;
    this.lastPoseTime = time ?? null;
    const moveDt = this.poseWallS;
    this.poseWallS = 0;
    const prev = !cut && this.prevPoses && this.prevPoses.length === poses.length ? this.prevPoses : null;
    for (const t of telemetry) {
      const rootPos = posOf(poses, s.roots[t.corner]);
      this.trackRoot(t.corner, rootPos, prev, s.roots[t.corner], moveDt);
      const pan = s.pan(rootPos);
      const torque = topMean(t.joints.map((j) => j.torqueFrac), 4);
      const speed = prev ? limbSpeed(s, t.corner, poses, prev, moveDt) : 0;
      this.whine[t.corner]?.set(t.down ? torque * 0.4 : torque, speed, pan);
      // Leak hiss belongs to the oil effects: silent while they are switched off in settings.
      const leak = settings().oilEffects ? t.parts.reduce((sum, p) => sum + (p.leak > LEAK_EPS ? p.leak : 0), 0) : 0;
      this.hiss[t.corner]?.set(leak, pan);
    }
    this.footfalls(s, poses, moveDt, cut);
    if (this.prevPoses?.length !== poses.length) this.prevPoses = new Float32Array(poses.length);
    this.prevPoses.set(poses);
  }

  silence(): void {
    for (const w of this.whine) w.silence();
    for (const h of this.hiss) h.silence();
  }

  private footfalls(s: AudioScene, poses: Float32Array, dt: number, cut: boolean): void {
    const foley = this.foley!;
    for (const f of s.feet) {
      const z = poses[f.body * 7 + 2];
      let st = this.feet.get(f.body);
      if (!st) { st = { minZ: z, prevZ: z, cooldown: 0 }; this.feet.set(f.body, st); }
      st.minZ = Math.min(st.minZ, z);
      st.cooldown -= dt;
      const vz = cut ? 0 : (z - st.prevZ) / dt;
      st.prevZ = z;
      if (st.cooldown > 0 || z > st.minZ + FOOT.CONTACT_MARGIN_M || vz > -FOOT.MIN_DOWN_SPEED) continue;
      st.cooldown = FOOT.COOLDOWN_S;
      const level = Math.min(1, Math.max(0.12, -vz * s.massKg[f.corner] * FOOT.LEVEL_PER_KG_MS));
      foley.footstep(level, s.massKg[f.corner], this.place(s, posOf(poses, f.body), 1));
    }
  }

  /** Root position (for placing corner events) and its recent peak fall speed (for how hard a fall lands). */
  private trackRoot(corner: Corner, pos: Vec3, prev: Float32Array | null, body: number, dt: number): void {
    this.rootPos[corner] = pos;
    const decay = Math.exp(-dt / FALL_SPEED_MEMORY_S);
    const vz = prev ? (pos[2] - prev[body * 7 + 2]) / dt : 0;
    this.fallSpeed[corner] = Math.max(this.fallSpeed[corner] * decay, -vz);
  }
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function posOf(poses: Float32Array, body: number): Vec3 {
  return [poses[body * 7], poses[body * 7 + 1], poses[body * 7 + 2]];
}

function topMean(values: number[], n: number): number {
  if (!values.length) return 0;
  const top = [...values].sort((a, b) => b - a).slice(0, n);
  return top.reduce((a, b) => a + b, 0) / top.length;
}

/** Peak limb speed relative to the root, 0..1. */
function limbSpeed(s: AudioScene, corner: Corner, poses: Float32Array, prev: Float32Array, dt: number): number {
  const r = s.roots[corner] * 7;
  const rv = [(poses[r] - prev[r]) / dt, (poses[r + 1] - prev[r + 1]) / dt, (poses[r + 2] - prev[r + 2]) / dt];
  let peak = 0;
  for (const l of s.limbs) {
    if (l.corner !== corner) continue;
    const o = l.body * 7;
    const vx = (poses[o] - prev[o]) / dt - rv[0];
    const vy = (poses[o + 1] - prev[o + 1]) / dt - rv[1];
    const vz = (poses[o + 2] - prev[o + 2]) / dt - rv[2];
    peak = Math.max(peak, Math.hypot(vx, vy, vz));
  }
  return Math.min(1, peak / LIMB_FULL_SPEED);
}
