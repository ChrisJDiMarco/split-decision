// Fighter select: two corner cards (mind, design, skin, tale of the tape, fight plan,
// temperament) around a see-through center that shows the cage, and a FIGHT button.
// Each corner's mind is JEV (cloud), LOCAL (open-source Jev on this Mac), HOUSE (rules) or YOU
// (the player); the MINDS setting under FIGHT can put every non-player corner on one mind.
import { probeLocalHealth, sharedJevLink } from '../brain';
import { GLOBAL_MINDS, onSettingsChange, setSetting, settings } from '../core/settings';
import type { Corner, FighterSetup, HandsOption, MatchSetup, RobotDesign, SkinId } from '../core/types';
import { applyLoadout, HANDS_LABEL, HANDS_OPTIONS, stockHands } from '../robots/loadout';
import { h, setText, toggleClass } from './dom';
import { DamageSilhouette } from './hud/silhouette';
import { CORNER_NAMES, portraitUrl, SKIN_ORDER, SKIN_SWATCHES, swatchFor } from './skins';
import { taleOfTheTape } from './tale';
import {
  CORNER_PICKS, GLOBAL_LABEL, LOCAL_SETUP_DOC, MIND_TAG, PICK_DETAIL, PICK_LABEL, cornerPick, effectiveMind, isOverridden, localStatusLine, pickMind,
  type CornerPick, type LocalHealthView,
} from './mind-picks';
import { PLAYER_REACTION_DELAY_S } from '../player/config';

export const PLAN_MAX_WORDS = 150;
export const TEMPERAMENT = { MIN: 0.3, MAX: 1.8, STEP: 0.05 } as const;
/** How often the LOCAL model's health is re-read while a corner has it picked (ms). */
const LOCAL_PROBE_MS = 5000;

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** A starting plan when the design has none: built from its abilities. */
export function defaultPlan(d: RobotDesign): string {
  const a = d.abilities;
  const lead = a.includes('jab') ? 'Jab to find range' : a.includes('ram') ? 'Line up the ram' : `Open with the ${a[0]?.replace(/_/g, ' ') ?? 'lead'}`;
  const power = a.find((x) => ['overhand', 'rocket_punch', 'hammer_smash', 'head_kick', 'jaw_crush', 'spinner', 'uppercut'].includes(x));
  return `${lead}, stay off the cage and make them miss. ${power ? `When they commit, punish with the ${power.replace(/_/g, ' ')}.` : 'Counter every lunge.'} If a joint on their side starts failing, attack that side until it gives out.`;
}

interface CornerCard {
  root: HTMLElement;
  setup: FighterSetup;
  render(): void;
}

export interface SelectOptions {
  designs: RobotDesign[];
  initial: MatchSetup;
  onFight(setup: MatchSetup): void;
}

export class SelectScreen {
  readonly el: HTMLElement;
  private cards: CornerCard[] = [];
  private fight: HTMLButtonElement;
  private base: MatchSetup;
  private syncSettings: () => void = () => {};
  private localHealth: LocalHealthView | null = null;
  private localAt = -Infinity;
  private probing = false;

  constructor(private opts: SelectOptions) {
    this.base = opts.initial;
    this.fight = h('button', { class: 'btn primary fight-btn', type: 'button' }, 'FIGHT');
    this.fight.addEventListener('click', () => this.submit());
    const title = h('div', 'sel-title',
      h('h1', {}, 'JEV ', h('em', {}, 'KUNE DO')),
      h('p', {}, 'ROBOT FIGHT NIGHT · EVERY MOVE PICKED BY JEV'),
    );
    const center = h('div', 'sel-center', h('div', 'sel-vs', 'VS'), this.fight, this.buildSettings(), h('div', 'sel-note', 'Physics: MuJoCo at 1 kHz · no trained policies · Jev never touches a motor'));
    this.cards = [0, 1].map((c) => this.buildCard(c as Corner, opts.initial.fighters[c]));
    this.el = h('div', 'select-screen', title, this.cards[0].root, center, this.cards[1].root);
    this.validate();
    // Settings changed here or in another tab: the toggles, the corner minds and their status follow.
    onSettingsChange(() => {
      this.syncSettings();
      this.renderCards();
      this.probeLocal();
    });
    setInterval(() => this.probeLocal(), LOCAL_PROBE_MS);
    this.probeLocal();
  }

  /**
   * Settings: MINDS (the global mind override), FAIR MODE, and the presentation toggles. Only MINDS
   * and FAIR MODE change who decides or how fast; physics never reads any of them.
   */
  private buildSettings(): HTMLElement {
    const toggle = (key: 'oilEffects' | 'soundOn' | 'fairMode', label: string, title?: string) => {
      const input = h('input', { type: 'checkbox', class: 'sel-toggle-input' }) as HTMLInputElement;
      input.checked = settings()[key];
      input.addEventListener('change', () => setSetting(key, input.checked));
      return { input, el: h('label', { class: 'sel-settings', title }, input, h('span', 'sel-toggle'), h('span', 'sel-settings-label', label)) };
    };
    const sound = toggle('soundOn', 'SOUND');
    const oil = toggle('oilEffects', 'OIL SPILLS & HISS');
    const fair = toggle('fairMode', 'FAIR MODE', 'The human player feels Jev\'s 0.3 s reaction delay instead of 0.05 s');
    const minds = mindSwitch(GLOBAL_MINDS, (g) => GLOBAL_LABEL[g], (g) => setSetting('minds', g), 'Global minds');
    this.syncSettings = () => {
      const s = settings();
      sound.input.checked = s.soundOn;
      oil.input.checked = s.oilEffects;
      fair.input.checked = s.fairMode;
      minds.set(s.minds);
    };
    this.syncSettings();
    return h('div', 'sel-settings-block',
      h('div', 'sel-minds-global', h('span', 'sel-settings-label', 'MINDS'), minds.el),
      h('div', 'sel-settings-row', sound.el, oil.el, fair.el),
    );
  }

  show(setup?: MatchSetup): void {
    if (setup) {
      this.base = setup;
      setup.fighters.forEach((f, i) => { this.cards[i].setup = { ...f }; });
    }
    this.el.classList.remove('bc-hidden');
    this.renderCards();
    this.validate();
    this.probeLocal(true);
  }

  /** Pick a corner's mind (at most one YOU: the other corner goes back to its previous mind). */
  pick(corner: Corner, p: CornerPick): void {
    const fighters = pickMind([this.cards[0].setup, this.cards[1].setup], corner, p);
    this.cards.forEach((c, i) => { c.setup = fighters[i]; });
    this.renderCards();
    this.probeLocal();
  }

  private renderCards(): void {
    for (const c of this.cards) c.render();
  }

  /** Re-read the LOCAL model's health while a corner has LOCAL (no call otherwise). */
  private probeLocal(force = false): void {
    if (!this.visible || this.probing) return;
    const g = settings().minds;
    if (!this.cards.some((c) => effectiveMind(c.setup, g) === 'local')) return;
    const now = performance.now();
    if (!force && now - this.localAt < LOCAL_PROBE_MS) return;
    this.probing = true;
    probeLocalHealth()
      .then((health) => { this.localHealth = health; })
      .finally(() => {
        this.probing = false;
        this.localAt = performance.now();
        this.renderCards();
      });
  }

  /** The live status line under a corner's mind picker. */
  private mindStatus(m: CornerPick): { cls: string; text: string; hint: string | null } {
    if (m === 'house') return { cls: '', text: 'RULES ONLY · NO NETWORK CALLS', hint: null };
    if (m === 'you') {
      const delay = settings().fairMode ? 'FAIR MODE · JEV\'S 0.30 S DELAY' : `${Math.round(PLAYER_REACTION_DELAY_S * 1000)} MS INPUT DELAY`;
      return { cls: 'ok', text: `WASD + MOUSE · ${delay}`, hint: 'CLICK THE CAGE TO TAKE CONTROL · H SHOWS THE KEYS' };
    }
    if (m === 'jev') {
      const link = sharedJevLink();
      if (link.offline) return { cls: 'bad', text: 'CLOUD · LAST CALL FAILED', hint: 'THE HOUSE MIND FIGHTS UNTIL JEV ANSWERS AGAIN' };
      return { cls: link.status === 'online' ? 'ok' : '', text: link.status === 'online' ? 'CLOUD · ONLINE' : 'CLOUD · TYPESAFE JEV', hint: null };
    }
    const line = localStatusLine(this.localHealth);
    return {
      cls: line.ok === null ? '' : line.ok ? 'ok' : 'bad',
      text: line.text,
      hint: line.ok === false ? `SET UP: ${LOCAL_SETUP_DOC} · THE HOUSE MIND FIGHTS UNTIL IT ANSWERS` : null,
    };
  }

  /** The tale of the tape's MIND row. */
  private mindTape(m: CornerPick): string {
    if (m === 'local') return `LOCAL · ${this.localHealth?.ok && this.localHealth.model ? this.localHealth.model : 'OPEN SOURCE'}`;
    return MIND_TAG[m];
  }

  hide(): void {
    this.el.classList.add('bc-hidden');
  }

  get visible(): boolean {
    return !this.el.classList.contains('bc-hidden');
  }

  current(): MatchSetup {
    return { ...this.base, fighters: [{ ...this.cards[0].setup }, { ...this.cards[1].setup }] };
  }

  private submit(): void {
    if (!this.validate()) return;
    this.opts.onFight(this.current());
  }

  private validate(): boolean {
    const ok = this.cards.every((c) => wordCount(c.setup.plan) <= PLAN_MAX_WORDS);
    this.fight.disabled = !ok;
    return ok;
  }

  private buildCard(corner: Corner, initial: FighterSetup): CornerCard {
    const designs = this.opts.designs;
    const byId = new Map(designs.map((d) => [d.id, d]));
    const card: CornerCard = { root: h('section', `sel-card c${corner}`), setup: { ...initial }, render: () => {} };
    const portrait = h('div', 'sel-portrait');
    const name = h('div', 'sel-name');
    const tagline = h('div', 'sel-tag');
    const kind = h('span', 'chip');
    const designRow = h('div', 'sel-designs');
    const skinRow = h('div', 'sel-skins');
    const skinName = h('span', 'sel-skin-name');
    const handsRow = h('div', 'sel-hands');
    const handsName = h('span', 'sel-skin-name');
    const tape = h('div', 'sel-tape');
    const abilities = h('div', 'sel-abilities');
    const plan = h('textarea', { class: 'sel-plan', rows: 4, spellcheck: 'false', 'aria-label': `${CORNER_NAMES[corner]} fight plan` });
    const words = h('span', 'sel-words');
    const temp = h('input', { type: 'range', min: TEMPERAMENT.MIN, max: TEMPERAMENT.MAX, step: TEMPERAMENT.STEP, 'aria-label': 'Temperament' });
    const tempValue = h('b', {});
    const mindName = h('span', 'sel-skin-name');
    const mindStatus = h('span', 'sel-mind-line');
    const mindHint = h('span', 'sel-mind-hint');
    const minds = mindSwitch(CORNER_PICKS, (p) => PICK_LABEL[p], (p) => this.pick(corner, p), `${CORNER_NAMES[corner]} mind`);

    const designButtons = designs.map((d) => {
      const b = h('button', { class: 'sel-design', type: 'button' }, d.name);
      b.addEventListener('click', () => {
        const prev = byId.get(card.setup.design);
        const planWasDefault = !prev || card.setup.plan.trim() === defaultPlan(prev).trim();
        // The hands choice carries over to the new design (it is re-fitted to that design's fists).
        const hands = card.setup.loadout?.hands ?? 'stock';
        card.setup = { ...card.setup, design: d.id, skin: d.defaultSkin, plan: planWasDefault ? defaultPlan(d) : card.setup.plan, loadout: { design: d.id, hands } };
        card.render();
        this.validate();
      });
      designRow.append(b);
      return { id: d.id, b };
    });
    const skinButtons = SKIN_ORDER.map((id) => {
      const sw = SKIN_SWATCHES[id];
      const b = h('button', { class: 'sel-skin', type: 'button', title: sw.name, 'aria-label': `${sw.name} skin` });
      b.style.setProperty('--base', sw.base);
      b.style.setProperty('--accent', sw.accent);
      b.addEventListener('click', () => { card.setup = { ...card.setup, skin: id as SkinId }; card.render(); });
      skinRow.append(b);
      return { id, b };
    });
    // Hands loadout (docs/design/loadouts-and-workshop.md). The option the design already wears is
    // its stock hands, so it is shown as taken by STOCK.
    const handsButtons = HANDS_OPTIONS.map((opt) => {
      const b = h('button', { class: 'sel-hand', type: 'button', 'aria-label': `${HANDS_LABEL[opt]} hands` }, HANDS_LABEL[opt]) as HTMLButtonElement;
      b.addEventListener('click', () => {
        card.setup = { ...card.setup, loadout: { design: card.setup.design, hands: opt } };
        card.render();
      });
      handsRow.append(b);
      return { opt, b };
    });
    plan.addEventListener('input', () => {
      card.setup = { ...card.setup, plan: plan.value };
      this.renderWords(words, plan.value);
      this.validate();
    });
    temp.addEventListener('input', () => {
      card.setup = { ...card.setup, temperament: Number(temp.value) };
      setText(tempValue, Number(temp.value).toFixed(2));
    });

    card.render = () => {
      const d = byId.get(card.setup.design) ?? designs[0];
      const g = settings().minds;
      const own = cornerPick(card.setup);
      const eff = effectiveMind(card.setup, g);
      const overridden = isOverridden(card.setup, g);
      minds.set(own, overridden ? eff : null);
      setText(mindName, overridden ? `${GLOBAL_LABEL[g]} · GLOBAL` : PICK_DETAIL[eff]);
      const st = this.mindStatus(eff);
      setText(mindStatus, st.text);
      mindStatus.className = `sel-mind-line ${st.cls}`;
      setText(mindHint, st.hint ?? '');
      toggleClass(mindHint, 'bc-hidden', !st.hint);
      const you = eff === 'you';
      toggleClass(card.root, 'is-you', you);
      (plan as HTMLTextAreaElement).disabled = you; // the player fights to no plan
      (temp as HTMLInputElement).disabled = you;
      const hands: HandsOption = card.setup.loadout?.design === d.id ? card.setup.loadout.hands : 'stock';
      const t = taleOfTheTape(applyLoadout(d, { design: d.id, hands }));
      const stock = stockHands(d);
      for (const { opt, b } of handsButtons) {
        const isStock = opt === stock;
        toggleClass(b, 'on', opt === hands || (hands === 'stock' && isStock) || (opt === 'stock' && hands === stock));
        b.disabled = isStock; // same as STOCK on this design
        b.title = isStock ? `${d.name}'s stock hands` : opt === 'stock' ? `As built: ${HANDS_LABEL[stock].toLowerCase()}` : '';
      }
      setText(handsName, hands === 'stock' || hands === stock ? `STOCK · ${HANDS_LABEL[stock]}` : HANDS_LABEL[hands]);
      const url = portraitUrl(d.id);
      portrait.style.backgroundImage = url ? `url("${url}")` : '';
      portrait.replaceChildren(...(url ? [] : [new DamageSilhouette(d).el]));
      setText(name, d.name);
      setText(tagline, d.tagline);
      setText(kind, d.bodyType.toUpperCase());
      for (const { id, b } of designButtons) toggleClass(b, 'on', id === d.id);
      for (const { id, b } of skinButtons) {
        toggleClass(b, 'on', id === card.setup.skin);
        const sw = swatchFor(id as SkinId, d); // the livery chip takes each design's own palette
        b.style.setProperty('--base', sw.base);
        b.style.setProperty('--accent', sw.accent);
      }
      setText(skinName, swatchFor(card.setup.skin, d).name.toUpperCase());
      tape.replaceChildren(...[
        ['MIND', this.mindTape(eff)],
        ['MASS', `${Math.round(t.massKg)} kg`],
        ['HEIGHT', `${t.heightM.toFixed(2)} m`],
        ['PEAK TORQUE', `${Math.round(t.peakTorqueNm)} N·m · ${t.peakJoint}`],
        ['ARMOR', t.armor],
        ['FRAME', t.frame],
        ['GYRO', t.gyro],
        ['HYDRAULICS', t.hydraulics],
        ['HANDS', t.hands],
      ].map(([k, v]) => h('div', 'sel-row', h('span', {}, k), h('b', {}, v))));
      abilities.replaceChildren(...t.abilities.map((a) => h('span', 'chip', a.replace(/_/g, ' ').toUpperCase())));
      if (plan.value !== card.setup.plan) plan.value = card.setup.plan;
      this.renderWords(words, card.setup.plan);
      temp.value = String(card.setup.temperament);
      setText(tempValue, card.setup.temperament.toFixed(2));
    };

    card.root.append(
      h('header', 'sel-corner', CORNER_NAMES[corner]),
      h('div', 'sel-hero', portrait, h('div', 'sel-hero-text', h('div', 'sel-hero-top', kind), name, tagline)),
      h('div', 'sel-label', 'MIND ', mindName), minds.el, h('div', 'sel-mind-status', mindStatus, mindHint),
      designRow,
      h('div', 'sel-label', 'SKIN ', skinName), skinRow,
      h('div', 'sel-label', 'HANDS ', handsName), handsRow,
      h('div', 'sel-label', 'TALE OF THE TAPE'), tape, abilities,
      h('div', 'sel-label', 'FIGHT PLAN ', words), plan,
      h('div', 'sel-label', 'TEMPERAMENT ', tempValue), temp,
      h('div', 'sel-scale', h('span', {}, 'DISCIPLINED'), h('span', {}, 'WILD')),
    );
    card.render();
    return card;
  }

  private renderWords(el: HTMLElement, text: string): void {
    const n = wordCount(text);
    setText(el, `${n} / ${PLAN_MAX_WORDS} WORDS`);
    toggleClass(el, 'over', n > PLAN_MAX_WORDS);
  }
}

/** A row of one-choice buttons: `on` is the chosen value; `forced` shows a value a global override puts in its place. */
function mindSwitch<T extends string>(values: readonly T[], label: (v: T) => string, onPick: (v: T) => void, aria: string) {
  const buttons = values.map((v) => {
    const b = h('button', { class: 'sel-mind', type: 'button', 'aria-pressed': 'false' }, label(v)) as HTMLButtonElement;
    b.addEventListener('click', () => {
      b.blur(); // a focused button would take the next Space or Enter
      onPick(v);
    });
    return { v, b };
  });
  const el = h('div', { class: 'sel-minds', role: 'group', 'aria-label': aria }, ...buttons.map((x) => x.b));
  return {
    el,
    set(on: T, forced: T | null = null): void {
      for (const { v, b } of buttons) {
        toggleClass(b, 'on', v === on);
        toggleClass(b, 'overridden', forced !== null && v === on);
        toggleClass(b, 'forced', v === forced);
        b.setAttribute('aria-pressed', String(v === on));
      }
    },
  };
}
