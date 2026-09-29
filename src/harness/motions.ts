// Motion preview: plays retargeted mocap kinematically on the real robot kit (no physics), with
// the source actor as a ghost skeleton beside it and a timeline of phases and contacts.
// Open http://localhost:5297/harness/motions.html
//   ?design=striker&move=jab.13_17.0412     a library move
//   ?mode=clip&clip=135_07                   a whole source clip, retargeted in the browser
import * as THREE from 'three/webgpu';
import type { RobotDesign, Vec3 } from '../core/types';
import { DESIGNS } from '../robots/designs';
import { applyBodyPoses, buildRobotKitView, forwardKinematics, updateRobotKit, type RobotKitView } from '../render/robot-kit';
import { createStudio } from '../render/robot-kit/showroom/studio';
import { parseBvh } from '../robots/motions/bvh';
import { CLIPS, bvhPath } from '../robots/motions/clips';
import { CONTACT } from '../robots/motions/contacts';
import { humanTrack, mirrorTrack, pt, type HumanTrack, type PointId } from '../robots/motions/human';
import { loadLibrary, sample, type MotionLibrary, type Move, type MotionSample } from '../robots/motions';
import { matFromQuat, mulMtV, mulMV, quatFromMat, rotZ, sub, type Mat3 } from '../robots/motions/math';
import { retarget, type Retargeted } from '../robots/motions/retarget';
import { robotModel } from '../robots/motions/robot-model';
import { kinematics } from '../robots/motions/kinematics';

type Mode = 'library' | 'clip';

const params = new URLSearchParams(location.search);
const state = {
  design: DESIGNS[params.get('design') ?? ''] ? params.get('design')! : 'striker',
  mode: (params.get('mode') === 'clip' ? 'clip' : 'library') as Mode,
  clip: params.get('clip') ?? '13_17',
  move: params.get('move') ?? '',
  speed: Number(params.get('speed') ?? 1),
  loop: params.get('loop') !== '0',
  mirror: params.get('mirror') === '1',
  playing: params.get('play') !== '0',
  ghost: params.get('ghost') !== '0',
  targets: params.get('targets') === '1',
  follow: params.get('follow') !== '0',
  t: Number(params.get('t') ?? 0), // playback time in clip seconds (1× clock)
  ui: params.get('ui') !== '0',
  cam: (params.get('cam') ?? '') as '' | 'front' | 'side' | 'three' | 'top' | 'back',
  dist: Number(params.get('dist') ?? 5.2),
  strip: Math.max(0, Math.min(9, Number(params.get('strip') ?? 0))),
  stripFrom: params.get('from') === null ? null : Number(params.get('from')),
  stripTo: params.get('to') === null ? null : Number(params.get('to')),
};
if (!state.ui) for (const id of ['ui', 'info', 'timeline', 'status']) document.getElementById(id)!.style.display = 'none';

const statusEl = document.getElementById('status')!;
const infoEl = document.getElementById('info')!;
const ui = document.getElementById('ui')!;
function status(msg: string): void {
  statusEl.textContent = msg;
  (window as unknown as { motionsStatus: string }).motionsStatus = msg;
}

status('starting renderer…');
const studio = await createStudio(document.getElementById('c') as HTMLCanvasElement, params.get('webgl') === '1');
studio.turntable.children[0].visible = false; // no plinth: moves travel
studio.physicsRoot.position.y = 0;
studio.camera.position.set(5.2, 1.9, 6.2);
studio.controls.target.set(0, 0.95, 0.6);

// ---------------------------------------------------------------- robot + ghost

class Puppet {
  readonly root = new THREE.Group();
  readonly view: RobotKitView;
  private readonly byPart = new Map<string, THREE.Object3D>();
  constructor(readonly design: RobotDesign, parent: THREE.Object3D) {
    parent.add(this.root);
    const bodyGroups = new Map<number, THREE.Group>();
    let next = 1;
    const parts = design.parts.map((p) => ({ id: p.id, body: next++, debrisBody: null as number | null }));
    this.view = buildRobotKitView(design, design.defaultSkin, 0, parts, this.root, bodyGroups);
    for (const pm of parts) {
      const g = bodyGroups.get(pm.body);
      if (g) this.byPart.set(pm.id, g);
    }
  }
  pose(q: Record<string, number>, pos: Vec3, rot: Mat3): void {
    const qq = quatFromMat(rot);
    const poses = forwardKinematics(this.design, q, new THREE.Vector3(...pos), new THREE.Quaternion(qq[1], qq[2], qq[3], qq[0]));
    applyBodyPoses(poses, this.byPart);
  }
  dispose(): void {
    this.view.dispose();
    this.root.removeFromParent();
  }
}

const BONES: Array<[PointId, PointId]> = [
  ['hipL', 'hipR'], ['hipC', 'chest'], ['chest', 'neck'], ['neck', 'head'], ['head', 'headTop'],
  ['shoulderL', 'shoulderR'], ['neck', 'shoulderL'], ['neck', 'shoulderR'],
  ['hipL', 'kneeL'], ['kneeL', 'ankleL'], ['ankleL', 'ballL'], ['ballL', 'toeL'],
  ['hipR', 'kneeR'], ['kneeR', 'ankleR'], ['ankleR', 'ballR'], ['ballR', 'toeR'],
  ['shoulderL', 'elbowL'], ['elbowL', 'wristL'], ['wristL', 'fistL'],
  ['shoulderR', 'elbowR'], ['elbowR', 'wristR'], ['wristR', 'fistR'],
];

class Ghost {
  readonly group = new THREE.Group();
  private readonly lines: THREE.LineSegments;
  private readonly dots: THREE.InstancedMesh;
  private readonly pos: Float32Array;
  private readonly m = new THREE.Matrix4();
  constructor(parent: THREE.Object3D) {
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(BONES.length * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.9 }));
    this.lines.frustumCulled = false;
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.022, 10, 8), new THREE.MeshBasicMaterial({ color: 0x7fe0ff }), BONES.length * 2);
    this.dots.frustumCulled = false;
    this.group.add(this.lines, this.dots);
    parent.add(this.group);
  }
  set(points: (id: PointId) => Vec3): void {
    BONES.forEach(([a, b], i) => {
      const pa = points(a), pb = points(b);
      this.pos.set(pa, i * 6);
      this.pos.set(pb, i * 6 + 3);
      this.m.makeTranslation(pa[0], pa[1], pa[2]);
      this.dots.setMatrixAt(i * 2, this.m);
      this.m.makeTranslation(pb[0], pb[1], pb[2]);
      this.dots.setMatrixAt(i * 2 + 1, this.m);
    });
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.dots.instanceMatrix.needsUpdate = true;
  }
}

class Markers {
  private readonly mesh: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  constructor(parent: THREE.Object3D, color: number, count: number, radius = 0.035) {
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(radius, 12, 8), new THREE.MeshBasicMaterial({ color }), count);
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }
  set(points: Vec3[], visible: boolean): void {
    this.mesh.visible = visible && points.length > 0;
    this.mesh.count = Math.min(points.length, this.mesh.instanceMatrix.count);
    points.slice(0, this.mesh.count).forEach((p, i) => {
      this.m.makeTranslation(p[0], p[1], p[2]);
      this.mesh.setMatrixAt(i, this.m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- playables

interface Frame {
  q: Record<string, number>;
  rootPos: Vec3;
  rootRot: Mat3;
  contacts: number;
  ghost: ((id: PointId) => Vec3) | null;
  targets: Vec3[]; // fists then ankles (requested)
}

interface Playable {
  title: string;
  duration: number; // seconds at 1×
  fps: number;
  loop: boolean;
  frameAt(t: number): Frame;
  bands: Array<{ from: number; to: number; label: string; color: string }>; // seconds
  events: Array<{ t: number; label: string }>;
  contacts(t: number): number;
  /** Heading the actor looks toward (camera presets and filmstrip layout follow it). */
  facing(t: number): number;
  /** Filmstrip times that tell the move's story (start, windup, strike, impact, reach, recover, end). */
  keyTimes?: number[];
  /** Where the strike lands (playable frame), drawn as a target. */
  target?: () => Vec3 | null;
  info(): string;
}

const trackCache = new Map<string, Promise<HumanTrack>>();
function loadTrack(clip: string): Promise<HumanTrack> {
  let p = trackCache.get(clip);
  if (!p) {
    p = fetch(`/${bvhPath(clip)}`).then(async (r) => {
      if (!r.ok) throw new Error(`${clip}: HTTP ${r.status}`);
      return humanTrack(clip, parseBvh(await r.text()), { fps: 60 });
    });
    trackCache.set(clip, p);
  }
  return p;
}

const GHOST_SIDE_M = 1.35;

async function clipPlayable(designId: string, clip: string): Promise<Playable> {
  const tr = await loadTrack(clip);
  const model = robotModel(DESIGNS[designId]);
  const t0 = performance.now();
  const r: Retargeted = retarget(tr, model);
  const ms = performance.now() - t0;
  const kin = kinematics(tr);
  const names = model.joints.map((j) => j.name);
  const nj = names.length;
  const kLeg = r.scale.leg;
  const at = (t: number) => Math.min(r.n - 1, Math.max(0, Math.round(t * r.fps)));
  const vec = (arr: Float64Array, o: number): Vec3 => [arr[o], arr[o + 1], arr[o + 2]];
  const err = (a: Float64Array, b: Float64Array) => {
    let s = 0;
    for (let i = 0; i < a.length; i += 3) s += Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]);
    return (s / (a.length / 3)) * 100;
  };
  const limits = model.joints.map((j, i) => [j.name, r.atLimit[i] / r.n] as const).filter(([, v]) => v > 0.02);
  return {
    title: `${clip} (whole clip)`,
    duration: (r.n - 1) / r.fps,
    fps: r.fps,
    loop: true,
    frameAt(t) {
      const k = at(t);
      const q: Record<string, number> = {};
      for (let j = 0; j < nj; j++) q[names[j]] = r.q[k * nj + j];
      const ghostAt = (id: PointId): Vec3 => {
        const p = pt(tr, id, k);
        return [p[0] * kLeg, p[1] * kLeg + GHOST_SIDE_M, p[2] * kLeg + r.scale.lift];
      };
      return {
        q, rootPos: vec(r.rootPos, k * 3), rootRot: Array.from(r.rootRot.subarray(k * 9, k * 9 + 9)) as Mat3,
        contacts: r.contacts[k], ghost: ghostAt,
        targets: [vec(r.fistTarget, k * 6), vec(r.fistTarget, k * 6 + 3), vec(r.ankleTarget, k * 6), vec(r.ankleTarget, k * 6 + 3)],
      };
    },
    bands: [],
    events: [],
    contacts: (t) => r.contacts[at(t)],
    facing: (t) => kin.yaw[at(t)],
    info: () => [
      `<b>${clip}</b>  ${CLIPS.find((c) => c.id === clip)?.note ?? ''}`,
      `${r.n} frames @ ${r.fps} Hz, retargeted in ${ms.toFixed(0)} ms`,
      `scale leg ${kLeg.toFixed(3)} arm ${r.scale.arm.toFixed(3)} lift ${(r.scale.lift * 100).toFixed(1)} cm`,
      `mean error fist ${err(r.fistTarget, r.fist).toFixed(1)} cm  ankle ${err(r.ankleTarget, r.ankle).toFixed(1)} cm`,
      `knee ${err(r.kneeTarget, r.knee).toFixed(1)} cm  elbow ${err(r.elbowTarget, r.elbow).toFixed(1)} cm`,
      `arm targets out of reach ${((r.armOutOfReach / (2 * r.n)) * 100).toFixed(1)}%`,
      `joints on a limit >2% of frames:`,
      ...limits.map(([n, v]) => `  ${n.padEnd(18)} ${(v * 100).toFixed(1)}%`),
    ].join('\n'),
  };
}

const PHASE_COLORS: Record<string, string> = { windup: '#3d6bff', strike: '#ff4d2e', recover: '#3bbf7a', loop: '#8a8f98' };

async function movePlayable(lib: MotionLibrary, move: Move): Promise<Playable> {
  const model = robotModel(DESIGNS[lib.design]);
  const names = lib.joints;
  let ghostTrack: HumanTrack | null = null;
  try {
    const tr = await loadTrack(move.source.clip);
    ghostTrack = move.source.mirrored ? mirrorTrack(tr) : tr;
  } catch {
    ghostTrack = null; // raw BVH not present (fresh clone): no ghost
  }
  const kLeg = move.source.scale;
  const align = move.source.align; // track world → move frame
  const Rinv: Mat3 = rotZ(-align.yaw);
  const s: MotionSample = sample(move, 0);
  const dur = move.duration;
  return {
    title: move.id,
    duration: dur,
    fps: move.fps,
    loop: move.loop,
    frameAt(t) {
      sample(move, t, { mirror: state.mirror }, s);
      const q: Record<string, number> = {};
      for (let j = 0; j < names.length; j++) q[names[j]] = s.q[j];
      const k = Math.min(move.frames - 1, Math.max(0, Math.round(t * move.fps)));
      const ghost = ghostTrack && !state.mirror
        ? (id: PointId): Vec3 => {
          const p = pt(ghostTrack!, id, move.source.start + k);
          const rel = mulMV(Rinv, [p[0] * kLeg - align.x, p[1] * kLeg - align.y, 0]);
          return [rel[0], rel[1] + GHOST_SIDE_M, p[2] * kLeg + move.source.lift];
        }
        : null;
      return { q, rootPos: s.rootPos, rootRot: matFromQuat(s.rootQuat), contacts: s.contacts, ghost, targets: [] };
    },
    bands: phaseBands(move),
    events: move.impact !== null ? [{ t: move.impact, label: 'impact' }] : [],
    contacts: (t) => sample(move, t, { mirror: state.mirror }).contacts,
    facing: () => 0,
    keyTimes: move.loop || move.impact === null
      ? Array.from({ length: 7 }, (_, k) => (dur * k) / 6)
      : [0, move.phases.strike * 0.5, move.phases.strike, move.impact, move.reach ?? move.phases.recover, ((move.reach ?? move.phases.recover) + dur) / 2, dur],
    target: () => (move.target ? [move.target[0], state.mirror ? -move.target[1] : move.target[1], move.target[2]] : null),
    info: () => [
      `<b>${move.id}</b>`,
      `label ${move.label}${move.side ? `  side ${move.side}` : ''}${move.height ? `  height ${move.height}` : ''}`,
      `source ${move.source.clip} frames ${move.source.start}-${move.source.end}${move.source.mirrored ? ' (mirrored)' : ''}`,
      `duration ${dur.toFixed(2)} s  ${move.frames} frames${move.loop ? '  loop' : ''}`,
      move.impact !== null ? `impact at ${move.impact.toFixed(2)} s  peak ${move.peakSpeed.toFixed(1)} m/s` : '',
      `max speed-up within motor limits ×${move.maxSpeed.toFixed(2)}`,
      `IK error fist ${(move.quality.fistErr * 100).toFixed(1)} cm  foot ${(move.quality.footErr * 100).toFixed(1)} cm`,
      `joints on a limit ${(move.quality.limitRate * 100).toFixed(1)}% of joint-frames`,
      model.design.name,
    ].filter(Boolean).join('\n'),
  };
}

function phaseBands(move: Move): Playable['bands'] {
  if (move.loop) return [{ from: 0, to: move.duration, label: 'loop', color: PHASE_COLORS.loop }];
  const p = move.phases;
  return [
    { from: 0, to: p.strike, label: 'windup', color: PHASE_COLORS.windup },
    { from: p.strike, to: p.recover, label: 'strike', color: PHASE_COLORS.strike },
    { from: p.recover, to: move.duration, label: 'recover', color: PHASE_COLORS.recover },
  ];
}

// ---------------------------------------------------------------- scene objects

let puppet: Puppet | null = null;
let ghost: Ghost | null = null;
let playable: Playable | null = null;
let library: MotionLibrary | null = null;
const fistMarks = new Markers(studio.physicsRoot, 0xff4d2e, 2);
const ankleMarks = new Markers(studio.physicsRoot, 0x3d8bff, 2);
const targetMarks = new Markers(studio.physicsRoot, 0xffd21f, 9, 0.06);

const STRIP_SPACING_M = 1.35;
let strip: Puppet[] = [];

function ensurePuppet(): void {
  if (puppet?.design.id !== state.design) {
    puppet?.dispose();
    puppet = new Puppet(DESIGNS[state.design], studio.physicsRoot);
  }
  ghost ??= new Ghost(studio.physicsRoot);
  const want = state.strip > 1 ? state.strip : 0;
  if (strip.length !== want || strip[0]?.design.id !== state.design) {
    for (const p of strip) p.dispose();
    strip = Array.from({ length: want }, () => new Puppet(DESIGNS[state.design], studio.physicsRoot));
  }
}

/** Filmstrip times: a move's key times, or evenly over [from, to] (clip seconds). */
function stripTimes(): number[] {
  if (!playable) return [];
  if (playable.keyTimes && playable.keyTimes.length === strip.length && state.stripFrom === null) return playable.keyTimes;
  const a = Math.max(0, state.stripFrom ?? 0);
  const b = Math.min(playable.duration, state.stripTo ?? playable.duration);
  return Array.from({ length: strip.length }, (_, k) => a + ((b - a) * k) / Math.max(1, strip.length - 1));
}

/** Pose the filmstrip: each copy at its time, root drift removed, laid out across the view. */
function poseStrip(): void {
  if (!playable || strip.length < 2 || !puppet) return;
  puppet.root.visible = false;
  if (ghost) ghost.group.visible = false;
  const times = stripTimes();
  const f0 = playable.frameAt(times[0]);
  const yaw0 = playable.facing(times[0]);
  const cam = state.cam || 'side';
  // Spread along the view's horizontal axis: side view → along the facing, front → across it.
  const along: [number, number] = cam === 'front' || cam === 'back' ? [0, -1] : cam === 'three' ? [0.66, 0.75] : [1, 0];
  const c = Math.cos(yaw0), sn = Math.sin(yaw0);
  const ax = c * along[0] - sn * along[1], ay = sn * along[0] + c * along[1];
  const tgt = playable.target?.() ?? null;
  const reachK = playable.keyTimes && times === playable.keyTimes ? 4 : -1; // key frame 4 is full reach
  const marks: Vec3[] = [];
  strip.forEach((p, k) => {
    const fr = playable!.frameAt(times[k]);
    const off = (k - (strip.length - 1) / 2) * STRIP_SPACING_M;
    // Each copy keeps its own travel from the first frame, so steps and lunges read.
    const pos: Vec3 = [fr.rootPos[0] + ax * off, fr.rootPos[1] + ay * off, fr.rootPos[2]];
    p.pose(fr.q, pos, fr.rootRot);
    updateRobotKit([p.view], null, 0);
    // The strike's landing point, on the copy frozen at full reach.
    if (tgt && k === reachK) marks.push([tgt[0] + ax * off, tgt[1] + ay * off, tgt[2]]);
  });
  targetMarks.set(marks, marks.length > 0);
  lastRoot = { pos: [f0.rootPos[0], f0.rootPos[1], 0.9], yaw: yaw0 };
}

async function load(): Promise<void> {
  ensurePuppet();
  status('loading…');
  try {
    if (state.mode === 'clip') {
      playable = await clipPlayable(state.design, state.clip);
    } else {
      if (library?.design !== state.design) library = await loadLibrary(state.design);
      const move = library.moves.find((m) => m.id === state.move) ?? library.moves[0];
      if (!move) throw new Error(`library '${state.design}' has no moves`);
      state.move = move.id;
      playable = await movePlayable(library, move);
    }
    state.t = Math.min(state.t, playable.duration);
    status('');
  } catch (e) {
    status(`load failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
  renderUi();
  infoEl.innerHTML = playable.info();
}

// ---------------------------------------------------------------- UI

function button(label: string, on: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (on) b.className = 'on';
  b.addEventListener('click', onClick);
  return b;
}

function row(label: string, children: HTMLElement[]): HTMLDivElement {
  const r = document.createElement('div');
  r.className = 'row';
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = label;
  r.append(l, ...children);
  return r;
}

function slider(min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement {
  const s = document.createElement('input');
  s.type = 'range';
  s.min = String(min);
  s.max = String(max);
  s.step = String(step);
  s.value = String(value);
  s.addEventListener('input', () => onInput(Number(s.value)));
  return s;
}

function renderUi(): void {
  ui.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'title';
  title.innerHTML = 'MOTION PREVIEW <small>SPLIT DECISION · CMU MOCAP → ROBOT</small>';
  ui.append(title);
  ui.append(row('DESIGN', Object.keys(DESIGNS).map((id) => button(DESIGNS[id].name, id === state.design, () => { state.design = id; void load(); }))));
  ui.append(row('SOURCE', [
    button('Library', state.mode === 'library', () => { state.mode = 'library'; void load(); }),
    button('Raw clip', state.mode === 'clip', () => { state.mode = 'clip'; void load(); }),
  ]));
  const speedLabel = document.createElement('span');
  speedLabel.textContent = `×${state.speed.toFixed(2)}`;
  ui.append(row('SPEED', [slider(0.1, 2.5, 0.05, state.speed, (v) => { state.speed = v; speedLabel.textContent = `×${v.toFixed(2)}`; }), speedLabel]));
  ui.append(row('PLAY', [
    button(state.playing ? 'Pause' : 'Play', state.playing, () => { state.playing = !state.playing; renderUi(); }),
    button('Loop', state.loop, () => { state.loop = !state.loop; renderUi(); }),
    button('Restart', false, () => { state.t = 0; }),
    button('Mirror', state.mirror, () => { state.mirror = !state.mirror; renderUi(); }),
  ]));
  ui.append(row('SHOW', [
    button('Ghost', state.ghost, () => { state.ghost = !state.ghost; renderUi(); }),
    button('Targets', state.targets, () => { state.targets = !state.targets; renderUi(); }),
    button('Follow', state.follow, () => { state.follow = !state.follow; renderUi(); }),
  ]));
  ui.append(row('CAMERA', (['front', 'side', 'three', 'top'] as const).map((v) => button(v === 'three' ? '3/4' : v, false, () => view(v)))));
  const list = document.createElement('div');
  list.id = 'moves';
  if (state.mode === 'clip') {
    let kind = '';
    for (const c of CLIPS) {
      if (c.kind !== kind) {
        kind = c.kind;
        const g = document.createElement('div');
        g.className = 'grp';
        g.textContent = kind;
        list.append(g);
      }
      const d = document.createElement('div');
      d.textContent = `${c.id.padEnd(7)} ${c.note}`;
      if (c.id === state.clip) d.className = 'sel';
      d.addEventListener('click', () => { state.clip = c.id; state.t = 0; void load(); });
      list.append(d);
    }
  } else if (library) {
    let label = '';
    for (const m of library.moves) {
      if (m.label !== label) {
        label = m.label;
        const g = document.createElement('div');
        g.className = 'grp';
        g.textContent = `${label} (${library.moves.filter((x) => x.label === label).length})`;
        list.append(g);
      }
      const d = document.createElement('div');
      d.textContent = `${m.id.padEnd(22)} ${m.duration.toFixed(2)}s`;
      if (m.id === state.move) d.className = 'sel';
      d.addEventListener('click', () => { state.move = m.id; state.t = 0; void load(); });
      list.append(d);
    }
  }
  ui.append(list);
  list.querySelector('.sel')?.scrollIntoView({ block: 'center' });
}

// ---------------------------------------------------------------- timeline

const tl = document.getElementById('tl') as HTMLCanvasElement;
const tlCtx = tl.getContext('2d')!;
const CONTACT_ROWS: Array<[number, string]> = [
  [CONTACT.FOOT_L, 'foot L'], [CONTACT.FOOT_R, 'foot R'], [CONTACT.HAND_L, 'hand L'], [CONTACT.HAND_R, 'hand R'],
  [CONTACT.KNEE_L, 'knee L'], [CONTACT.KNEE_R, 'knee R'], [CONTACT.HIPS, 'hips'], [CONTACT.CHEST, 'chest'],
];
let contactCache: { key: string; cols: number[] } = { key: '', cols: [] };

function drawTimeline(): void {
  const dpr = Math.min(2, window.devicePixelRatio);
  const w = tl.clientWidth, h = tl.clientHeight;
  if (tl.width !== w * dpr || tl.height !== h * dpr) {
    tl.width = w * dpr;
    tl.height = h * dpr;
  }
  const ctx = tlCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!playable) return;
  const x0 = 64, x1 = w - 12, span = Math.max(1e-6, playable.duration);
  const X = (t: number) => x0 + ((x1 - x0) * t) / span;
  ctx.font = '11px JetBrains Mono, monospace';
  ctx.fillStyle = '#8b929a';
  ctx.fillText('phase', 8, 16);
  for (const b of playable.bands) {
    ctx.fillStyle = b.color;
    ctx.globalAlpha = 0.75;
    ctx.fillRect(X(b.from), 6, Math.max(1, X(b.to) - X(b.from)), 14);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#07080a';
    if (X(b.to) - X(b.from) > 50) ctx.fillText(b.label, X(b.from) + 4, 17);
  }
  // contacts: sample once per pixel column, cached per playable + mirror state
  const key = `${playable.title}:${state.mirror}:${w}`;
  if (contactCache.key !== key) {
    const cols: number[] = [];
    for (let x = x0; x <= x1; x++) cols.push(playable.contacts(((x - x0) / (x1 - x0)) * span));
    contactCache = { key, cols };
  }
  CONTACT_ROWS.forEach(([bit, name], r) => {
    const y = 26 + r * 11;
    ctx.fillStyle = '#8b929a';
    ctx.fillText(name, 8, y + 8);
    ctx.fillStyle = r < 2 ? '#ffb020' : r < 4 ? '#ff6ad5' : '#7fe0ff';
    contactCache.cols.forEach((c, i) => {
      if (c & bit) ctx.fillRect(x0 + i, y, 1, 8);
    });
  });
  for (const e of playable.events) {
    ctx.strokeStyle = '#ffffff';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(X(e.t), 4);
    ctx.lineTo(X(e.t), h - 4);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(e.label, X(e.t) + 3, h - 6);
  }
  ctx.strokeStyle = '#ffb020';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(X(state.t), 2);
  ctx.lineTo(X(state.t), h - 2);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = '#e9ecef';
  ctx.fillText(`${state.t.toFixed(2)} / ${playable.duration.toFixed(2)} s`, w - 130, h - 6);
}

tl.addEventListener('pointerdown', (ev) => {
  const scrub = (e: PointerEvent) => {
    if (!playable) return;
    const r = tl.getBoundingClientRect();
    const x0 = 64, x1 = r.width - 12;
    state.t = Math.min(playable.duration, Math.max(0, ((e.clientX - r.left - x0) / (x1 - x0)) * playable.duration));
  };
  scrub(ev);
  const move = (e: PointerEvent) => scrub(e);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

window.addEventListener('keydown', (e) => {
  if (e.key === ' ') {
    state.playing = !state.playing;
    renderUi();
  } else if (e.key === 'ArrowRight') state.t = Math.min(playable?.duration ?? 0, state.t + 1 / 60);
  else if (e.key === 'ArrowLeft') state.t = Math.max(0, state.t - 1 / 60);
});

// ---------------------------------------------------------------- loop

const followTarget = new THREE.Vector3();
const tmp = new THREE.Vector3();
let lastRoot: { pos: Vec3; yaw: number } = { pos: [0, 0, 0.9], yaw: 0 };

/** Camera presets around the robot (physics frame, z up): front faces the robot. */
function view(preset: 'front' | 'side' | 'three' | 'top' | 'back'): void {
  if (state.cam !== preset && strip.length > 1) {
    state.cam = preset; // the filmstrip lays out across the view: re-pose it first
    poseStrip();
  }
  state.cam = preset;
  const { pos, yaw } = lastRoot;
  const dir: Record<typeof preset, [number, number, number]> = {
    front: [1, 0, 0.12], side: [0, -1, 0.12], three: [0.75, -0.66, 0.25], top: [0.15, -0.1, 1.0], back: [-1, 0, 0.15],
  };
  const [dx, dy, dz] = dir[preset];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const dist = strip.length > 1 ? Math.max(state.dist, strip.length * STRIP_SPACING_M * 1.65) : state.dist;
  const side = strip.length > 1 ? 0 : state.ghost ? GHOST_SIDE_M * 0.5 : 0;
  const target = new THREE.Vector3(pos[0], pos[1] + side, Math.max(0.35, pos[2] * 0.85));
  const eye = new THREE.Vector3(target.x + dist * (c * dx - s * dy), target.y + dist * (s * dx + c * dy), target.z + dist * dz);
  studio.physicsRoot.localToWorld(target);
  studio.physicsRoot.localToWorld(eye);
  studio.controls.target.copy(target);
  studio.camera.position.copy(eye);
  followTarget.copy(target);
}

function tick(dt: number): void {
  if (playable && puppet && strip.length > 1) {
    poseStrip();
  } else if (playable && puppet) {
    if (state.playing) {
      state.t += dt * state.speed;
      if (state.t > playable.duration) state.t = state.loop ? state.t % Math.max(1e-6, playable.duration) : playable.duration;
    }
    const fr = playable.frameAt(state.t);
    puppet.pose(fr.q, fr.rootPos, fr.rootRot);
    lastRoot = { pos: fr.rootPos, yaw: playable.facing(state.t) };
    if (ghost) {
      ghost.group.visible = state.ghost && fr.ghost !== null;
      if (ghost.group.visible && fr.ghost) ghost.set(fr.ghost);
    }
    fistMarks.set(fr.targets.slice(0, 2), state.targets && fr.targets.length > 0);
    ankleMarks.set(fr.targets.slice(2, 4), state.targets && fr.targets.length > 0);
    const tgt = playable.target?.() ?? null;
    targetMarks.set(tgt ? [tgt] : [], tgt !== null);
    if (state.follow) {
      const side = state.ghost && fr.ghost ? GHOST_SIDE_M * 0.5 : 0;
      tmp.set(fr.rootPos[0], fr.rootPos[1] + side, Math.max(0.35, fr.rootPos[2] * 0.85));
      studio.physicsRoot.localToWorld(tmp);
      followTarget.lerp(tmp, Math.min(1, dt * 3));
      const d = followTarget.clone().sub(studio.controls.target);
      studio.controls.target.add(d);
      studio.camera.position.add(d);
    }
    updateRobotKit([puppet.view], null, dt);
  }
  drawTimeline();
  studio.render();
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  tick(dt);
  requestAnimationFrame(frame);
}

await load();
if (state.cam) {
  tick(0);
  view(state.cam);
}
requestAnimationFrame(frame);

/** Render frames without requestAnimationFrame (hidden tabs, automated screenshots). */
async function step(n = 1, dt = 1 / 60): Promise<void> {
  for (let i = 0; i < n; i++) {
    tick(dt);
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Jump to a time (seconds, 1× clock) and render it. */
async function seek(t: number): Promise<void> {
  state.t = t;
  const was = state.playing;
  state.playing = false;
  await step(2, 0);
  state.playing = was;
}

/**
 * Render the current frame and POST it as a PNG (width px) to a local receiver: screenshots that
 * work while the preview tab is not composited. The receiver is a dev tool, not part of the app.
 */
async function shot(name: string, width = 1400, url = RECEIVER): Promise<string> {
  await step(1, 0);
  const src = document.getElementById('c') as HTMLCanvasElement;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = Math.round((src.height * width) / src.width);
  const g = out.getContext('2d')!;
  studio.render();
  g.drawImage(src, 0, 0, out.width, out.height);
  return post(out, name, url);
}

const RECEIVER = 'http://127.0.0.1:5399/save';

async function post(canvas: HTMLCanvasElement, name: string, url: string): Promise<string> {
  const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/png'));
  const r = await fetch(`${url}?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
  return r.text();
}

/**
 * Contact sheet of the current playable: one tile per time (default the move's key times), the
 * camera re-centred on the robot in every tile, each labelled with time and phase. Clearer than a
 * filmstrip for judging a pose, and one image per move.
 */
async function sheet(name: string, opts: { times?: number[]; cam?: 'front' | 'side' | 'three' | 'top' | 'back'; cols?: number; tileW?: number; dist?: number } = {}, url = RECEIVER): Promise<string> {
  if (!playable) throw new Error('nothing loaded');
  const times = opts.times ?? playable.keyTimes ?? Array.from({ length: 6 }, (_, k) => (playable!.duration * k) / 5);
  const cols = opts.cols ?? Math.min(4, times.length);
  const rows = Math.ceil(times.length / cols);
  const src = document.getElementById('c') as HTMLCanvasElement;
  const tileW = opts.tileW ?? 440;
  const tileH = Math.round((tileW * src.height) / src.width);
  const out = document.createElement('canvas');
  out.width = cols * tileW;
  out.height = rows * tileH;
  const g = out.getContext('2d')!;
  g.fillStyle = '#07080a';
  g.fillRect(0, 0, out.width, out.height);
  const saved = { strip: strip.length, dist: state.dist, playing: state.playing, t: state.t, ghost: state.ghost };
  const hidden = strip;
  for (const p of hidden) p.root.visible = false;
  strip = [];
  state.playing = false;
  state.dist = opts.dist ?? 3.4;
  if (puppet) puppet.root.visible = true;
  for (let k = 0; k < times.length; k++) {
    state.t = times[k];
    tick(0);
    view(opts.cam ?? 'three');
    // Same capture sequence as shot(): render, yield once, render again and copy in that task (a
    // WebGPU canvas is only readable in the task that drew it).
    await step(1, 0);
    studio.render();
    const x = (k % cols) * tileW, y = Math.floor(k / cols) * tileH;
    g.drawImage(src, x, y, tileW, tileH);
    g.fillStyle = '#e9ecef';
    g.font = '600 15px JetBrains Mono, monospace';
    const band = playable.bands.find((b) => times[k] >= b.from - 1e-6 && times[k] <= b.to + 1e-6);
    g.fillText(`${times[k].toFixed(2)} s ${band ? band.label : ''}`, x + 10, y + 22);
    if (k === 0) g.fillText(playable.title, x + 10, y + tileH - 12);
  }
  strip = hidden;
  for (const p of strip) p.root.visible = true;
  Object.assign(state, { dist: saved.dist, playing: saved.playing, t: saved.t, ghost: saved.ghost });
  return post(out, name, url);
}

// Handy for automated checks from the console.
Object.assign(window, { motions: { state, load, step, seek, view, shot, sheet, studio, playable: () => playable, library: () => library, mulMtV, sub } });
