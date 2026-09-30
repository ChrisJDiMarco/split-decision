// The shared line to Jev: one per match, used by both fighters. It owns the local
// request budget (never hammer the proxy) and the online/offline state. When a call
// fails the link goes offline and allows exactly one probe every RETRY_MS, because the
// proxy answers 503 until Chris approves the macOS Keychain prompt.
// A link given a `health` probe (the LOCAL mind) recovers differently: while offline it sends no
// decisions at all and polls the probe every healthMs instead, and it also goes offline when its
// answers keep arriving too slowly (slowMs, slowLimit in a row).
import { askJev, JevError, type JevClientOptions, type JevQuestion, type JevResult } from './jev-client';
import type { JevStatus } from './types';

export const MAX_REQUESTS_PER_S = 8;
export const RETRY_MS = 10_000;
export const LINK_TIMEOUT_MS = 2000;
const WINDOW_MS = 1000;
/** Health links: a failure within this long of a recovery counts as flapping (backoff doubles). */
const FLAP_WINDOW_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;

export type AskFn = (state: unknown, questions: Record<string, JevQuestion>) => Promise<JevResult>;

/** What a health probe reports (the /api/local-jev/health body). */
export interface LinkHealth { ok: boolean; model?: string; backend?: string; latencyMs?: number; error?: string }
export type HealthFn = () => Promise<LinkHealth>;

export interface JevLinkOptions extends JevClientOptions {
  maxPerSecond?: number;
  retryMs?: number;
  now?: () => number; // wall clock in ms
  ask?: AskFn; // replaces the HTTP client entirely
  /** Offline recovery by health probe instead of a real request (LOCAL). */
  health?: HealthFn;
  healthMs?: number;
  /** An answer slower than slowMs counts as slow; slowLimit slow answers in a row take the link offline. */
  slowMs?: number;
  slowLimit?: number;
}

export class JevLink {
  status: JevStatus = 'unknown';
  lastError: string | null = null;
  lastErrorStatus: number | null = null;
  /** The model the last health probe named (LOCAL), or null. */
  model: string | null = null;
  private sentAt: number[] = [];
  private nextRetryAt = 0;
  private probing = false;
  private readonly maxPerSecond: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly ask: AskFn;
  private readonly health: HealthFn | null;
  private readonly healthMs: number;
  private readonly slowMs: number;
  private readonly slowLimit: number;
  private slowRun = 0;
  private healthInFlight = false;
  /** Health links: bumped by every failure, so an answer sent before it cannot bring the link back. */
  private failEpoch = 0;
  /** Health links: the current re-probe interval (doubles while the model keeps failing right after recovering). */
  private backoffMs: number;
  private onlineSince = -Infinity;
  private nameAsked = false;

  constructor(opts: JevLinkOptions = {}) {
    this.maxPerSecond = opts.maxPerSecond ?? MAX_REQUESTS_PER_S;
    this.retryMs = opts.retryMs ?? RETRY_MS;
    this.health = opts.health ?? null;
    this.healthMs = opts.healthMs ?? this.retryMs;
    this.slowMs = opts.slowMs ?? Infinity;
    this.slowLimit = opts.slowLimit ?? 3;
    this.backoffMs = this.healthMs;
    this.now = opts.now ?? (() => performance.now());
    const client: JevClientOptions = { endpoint: opts.endpoint, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? LINK_TIMEOUT_MS };
    this.ask = opts.ask ?? ((state, questions) => askJev(state, questions, undefined, client));
  }

  get offline(): boolean { return this.status === 'offline'; }

  /** Requests sent in the last second (for the HUD). */
  get recentRate(): number {
    this.prune();
    return this.sentAt.length;
  }

  retryInMs(): number {
    return this.offline ? Math.max(0, this.nextRetryAt - this.now()) : 0;
  }

  private prune() {
    const cutoff = this.now() - WINDOW_MS;
    if (this.sentAt.length && this.sentAt[0] <= cutoff) this.sentAt = this.sentAt.filter((t) => t > cutoff);
  }

  private budgetOk(): boolean {
    this.prune();
    return this.sentAt.length < this.maxPerSecond;
  }

  /** May a request go out right now? Offline, only a single probe once the retry is due. */
  canSend(): boolean {
    if (!this.budgetOk()) return false;
    if (!this.offline) return true;
    if (this.health) { this.poll(); return false; }
    return !this.probing && this.now() >= this.nextRetryAt;
  }

  /**
   * Health-probed links only: while offline, run one probe once it is due (every healthMs); a
   * healthy answer brings the link back online. Cheap to call every frame.
   */
  poll() {
    if (!this.health || !this.offline || this.healthInFlight || this.now() < this.nextRetryAt) return;
    this.healthInFlight = true;
    this.nextRetryAt = this.now() + this.backoffMs;
    this.health().then(
      (h) => {
        if (h.model) this.model = h.model;
        if (!this.offline) return;
        if (h.ok) {
          this.status = 'online';
          this.onlineSince = this.now();
          this.slowRun = 0;
          this.lastError = null;
          this.lastErrorStatus = null;
        } else if (h.error) {
          this.lastError = h.error;
        }
      },
      (e) => { this.lastError = e instanceof Error ? e.message : String(e); },
    ).finally(() => { this.healthInFlight = false; });
  }

  /** Sends one request. Caller must check canSend() first. Rejects on any failure. */
  async send(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult> {
    const isProbe = this.offline;
    if (isProbe) this.probing = true;
    const epoch = this.failEpoch;
    this.sentAt.push(this.now());
    try {
      const res = await this.ask(state, questions);
      // A health link that failed while this answer was on its way stays offline: only a health
      // probe brings it back (a late slow answer used to revive it at once, so it flickered).
      if (this.health && epoch !== this.failEpoch) return res;
      this.status = 'online';
      this.lastError = null;
      this.lastErrorStatus = null;
      if (this.health && this.model === null && !this.nameAsked) {
        // Online from the first answer (no probe ran): ask the health endpoint once for the model's name (HUD label).
        this.nameAsked = true;
        this.health().then((h) => { if (h.model) this.model = h.model; }, () => {});
      }
      this.slowRun = res.latencyMs > this.slowMs ? this.slowRun + 1 : 0;
      if (this.slowRun >= this.slowLimit) this.markFailed(new Error(`too slow: ${this.slowRun} answers over ${this.slowMs} ms`));
      return res;
    } catch (e) {
      if (!this.health || epoch === this.failEpoch) this.markFailed(e); // a health link already offline keeps its backoff
      throw e;
    } finally {
      if (isProbe) this.probing = false;
    }
  }

  /** Records a failure (also used when an answer arrives but is malformed). */
  markFailed(e: unknown) {
    this.status = 'offline';
    this.lastError = e instanceof Error ? e.message : String(e);
    this.lastErrorStatus = e instanceof JevError ? e.status : null;
    if (this.health) {
      // Failing again soon after a probe said healthy (a model that answers the probe but not real
      // decisions, or answers them too slowly): wait twice as long before the next probe.
      const flapped = this.now() - this.onlineSince < FLAP_WINDOW_MS;
      this.backoffMs = flapped ? Math.min(MAX_BACKOFF_MS, this.backoffMs * 2) : this.healthMs;
      this.onlineSince = -Infinity;
      this.failEpoch++;
    }
    this.nextRetryAt = this.now() + (this.health ? this.backoffMs : this.retryMs);
    this.slowRun = 0;
  }
}
