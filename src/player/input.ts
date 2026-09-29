// Player input: keyboard, mouse buttons and pointer-locked mouse look. While enabled, keys the
// keymap uses are swallowed in the capture phase at the window (preventDefault +
// stopImmediatePropagation), so the page's own shortcuts (the broadcast's C/H/P/M, main.ts's S/Q/R)
// never see them. Escape is left alone: the browser uses it to release the pointer lock.
import { heldActionFor, isBoundCode, pressActionFor, type HeldAction, type Keymap, type PressAction } from './keymap';

export interface InputHandlers {
  /** A press action, with the event time in seconds (performance clock). */
  onPress(action: PressAction, t: number): void;
  /** The held set changed. */
  onHeld(held: ReadonlySet<HeldAction>): void;
}

const MOUSE = (button: number) => `Mouse${button}`;

export class PlayerInput {
  enabled = true;
  /** Mouse strikes need the pointer locked (so a click into the page doesn't throw). Tests turn it off. */
  requireLockForMouse = true;
  /**
   * The browser refused the pointer lock (an embedded view, a denied permission, a re-lock too soon
   * after Esc). Mouse strikes then fire without it, and each click still asks for the lock again.
   */
  lockRefused = false;
  /** When set, the next key or mouse button is captured as a binding instead of acting. */
  capture: ((binding: { code: string; shift: boolean } | null) => void) | null = null;
  private held = new Set<HeldAction>();
  private codesDown = new Map<string, HeldAction>();
  private lookX = 0;
  private lookY = 0;
  private lastLookAt = -Infinity;
  private readonly off: Array<() => void> = [];

  constructor(private readonly surface: HTMLElement, private keymap: Keymap, private readonly handlers: InputHandlers) {
    type Events = WindowEventMap & DocumentEventMap;
    const on = <K extends keyof Events>(target: Window | HTMLElement | Document, type: K, fn: (e: Events[K]) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(window, 'keydown', (e) => this.key(e, true), { capture: true });
    on(window, 'keyup', (e) => this.key(e, false), { capture: true });
    on(window, 'blur', () => this.releaseAll());
    on(document, 'visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    on(surface, 'mousedown', (e) => this.mouse(e));
    on(surface, 'contextmenu', (e) => { if (this.enabled) e.preventDefault(); });
    on(document, 'mousemove', (e) => this.look(e));
    on(document, 'pointerlockchange', () => {
      if (this.locked) this.lockRefused = false;
      else this.releaseAll();
    });
    on(document, 'pointerlockerror', () => { this.lockRefused = true; });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.surface;
  }

  setKeymap(map: Keymap): void {
    this.keymap = map;
    this.releaseAll();
  }

  /** Mouse look since the last call (pixels), and seconds since the mouse last moved. */
  consumeLook(now: number): { dx: number; dy: number; idleS: number } {
    const out = { dx: this.lookX, dy: this.lookY, idleS: (now - this.lastLookAt) / 1000 };
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }

  requestLock(): void {
    if (this.locked) return;
    const req = this.surface.requestPointerLock?.();
    if (req && typeof (req as Promise<void>).catch === 'function') (req as Promise<void>).catch(() => { /* denied: play without mouse look */ });
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
    if (this.locked) document.exitPointerLock();
  }

  private key(e: KeyboardEvent, down: boolean): void {
    // A released key always lets go, even while disabled (a KO, a break), typing, or with Cmd held,
    // so nothing stays held into the next round. macOS drops the keyups of keys released while Cmd
    // is down, so letting go of Cmd releases everything.
    if (!down && this.codesDown.delete(e.code)) this.syncHeld();
    if (!down && (e.code === 'MetaLeft' || e.code === 'MetaRight')) this.releaseAll();
    if (e.code === 'Escape' && this.capture && down) {
      const cb = this.capture;
      this.capture = null;
      cb(null); // cancelled
      return;
    }
    if (!this.enabled || e.code === 'Escape' || e.metaKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (this.capture) {
      if (!down || e.code.startsWith('Shift')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const cb = this.capture;
      this.capture = null;
      cb({ code: e.code, shift: e.shiftKey });
      return;
    }
    if (!isBoundCode(this.keymap, e.code)) return;
    e.preventDefault(); // Tab focus, Space scroll
    e.stopImmediatePropagation(); // the page's own shortcuts (window listeners too) never see a player key
    const held = heldActionFor(this.keymap, e.code);
    if (held) {
      if (down) this.codesDown.set(e.code, held);
      else this.codesDown.delete(e.code);
      this.syncHeld();
      return;
    }
    if (!down || e.repeat) return;
    const action = pressActionFor(this.keymap, e.code, e.shiftKey);
    if (action) this.handlers.onPress(action, e.timeStamp / 1000);
  }

  private mouse(e: MouseEvent): void {
    if (!this.enabled) return;
    if (this.capture) {
      e.preventDefault();
      const cb = this.capture;
      this.capture = null;
      cb({ code: MOUSE(e.button), shift: e.shiftKey });
      return;
    }
    // The first click only takes the pointer: no stray jab from clicking into the game.
    if (!this.locked && this.requireLockForMouse) {
      this.requestLock();
      if (!this.lockRefused) return;
    }
    const action = pressActionFor(this.keymap, MOUSE(e.button), e.shiftKey);
    if (!action) return;
    e.preventDefault();
    this.handlers.onPress(action, e.timeStamp / 1000);
  }

  private look(e: MouseEvent): void {
    if (!this.enabled || !this.locked) return;
    this.lookX += e.movementX;
    this.lookY += e.movementY;
    if (e.movementX || e.movementY) this.lastLookAt = e.timeStamp;
  }

  private syncHeld(): void {
    const next = new Set(this.codesDown.values());
    if (next.size === this.held.size && [...next].every((a) => this.held.has(a))) return;
    this.held = next;
    this.handlers.onHeld(this.held);
  }

  private releaseAll(): void {
    this.codesDown.clear();
    this.syncHeld();
  }
}
