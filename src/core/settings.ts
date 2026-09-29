// Player settings, persisted per browser. Physics never reads these: they only switch
// presentation (effects and sounds), so a setting can never change a fight's outcome.

export interface Settings {
  /** Hydraulic oil spray, puddles and the leak hiss. Leaks still cost pressure either way. */
  oilEffects: boolean;
  /** Master sound. Off by default while Chris watches other things during test runs. */
  soundOn: boolean;
}

const STORAGE_KEY = 'split-decision.settings.v1';
const DEFAULTS: Settings = { oilEffects: false, soundOn: false };

type Listener = (s: Readonly<Settings>) => void;
const listeners = new Set<Listener>();
let current: Settings = load();

function load(): Settings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...pick(parsed) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Only known keys with the right type survive a load, so stale or edited storage can't break the page. */
function pick(p: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  if (typeof p.oilEffects === 'boolean') out.oilEffects = p.oilEffects;
  if (typeof p.soundOn === 'boolean') out.soundOn = p.soundOn;
  return out;
}

export function settings(): Readonly<Settings> {
  return current;
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Storage blocked (private window, previews): the setting still applies for this session.
  }
  for (const fn of listeners) fn(current);
}

// Another tab changed a setting (same origin, same storage): apply it here too, so switching
// sound off in one tab silences every open tab at once.
globalThis.addEventListener?.('storage', (e: StorageEvent) => {
  if (e.key !== STORAGE_KEY) return;
  current = load();
  for (const fn of listeners) fn(current);
});

export function onSettingsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
