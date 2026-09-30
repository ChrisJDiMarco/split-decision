// Player keymap: every action has one or more bindings. A binding is a KeyboardEvent.code
// ('KeyW', 'Space', 'KeyG') or a mouse button ('Mouse0' left, 'Mouse1' middle,
// 'Mouse2' right), optionally prefixed 'Shift+' for a modified press. Held actions ignore
// modifiers (Shift+W still walks). Rebinds persist per browser (localStorage, best effort).
import { KEYMAP_STORAGE_KEY } from './config';

/** Held while the key is down. */
export const HELD_ACTIONS = ['move_forward', 'move_back', 'move_left', 'move_right', 'guard', 'clinch'] as const;
/** Fire once per press. */
export const PRESS_ACTIONS = [
  'jab', 'cross', 'hook_lead', 'hook_rear', 'uppercut', 'overhand',
  'front_kick', 'low_kick', 'head_kick', 'tornado_kick', 'spinning_backfist',
  'slip', 'feint', 'aim_body', 'toggle_camera', 'toggle_hints',
] as const;

export type HeldAction = (typeof HELD_ACTIONS)[number];
export type PressAction = (typeof PRESS_ACTIONS)[number];
export type ActionId = HeldAction | PressAction;
export type Keymap = Record<ActionId, string[]>;

export const DEFAULT_KEYMAP: Readonly<Keymap> = {
  move_forward: ['KeyW'],
  move_back: ['KeyS'],
  move_left: ['KeyA'],
  move_right: ['KeyD'],
  // G, not Ctrl: Ctrl+Tab/W/Space/click are browser and OS shortcuts (a held Ctrl guard closed tabs).
  guard: ['KeyG'],
  clinch: ['KeyC'],
  jab: ['Mouse0'],
  cross: ['Mouse2'],
  hook_lead: ['KeyQ'],
  hook_rear: ['KeyE'],
  uppercut: ['Shift+Mouse0'],
  overhand: ['Shift+Mouse2'],
  front_kick: ['KeyF'],
  low_kick: ['KeyR'],
  head_kick: ['Shift+KeyR'],
  tornado_kick: ['KeyZ'],
  spinning_backfist: ['KeyX'],
  slip: ['Space'],
  feint: ['Tab'],
  aim_body: ['KeyB'],
  toggle_camera: ['KeyV'],
  toggle_hints: ['KeyH'],
};

export const ACTION_LABEL: Record<ActionId, string> = {
  move_forward: 'Step in', move_back: 'Back out', move_left: 'Circle left', move_right: 'Circle right',
  guard: 'Guard (hold)', clinch: 'Clinch (hold)',
  jab: 'Jab', cross: 'Cross', hook_lead: 'Lead hook', hook_rear: 'Rear hook', uppercut: 'Uppercut', overhand: 'Overhand',
  front_kick: 'Front kick', low_kick: 'Low kick', head_kick: 'Head kick', tornado_kick: 'Tornado kick', spinning_backfist: 'Spinning backfist',
  slip: 'Slip / counter (kip-up when down)', feint: 'Feint', aim_body: 'Aim head / body', toggle_camera: 'Camera: chase / broadcast', toggle_hints: 'Show / hide keys',
};

const HELD = new Set<string>(HELD_ACTIONS);
export const isHeld = (a: ActionId): a is HeldAction => HELD.has(a);

const SHIFT = 'Shift+';
const BINDING_RE = /^(Shift\+)?(Mouse[0-4]|[A-Za-z][A-Za-z0-9]{1,24})$/;
/**
 * Keys a binding may not use: Ctrl, Alt and Cmd turn the other game keys into browser and OS
 * shortcuts (Ctrl+W closes the tab, Alt+F opens the menu, Cmd+Q quits). Saved keymaps that still
 * bind them lose those bindings on load (see mergeKeymap).
 */
const MODIFIER_RE = /^(Control|Alt|Meta|OS)(Left|Right)?$/;
/** When a default key is already taken by a saved rebind, the action falls back to the first free one. */
const FALLBACK_KEYS = ['KeyG', 'KeyY', 'KeyU', 'KeyJ', 'KeyK'] as const;

/** Is this a well-formed, bindable binding string? */
export function validBinding(b: unknown): b is string {
  return typeof b === 'string' && BINDING_RE.test(b) && !MODIFIER_RE.test(baseOf(b));
}

/** The binding a keyboard or mouse input produces: 'Shift+KeyR', 'Mouse0'. Shift keys alone are never chords. */
export function chordOf(code: string, shift: boolean): string {
  return shift && !code.startsWith('Shift') ? SHIFT + code : code;
}

const baseOf = (binding: string) => (binding.startsWith(SHIFT) ? binding.slice(SHIFT.length) : binding);

/** The held action a code drives, ignoring modifiers, or null. */
export function heldActionFor(map: Keymap, code: string): HeldAction | null {
  for (const a of HELD_ACTIONS) if (map[a].some((b) => baseOf(b) === code)) return a;
  return null;
}

/**
 * The press action for an input: an exact chord match first ('Shift+Mouse0' → uppercut), then the
 * unmodified binding (Shift+F still front-kicks when nothing is bound to Shift+F).
 */
export function pressActionFor(map: Keymap, code: string, shift: boolean): PressAction | null {
  const chord = chordOf(code, shift);
  for (const a of PRESS_ACTIONS) if (map[a].includes(chord)) return a;
  if (chord !== code) for (const a of PRESS_ACTIONS) if (map[a].includes(code)) return a;
  return null;
}

/** Does any action use this code (with or without Shift)? The input layer swallows such keys. */
export function isBoundCode(map: Keymap, code: string): boolean {
  for (const list of Object.values(map)) if (list.some((b) => baseOf(b) === code)) return true;
  return false;
}

/**
 * Bind `action` to exactly `binding`, taking it away from any other action (a key does one thing).
 * Held actions store the unmodified code. Returns a new keymap.
 */
export function rebind(map: Keymap, action: ActionId, binding: string): Keymap {
  if (!validBinding(binding)) return map;
  const held = isHeld(action);
  const b = held ? baseOf(binding) : binding;
  // A held key owns its code outright (with or without Shift); a press chord clashes with the same
  // chord elsewhere and with a held action on its base code (held input wins at runtime).
  const clashes = (other: ActionId, x: string) => x === b || ((held || isHeld(other)) && baseOf(x) === baseOf(b));
  const out = {} as Keymap;
  for (const [a, list] of Object.entries(map) as Array<[ActionId, string[]]>) {
    out[a] = a === action ? [b] : list.filter((x) => !clashes(a, x));
  }
  return out;
}

/**
 * Defaults with any valid stored overrides on top. Unknown actions and bad bindings are ignored.
 * Migration: a saved keymap from before the guard left Ctrl loses its Ctrl bindings, and an action
 * left with nothing gets its default key back, or the first free fallback key when a saved rebind
 * already uses that key (a key does one thing).
 */
export function mergeKeymap(stored: unknown): Keymap {
  const out: Keymap = { ...DEFAULT_KEYMAP } as Keymap;
  for (const a of Object.keys(out) as ActionId[]) out[a] = [...DEFAULT_KEYMAP[a]];
  if (!stored || typeof stored !== 'object') return out;
  const fromStore = new Set<ActionId>();
  for (const [a, list] of Object.entries(stored as Record<string, unknown>)) {
    if (!(a in out) || !Array.isArray(list)) continue;
    const valid = list.filter(validBinding);
    if (!valid.length) continue;
    out[a as ActionId] = valid;
    fromStore.add(a as ActionId);
  }
  // Defaults filled in next to saved rebinds must not reuse a key a saved action already owns
  // (same clash rule as rebind: the same chord, or the same base key where a held action is involved).
  const owned: Array<{ b: string; held: boolean }> = [];
  for (const a of fromStore) for (const b of out[a]) owned.push({ b, held: isHeld(a) });
  const clashes = (action: ActionId, x: string) => owned.some((o) => o.b === x || ((o.held || isHeld(action)) && baseOf(o.b) === baseOf(x)));
  const inUse = (k: string) => Object.values(out).some((list) => list.some((b) => baseOf(b) === k));
  for (const a of Object.keys(out) as ActionId[]) {
    if (fromStore.has(a)) continue;
    const kept = out[a].filter((b) => !clashes(a, b));
    if (!kept.length) {
      const free = FALLBACK_KEYS.find((k) => !clashes(a, k) && !inUse(k));
      if (free) {
        kept.push(free);
        owned.push({ b: free, held: isHeld(a) });
      }
    }
    out[a] = kept;
  }
  return out;
}

/** The stored keymap for this browser, or the defaults (storage can be blocked or empty). */
export function loadKeymap(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Keymap {
  try {
    const raw = storage?.getItem(KEYMAP_STORAGE_KEY);
    return mergeKeymap(raw ? JSON.parse(raw) : null);
  } catch {
    return mergeKeymap(null);
  }
}

/** Persist a keymap; returns false when the browser refuses (private window, blocked storage). */
export function saveKeymap(map: Keymap, storage: Pick<Storage, 'setItem'> | null = safeStorage()): boolean {
  try {
    storage?.setItem(KEYMAP_STORAGE_KEY, JSON.stringify(map));
    return !!storage;
  } catch {
    return false;
  }
}

export function resetKeymap(storage: Pick<Storage, 'removeItem'> | null = safeStorage()): Keymap {
  try {
    storage?.removeItem(KEYMAP_STORAGE_KEY);
  } catch {
    // storage blocked: the defaults still apply for this session
  }
  return mergeKeymap(null);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 'Shift+Mouse0' → 'SHIFT + LMB', 'KeyQ' → 'Q', 'ControlLeft' → 'CTRL'. */
export function bindingLabel(b: string): string {
  const shift = b.startsWith(SHIFT);
  const base = baseOf(b);
  const names: Record<string, string> = {
    Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'MB4', Mouse4: 'MB5', Space: 'SPACE', Tab: 'TAB',
    ControlLeft: 'CTRL', ControlRight: 'R-CTRL', AltLeft: 'ALT', AltRight: 'R-ALT', ShiftLeft: 'SHIFT', ShiftRight: 'R-SHIFT',
    Enter: 'ENTER', Backquote: '`', CapsLock: 'CAPS', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  };
  const name = names[base] ?? base.replace(/^Key/, '').replace(/^Digit/, '');
  return shift ? `SHIFT + ${name}` : name;
}
