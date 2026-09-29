// Event ticker (bottom center, newest first, three visible) and full-screen callouts for
// the biggest moments ("HEAD OFF!").
import { h } from '../dom';
import type { TickerItem } from '../ticker-feed';

const VISIBLE = 3;
const ITEM_TTL_MS = 6500;
const CALLOUT_MS = 2300;

export class TickerView {
  readonly el: HTMLElement;
  private items: Array<{ el: HTMLElement; born: number }> = [];

  constructor(private calloutLayer: HTMLElement) {
    this.el = h('div', 'ticker');
  }

  clear(): void {
    this.items = [];
    this.el.replaceChildren();
    this.clearCallouts();
  }

  clearCallouts(): void {
    this.calloutLayer.replaceChildren();
  }

  push(item: TickerItem, roundClock: string): void {
    const cornerCls = item.corner === null ? 'neutral' : `c${item.corner}`;
    const el = h('div', `tick ${item.level} ${cornerCls}`, h('time', {}, roundClock), item.text);
    this.el.prepend(el);
    this.items.unshift({ el, born: performance.now() });
    this.restyle();
    const big = item.level === 'huge' ? calloutText(item) : null;
    if (big) this.callout(big, item.corner);
  }

  /** Big center-screen text. */
  callout(text: string, corner: number | null): void {
    const el = h('div', `callout ${corner === null ? '' : `c${corner}`}`, text);
    this.calloutLayer.append(el);
    setTimeout(() => el.remove(), CALLOUT_MS);
  }

  update(): void {
    const now = performance.now();
    let changed = false;
    while (this.items.length && (this.items.length > VISIBLE || now - this.items[this.items.length - 1].born > ITEM_TTL_MS)) {
      this.items.pop()!.el.remove();
      changed = true;
    }
    if (changed) this.restyle();
  }

  private restyle(): void {
    this.items.forEach((it, i) => {
      it.el.classList.toggle('old', i === 1);
      it.el.classList.toggle('old2', i >= 2);
    });
  }
}

/** Callout text for a huge item; null when another overlay owns the moment (the KO band). */
function calloutText(item: TickerItem): string | null {
  if (item.text.startsWith('HEAD OFF')) return 'HEAD OFF!';
  if (item.text.startsWith('KNOCKOUT')) return null;
  if (/torn off/.test(item.text)) return 'TORN OFF!';
  return item.text.split('·')[0].trim();
}
