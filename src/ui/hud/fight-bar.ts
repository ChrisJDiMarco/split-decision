// Top-center fight bar: corner names, structural integrity with a trailing damage ghost,
// and the round clock.
import type { RobotTelemetry } from '../../core/protocol';
import type { Corner } from '../../core/types';
import { h, setFill, setText, toggleClass } from '../dom';

const LOW_INTEGRITY = 0.3;

interface Side { health: HTMLElement; live: HTMLElement; ghost: HTMLElement; name: HTMLElement; sub: HTMLElement }

export class FightBar {
  readonly el: HTMLElement;
  private sides: Side[] = [];
  private round: HTMLElement;
  private time: HTMLElement;
  private state: HTMLElement;

  constructor() {
    this.round = h('div', 'fb-round', 'ROUND 1');
    this.time = h('div', 'fb-time', '2:00');
    this.state = h('div', 'fb-state', '');
    const clock = h('div', 'fb-clock', this.round, this.time, this.state);
    const side = (c: Corner) => {
      const live = h('i', 'live');
      const ghost = h('i', 'ghost');
      const health = h('div', 'fb-health', ghost, live);
      const name = h('span', 'fb-name', '—');
      const sub = h('span', 'fb-sub', '');
      this.sides[c] = { health, live, ghost, name, sub };
      return h('div', `fb-side c${c}`, h('div', 'fb-name-row', name, sub), health);
    };
    this.el = h('div', 'fight-bar', side(0), clock, side(1));
    for (const s of this.sides) { setFill(s.live, 1); setFill(s.ghost, 1); }
  }

  setFighters(names: readonly [string, string], subs: readonly [string, string]): void {
    this.sides.forEach((s, i) => {
      setText(s.name, names[i]);
      setText(s.sub, subs[i]);
      setFill(s.live, 1);
      setFill(s.ghost, 1);
    });
  }

  update(telemetry: readonly RobotTelemetry[] | null): void {
    if (!telemetry) return;
    for (const t of telemetry) {
      const s = this.sides[t.corner];
      const integrity = 1 - t.damageTotal;
      setFill(s.live, integrity);
      setFill(s.ghost, integrity);
      toggleClass(s.health, 'low', integrity < LOW_INTEGRITY);
    }
  }

  setClock(round: number, rounds: number, label: string, state: string): void {
    setText(this.round, `ROUND ${round} / ${rounds}`);
    setText(this.time, label);
    setText(this.state, state);
  }
}
