// Minimal DOM helpers. Text always goes through textContent (never innerHTML) so plan
// text and names can't inject markup.

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | string = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const a: Attrs = typeof attrs === 'string' ? { class: attrs } : attrs;
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== false) el.setAttribute(k, String(v));
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

/** Set text only when it changed (cheap to call every frame). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Set a 0..1 fill on a bar element via a CSS variable (compositor-friendly scaleX). */
export function setFill(el: HTMLElement, v: number): void {
  const s = Math.max(0, Math.min(1, v)).toFixed(3);
  if (el.style.getPropertyValue('--fill') !== s) el.style.setProperty('--fill', s);
}

export function toggleClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

/** A labelled 0..1 bar: returns the root and a setter. */
export function meter(label: string, cls = ''): { el: HTMLElement; set(v: number, text?: string): void } {
  const fill = h('i', 'bar-fill');
  const value = h('b', 'meter-value');
  const el = h('div', `meter ${cls}`, h('span', 'meter-label', label), h('div', 'bar', fill), value);
  return {
    el,
    set(v: number, text?: string) {
      setFill(fill, v);
      setText(value, text ?? `${Math.round(v * 100)}%`);
    },
  };
}
