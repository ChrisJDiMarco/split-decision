// Player settings, persisted per browser. Physics never reads these. Most only switch presentation
// (effects, sounds, how deep dents are drawn); MINDS picks which mind decides for every non-player
// corner, and FAIR MODE gives a human player Jev's reaction delay.

export interface Settings {
  /** Hydraulic oil spray, puddles and the leak hiss. Leaks still cost pressure either way. */
  oilEffects: boolean;
  /** Master sound. Off by default while Chris watches other things during test runs. */
  soundOn: boolean;
  /**
   * The global MINDS override, 'jev' (cloud) by default (Chris, 2026-10-20; LOCAL is still too slow): 'corner' fights each corner's own pick; 'jev', 'local' or
   * 'house' puts every corner that is not the human player on that mind. Changing it mid-fight hot
   * swaps the minds (Brain.setSource).
   */
  minds: GlobalMinds;
  /** A human player feels Jev's reaction delay (MatchSetup.reactionDelayS) instead of the snappy player delay. */
  fairMode: boolean;
  /**
   * PRESENTATION ONLY: draw physical dents about 2× deeper so they read on screen
   * (src/render/robot-kit/damage DENT_VISUAL_BOOST). The physics, and every number it reports, is
   * unchanged either way. On by default (Chris, decision D6).
   */
  dentBoost: boolean;
}

export type GlobalMinds = 'corner' | 'jev' | 'local' | 'house';
export const GLOBAL_MINDS: readonly GlobalMinds[] = ['corner', 'jev', 'local', 'house'];

const STORAGE_KEY = 'split-decision.settings.v1';
const DEFAULTS: Settings = { oilEffects: false, soundOn: false, minds: 'jev', fairMode: false, dentBoost: true };

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
  if (typeof p.minds === 'string' && (GLOBAL_MINDS as readonly string[]).includes(p.minds)) out.minds = p.minds;
  if (typeof p.fairMode === 'boolean') out.fairMode = p.fairMode;
  if (typeof p.dentBoost === 'boolean') out.dentBoost = p.dentBoost;
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
