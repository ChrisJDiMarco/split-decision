// Fighter select: two corner cards (design, skin, tale of the tape, fight plan,
// temperament) around a see-through center that shows the cage, and a FIGHT button.
import { setSetting, settings } from '../core/settings';
import type { Corner, FighterSetup, MatchSetup, RobotDesign, SkinId } from '../core/types';
import { h, setText, toggleClass } from './dom';
import { DamageSilhouette } from './hud/silhouette';
import { CORNER_NAMES, portraitUrl, SKIN_ORDER, SKIN_SWATCHES, swatchFor } from './skins';
import { taleOfTheTape } from './tale';

export const PLAN_MAX_WORDS = 150;
export const TEMPERAMENT = { MIN: 0.3, MAX: 1.8, STEP: 0.05 } as const;

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

  constructor(private opts: SelectOptions) {
    this.base = opts.initial;
    this.fight = h('button', { class: 'btn primary fight-btn', type: 'button' }, 'FIGHT');
    this.fight.addEventListener('click', () => this.submit());
    const title = h('div', 'sel-title',
      h('h1', {}, 'SPLIT ', h('em', {}, 'DECISION')),
      h('p', {}, 'ROBOT FIGHT NIGHT · EVERY MOVE PICKED BY JEV'),
    );
    const center = h('div', 'sel-center', h('div', 'sel-vs', 'VS'), this.fight, this.buildSettings(), h('div', 'sel-note', 'Physics: MuJoCo at 1 kHz · no trained policies · Jev never touches a motor'));
    this.cards = [0, 1].map((c) => this.buildCard(c as Corner, opts.initial.fighters[c]));
    this.el = h('div', 'select-screen', title, this.cards[0].root, center, this.cards[1].root);
    this.validate();
  }

  /** Presentation settings. They never touch physics: a hydraulic leak still costs pressure with oil effects off. */
  private buildSettings(): HTMLElement {
    const input = h('input', { type: 'checkbox', class: 'sel-toggle-input' }) as HTMLInputElement;
    input.checked = settings().oilEffects;
    input.addEventListener('change', () => setSetting('oilEffects', input.checked));
    const sound = h('input', { type: 'checkbox', class: 'sel-toggle-input' }) as HTMLInputElement;
    sound.checked = settings().soundOn;
    sound.addEventListener('change', () => setSetting('soundOn', sound.checked));
    return h('div', 'sel-settings-row',
      h('label', 'sel-settings', sound, h('span', 'sel-toggle'), h('span', 'sel-settings-label', 'SOUND')),
      h('label', 'sel-settings', input, h('span', 'sel-toggle'), h('span', 'sel-settings-label', 'OIL SPILLS & HISS')),
    );
  }

  show(setup?: MatchSetup): void {
    if (setup) {
      this.base = setup;
      setup.fighters.forEach((f, i) => { this.cards[i].setup = { ...f }; this.cards[i].render(); });
    }
    this.el.classList.remove('bc-hidden');
    this.validate();
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
    const tape = h('div', 'sel-tape');
    const abilities = h('div', 'sel-abilities');
    const plan = h('textarea', { class: 'sel-plan', rows: 4, spellcheck: 'false', 'aria-label': `${CORNER_NAMES[corner]} fight plan` });
    const words = h('span', 'sel-words');
    const temp = h('input', { type: 'range', min: TEMPERAMENT.MIN, max: TEMPERAMENT.MAX, step: TEMPERAMENT.STEP, 'aria-label': 'Temperament' });
    const tempValue = h('b', {});

    const designButtons = designs.map((d) => {
      const b = h('button', { class: 'sel-design', type: 'button' }, d.name);
      b.addEventListener('click', () => {
        const prev = byId.get(card.setup.design);
        const planWasDefault = !prev || card.setup.plan.trim() === defaultPlan(prev).trim();
        card.setup = { ...card.setup, design: d.id, skin: d.defaultSkin, plan: planWasDefault ? defaultPlan(d) : card.setup.plan };
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
      const t = taleOfTheTape(d);
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
        ['MASS', `${Math.round(t.massKg)} kg`],
        ['HEIGHT', `${t.heightM.toFixed(2)} m`],
        ['PEAK TORQUE', `${Math.round(t.peakTorqueNm)} N·m · ${t.peakJoint}`],
        ['ARMOR', t.armor],
        ['FRAME', t.frame],
        ['GYRO', t.gyro],
        ['HYDRAULICS', t.hydraulics],
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
      designRow,
      h('div', 'sel-label', 'SKIN ', skinName), skinRow,
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
