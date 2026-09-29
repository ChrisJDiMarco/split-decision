// Maps the fight to sound: events → clangs, thuds, tears and crowd swells; telemetry and
// poses → servo whine, hydraulic hiss and footfalls. Created on a user gesture.
import { onSettingsChange, settings } from '../core/settings';
import type { RobotTelemetry, SimEvent } from '../core/protocol';
import type { Corner, MaterialId, Vec3 } from '../core/types';
import { AudioEngine } from './engine';
import { Crowd, HydraulicHiss, ServoWhine } from './loops';
import { bell, cageRattle, clang, energyLevel, grind, tear, thud } from './sounds';

export interface AudioScene {
  pan(p: Vec3): number; // physics-frame point → stereo -1..1
  material(corner: Corner, part: string | null): MaterialId;
  massKg: [number, number];
  /** Bodies whose touchdowns are footfalls, plus bodies that drive the servo-speed estimate. */
  feet: Array<{ corner: Corner; body: number }>;
  limbs: Array<{ corner: Corner; body: number }>;
  roots: [number, number];
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

interface FootState { minZ: number; prevZ: number; cooldown: number }

export class BroadcastAudio {
  private engine: AudioEngine | null = null;
  private crowd: Crowd | null = null;
  private whine: ServoWhine[] = [];
  private hiss: HydraulicHiss[] = [];
  private scene: AudioScene | null = null;
  private feet = new Map<number, FootState>();
  private prevPoses: Float32Array | null = null;
  private lastPoseTime: number | null = null;
  private poseWallS = 0; // wall time since the displayed poses last changed
  // Follows the SOUND setting (off by default); M toggles it for the session.
  private muted = !settings().soundOn;
  readonly unsubscribeSettings = onSettingsChange((next) => this.setMuted(!next.soundOn));

  get started(): boolean {
    return this.engine !== null;
  }

  /** Must be called from a user gesture (click / key). Safe to call repeatedly. */
  async start(): Promise<void> {
    if (!this.engine) {
      const e = new AudioEngine();
      this.engine = e;
      this.crowd = new Crowd(e);
      this.whine = [new ServoWhine(e, -8), new ServoWhine(e, 11)];
      this.hiss = [new HydraulicHiss(e, 0.4), new HydraulicHiss(e, 1.7)];
      e.setMuted(this.muted);
    }
    await this.engine.resume();
  }

  setScene(scene: AudioScene): void {
    this.scene = scene;
    this.feet.clear();
    this.prevPoses = null;
    this.lastPoseTime = null;
    this.poseWallS = 0;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.engine?.setMuted(muted);
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
    const e = this.engine;
    const s = this.scene;
    if (!e || !s) return;
    for (const ev of events) this.playEvent(e, s, ev, rate);
  }

  private playEvent(e: AudioEngine, s: AudioScene, ev: SimEvent, rate: number): void {
    switch (ev.kind) {
      case 'impact': {
        const pan = s.pan(ev.pos);
        const level = energyLevel(ev.energyJ);
        if (ev.striker === null) {
          if (ev.part && /foot/.test(ev.part) && ev.energyJ < 50) return; // footfalls come from poses
          if (ev.victim !== null) thud(e, level, pan, ev.energyJ > 80);
          if (ev.metal || ev.victim === null) clang(e, { material: ev.victim === null ? 'steel' : s.material(ev.victim, ev.part), part: ev.part, level: level * 0.6, pan, rate });
          return;
        }
        const material = ev.victim === null ? 'steel' : s.material(ev.victim, ev.part);
        clang(e, { material: ev.metal ? material : 'carbon', part: ev.part, level, pan, rate });
        if (!ev.metal) thud(e, level * 0.7, pan, false);
        if (ev.energyJ > 150) this.crowd?.swell(0.08 + ev.energyJ / 1500);
        return;
      }
      case 'cage':
        cageRattle(e, Math.min(1, ev.speed / 5), s.pan(ev.pos));
        return;
      case 'detach': {
        const pan = s.pan(ev.pos);
        tear(e, 1, pan, rate);
        clang(e, { material: s.material(ev.corner, ev.part), part: ev.part, level: 1, pan, rate });
        this.crowd?.swell(ev.part === 'head' ? 0.9 : 0.55);
        return;
      }
      case 'fall':
        thud(e, 1, 0, true);
        this.crowd?.swell(0.4);
        return;
      case 'getup':
        this.crowd?.swell(0.2);
        return;
      case 'ko':
        this.crowd?.swell(1);
        return;
      case 'joint':
        if (ev.state !== 'ok') grind(e, ev.state === 'degraded' ? 0.5 : 0.9, 0);
        return;
    }
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
    const e = this.engine!;
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
      thud(e, level, s.pan(posOf(poses, f.body)), false);
    }
  }
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
