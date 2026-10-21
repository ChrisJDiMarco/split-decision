// Fight night: stage → arena + post → robot kit → VFX → broadcast → minds → physics worker.
// The broadcast owns the flow (select → intro → release → rounds → KO/decision); this file
// wires the modules together and runs the render loop.
// Each corner is fought by a Brain (JEV cloud, LOCAL open-source model, or HOUSE rules; hot
// swappable) or by the human player (PlayerMode, src/player): docs/design/player-mode-integration.md.
import * as THREE from 'three/webgpu';
import { Brain, sharedJevLink, type MindSource } from './brain';
import type { MainToWorker, SimEvent, WorkerToMain, WorldMeta } from './core/protocol';
import { onSettingsChange, settings } from './core/settings';
import type { Corner, MatchSetup } from './core/types';
import { PlayerMode, playerHostState, type PlayerCamera } from './player';
import { buildArenaView, installPostProcessing, type Quality } from './render/arena';
import { applyImpact, buildRobotKitViews, updateRobotKit, type RobotKitView } from './render/robot-kit';
import { TimeWarp } from './render/camera/time-warp';
import { applyPoses } from './render/robot-view';
import { createStage } from './render/stage';
import { createVfx, VFX_REQUIRED_LIMITS } from './render/vfx';
import { Weapons } from './render/weapons';
import { HIT, strikeStrength } from './render/vfx/scaling';
import { design } from './robots/designs';
import { applyLoadout } from './robots/loadout';
import { createBroadcast } from './ui/broadcast';
import type { FightPhase } from './ui/broadcast';
import { PICK_LABEL, effectiveMind, playerCornerOf } from './ui/mind-picks';
import type { Minds } from './ui/minds';

type FrameMsg = Extract<WorkerToMain, { type: 'frame' }>;

const SLOW_MO = 0.15;
const MAX_DT = 1 / 20;
const QUALITIES: Quality[] = ['high', 'medium', 'low'];
/** Post pulse for a detached head, and the share replays get. */
const PULSE_DETACH = 0.8;
const PULSE_REPLAY = 0.5;

const DEFAULT_SETUP: MatchSetup = {
  fighters: [
    { design: 'savate', skin: 'livery', plan: 'Orthodox kickboxer. Measure him with the jab and live at kicking range. Chop his lead leg with low kicks until his stance or his gyro gives, then go upstairs with the head kick. When he walks in behind the guard, front kick him off his base and sprint off the angle. Never stand in the clinch with him. Finish every combination with a kick: jab, cross, hook, low kick.', temperament: 1.1 },
    { design: 'haymaker', skin: 'livery', plan: 'Pressure brawler. Walk him down behind a high guard, chin tucked, and cut off the cage; do not chase, cut the angle. Get inside his kicks and smother him in the clinch. Dig hooks and uppercuts to the body, and when he covers up, load the overhand. If he circles out, chop his leg with a low kick. Every punch is thrown to end it.', temperament: 1.3 },
  ],
  seed: 7,
  timestep: 0.001,
  reactionDelayS: 0.3,
};

// ---------------------------------------------------------------- scene

const stage = await createStage(document.getElementById('stage') as HTMLCanvasElement, {
  requiredLimits: VFX_REQUIRED_LIMITS,
  antialias: false,
});
const arena = buildArenaView(stage);
const post = installPostProcessing(stage, arena, 'high');
const vfx = createVfx(stage);
arena.excludeFromContactShadows(vfx.root);

const worker = new Worker(new URL('./physics/worker.ts', import.meta.url), { type: 'module' });
const send = (m: MainToWorker) => worker.postMessage(m);

// Hidden shoulder weapons (src/render/weapons): pop out, track him, fire bursts.
const weapons = new Weapons({
  physicsRoot: stage.physicsRoot,
  camera: stage.camera,
  send,
  sparks: (events) => vfx.onEvents(events, broadcast.displayFrame()?.telemetry ?? null),
  pulse: (amount) => post.pulse(amount),
});

// ?balance=dcm previews the in-progress balance engine (docs/design/balance-engine.md); the default stays legacy.
const BALANCE_PREVIEW = new URLSearchParams(location.search).get('balance') === 'dcm' ? 'dcm' : undefined;
if (BALANCE_PREVIEW) {
  const badge = document.createElement('div');
  badge.textContent = 'PREVIEW · NEW BALANCE ENGINE';
  badge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:50;padding:4px 8px;font:600 11px/1 "JetBrains Mono",monospace;letter-spacing:.08em;color:#0b0b0b;background:#ffd23f;border-radius:3px;pointer-events:none';
  document.body.appendChild(badge);
}

// ---------------------------------------------------------------- match state

const link = sharedJevLink(); // the page-wide cloud link (the select screen reads its status)
let setup: MatchSetup = DEFAULT_SETUP;
let meta: WorldMeta | null = null;
let views: RobotKitView[] = [];
let bodyGroups = new Map<number, THREE.Group>();
let brains: Brain[] = []; // one per corner a mind fights (not the player's corner)
let player: PlayerMode | null = null;
let playerCam: PlayerCamera = 'chase'; // the player's own choice (V); replays and the walkout borrow the director
let forcingCam = false;
let pendingImpacts: SimEvent[] = [];
let workerPaused = false;
let timescale = 1; // the S key's slow motion
let qualityIndex = 0;
// Hit-stop and KO slow motion (presentation only: the worker's fixed-step physics is unchanged).
// ?hitstop=0 turns both off for testing; so does splitDecision.hitFeel.warp.enabled = false.
const warp = new TimeWarp(new URLSearchParams(location.search).get('hitstop') !== '0');
let sentScale = 1; // the scale the worker is running at

const brainFor = (corner: Corner) => brains.find((b) => b.corner === corner) ?? null;

function minds(): Minds {
  return [brainFor(0)?.latest ?? null, brainFor(1)?.latest ?? null];
}

/** The mind a corner's Brain runs now (its pick, or the global MINDS override). */
function sourceFor(corner: Corner): MindSource {
  const m = effectiveMind(setup.fighters[corner], settings().minds);
  return m === 'you' ? 'jev' : m; // 'you' never gets a Brain
}

/** Hot swap every Brain to its current mind (MINDS changed here, in another tab, or from the HUD). */
function applySources() {
  for (const b of brains) b.setSource(sourceFor(b.corner));
  if (player) player.setOpponentLabel(PICK_LABEL[sourceFor(player.corner === 0 ? 1 : 0)]);
}
onSettingsChange(applySources);

function setWorkerPaused(p: boolean) {
  workerPaused = p;
  send({ type: 'pause', paused: p });
}

function buildBrains(m: WorldMeta) {
  for (const b of brains) b.stop();
  const pc = playerCornerOf(setup);
  brains = ([0, 1] as Corner[]).filter((c) => c !== pc).map((corner) => new Brain({
    corner,
    meta: m,
    fighter: setup.fighters[corner],
    seed: setup.seed,
    link,
    source: sourceFor(corner),
    onIntent: (c, intent, issuedAtTick) => send({ type: 'intent', corner: c, intent, issuedAtTick }),
  }));
  buildPlayer(m, pc);
}

/** The YOU corner's PlayerMode (none in a fight between two minds). */
function buildPlayer(m: WorldMeta, pc: Corner | -1) {
  disposePlayer();
  if (pc === -1) return;
  const f = setup.fighters;
  forcingCam = true; // the constructor's director camera is not the player's choice
  player = new PlayerMode({
    stage,
    corner: pc,
    designs: [applyLoadout(design(f[0].design), f[0].loadout), applyLoadout(design(f[1].design), f[1].loadout)],
    hudRoot: document.getElementById('hud')!,
    fightBar: false, // the broadcast has one
    camera: 'director', // the walkout is the director's; the chase camera takes over at the release
    oppLabel: PICK_LABEL[sourceFor(pc === 0 ? 1 : 0)],
    send: (intent, issuedAtTick) => send({ type: 'intent', corner: pc, intent, issuedAtTick }),
    onCamera: (mode) => {
      broadcast.camera.setExternal(mode === 'chase');
      if (!forcingCam) playerCam = mode;
    },
  });
  forcingCam = false;
  player.setEnabled(false);
  player.setWorld(m);
}

function disposePlayer() {
  if (!player) return;
  player.dispose();
  player = null;
  broadcast.camera.setExternal(false);
}

/**
 * Player input and camera follow the fight: input only while the live fight runs (not in the
 * walkout, a break, a KO, the decision, a replay); the chase camera (or the director, V) during the
 * fight and the KO, the director for the walkout, replays and the winner card.
 */
function syncPlayer() {
  if (!player) return;
  const want = playerHostState(broadcast.phase(), broadcast.replaying(), workerPaused, playerCam);
  if (player.isEnabled !== want.enabled) player.setEnabled(want.enabled);
  if (player.camera !== want.camera) {
    forcingCam = true;
    player.setCamera(want.camera);
    forcingCam = false;
  }
  player.setHudVisible(want.hud);
}

function onPhase(phase: FightPhase) {
  switch (phase) {
    case 'break':
      // Between rounds the fighters stand where they are: physics and minds hold.
      for (const b of brains) b.stop();
      setWorkerPaused(true);
      break;
    case 'fight':
      if (workerPaused) setWorkerPaused(false);
      for (const b of brains) b.start();
      break;
    case 'ko':
    case 'decision':
    case 'over':
      for (const b of brains) b.stop();
      break;
    case 'select':
      disposePlayer(); // back to the select screen: the director shows the cage again
      break;
    default:
      break;
  }
  syncPlayer();
}

const broadcast = createBroadcast(stage, {
  initialSetup: DEFAULT_SETUP,
  onStart(s) {
    setup = s;
    timescale = 1;
    warp.cancel();
    sentScale = 1; // init resets the worker to real time
    vfx.clear();
    weapons.clear();
    send({ type: 'init', setup: s, ...(BALANCE_PREVIEW ? { balance: BALANCE_PREVIEW } : {}) });
  },
  onRelease() {
    send({ type: 'release' });
    for (const b of brains) b.start();
  },
  onPause(p) {
    setWorkerPaused(p);
  },
  onPhase,
  onMinds(s) {
    setup = s;
    applySources();
  },
  onReplayEvents(events) {
    const tel = broadcast.displayFrame()?.telemetry ?? null;
    vfx.onEvents(events, tel);
    queueImpacts(events);
    pulseFor(events, PULSE_REPLAY, tel);
  },
});

// ---------------------------------------------------------------- hit feel

/** The live fight is running forward on screen (hit-stop and slow-mo only apply then). */
function liveFight(): boolean {
  const p = broadcast.phase();
  return (p === 'fight' || p === 'ko') && !broadcast.replaying() && !workerPaused;
}

/** A short capped post pulse on the heaviest hits and a head knockoff. */
function pulseFor(events: readonly SimEvent[], scale: number, tel: FrameMsg['telemetry'] | null) {
  let amount = 0;
  for (const e of events) {
    if (e.kind === 'impact') {
      const s = strikeStrength(e, tel);
      if (s >= HIT.PULSE) amount = Math.max(amount, 0.4 + 0.6 * (s - HIT.PULSE) / (1 - HIT.PULSE));
    } else if (e.kind === 'detach' && e.part === 'head') amount = Math.max(amount, PULSE_DETACH);
  }
  if (amount > 0) post.pulse(amount * scale);
}

// ---------------------------------------------------------------- worker traffic

function queueImpacts(events: readonly SimEvent[]) {
  for (const e of events) {
    if (e.kind === 'impact' && e.victim !== null && e.part) pendingImpacts.push(e);
    else if (e.kind === 'cage') arena.bowFence(e.pos, e.speed / 3);
  }
}

function onReady(m: WorldMeta) {
  for (const v of views) v.dispose();
  meta = m;
  ({ views, bodyGroups } = buildRobotKitViews(m, stage.physicsRoot, [setup.fighters[0].skin, setup.fighters[1].skin]));
  vfx.setWorld(m);
  weapons.setViews(views);
  pendingImpacts = [];
  buildBrains(m);
  broadcast.setWorld(m, setup);
}

function onFrame(msg: FrameMsg) {
  broadcast.onFrame(msg, minds());
  const clock = broadcast.clock();
  for (const b of brains) b.onFrame(msg, clock);
  if (player) player.onFrame(msg, brainFor(player.corner === 0 ? 1 : 0)?.latest ?? null);
  if (broadcast.replaying()) return;
  warp.onEvents(msg.events, liveFight(), msg.telemetry);
  pulseFor(msg.events, 1, msg.telemetry);
  vfx.onEvents(msg.events, msg.telemetry);
  vfx.onTelemetry(msg.telemetry, msg.poses);
  for (const e of msg.events) {
    // Melee hits chip the outer armour plates too.
    if (e.kind === 'impact' && e.victim !== null && e.striker !== null && !e.push) {
      weapons.impact(e.victim, new THREE.Vector3(...e.pos), e.energyJ, new THREE.Vector3(-e.normal[0], -e.normal[1], -e.normal[2]));
    }
  }
  queueImpacts(msg.events);
}

worker.onmessage = (e: MessageEvent<WorkerToMain>) => {
  const msg = e.data;
  if (msg.type === 'ready') onReady(msg.meta);
  else if (msg.type === 'frame') onFrame(msg);
  else if (msg.type === 'error') console.error('[physics]', msg.message);
};

// ---------------------------------------------------------------- input

// S, Q and R are player keys (back out, lead hook, low kick) when a corner is YOU, so they only
// work between two minds; T (slow motion), L (quality) and N (new fight) always work.
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return; // browser and OS shortcuts
  const spectating = playerCornerOf(setup) === -1;
  const is = (always: string, classic: string) => e.code === always || (spectating && e.code === classic);
  if (is('KeyT', 'KeyS') && broadcast.phase() === 'fight') {
    timescale = timescale === 1 ? SLOW_MO : 1; // the render loop sends it (combined with hit-stop)
  } else if (is('KeyL', 'KeyQ')) {
    qualityIndex = (qualityIndex + 1) % QUALITIES.length;
    post.setQuality(QUALITIES[qualityIndex]);
  } else if (is('KeyN', 'KeyR')) {
    for (const b of brains) b.stop();
    broadcast.showSelect();
  }
});

// ---------------------------------------------------------------- render loop

const tmpPos = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();

function applyPendingImpacts() {
  if (!pendingImpacts.length) return;
  stage.physicsRoot.updateMatrixWorld();
  for (const e of pendingImpacts) {
    if (e.kind !== 'impact' || e.victim === null || !e.part) continue;
    const view = views.find((v) => v.corner === e.victim);
    if (!view) continue;
    stage.physicsRoot.localToWorld(tmpPos.set(...e.pos));
    tmpNormal.set(...e.normal).transformDirection(stage.physicsRoot.matrixWorld);
    applyImpact(view, e.part, tmpPos, tmpNormal, e.energyJ);
  }
  pendingImpacts = [];
}

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(MAX_DT, (now - last) / 1000);
  last = now;
  broadcast.update(dt);
  syncPlayer();
  const shown = broadcast.displayFrame();
  if (shown && meta) {
    applyPoses(shown.poses, bodyGroups);
    applyPendingImpacts();
    updateRobotKit(views, shown.telemetry, dt);
  }
  const replaying = broadcast.replaying();
  const scale = Math.min(timescale, warp.update(dt, liveFight()));
  if (Math.abs(scale - sentScale) > 1e-4) {
    sentScale = scale;
    send({ type: 'timescale', scale });
  }
  vfx.setReplay(replaying);
  const simDt = workerPaused && !replaying ? 0 : dt * (replaying ? 0.25 : scale);
  vfx.update(simDt);
  weapons.update(simDt, shown?.telemetry ?? null, liveFight());
  arena.update(dt);
  player?.update(dt); // the chase camera is the last to write the lens before rendering
  post.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Debug handle for the console and automated checks.
Object.assign(window, { splitDecision: { stage, broadcast, vfx, arena, link, get brains() { return brains; }, get player() { return player; }, get setup() { return setup; }, send, weapons, hitFeel: { warp, post } } });
