// The line to the LOCAL mind: an open-source Jev-compatible model on this Mac, reached through
// the dev-server bridge at /api/local-jev (server/local-mind.ts), which speaks the same
// /v1/systemone request and response shape as /api/jev. When the bridge or the model is down (or
// keeps answering too slowly) the link goes offline, the House Mind fights, and the health
// endpoint is re-probed every few seconds until the model is back.
import { JevLink, type JevLinkOptions, type LinkHealth } from './link';

export const LOCAL_JEV_ENDPOINT = '/api/local-jev';
export const LOCAL_TIMEOUT_MS = 3500; // the bridge gives up at 3000 ms, so its 504 arrives first
export const LOCAL_HEALTH_MS = 3000;
export const LOCAL_SLOW_MS = 1500;
export const LOCAL_SLOW_LIMIT = 3;
const HEALTH_TIMEOUT_MS = 4000;

/** GET <endpoint>/health; never throws (a failed probe is { ok: false, error }). */
export async function probeLocalHealth(endpoint = LOCAL_JEV_ENDPOINT, fetchImpl: typeof fetch = fetch): Promise<LinkHealth> {
  try {
    const r = await fetchImpl(`${endpoint}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const j = (await r.json().catch(() => null)) as LinkHealth | null;
    if (!r.ok || !j) return { ok: false, error: `health HTTP ${r.status}` };
    return { ok: j.ok === true, model: j.model, backend: j.backend, latencyMs: j.latencyMs, error: j.error };
  } catch (e) {
    return { ok: false, error: `health unreachable: ${(e as Error)?.message ?? e}` };
  }
}

export function createLocalLink(opts: JevLinkOptions = {}): JevLink {
  const endpoint = opts.endpoint ?? LOCAL_JEV_ENDPOINT;
  return new JevLink({
    timeoutMs: LOCAL_TIMEOUT_MS,
    healthMs: LOCAL_HEALTH_MS,
    slowMs: LOCAL_SLOW_MS,
    slowLimit: LOCAL_SLOW_LIMIT,
    health: () => probeLocalHealth(endpoint, opts.fetchImpl),
    ...opts,
    endpoint,
  });
}

let sharedLocal: JevLink | null = null;
/** The page-wide LOCAL link (both fighters share its budget and its online/offline state). */
export function sharedLocalLink(): JevLink {
  sharedLocal ??= createLocalLink();
  return sharedLocal;
}
