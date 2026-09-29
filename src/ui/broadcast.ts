// Fight-night broadcast: select screen, HUD, camera direction, replay and audio.
//
// Integration contract (see createBroadcast):
//   const bc = createBroadcast(stage, { onStart: (setup) => worker.init(setup), onRelease, onPause });
//   worker 'ready'  → bc.setWorld(meta, setup)
//   worker 'frame'  → bc.onFrame(frame, minds)        (consumes frame.events itself)
//   per rAF         → bc.update(dt); const f = bc.displayFrame(); applyPoses(f.poses); stage.render()
import './broadcast.css';
import './select.css';
import type { SimEvent, WorkerToMain, WorldMeta, RobotTelemetry } from '../core/protocol';
import type { Corner, MatchSetup, RobotDesign } from '../core/types';
import { BroadcastAudio } from '../audio/broadcast-audio';
import { CameraRig } from '../render/camera/camera-rig';
import { Director } from '../render/camera/director';
import { CameraShake } from '../render/camera/shake';
import type { Stage } from '../render/stage';
import { DESIGNS, design as getDesign } from '../robots/designs';
import { h, toggleClass } from './dom';
import { CornerPanel } from './hud/corner-panel';
import { FightBar } from './hud/fight-bar';
import { Overlays } from './hud/overlays';
import { TickerView } from './hud/ticker-view';
import type { Minds } from './minds';
import { ReplayBuffer, findKoHighlight, type ReplayFrame } from './replay-buffer';
import { ReplayPlayer } from './replay-player';
import { MATCH, RoundClock, formatClock } from './round-clock';
import { buildAudioScene, buildSubjects, indexWorld, type WorldIndex } from './scene-bridge';
import { Scorecard } from './scorecard';
import { SelectScreen, defaultPlan } from './select-screen';
import { taleOfTheTape } from './tale';
import { TickerFeed } from './ticker-feed';
import * as THREE from 'three/webgpu';

export type FrameMsg = Extract<WorkerToMain, { type: 'frame' }>;
export type FightPhase = 'select' | 'intro' | 'fight' | 'break' | 'ko' | 'decision' | 'over';

export interface BroadcastOptions {
  /** FIGHT (or REMATCH) pressed: build the world for this setup, then call setWorld. */
  onStart(setup: MatchSetup): void;
  /** Walkout done: drop the robots from the gantry. */
  onRelease?(): void;
  /** Replays pause the sim so the fight doesn't run on behind them. */
  onPause?(paused: boolean): void;
  /** Phase changes, e.g. to hold the brains between rounds or after the fight. */
  onPhase?(phase: FightPhase, round: number): void;
  /** Events crossed during replay playback (for VFX re-fire). */
  onReplayEvents?(events: SimEvent[], speed: number): void;
  initialSetup?: MatchSetup;
  root?: HTMLElement; // defaults to #hud
  roundSeconds?: number; // default 120
  breakSeconds?: number; // wall seconds between rounds, default MATCH.BREAK_S
  introSeconds?: number; // tale-of-the-tape walkout, default 6
}

export interface DisplayFrame {
  poses: Float32Array;
  telemetry: [RobotTelemetry, RobotTelemetry];
  time: number;
  replaying: boolean;
}

export interface Broadcast {
  setWorld(meta: WorldMeta, setup: MatchSetup): void;
  onFrame(frame: FrameMsg, minds?: Minds | null): void;
  onEvents(events: readonly SimEvent[]): void;
  update(dt: number): void;
  displayFrame(): DisplayFrame | null;
  phase(): FightPhase;
  clock(): { round: number; rounds: number; remainingS: number };
  replay(): boolean; // start a manual replay; false if there's nothing to show
  replaying(): boolean;
  camera: { toggleFree(): boolean; isFree(): boolean; director: Director; shake(amount: number): void };
  audio: { start(): Promise<void>; setMuted(muted: boolean): void; isMuted(): boolean };
  showSelect(): void;
  dispose(): void;
}

const KO_HOLD_S = 2.8;
const DECISION_HOLD_S = 2.6;
const REPLAY_AUDIO_RATE = 0.62;
const HUD_INTERVAL_S = 1 / 30;
const MAX_SIM_STEP_S = 0.5; // a bigger jump in frame.time is a reset, not elapsed time
const SHAKE_DETACH = 0.55;
const SHAKE_FALL = 0.35;
const PHASE_LABEL: Partial<Record<FightPhase, string>> = { intro: 'WALKOUT', break: 'BREAK', ko: 'KO', decision: 'JUDGES', over: 'FINAL' };
const KO_REASON: Record<string, string> = { head: 'HEAD REMOVED', down: 'DOWN FOR THE COUNT', power: 'POWER FAILURE', disabled: 'DISABLED' };

function fallbackSetup(): MatchSetup {
  const ids = Object.keys(DESIGNS);
  const a = getDesign(ids[0]);
  const b = getDesign(ids[1] ?? ids[0]);
  return {
    fighters: [
      { design: a.id, skin: a.defaultSkin, plan: defaultPlan(a), temperament: 1 },
      { design: b.id, skin: b.defaultSkin, plan: defaultPlan(b), temperament: 1.2 },
    ],
    seed: 7, timestep: 0.001, reactionDelayS: 0.3,
  };
}

export function createBroadcast(stage: Stage, opts: BroadcastOptions): Broadcast {
  const root = opts.root ?? document.getElementById('hud');
  if (!root) throw new Error('createBroadcast: no #hud element');
  root.classList.add('broadcast');

  // ---------------------------------------------------------------- state
  let phase: FightPhase = 'select';
  let phaseT = 0;
  let setup: MatchSetup = opts.initialSetup ?? fallbackSetup();
  let designs: [RobotDesign, RobotDesign] = [getDesign(setup.fighters[0].design), getDesign(setup.fighters[1].design)];
  let names: [string, string] = [designs[0].name, designs[1].name];
  let world: WorldIndex | null = null;
  let awaitingWorld = false;
  let latest: FrameMsg | null = null;
  let minds: Minds = [null, null];
  let lastSimTime: number | null = null;
  let hudT = 0;
  let density = 0;
  let koLoser: Corner | null = null;
  let koCause = ''; // the physics' KO reason ('head', 'down', ...)
  let koReason = '';
  let koWhen = '';
  let koTime = 0; // sim seconds
  let replayPlayer: ReplayPlayer | null = null;
  let replayForKO = false;
  let replaySecondAngle = false;
  let camBugText = '';
  const processed = new WeakSet<SimEvent>();

  const clock = new RoundClock(opts.roundSeconds ?? MATCH.ROUND_S, MATCH.ROUNDS);
  const breakS = opts.breakSeconds ?? MATCH.BREAK_S;
  const scorecard = new Scorecard();
  const feed = new TickerFeed(names);
  const buffer = new ReplayBuffer();
  const director = new Director();
  const shake = new CameraShake();
  const rig = new CameraRig(stage);
  const audio = new BroadcastAudio();
  director.setMode('idle');

  // ---------------------------------------------------------------- DOM
  const calloutLayer = h('div', 'bc-layer');
  const hud = h('div', 'bc-layer bc-hud bc-hidden');
  const fightBar = new FightBar();
  const ticker = new TickerView(calloutLayer);
  const overlays = new Overlays();
  let corners: [CornerPanel, CornerPanel] = [new CornerPanel(0, designs[0]), new CornerPanel(1, designs[1])];
  const camBug = h('div', 'cam-bug');
  const hints = h('div', 'key-hints', h('kbd', {}, 'C'), 'camera ', h('kbd', {}, 'P'), 'replay ', h('kbd', {}, 'H'), 'hud ', h('kbd', {}, 'M'), 'mute');
  hud.append(fightBar.el, corners[0].el, corners[1].el, ticker.el, camBug, hints);
  const select = new SelectScreen({ designs: Object.values(DESIGNS), initial: setup, onFight: (s) => startMatch(s) });
  root.append(hud, calloutLayer, overlays.el, select.el);

  // ---------------------------------------------------------------- helpers
  const setPhase = (p: FightPhase) => {
    phase = p;
    phaseT = 0;
    opts.onPhase?.(p, clock.round);
  };

  const projected = new THREE.Vector3();
  const pan = (p: [number, number, number]) => {
    rig.toWorld(p, projected).project(stage.camera);
    return Math.max(-1, Math.min(1, projected.x * 0.85));
  };

  function rebuildCorners(): void {
    const fresh: [CornerPanel, CornerPanel] = [new CornerPanel(0, designs[0]), new CornerPanel(1, designs[1])];
    corners[0].el.replaceWith(fresh[0].el);
    corners[1].el.replaceWith(fresh[1].el);
    corners = fresh;
  }

  function adoptSetup(s: MatchSetup): void {
    setup = s;
    designs = [getDesign(s.fighters[0].design), getDesign(s.fighters[1].design)];
    names = [designs[0].name, designs[1].name];
    fightBar.setFighters(names, [`${designs[0].bodyType} · ${s.fighters[0].skin}`, `${designs[1].bodyType} · ${s.fighters[1].skin}`]);
    feed.reset(names);
    rebuildCorners();
  }

  function resetMatch(): void {
    clock.reset();
    scorecard.reset();
    buffer.clear();
    ticker.clear();
    overlays.clear();
    koLoser = null;
    stopReplay();
    lastSimTime = null;
    minds = [null, null];
  }

  function startMatch(s: MatchSetup): void {
    // Called from the FIGHT click, so the AudioContext may start. Never block the match on it:
    // resume() can stay pending forever without a user gesture.
    audio.start().catch((err: unknown) => console.warn('[broadcast] audio unavailable', err));
    select.hide();
    resetMatch();
    adoptSetup(s);
    hud.classList.remove('bc-hidden');
    awaitingWorld = true;
    setPhase('intro');
    director.setMode('intro');
    opts.onStart(s);
  }

  function beginIntro(): void {
    overlays.showTape([taleOfTheTape(designs[0]), taleOfTheTape(designs[1])]);
    audio.swell(0.5);
  }

  function beginRound(): void {
    overlays.hideTape();
    overlays.roundCard(`ROUND ${clock.round}`, 'FIGHT!', 1800);
    audio.bell(1);
    audio.swell(0.45);
    clock.running = true;
    director.setMode('live');
    if (clock.round === 1) opts.onRelease?.();
    setPhase('fight');
  }

  function endRound(final: boolean): void {
    audio.bell(3);
    audio.swell(0.35);
    if (final) {
      overlays.roundCard('THAT\'S THE FIGHT', 'WE GO TO THE JUDGES', DECISION_HOLD_S * 1000);
      setPhase('decision');
    } else {
      overlays.roundCard(`END OF ROUND ${clock.round}`, `ROUND ${clock.round + 1} IN ${Math.round(breakS)} S`, Math.min(2600, breakS * 1000));
      setPhase('break');
    }
  }

  function showDecision(): void {
    const d = scorecard.decision();
    const kind = d.kind === 'draw' ? 'DRAW' : `${d.kind.toUpperCase()} DECISION`;
    showWinner(d.winner, kind, `${clock.rounds} ROUNDS`, d.cards);
  }

  function showWinner(winner: Corner | null, method: string, detail: string, cards?: Array<[number, number]>): void {
    audio.swell(0.8);
    director.setMode('victory', { subject: winner ?? 0 });
    overlays.showWinner({ winner, names, designIds: [designs[0].id, designs[1].id], method, detail, cards, stats: scorecard.totals() }, {
      rematch: () => startMatch({ ...setup, seed: setup.seed + 1 }),
      newFight: () => showSelect(),
    });
    setPhase('over');
  }

  function onKO(loser: Corner, reason: string): void {
    if (koLoser !== null || phase === 'over' || phase === 'select') return;
    koLoser = loser;
    koCause = reason;
    koTime = latest?.time ?? 0;
    koReason = KO_REASON[reason] ?? reason.toUpperCase();
    koWhen = `ROUND ${clock.round} · ${formatClock(clock.elapsed)}`;
    clock.running = false;
    ticker.clearCallouts(); // the KO band owns the screen
    overlays.showKO(loser, koReason, koWhen);
    audio.bell(5);
    setPhase('ko');
  }

  function startReplay(forKO: boolean): boolean {
    if (replayPlayer || buffer.size < 2) return false;
    const frames: ReplayFrame[] = buffer.snapshot();
    const koMoment = forKO && koLoser !== null ? findKoHighlight(frames, koLoser, koTime, koCause) : null;
    replayPlayer = new ReplayPlayer(frames, koMoment ?? undefined);
    replayForKO = forKO;
    replaySecondAngle = false;
    const hl = replayPlayer.highlight;
    director.setMode('replay', { anchor: hl?.pos ?? null, subject: koLoser ?? 0 });
    overlays.hideKO();
    overlays.showReplay(forKO ? `${koReason} · ${koWhen}` : `ROUND ${clock.round}`);
    root!.classList.add('replaying');
    audio.silence();
    opts.onPause?.(true);
    return true;
  }

  /** Drop a running replay without its end-of-replay transition (a new match, back to select). */
  function stopReplay(): void {
    if (!replayPlayer) return;
    replayPlayer = null;
    overlays.hideReplay();
    root!.classList.remove('replaying');
    opts.onPause?.(false);
  }

  function finishReplay(): void {
    stopReplay();
    if (replayForKO && koLoser !== null) {
      showWinner(koLoser === 0 ? 1 : 0, `KO · ${koReason}`, koWhen);
    } else {
      director.setMode(phase === 'over' ? 'victory' : 'live');
    }
  }

  function showSelect(): void {
    stopReplay();
    overlays.clear();
    hud.classList.add('bc-hidden');
    director.setMode('idle');
    select.show(setup);
    setPhase('select');
  }

  // ---------------------------------------------------------------- events
  function handleEvents(events: readonly SimEvent[], telemetry: readonly RobotTelemetry[] | null, time: number): void {
    const fresh = events.filter((e) => !processed.has(e));
    for (const e of fresh) processed.add(e);
    const live = phase === 'fight' || phase === 'break' || phase === 'ko';
    if (live) {
      scorecard.record(fresh, telemetry);
      for (const item of feed.ingest(fresh, telemetry, time)) ticker.push(item, clock.label());
    }
    director.onEvents(fresh);
    audio.onEvents(fresh);
    applyShake(fresh, 1);
    for (const e of fresh) if (e.kind === 'ko' && live) onKO(e.corner, e.reason);
  }

  function applyShake(events: readonly SimEvent[], scale: number): void {
    for (const e of events) {
      if (e.kind === 'impact') shake.add(CameraShake.forEnergy(e.energyJ) * scale);
      else if (e.kind === 'detach') shake.add(SHAKE_DETACH * scale);
      else if (e.kind === 'fall') shake.add(SHAKE_FALL * scale);
    }
  }

  // ---------------------------------------------------------------- per-frame
  function tickPhase(dt: number): void {
    if (replayPlayer) return; // a replay owns the screen: the break (or KO hold) waits for it
    phaseT += dt;
    if (phase === 'intro' && !awaitingWorld && phaseT >= (opts.introSeconds ?? 6)) beginRound();
    else if (phase === 'break' && phaseT >= breakS) {
      clock.nextRound();
      scorecard.startRound();
      beginRound();
    } else if (phase === 'ko' && !replayPlayer && phaseT >= KO_HOLD_S) {
      if (!startReplay(true)) showWinner(koLoser === 0 ? 1 : 0, `KO · ${koReason}`, koWhen);
    } else if (phase === 'decision' && phaseT >= DECISION_HOLD_S) showDecision();
  }

  function tickReplay(dt: number): void {
    const p = replayPlayer!;
    const tick = p.update(dt);
    if (tick.events.length) {
      audio.onEvents(tick.events, REPLAY_AUDIO_RATE);
      applyShake(tick.events, 0.6);
      opts.onReplayEvents?.(tick.events, tick.speed);
    }
    if (!replaySecondAngle && p.highlight && p.t >= p.highlight.time - 0.25) {
      replaySecondAngle = true; // cut to a second, lower angle for the money moment
      director.cut('replay', director.shot.subject, { anchor: p.highlight.pos, angle: director.shot.angle + Math.PI * 0.6 });
    }
    overlays.setReplayProgress(p.progress);
    if (tick.done) finishReplay();
  }

  function updateHud(frame: DisplayFrame | null): void {
    const tel = frame?.telemetry ?? null;
    fightBar.update(tel);
    corners[0].update(tel?.[0] ?? null, minds[0]);
    corners[1].update(tel?.[1] ?? null, minds[1]);
    fightBar.setClock(clock.round, clock.rounds, clock.label(), clockState());
    const bug = rig.free ? 'FREE ORBIT' : director.shot.kind.replace('_', ' ');
    if (bug !== camBugText) {
      camBugText = bug;
      camBug.replaceChildren(rig.free ? h('b', {}, bug) : h('span', {}, 'CAM · ', h('b', {}, bug)));
    }
    ticker.update();
  }

  function clockState(): string {
    if (replayPlayer) return 'REPLAY';
    return PHASE_LABEL[phase] ?? '';
  }

  function displayFrame(): DisplayFrame | null {
    if (replayPlayer) return { poses: replayPlayer.poses(), telemetry: replayPlayer.telemetry(), time: replayPlayer.t, replaying: true };
    if (!latest) return null;
    return { poses: latest.poses, telemetry: latest.telemetry, time: latest.time, replaying: false };
  }

  // ---------------------------------------------------------------- input
  function onKey(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyC') rig.setFree(!rig.free);
    else if (e.code === 'KeyP') {
      if (replayPlayer) finishReplay();
      else if (phase === 'fight' || phase === 'break' || phase === 'over') startReplay(false);
    } else if (e.code === 'Escape' && replayPlayer) finishReplay();
    else if (e.code === 'KeyH') {
      density = (density + 1) % 3;
      toggleClass(root!, 'density-clean', density === 1);
      toggleClass(root!, 'density-off', density === 2);
    } else if (e.code === 'KeyM') audio.setMuted(!audio.isMuted());
  }
  window.addEventListener('keydown', onKey);

  // ---------------------------------------------------------------- API
  return {
    setWorld(meta, s) {
      if (s !== setup) adoptSetup(s);
      world = indexWorld(meta);
      audio.setScene(buildAudioScene(world, designs, pan));
      latest = null;
      lastSimTime = null;
      buffer.clear();
      if (awaitingWorld) {
        awaitingWorld = false;
        phaseT = 0;
        beginIntro();
      }
    },

    onFrame(frame, m) {
      if (m) minds = m;
      const prevTime = lastSimTime;
      lastSimTime = frame.time;
      latest = frame;
      buffer.push({ time: frame.time, poses: frame.poses.slice(), events: frame.events, telemetry: frame.telemetry });
      handleEvents(frame.events, frame.telemetry, frame.time);
      if (prevTime === null) return;
      const simDt = frame.time - prevTime;
      if (simDt <= 0 || simDt > MAX_SIM_STEP_S) return;
      const signal = clock.advance(simDt);
      if (signal) endRound(signal === 'fight_end');
    },

    onEvents(events) {
      handleEvents(events, latest?.telemetry ?? null, latest?.time ?? 0);
    },

    update(dt) {
      tickPhase(dt);
      if (replayPlayer) tickReplay(dt);
      const frame = displayFrame();
      const subjects = buildSubjects(world, frame?.telemetry ?? null, frame?.poses ?? null);
      const out = director.update(dt, subjects);
      rig.apply(rig.free ? null : out, dt, shake.update(dt));
      audio.onFrame(frame?.poses ?? null, frame?.telemetry ?? null, dt, frame?.time);
      hudT += dt;
      if (hudT >= HUD_INTERVAL_S) {
        hudT = 0;
        updateHud(frame);
      }
    },

    displayFrame,
    phase: () => phase,
    clock: () => clock.matchClock(),
    replay: () => startReplay(false),
    replaying: () => replayPlayer !== null,
    camera: {
      toggleFree: () => { rig.setFree(!rig.free); return rig.free; },
      isFree: () => rig.free,
      director,
      shake: (amount: number) => shake.add(amount),
    },
    audio: {
      start: () => audio.start(),
      setMuted: (m: boolean) => audio.setMuted(m),
      isMuted: () => audio.isMuted(),
    },
    showSelect,
    dispose() {
      window.removeEventListener('keydown', onKey);
      audio.silence();
      hud.remove();
      calloutLayer.remove();
      overlays.el.remove();
      select.el.remove();
      root.classList.remove('broadcast');
    },
  };
}
