// Player HUD: your robot (damage silhouette, battery, heat, gyro saturation, the move standing
// and the strike buffer), the opponent's JEV MIND + body (the broadcast's CornerPanel, reused
// as is), the fight bar, a lock-on reticle, hit markers, a hurt flash and the key hints with
// click-to-rebind. Reuses the broadcast's HUD components and tokens read-only.
import '../ui/broadcast.css';
import './player.css';
import * as THREE from 'three/webgpu';
import type { RobotTelemetry, SimEvent } from '../core/protocol';
import type { Corner, RobotDesign, Vec3 } from '../core/types';
import { h, meter, setText, toggleClass } from '../ui/dom';
import { CornerPanel } from '../ui/hud/corner-panel';
import { FightBar } from '../ui/hud/fight-bar';
import { DamageSilhouette } from '../ui/hud/silhouette';
import type { MindView } from '../ui/minds';
import { tacticLabel } from '../ui/minds';
import { hitStrength } from '../render/vfx/scaling';
import { STRIKE_ACTIONS, type DriverView } from './driver';
import { ACTION_LABEL, bindingLabel, type ActionId, type Keymap } from './keymap';

const WARN = 0.65;
const CRIT = 0.85;
const HIT_MARKER_S = 0.45;
const HURT_S = 0.35;
/** The FIGHT! flash when a referee break ends. */
const FIGHT_FLASH_S = 0.9;
const BREAK_TEXT: Record<'down' | 'neutral' | 'hold', [string, string]> = {
  down: ['BREAK', 'GET UP · SPACE KIP-UP'],
  neutral: ['BREAK', 'GIVE HIM ROOM · WAIT FOR FIGHT'],
  hold: ['BREAK', 'WAIT FOR FIGHT'],
};
const HINT_GROUPS: Array<[string, ActionId[]]> = [
  ['MOVE', ['move_forward', 'move_back', 'move_left', 'move_right']],
  ['HANDS', ['jab', 'cross', 'hook_lead', 'hook_rear', 'uppercut', 'overhand']],
  ['LEGS', ['front_kick', 'low_kick', 'head_kick']],
  ['FLASH', ['tornado_kick', 'spinning_backfist']],
  ['DEFENCE', ['guard', 'slip', 'clinch', 'feint']],
  ['VIEW', ['aim_body', 'toggle_camera', 'toggle_hints']],
];

export interface HudCallbacks {
  /** A binding chip was clicked: capture the next input for this action. */
  onRebind(action: ActionId): void;
  onResetKeys(): void;
}

export class PlayerHud {
  readonly el: HTMLElement;
  private fightBar = new FightBar();
  private opp: CornerPanel;
  private silhouette: DamageSilhouette;
  private battery = meter('BATTERY');
  private heat = meter('HEAT');
  private gyro = meter('GYRO SAT');
  private hasGyro: boolean;
  private now: HTMLElement;
  private buffer: HTMLElement;
  private state: HTMLElement;
  private camChip: HTMLElement;
  private aimChip: HTMLElement;
  private latencyChip: HTMLElement;
  private reticle: HTMLElement;
  private marker: HTMLElement;
  private hurt: HTMLElement;
  private prompt: HTMLElement;
  private breakBand: HTMLElement;
  private fightT = 0;
  private hints: HTMLElement;
  private hintRows = new Map<ActionId, HTMLElement>();
  private markerT = 0;
  private hurtT = 0;
  private lastBufferKey = '';
  private readonly v = new THREE.Vector3();

  /** `fightBar: false` when the host already shows one (the broadcast in main.ts). */
  constructor(readonly corner: Corner, private readonly me: RobotDesign, oppDesign: RobotDesign, private readonly cb: HudCallbacks, fightBar = true) {
    const oppCorner: Corner = corner === 0 ? 1 : 0;
    this.opp = new CornerPanel(oppCorner, oppDesign);
    this.opp.el.classList.add('ph-opp');
    this.silhouette = new DamageSilhouette(me);
    this.hasGyro = !!me.gyro;
    if (!this.hasGyro) this.gyro.set(0, 'NONE');
    this.now = h('b', 'ph-now', 'STANCE');
    this.buffer = h('div', 'ph-buffer');
    this.state = h('span', 'ph-state', 'STANDING');
    this.camChip = h('span', 'chip', 'CAM · CHASE');
    this.aimChip = h('span', 'chip', 'AIM · HEAD');
    this.latencyChip = h('span', 'chip', 'INPUT — ms');
    const head = h('div', 'panel-head',
      h('div', 'panel-title', 'YOU · ', h('em', {}, me.name)),
      h('div', 'ph-chips', this.aimChip, this.camChip),
    );
    const meters = h('div', 'body-meters', this.battery.el, this.heat.el, this.hasGyro ? this.gyro.el : null,
      h('div', 'ph-move', h('span', {}, 'MOVE '), this.now), this.buffer,
      h('div', 'body-status', this.latencyChip, this.state));
    const mine = h('div', `corner-stack c${corner} ph-me`, h('div', 'panel', head, h('div', 'body-panel', this.silhouette.el, meters)));
    this.reticle = h('div', `ph-reticle c${oppCorner}`, h('i'), h('i'), h('i'), h('i'));
    this.marker = h('div', 'ph-marker', '');
    this.hurt = h('div', 'ph-hurt');
    this.prompt = h('div', 'ph-prompt', h('b', {}, 'CLICK'), ' to take control · ', h('b', {}, 'H'), ' keys · ', h('b', {}, 'ESC'), ' releases the mouse');
    this.hints = this.buildHints();
    this.breakBand = h('div', 'ph-break hidden');
    this.el = h('div', 'player-hud', this.hurt, fightBar ? this.fightBar.el : null, this.reticle, this.marker, this.breakBand, mine, this.opp.el, this.prompt, this.hints);
  }

  setNames(names: readonly [string, string], subs: readonly [string, string]): void {
    this.fightBar.setFighters(names, subs);
  }

  setClock(label: string, state: string): void {
    this.fightBar.setClock(1, 1, label, state);
  }

  setKeymap(map: Keymap, capturing: ActionId | null): void {
    for (const [action, row] of this.hintRows) {
      const chip = row.querySelector('.ph-key') as HTMLElement;
      setText(chip, capturing === action ? 'PRESS A KEY…' : map[action].map(bindingLabel).join(' / ') || '—');
      toggleClass(row, 'capturing', capturing === action);
    }
  }

  showHints(on: boolean): void {
    toggleClass(this.hints, 'open', on);
  }

  hintsOpen(): boolean {
    return this.hints.classList.contains('open');
  }

  setLocked(locked: boolean): void {
    toggleClass(this.prompt, 'hidden', locked);
  }

  /** The referee's break: a BREAK band with what to do (null: fighting; `fight` flashes FIGHT! as it ends). */
  setBreak(role: 'down' | 'neutral' | 'hold' | null, fight = false): void {
    if (role) {
      const [title, sub] = BREAK_TEXT[role];
      this.breakBand.replaceChildren(h('b', {}, title), h('span', {}, sub));
      this.fightT = 0;
    } else if (fight) {
      this.breakBand.replaceChildren(h('b', {}, 'FIGHT!'));
      this.fightT = FIGHT_FLASH_S;
    }
    toggleClass(this.breakBand, 'hidden', !role && !fight);
    toggleClass(this.breakBand, 'fight', !role && fight);
  }

  setCamera(label: string): void {
    setText(this.camChip, `CAM · ${label}`);
  }

  setLatency(ms: number | null): void {
    setText(this.latencyChip, ms === null ? 'INPUT — ms' : `INPUT ${Math.round(ms)} ms`);
  }

  /** Landed hits by me flash the marker; hits on me flash the edges. */
  onEvents(events: readonly SimEvent[]): void {
    for (const e of events) {
      if (e.kind !== 'impact' || e.striker === null || e.victim === null || e.striker === e.victim) continue;
      const s = hitStrength(e.energyJ, e.impulseNs, e.speed);
      if (e.striker === this.corner) {
        this.markerT = HIT_MARKER_S;
        setText(this.marker, `${s > 0.66 ? 'CRUSHING' : s > 0.33 ? 'CLEAN' : 'TAG'} · ${Math.round(e.energyJ)} J`);
        toggleClass(this.marker, 'big', s > 0.66);
      } else if (e.victim === this.corner) {
        this.hurtT = Math.max(this.hurtT, HURT_S * (0.4 + s));
      }
    }
  }

  update(dt: number, tel: readonly [RobotTelemetry, RobotTelemetry] | null, oppMind: MindView | null, driver: DriverView): void {
    this.fightBar.update(tel);
    const me = tel?.[this.corner] ?? null;
    this.opp.update(tel?.[this.corner === 0 ? 1 : 0] ?? null, oppMind);
    if (me) {
      this.silhouette.update(me);
      this.battery.set(me.battery);
      level(this.battery.el, me.battery < 0.3, me.battery < 0.15);
      const heat = me.parts.reduce((m, p) => Math.max(m, p.heat), 0);
      this.heat.set(heat);
      level(this.heat.el, heat > WARN, heat > CRIT);
      if (this.hasGyro) {
        this.gyro.set(me.gyroSaturation, me.gyroHealth < 0.05 ? 'DEAD' : undefined);
        level(this.gyro.el, me.gyroSaturation > WARN, me.gyroSaturation > CRIT);
      }
      setText(this.state, me.skill === 'out' ? 'KO' : me.down ? 'DOWN · SPACE KIP-UP' : me.upright < 0.6 ? 'STAGGERED' : 'STANDING');
      toggleClass(this.state, 'down', me.down);
      const body = me.skill && me.skill !== 'stance' && me.skill !== 'step' ? me.skill : driver.current ?? 'stance';
      setText(this.now, tacticLabel(body));
    }
    setText(this.aimChip, `AIM · ${driver.aimBody ? 'BODY' : 'HEAD'}`);
    const key = `${driver.combo?.join('+') ?? ''}|${driver.buffer.join('+')}`;
    if (key !== this.lastBufferKey) {
      this.lastBufferKey = key;
      const chips = [
        ...(driver.combo ? [h('span', 'ph-combo', `COMBO ${driver.combo.map(tacticLabel).join(' › ')}`)] : []),
        ...driver.buffer.map((t) => h('span', 'chip ph-queued', tacticLabel(t))),
      ];
      this.buffer.replaceChildren(...(chips.length ? chips : [h('span', 'ph-empty', 'BUFFER EMPTY')]));
    }
    if (this.fightT > 0) {
      this.fightT = Math.max(0, this.fightT - dt);
      if (this.fightT === 0) toggleClass(this.breakBand, 'hidden', true);
    }
    this.markerT = Math.max(0, this.markerT - dt);
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.marker.style.opacity = (this.markerT / HIT_MARKER_S).toFixed(3);
    this.hurt.style.opacity = Math.min(1, this.hurtT / HURT_S).toFixed(3);
  }

  /** Lock-on reticle over the opponent's chest (physics point → screen), hidden when behind the lens. */
  placeReticle(point: Vec3 | null, physicsRoot: THREE.Object3D, camera: THREE.Camera, visible: boolean): void {
    if (!point || !visible) {
      toggleClass(this.reticle, 'hidden', true);
      return;
    }
    physicsRoot.updateMatrixWorld();
    physicsRoot.localToWorld(this.v.set(point[0], point[1], point[2])).project(camera);
    const behind = this.v.z > 1;
    toggleClass(this.reticle, 'hidden', behind);
    if (behind) return;
    const x = (this.v.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this.v.y * 0.5 + 0.5) * window.innerHeight;
    this.reticle.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  dispose(): void {
    this.el.remove();
  }

  private buildHints(): HTMLElement {
    const groups = HINT_GROUPS.map(([title, actions]) => h('div', 'ph-hint-group',
      h('div', 'ph-hint-title', title),
      ...actions.map((a) => {
        const chip = h('button', 'ph-key', '—');
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          chip.blur(); // a focused button would re-open the capture on Enter (the rematch key)
          this.cb.onRebind(a);
        });
        // A move this robot doesn't have: control throws a stand-in strike (a clinch is not sent at all).
        const needs = a === 'clinch' ? 'clinch' : a === 'tornado_kick' || a === 'spinning_backfist' ? null : STRIKE_ACTIONS[a as keyof typeof STRIKE_ACTIONS]?.tactic;
        const missing = !!needs && !(this.me.abilities as readonly string[]).includes(needs);
        const attrs = missing ? { class: 'ph-hint na', title: `${this.me.name} has no ${needs}: ${a === 'clinch' ? 'nothing is sent' : 'it throws a stand-in strike'}` } : 'ph-hint';
        const row = h('div', attrs, h('span', {}, ACTION_LABEL[a], missing ? h('small', {}, ' · N/A') : null), chip);
        this.hintRows.set(a, row);
        return row;
      }),
    ));
    const reset = h('button', 'ph-reset', 'RESET KEYS');
    reset.addEventListener('click', (e) => {
      e.stopPropagation();
      reset.blur();
      this.cb.onResetKeys();
    });
    return h('div', 'ph-hints panel',
      h('div', 'panel-head', h('div', 'panel-title', 'CONTROLS'), h('span', 'chip', 'CLICK A KEY TO REBIND')),
      h('div', 'ph-hint-grid', ...groups),
      h('div', 'ph-hint-foot', h('span', {}, 'Strikes pressed within 0.25 s chain into a combo. W/S/A/D move relative to him (lock-on). Mouse orbits the camera.'), reset),
    );
  }
}

function level(el: HTMLElement, warn: boolean, crit: boolean): void {
  toggleClass(el, 'warn', warn && !crit);
  toggleClass(el, 'crit', crit);
}
