// PlayerMode: a human fights one corner. Wires the input layer, the intent driver, the chase
// camera and the player HUD together; the host (harness or main.ts) owns the worker, the
// renderer and the opponent's Brain, and calls:
//
//   const player = new PlayerMode({ stage, corner, designs, hudRoot, send, onCamera });
//   worker 'ready' → player.setWorld(meta)
//   worker 'frame' → player.onFrame(frame, opponentBrain.latest)
//   per rAF        → player.update(dt)   (after the broadcast/director camera, before rendering)
//
// Intents go out through `send(intent, issuedAtTick)` exactly like a Brain's onIntent. They are
// sent the moment a key changes (not on the next frame), so the only lag is the corner's
// reaction delay (FighterSetup.reactionDelayS) plus one telemetry frame.
import type { Intent, RobotTelemetry, WorkerToMain, WorldMeta } from '../core/protocol';
import type { Corner, RobotDesign, Vec3 } from '../core/types';
import type { Stage } from '../render/stage';
import { buildSubjects, indexWorld, type WorldIndex } from '../ui/scene-bridge';
import type { MindView } from '../ui/minds';
import { ChaseCamera, type ChaseSubjects } from './chase-camera';
import { breakRoleOf, inputAllowed, type BreakRole } from './host';
import { PlayerDriver, type SelfState } from './driver';
import { PlayerHud } from './hud';
import { PlayerInput } from './input';
import { chordOf, loadKeymap, rebind, resetKeymap, saveKeymap, type ActionId, type Keymap, type PressAction } from './keymap';

type FrameMsg = Extract<WorkerToMain, { type: 'frame' }>;
export type PlayerCamera = 'chase' | 'director';

export interface PlayerModeOptions {
  stage: Stage;
  corner: Corner;
  designs: readonly [RobotDesign, RobotDesign]; // by corner
  hudRoot: HTMLElement;
  /** Send an intent for this corner (same contract as Brain.onIntent). */
  send(intent: Intent, issuedAtTick: number): void;
  /** V pressed (or setCamera called): the host hands the camera to the director or takes it back. */
  onCamera?(mode: PlayerCamera): void;
  keymap?: Keymap;
  camera?: PlayerCamera;
  /** Draw the player HUD's own fight bar (off when the broadcast's is on screen). Default true. */
  fightBar?: boolean;
  /** The opponent's mind as the fight bar tags it: 'JEV' (default), 'LOCAL', 'HOUSE'. */
  oppLabel?: string;
}


/** Input-to-motion probes (ms): press → the telemetry frame showing it, on the main thread. */
export interface PlayerStats {
  strikeStartMs: number[]; // strike press → first frame with that strike running
  moveStartMs: number[]; // movement key → first frame with the COM moving that way at > MOVE_SPEED
  sends: number;
  lastIntent: Intent | null;
}

const MOVE_SPEED = 0.15; // m/s along the request counts as moving
const MOVE_PROBE_TIMEOUT_S = 2;
const MAX_SAMPLES = 200;

export class PlayerMode {
  readonly corner: Corner;
  readonly driver = new PlayerDriver();
  readonly chase: ChaseCamera;
  readonly hud: PlayerHud;
  readonly input: PlayerInput;
  readonly stats: PlayerStats = { strikeStartMs: [], moveStartMs: [], sends: 0, lastIntent: null };
  camera: PlayerCamera;
  private keymap: Keymap;
  private world: WorldIndex | null = null;
  private latest: FrameMsg | null = null;
  private oppMind: MindView | null = null;
  private capturing: ActionId | null = null;
  private enabled = true;
  /** The referee's break (RobotTelemetry.referee): input waits for FIGHT, except a downed fighter's get-up. */
  private breakRole: BreakRole = null;
  private fightCalled = false;
  private moveProbe: { t: number; forward: number; strafe: number; checked: boolean } | null = null;
  private lastLatency: number | null = null;

  constructor(private readonly opts: PlayerModeOptions) {
    this.corner = opts.corner;
    this.keymap = opts.keymap ?? loadKeymap();
    this.driver.abilities = new Set(opts.designs[opts.corner].abilities);
    this.chase = new ChaseCamera(opts.stage, opts.corner);
    this.hud = new PlayerHud(opts.corner, opts.designs[opts.corner], opts.designs[opts.corner === 0 ? 1 : 0], {
      onRebind: (a) => this.startRebind(a),
      onResetKeys: () => this.applyKeymap(resetKeymap()),
    }, opts.fightBar ?? true);
    opts.hudRoot.append(this.hud.el);
    this.setOpponentLabel(opts.oppLabel ?? 'JEV');
    this.hud.setKeymap(this.keymap, null);
    this.input = new PlayerInput(opts.stage.renderer.domElement, this.keymap, {
      onPress: (a, t) => this.onPress(a, t),
      onHeld: (held) => {
        const before = this.driver.view().move;
        this.driver.setHeld(held);
        this.probeMove(before);
        this.flush();
      },
    });
    this.driver.onStrikeStarted = (pressT, startT) => this.sample(this.stats.strikeStartMs, (startT - pressT) * 1000);
    this.camera = opts.camera ?? 'chase';
    this.setCamera(this.camera);
  }

  setWorld(meta: WorldMeta): void {
    this.world = indexWorld(meta);
    this.latest = null;
    this.driver.clear();
    this.chase.snap();
  }

  onFrame(frame: FrameMsg, oppMind: MindView | null): void {
    this.latest = frame;
    this.oppMind = oppMind;
    this.onReferee(frame.telemetry[this.corner]);
    this.chase.onEvents(frame.events);
    this.hud.onEvents(frame.events);
    this.checkMoveProbe(frame.telemetry);
    this.flush();
  }

  /** Turn player input on or off (off between rounds, during replays, after a KO). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.applyInput();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** The referee's current break role for this fighter (null: no break). */
  get refereeBreak(): BreakRole {
    return this.breakRole;
  }

  /** The opponent's mind changed (a hot swap): retag the fight bar. */
  setOpponentLabel(label: string): void {
    const o = this.opts;
    this.hud.setNames([o.designs[0].name, o.designs[1].name], o.corner === 0 ? ['YOU', label] : [label, 'YOU']);
  }

  /** Show or hide the player HUD (the host hides it behind the winner card). */
  setHudVisible(on: boolean): void {
    this.hud.el.classList.toggle('ph-off', !on);
  }

  /**
   * Referee breaks (docs/design/player-mode-integration.md, "Known limits"): the body obeys the
   * referee over any intent, so input pauses until FIGHT for clear feedback. A downed fighter keeps
   * its input, so Space can still pick the kip-up while it gets up.
   */
  private onReferee(me: RobotTelemetry): void {
    const role = breakRoleOf(me);
    // FIGHT! only when the referee called it: a KO also ends a break, with no 'fight' event.
    if (me.referee?.events?.some((e) => e.kind === 'fight')) this.fightCalled = true;
    if (role === this.breakRole) return;
    if (role !== null && this.breakRole === null) this.fightCalled = false; // a new break
    this.breakRole = role;
    this.hud.setBreak(role, role === null && this.fightCalled);
    this.applyInput();
  }

  private applyInput(): void {
    const on = inputAllowed(this.enabled, this.breakRole);
    this.input.enabled = on;
    if (!on) this.driver.clear();
  }

  setCamera(mode: PlayerCamera): void {
    this.camera = mode;
    if (mode === 'chase') this.chase.activate();
    else this.chase.deactivate();
    this.hud.setCamera(mode === 'chase' ? 'CHASE' : 'BROADCAST');
    this.opts.onCamera?.(mode);
  }

  update(dt: number): void {
    const now = performance.now();
    this.flush();
    const look = this.input.consumeLook(now);
    if (this.chase.active) this.chase.look(look.dx, look.dy, look.idleS, dt);
    const subjects = this.subjects();
    if (subjects) this.chase.update(dt, subjects);
    const tel = this.latest?.telemetry ?? null;
    this.hud.update(dt, tel, this.oppMind, this.driver.view());
    this.hud.setLocked(this.input.locked || this.input.lockRefused || this.hud.hintsOpen() || !this.input.enabled); // no prompt while input waits
    const oppPoint = subjects ? ([subjects.opp[0], subjects.opp[1], Math.max(0.5, subjects.oppHeadZ - 0.4)] as Vec3) : null;
    this.hud.placeReticle(oppPoint, this.opts.stage.physicsRoot, this.opts.stage.camera, this.chase.active && !!tel && !tel[this.corner === 0 ? 1 : 0].down);
  }

  dispose(): void {
    this.input.dispose();
    this.chase.deactivate();
    this.hud.dispose();
  }

  // ------------------------------------------------------------ internals

  private onPress(action: PressAction, t: number): void {
    if (action === 'toggle_camera') return this.setCamera(this.camera === 'chase' ? 'director' : 'chase');
    if (action === 'toggle_hints') {
      const open = !this.hud.hintsOpen();
      this.hud.showHints(open);
      if (open && this.input.locked) document.exitPointerLock();
      return;
    }
    if (!this.input.enabled) return;
    this.driver.press(action, t, this.self());
    this.flush();
  }

  /** Ask the driver for an intent and send it if it changed. */
  private flush(): void {
    if (!this.input.enabled || !this.latest) return;
    const intent = this.driver.update(performance.now() / 1000, this.self());
    if (!intent) return;
    this.stats.sends++;
    this.stats.lastIntent = intent;
    this.opts.send(intent, this.latest.tick);
  }

  private self(): SelfState | null {
    const tel = this.latest?.telemetry;
    if (!tel) return null;
    const me = tel[this.corner];
    const opp = tel[this.corner === 0 ? 1 : 0];
    return { skill: me.skill, skillPhase: me.skillPhase, down: me.down, oppLeadLeg: opp.stance === 'southpaw' ? 'right_leg' : 'left_leg' };
  }

  private subjects(): ChaseSubjects | null {
    const f = this.latest;
    if (!f) return null;
    const s = buildSubjects(this.world, f.telemetry, f.poses);
    const o: Corner = this.corner === 0 ? 1 : 0;
    return { me: s.pos[this.corner], meHeadZ: s.headZ[this.corner], opp: s.pos[o], oppHeadZ: s.headZ[o], down: s.down[this.corner] };
  }

  private startRebind(action: ActionId): void {
    this.capturing = action;
    this.hud.setKeymap(this.keymap, action);
    this.input.capture = (b) => {
      this.capturing = null;
      if (b) this.applyKeymap(rebind(this.keymap, action, chordOf(b.code, b.shift && !this.isHeldAction(action))));
      else this.hud.setKeymap(this.keymap, null);
    };
  }

  private isHeldAction(a: ActionId): boolean {
    return a.startsWith('move_') || a === 'guard' || a === 'clinch';
  }

  private applyKeymap(map: Keymap): void {
    this.keymap = map;
    saveKeymap(map);
    this.input.setKeymap(map);
    this.hud.setKeymap(map, this.capturing);
  }

  // ------------------------------------------------------------ latency probes

  private probeMove(before: { forward: number; strafe: number }): void {
    const m = this.driver.view().move;
    const changed = Math.sign(m.forward) !== Math.sign(before.forward) || Math.sign(m.strafe) !== Math.sign(before.strafe);
    if (!changed) return;
    this.moveProbe = m.forward || m.strafe ? { t: performance.now() / 1000, forward: m.forward, strafe: m.strafe, checked: false } : null;
  }

  private checkMoveProbe(tel: readonly [RobotTelemetry, RobotTelemetry]): void {
    const p = this.moveProbe;
    if (!p) return;
    const now = performance.now() / 1000;
    if (now - p.t > MOVE_PROBE_TIMEOUT_S) {
      this.moveProbe = null;
      return;
    }
    const me = tel[this.corner];
    const opp = tel[this.corner === 0 ? 1 : 0];
    const fx = opp.comWorld[0] - me.comWorld[0];
    const fy = opp.comWorld[1] - me.comWorld[1];
    const n = Math.hypot(fx, fy) || 1;
    const fwd: [number, number] = [fx / n, fy / n];
    const right: [number, number] = [fwd[1], -fwd[0]];
    const dx = fwd[0] * p.forward + right[0] * p.strafe;
    const dy = fwd[1] * p.forward + right[1] * p.strafe;
    const dn = Math.hypot(dx, dy) || 1;
    const along = (me.velocity[0] * dx + me.velocity[1] * dy) / dn;
    const first = !p.checked;
    p.checked = true;
    if (first && along > MOVE_SPEED) {
      this.moveProbe = null; // already moving that way (auto-ranging): not a clean sample
      return;
    }
    if (along > MOVE_SPEED) {
      this.sample(this.stats.moveStartMs, (now - p.t) * 1000);
      this.moveProbe = null;
    }
  }

  private sample(list: number[], ms: number): void {
    list.push(ms);
    if (list.length > MAX_SAMPLES) list.shift();
    this.lastLatency = ms;
    this.hud.setLatency(this.lastLatency);
  }
}

