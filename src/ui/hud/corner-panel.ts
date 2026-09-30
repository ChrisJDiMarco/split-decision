// One corner's stack: the MIND panel (JEV / LOCAL / HOUSE) on top, damage silhouette + power/heat/gyro meters below.
import type { RobotTelemetry } from '../../core/protocol';
import type { Corner, RobotDesign } from '../../core/types';
import { h, meter, setText, toggleClass } from '../dom';
import type { MindView } from '../minds';
import { MindPanel } from './mind-panel';
import { DamageSilhouette } from './silhouette';

const WARN = 0.65;
const CRIT = 0.85;
const BATTERY_WARN = 0.3;
const BATTERY_CRIT = 0.15;

function level(m: { el: HTMLElement }, warn: boolean, crit: boolean): void {
  toggleClass(m.el, 'warn', warn && !crit);
  toggleClass(m.el, 'crit', crit);
}

export class CornerPanel {
  readonly el: HTMLElement;
  private mind: MindPanel;
  private silhouette: DamageSilhouette;
  private battery = meter('BATTERY');
  private heat = meter('HEAT');
  private gyro = meter('GYRO SAT');
  private hyd = meter('HYD PRESS');
  private skill: HTMLElement;
  private state: HTMLElement;
  private hasGyro: boolean;
  private hasHyd: boolean;

  /** `mindName`: the mind picked for this corner (JEV, LOCAL, HOUSE), shown until its first decision. */
  constructor(corner: Corner, design: RobotDesign, mindName = '') {
    this.mind = new MindPanel(mindName);
    this.silhouette = new DamageSilhouette(design);
    this.hasGyro = !!design.gyro;
    this.hasHyd = !!design.hydraulics?.length;
    this.skill = h('b', {}, 'STANCE');
    this.state = h('span', {}, 'STANDING');
    const meters = h('div', 'body-meters',
      this.battery.el, this.heat.el,
      this.hasGyro ? this.gyro.el : null,
      this.hasHyd ? this.hyd.el : null,
      h('div', 'body-status', h('span', {}, 'SKILL ', this.skill), this.state),
    );
    if (!this.hasGyro) this.gyro.set(0, 'NONE');
    const body = h('div', 'panel body-panel', this.silhouette.el, meters);
    this.el = h('div', `corner-stack c${corner}`, this.mind.el, body);
  }

  update(t: RobotTelemetry | null, mind: MindView | null): void {
    this.mind.update(mind, t?.referee ?? null);
    if (!t) return;
    this.silhouette.update(t);
    this.battery.set(t.battery);
    level(this.battery, t.battery < BATTERY_WARN, t.battery < BATTERY_CRIT);
    const heat = t.parts.reduce((m, p) => Math.max(m, p.heat), 0);
    this.heat.set(heat);
    level(this.heat, heat > WARN, heat > CRIT);
    if (this.hasGyro) {
      this.gyro.set(t.gyroSaturation, t.gyroHealth < 0.05 ? 'DEAD' : undefined);
      level(this.gyro, t.gyroSaturation > WARN, t.gyroSaturation > CRIT || t.gyroHealth < 0.3);
    }
    if (this.hasHyd) {
      const pressures = Object.values(t.hydraulicPressure);
      const p = pressures.length ? Math.min(...pressures) : 1;
      this.hyd.set(p);
      level(this.hyd, p < 0.6, p < 0.3);
    }
    setText(this.skill, t.skill.replace(/_/g, ' ').toUpperCase() || '—');
    setText(this.state, t.down ? 'DOWN' : t.upright < 0.6 ? 'STAGGERED' : 'STANDING');
    toggleClass(this.state, 'down', t.down);
  }
}
