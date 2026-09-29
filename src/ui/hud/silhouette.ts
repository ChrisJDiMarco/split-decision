// Damage silhouette: the design's zero pose drawn as SVG, each part colored by hp,
// detached parts greyed and flagged, joints dotted by state, smoke and leaks animated.
// Bipeds are drawn from the front, everything else from the side.
import type { JointState, RobotTelemetry } from '../../core/protocol';
import type { GeomDef, RobotDesign, Vec3 } from '../../core/types';
import { addV, rotate } from '../../robots/compile-mjcf';
import { svg, toggleClass } from '../dom';
import { geomPoints, partPoses, type PartPose } from '../kinematics';

const PAD_M = 0.08;
const JOINT_DOT_R = 0.03;
const SMOKE_ON = 0.3;
const HOT = 0.6;
const LEAK_ON = 0.01;
const GONE_FILL = '#3a3c40';

type Project = (p: Vec3) => [number, number];

interface PartView {
  g: SVGGElement;
  shapes: SVGElement[];
  joint: SVGCircleElement | null;
  jointNames: string[];
  center: [number, number];
  top: [number, number];
  fx: SVGGElement; // smoke / leak / flag layer for this part
  key: string;
}

/** hp 1 → steel white, 0.5 → amber, 0.15 → red, 0 → dark red. */
export function hpColor(hp: number): string {
  const stops: Array<[number, [number, number, number]]> = [
    [0, [110, 18, 14]], [0.15, [255, 59, 47]], [0.5, [255, 176, 32]], [0.8, [217, 221, 227]], [1, [217, 221, 227]],
  ];
  const x = Math.max(0, Math.min(1, hp));
  for (let i = 1; i < stops.length; i++) {
    const [x1, c1] = stops[i];
    if (x > x1) continue;
    const [x0, c0] = stops[i - 1];
    const u = (x - x0) / Math.max(1e-6, x1 - x0);
    const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * u));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  return 'rgb(217,221,227)';
}

function hull(points: Array<[number, number]>): Array<[number, number]> {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function geomShape(g: GeomDef, pose: PartPose, project: Project): SVGElement {
  const { points, radius } = geomPoints(g);
  const world = points.map((p) => project(addV(pose.pos, rotate(pose.quat, p))));
  const s = g.shape;
  if (s.type === 'box') {
    return svg('polygon', { class: 'part', points: hull(world).map((p) => p.map((v) => v.toFixed(4)).join(',')).join(' ') });
  }
  if (s.type === 'sphere') {
    return svg('circle', { class: 'part', cx: world[0][0], cy: world[0][1], r: radius });
  }
  // capsule / cylinder: a thick round-capped outline stroke under a fill stroke
  const [a, b] = world;
  const d = `M${a[0].toFixed(4)},${a[1].toFixed(4)} L${b[0].toFixed(4)},${b[1].toFixed(4)}`;
  // Inline style, not attributes: CSS rules on .part would otherwise win over them.
  const line = svg('path', { class: 'part limb', d });
  line.style.strokeWidth = String(radius * 2);
  line.style.strokeLinecap = s.type === 'capsule' ? 'round' : 'butt';
  return line;
}

export class DamageSilhouette {
  readonly el: SVGSVGElement;
  private parts = new Map<string, PartView>();

  constructor(design: RobotDesign) {
    const front = design.bodyType === 'biped';
    // screen x: front view looks at the robot's face (its left on our right); side view faces right.
    const project: Project = front ? (p) => [-p[1], -p[2]] : (p) => [p[0], -p[2]];
    const poses = partPoses(design);
    this.el = svg('svg', { class: 'silhouette', 'aria-label': `${design.name} damage` });
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const depth = (id: string) => (front ? poses.get(id)!.pos[0] : -poses.get(id)!.pos[1]);
    const ordered = [...design.parts].sort((a, b) => depth(a.id) - depth(b.id));
    const body = svg('g');
    const fxLayer = svg('g');
    for (const p of ordered) {
      const pose = poses.get(p.id)!;
      const g = svg('g', { 'data-part': p.id });
      const shapes = p.geoms.map((geom) => geomShape(geom, pose, project));
      for (const sh of shapes) g.append(sh);
      body.append(g);
      const pts: Array<[number, number]> = [];
      for (const geom of p.geoms) {
        const { points, radius } = geomPoints(geom);
        for (const pt of points) {
          const [x, y] = project(addV(pose.pos, rotate(pose.quat, pt)));
          pts.push([x, y]);
          minX = Math.min(minX, x - radius); maxX = Math.max(maxX, x + radius);
          minY = Math.min(minY, y - radius); maxY = Math.max(maxY, y + radius);
        }
      }
      const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length;
      const cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
      const top = pts.reduce((best, q) => (q[1] < best[1] ? q : best), pts[0]);
      const jointNames = (p.joints ?? []).map((j) => j.name);
      let joint: SVGCircleElement | null = null;
      if (jointNames.length) {
        const [jx, jy] = project(pose.pos);
        joint = svg('circle', { class: 'joint', cx: jx, cy: jy, r: JOINT_DOT_R });
      }
      const fx = svg('g');
      fxLayer.append(fx);
      this.parts.set(p.id, { g, shapes, joint, jointNames, center: [cx, cy], top: [top[0], top[1]], fx, key: '' });
    }
    const joints = svg('g');
    for (const v of this.parts.values()) if (v.joint) joints.append(v.joint);
    this.el.append(body, joints, fxLayer);
    const w = maxX - minX + PAD_M * 2;
    const hgt = maxY - minY + PAD_M * 2;
    this.el.setAttribute('viewBox', `${(minX - PAD_M).toFixed(3)} ${(minY - PAD_M).toFixed(3)} ${w.toFixed(3)} ${hgt.toFixed(3)}`);
    this.el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }

  update(t: RobotTelemetry): void {
    const jointState = new Map<string, JointState>();
    for (const j of t.joints) jointState.set(j.name, j.state);
    for (const p of t.parts) {
      const v = this.parts.get(p.id);
      if (!v) continue;
      const states = v.jointNames.map((n) => jointState.get(n) ?? 'ok');
      const worst = worstState(states);
      const smoking = p.smoke >= SMOKE_ON;
      const leaking = p.leak >= LEAK_ON;
      const key = `${Math.round(p.hp * 40)}|${p.attached}|${smoking}|${p.heat >= HOT}|${leaking}|${worst}`;
      if (key === v.key) continue;
      v.key = key;
      this.paint(v, p.hp, p.attached, smoking, p.heat >= HOT, leaking, worst);
    }
  }

  private paint(v: PartView, hp: number, attached: boolean, smoking: boolean, hot: boolean, leaking: boolean, worst: JointState): void {
    const color = hpColor(hp);
    for (const sh of v.shapes) {
      if (sh.classList.contains('limb')) sh.style.stroke = attached ? color : GONE_FILL;
      else sh.style.fill = attached ? color : GONE_FILL;
    }
    toggleClass(v.g, 'gone', !attached);
    toggleClass(v.g, 'hot', attached && hot);
    if (v.joint) v.joint.setAttribute('class', `joint ${attached ? worst : ''}`);
    v.fx.replaceChildren();
    if (!attached) {
      const flag = svg('text', { class: 'flag', x: v.center[0] + 0.05, y: v.center[1], 'dominant-baseline': 'middle' });
      flag.textContent = '✕ OFF';
      v.fx.append(flag);
      return;
    }
    if (smoking) {
      for (let i = 0; i < 2; i++) {
        const c = svg('circle', { class: 'smoke', cx: v.top[0] + (i ? 0.03 : -0.02), cy: v.top[1] - 0.03, r: 0.04 });
        c.style.animationDelay = `${i * 0.7}s`;
        v.fx.append(c);
      }
    }
    if (leaking) v.fx.append(svg('circle', { class: 'leak', cx: v.center[0], cy: v.center[1] + 0.04, r: 0.018 }));
  }
}

const SEVERITY: Record<JointState, number> = { ok: 0, degraded: 1, limp: 2, seized: 3 };

function worstState(states: JointState[]): JointState {
  return states.reduce<JointState>((w, s) => (SEVERITY[s] > SEVERITY[w] ? s : w), 'ok');
}
