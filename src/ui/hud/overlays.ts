// Full-screen broadcast moments: tale of the tape, round cards, the referee's break banner, the KO
// band, the replay treatment (letterbox, bug, progress) and the winner card.
import type { Corner } from '../../core/types';
import { h, setFill } from '../dom';
import type { CornerStats } from '../scorecard';
import { portraitUrl } from '../skins';
import type { BreakBanner } from '../referee-view';
import type { Tale } from '../tale';

export interface WinnerInfo {
  winner: Corner | null; // null = draw
  names: readonly [string, string];
  designIds: readonly [string, string];
  method: string; // 'KO · HEAD REMOVED', 'SPLIT DECISION'
  detail: string; // 'ROUND 2 · 1:14'
  cards?: Array<[number, number]>;
  stats: readonly [CornerStats, CornerStats];
}

interface TapeRow { key: string; values: [string, string]; nums?: [number, number] }

function tapeRows(t: readonly [Tale, Tale]): TapeRow[] {
  const n = (f: (x: Tale) => number): [number, number] => [f(t[0]), f(t[1])];
  return [
    { key: 'MASS', values: [`${Math.round(t[0].massKg)} kg`, `${Math.round(t[1].massKg)} kg`], nums: n((x) => x.massKg) },
    { key: 'HEIGHT', values: [`${t[0].heightM.toFixed(2)} m`, `${t[1].heightM.toFixed(2)} m`], nums: n((x) => x.heightM) },
    { key: 'PEAK TORQUE', values: [`${Math.round(t[0].peakTorqueNm)} N·m`, `${Math.round(t[1].peakTorqueNm)} N·m`], nums: n((x) => x.peakTorqueNm) },
    { key: 'ARMOR', values: [t[0].armor, t[1].armor] },
    { key: 'GYRO', values: [t[0].gyro, t[1].gyro] },
    { key: 'HYDRAULICS', values: [t[0].hydraulics, t[1].hydraulics] },
    { key: 'ACTUATED DOF', values: [String(t[0].dof), String(t[1].dof)], nums: n((x) => x.dof) },
  ];
}

export function statTable(rows: TapeRow[]): HTMLElement {
  const table = h('div', 'stat-table');
  for (const r of rows) {
    const best = r.nums ? (r.nums[0] > r.nums[1] ? 0 : r.nums[1] > r.nums[0] ? 1 : -1) : -1;
    table.append(
      h('div', `l ${best === 0 ? 'best' : ''}`, r.values[0]),
      h('div', 'k', r.key),
      h('div', `r ${best === 1 ? 'best' : ''}`, r.values[1]),
    );
  }
  return table;
}

function portrait(cls: string, designId: string): HTMLElement {
  const el = h('div', cls);
  const url = portraitUrl(designId);
  if (url) el.style.backgroundImage = `url("${url}")`;
  return el;
}

export class Overlays {
  readonly el: HTMLElement;
  private tape: HTMLElement | null = null;
  private ko: HTMLElement | null = null;
  private winner: HTMLElement | null = null;
  private replay: { root: HTMLElement; fill: HTMLElement } | null = null;
  private brk: { root: HTMLElement; count: HTMLElement; title: HTMLElement; sub: HTMLElement; key: string } | null = null;

  constructor() {
    this.el = h('div', 'bc-layer overlays');
  }

  clear(): void {
    this.el.replaceChildren();
    this.tape = this.ko = this.winner = null;
    this.replay = null;
    this.brk = null;
  }

  showTape(tales: readonly [Tale, Tale]): void {
    this.hideTape();
    const mid = h('div', 'tape-mid',
      h('div', 'tape-title', 'TALE OF THE TAPE'),
      h('div', 'tape-names', h('b', 'c0', tales[0].name), h('span', {}, 'VS'), h('b', 'c1', tales[1].name)),
      statTable(tapeRows(tales)),
    );
    this.tape = h('div', 'tape', portrait('tape-portrait c0', tales[0].id), mid, portrait('tape-portrait c1', tales[1].id));
    this.el.append(this.tape);
  }

  hideTape(): void {
    this.tape?.remove();
    this.tape = null;
  }

  roundCard(title: string, sub: string, ms: number, cls = ''): void {
    const el = h('div', `round-card${cls ? ` ${cls}` : ''}`, h('h1', {}, title), sub ? h('p', {}, sub) : null);
    this.el.append(el);
    setTimeout(() => el.remove(), ms);
  }

  /** The referee's break banner with the count; updated in place (null hides it). */
  setBreak(b: BreakBanner | null): void {
    if (!b) {
      this.brk?.root.remove();
      this.brk = null;
      return;
    }
    if (!this.brk) {
      const count = h('b', 'ref-count', '');
      const title = h('div', 'ref-title', '');
      const sub = h('div', 'ref-sub', '');
      const root = h('div', 'ref-banner', h('div', 'ref-clock', count, h('span', {}, 'COUNT')), h('div', 'ref-text', title, sub));
      this.brk = { root, count, title, sub, key: '' };
      this.el.append(root);
    }
    const key = `${b.count}|${b.title}|${b.sub}|${b.corner}`;
    if (key === this.brk.key) return;
    this.brk.key = key;
    this.brk.count.textContent = String(b.count);
    this.brk.title.textContent = b.title;
    this.brk.sub.textContent = b.sub;
    this.brk.root.className = `ref-banner${b.corner === null ? ' both' : ` c${b.corner}`}`;
  }

  showKO(loser: Corner, reason: string, when: string): void {
    this.hideKO();
    const winner = loser === 0 ? 1 : 0;
    this.ko = h('div', `ko-band c${winner}`,
      h('h1', {}, 'K.O.'),
      h('div', 'ko-meta', h('div', 'ko-reason', reason), h('div', 'ko-time', when)),
    );
    this.el.append(this.ko);
  }

  hideKO(): void {
    this.ko?.remove();
    this.ko = null;
  }

  showReplay(label: string): void {
    this.hideReplay();
    const fill = h('i');
    const root = h('div', 'bc-layer letterbox',
      h('div', 'vignette'),
      h('div', 'replay-bug', h('i'), 'REPLAY', h('span', {}, label)),
      h('div', 'replay-progress', fill),
      h('div', 'replay-skip', 'P / ESC TO SKIP'),
    );
    this.replay = { root, fill };
    this.el.append(root);
  }

  setReplayProgress(v: number): void {
    if (this.replay) setFill(this.replay.fill, v);
  }

  hideReplay(): void {
    this.replay?.root.remove();
    this.replay = null;
  }

  showWinner(info: WinnerInfo, actions: { rematch(): void; newFight(): void }): void {
    this.hideWinner();
    const w = info.winner;
    const kicker = w === null ? 'THE JUDGES SCORE IT A' : 'AND THE WINNER';
    const name = w === null ? h('h2', 'wc-name', 'DRAW') : h('h2', 'wc-name', info.names[w]);
    const cards = info.cards
      ? h('div', 'wc-cards', ...info.cards.map((c, i) => h('div', {}, h('span', {}, `JUDGE ${i + 1}`), h('b', {}, `${c[0]}–${c[1]}`))))
      : null;
    const s = info.stats;
    const stats = statTable([
      { key: 'SIG. STRIKES', values: [String(s[0].strikes), String(s[1].strikes)], nums: [s[0].strikes, s[1].strikes] },
      { key: 'PEAK HIT', values: [`${Math.round(s[0].peakHitJ)} J`, `${Math.round(s[1].peakHitJ)} J`], nums: [s[0].peakHitJ, s[1].peakHitJ] },
      { key: 'KNOCKDOWNS', values: [String(s[0].knockdowns), String(s[1].knockdowns)], nums: [s[0].knockdowns, s[1].knockdowns] },
      { key: 'PARTS REMOVED', values: [String(s[0].partsRemoved), String(s[1].partsRemoved)], nums: [s[0].partsRemoved, s[1].partsRemoved] },
      { key: 'DAMAGE DEALT', values: [`${Math.round(s[0].damageDealt * 100)}%`, `${Math.round(s[1].damageDealt * 100)}%`], nums: [s[0].damageDealt, s[1].damageDealt] },
    ]);
    const rematch = h('button', 'btn primary', 'REMATCH');
    const next = h('button', 'btn', 'NEW FIGHT');
    rematch.addEventListener('click', actions.rematch);
    next.addEventListener('click', actions.newFight);
    const body = h('div', 'wc-body',
      h('div', 'wc-kicker', kicker),
      name,
      h('div', 'wc-method', `${info.method} · ${info.detail}`),
      cards,
      h('div', 'tape-names', h('b', 'c0', info.names[0]), h('span', {}, 'VS'), h('b', 'c1', info.names[1])),
      stats,
      h('div', 'wc-actions', rematch, next),
    );
    const pid = w === null ? info.designIds[0] : info.designIds[w];
    this.winner = h('div', `winner-card c${w ?? 0}`, portrait('wc-portrait', pid), body);
    this.el.append(this.winner);
    rematch.focus();
  }

  hideWinner(): void {
    this.winner?.remove();
    this.winner = null;
  }
}
