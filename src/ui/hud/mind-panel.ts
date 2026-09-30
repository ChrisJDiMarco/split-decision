// MIND panel (titled with the mind really deciding: JEV, LOCAL or HOUSE): the fighter's live tactic
// distribution (top 5), chosen target, the READ on the opponent, aggression and latency, with an
// offline badge on fallback. The opening, armed-reflex, plan (setup → payoff, or a plain combo) and
// read lines each keep a fixed one-line slot (empty or not), so the panel's height never changes and
// the tactic list above never jumps. During a referee break the armed slot shows the fighter's part
// in it (BREAK · NEUTRAL CORNER, BREAK · WAITING, DOWN · GETTING UP) and the intent is tagged as held.
import { h, meter, setFill, setText, toggleClass } from '../dom';
import {
  armedLine, comboLine, gambleLine, HELD_BY_REFEREE, mindChip, mindTitle, offlineBadge, planLine, readLine, refereeLine, seesLine, tacticLabel, topTactics,
  type MindReferee, type MindView,
} from '../minds';

const ROWS = 5;

interface Row { el: HTMLElement; name: HTMLElement; fill: HTMLElement; p: HTMLElement }

export class MindPanel {
  readonly el: HTMLElement;
  private rows: Row[] = [];
  private target: HTMLElement;
  private latency: HTMLElement;
  private badge: HTMLElement;
  private reason: HTMLElement;
  private gamble: HTMLElement;
  private armed: HTMLElement;
  private combo: HTMLElement;
  private readEl: HTMLElement;
  private read = meter('READ · COMMITTING', 'read');
  private aggression = meter('AGGRESSION');
  private lastKey = '';
  private who: HTMLElement;

  /** `mindName`: the mind picked for this corner ('JEV', 'LOCAL', 'HOUSE'), until its first decision says. */
  constructor(mindName = '') {
    this.latency = h('span', 'chip latency', '— ms');
    this.badge = h('span', 'badge-offline', 'JEV OFFLINE · HOUSE MIND');
    this.who = h('span', 'mind-who', mindName ? `${mindName} ` : '');
    const head = h('div', 'panel-head',
      h('div', 'panel-title', this.who, h('em', {}, 'MIND')),
      h('div', {}, this.latency, this.badge),
    );
    const list = h('div', 'tactics');
    for (let i = 0; i < ROWS; i++) {
      const name = h('span', 'tactic-name', '—');
      const fill = h('i', 'bar-fill');
      const p = h('span', 'tactic-p', '');
      const el = h('div', 'tactic empty', name, h('div', 'bar', fill), p);
      list.append(el);
      this.rows.push({ el, name, fill, p });
    }
    this.target = h('b', {}, '—');
    this.reason = h('div', 'mind-reason', '');
    this.gamble = h('div', 'mind-line mind-gamble', '');
    this.armed = h('div', 'mind-line mind-armed', '');
    this.combo = h('div', 'mind-line mind-combo', '');
    this.readEl = h('div', 'mind-line mind-read', '');
    const rows = h('div', 'mind-rows',
      h('div', 'mind-lines', this.gamble, this.armed, this.combo, this.readEl),
      h('div', 'mind-target', h('span', {}, 'TARGET'), this.target),
      this.read.el,
      this.aggression.el,
      this.reason,
    );
    this.el = h('div', 'panel mind', head, list, rows);
  }

  /** `ref`: this fighter's referee view (RobotTelemetry.referee), null or absent outside a break. */
  update(mind: MindView | null, ref: MindReferee | null = null): void {
    toggleClass(this.el, 'waiting', !mind);
    if (!mind) return;
    const who = mindTitle(mind);
    if (who) setText(this.who, `${who} `);
    const onBreak = refereeLine(ref);
    toggleClass(this.el, 'on-break', onBreak !== null);
    const badge = offlineBadge(mind);
    toggleClass(this.el, 'offline', badge !== null);
    if (badge) setText(this.badge, badge);
    const ranked = topTactics(mind.tacticProbs, ROWS);
    const key = ranked.map((r) => `${r.tactic}:${r.p.toFixed(3)}`).join('|') + mind.tactic;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.rows.forEach((row, i) => {
        const r = ranked[i];
        toggleClass(row.el, 'empty', !r);
        toggleClass(row.el, 'chosen', !!r && r.tactic === mind.tactic);
        setText(row.name, r ? tacticLabel(r.tactic) : '—');
        setText(row.p, r ? `${Math.round(r.p * 100)}` : '');
        setFill(row.fill, r ? r.p : 0);
      });
    }
    setText(this.target, mind.target.replace(/_/g, ' '));
    const commit = mind.oppCommit;
    this.read.set(commit ?? 0, commit === null ? '—' : `${Math.round(commit * 100)}%`);
    this.aggression.set(mind.aggression);
    setText(this.latency, mindChip(mind));
    const reason = mind.reason ? `${mind.mode ? mind.mode.toUpperCase() + ' · ' : ''}${mind.reason}` : '';
    setText(this.reason, onBreak ? `${HELD_BY_REFEREE}${reason ? ` · ${reason}` : ''}` : reason);
    toggleClass(this.reason, 'held', onBreak !== null);
    const gamble = gambleLine(mind) ?? seesLine(mind) ?? (mind.getupStyle === 'kip_up' ? 'GET-UP: KIP-UP' : null);
    setText(this.gamble, gamble ?? '');
    toggleClass(this.gamble, 'taken', !!mind.gamble || mind.getupStyle === 'kip_up');
    // During a break nothing is armed (the brain holds): the slot shows the fighter's part in the break.
    const armed = onBreak ?? armedLine(mind);
    setText(this.armed, armed ?? '');
    toggleClass(this.armed, 'ref', onBreak !== null);
    this.armed.title = armed ?? '';
    const plain = comboLine(mind);
    const plan = planLine(mind) ?? (plain ? `COMBO: ${plain}` : null);
    setText(this.combo, plan ?? '');
    toggleClass(this.combo, 'payoff', mind.plan?.phase === 'payoff' && !!mind.plan.setup.length);
    const read = readLine(mind);
    setText(this.readEl, read ?? '');
    toggleClass(this.readEl, 'bit', !!read && read.includes('HE BIT'));
    this.readEl.title = read ?? '';
    this.gamble.title = gamble ?? '';
    this.combo.title = plan ?? '';
  }
}
