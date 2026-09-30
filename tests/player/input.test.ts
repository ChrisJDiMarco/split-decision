// PlayerInput without a browser: window, document and the canvas are bare EventTargets, and key
// events are plain Events carrying the KeyboardEvent fields the input layer reads.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlayerInput } from '../../src/player/input';
import { mergeKeymap, type HeldAction } from '../../src/player/keymap';

type KeyFields = { code: string; shiftKey?: boolean; metaKey?: boolean; repeat?: boolean };
const key = (type: 'keydown' | 'keyup', f: KeyFields): Event =>
  Object.assign(new Event(type, { cancelable: true }), { shiftKey: false, metaKey: false, repeat: false, ...f });

describe('player input: held keys never stick', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document };
  let win: EventTarget;
  let input: PlayerInput;
  let held: HeldAction[];
  let presses: string[];
  let surface: EventTarget;
  const down = (code: string, f: Partial<KeyFields> = {}) => win.dispatchEvent(key('keydown', { code, ...f }));
  const up = (code: string, f: Partial<KeyFields> = {}) => win.dispatchEvent(key('keyup', { code, ...f }));

  beforeEach(() => {
    win = new EventTarget();
    g.window = win;
    g.document = Object.assign(new EventTarget(), { pointerLockElement: null, hidden: false });
    held = [];
    presses = [];
    surface = new EventTarget();
    input = new PlayerInput(surface as unknown as HTMLElement, mergeKeymap(null), {
      onPress: (a) => { presses.push(a); },
      onHeld: (h) => { held = [...h]; },
    });
  });
  afterEach(() => {
    input.dispose();
    g.window = saved.window;
    g.document = saved.document;
  });

  it('tracks held movement keys', () => {
    down('KeyW');
    down('KeyA');
    expect(held.sort()).toEqual(['move_forward', 'move_left']);
    up('KeyW');
    expect(held).toEqual(['move_left']);
  });

  it('lets go of a key released while input is disabled (a KO, a round break)', () => {
    down('KeyW');
    input.enabled = false;
    up('KeyW');
    input.enabled = true;
    expect(held).toEqual([]);
  });

  it('lets go of a key released with Cmd held, and of everything when Cmd is released', () => {
    down('KeyD');
    up('KeyD', { metaKey: true });
    expect(held).toEqual([]);
    down('KeyA');
    down('MetaLeft', { metaKey: true });
    up('MetaLeft'); // macOS never sends KeyA's keyup while Cmd is down
    expect(held).toEqual([]);
  });

  it('lets go on window blur', () => {
    down('KeyG');
    expect(held).toEqual(['guard']);
    win.dispatchEvent(new Event('blur'));
    expect(held).toEqual([]);
  });

  it('a click only asks for the pointer lock, unless the browser refused it: then the mouse strikes anyway', () => {
    const click = () => surface.dispatchEvent(Object.assign(new Event('mousedown', { cancelable: true }), { button: 0, shiftKey: false }));
    click();
    expect(presses).toEqual([]);
    (globalThis.document as unknown as EventTarget).dispatchEvent(new Event('pointerlockerror'));
    click();
    expect(presses).toEqual(['jab']);
  });
});
