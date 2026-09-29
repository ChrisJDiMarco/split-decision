// The shared line to Jev: one per match, used by both fighters. It owns the local
// request budget (never hammer the proxy) and the online/offline state. When a call
// fails the link goes offline and allows exactly one probe every RETRY_MS, because the
// proxy answers 503 until Chris approves the macOS Keychain prompt.
import { askJev, JevError, type JevClientOptions, type JevQuestion, type JevResult } from './jev-client';
import type { JevStatus } from './types';

export const MAX_REQUESTS_PER_S = 8;
export const RETRY_MS = 10_000;
export const LINK_TIMEOUT_MS = 2000;
const WINDOW_MS = 1000;

export type AskFn = (state: unknown, questions: Record<string, JevQuestion>) => Promise<JevResult>;

export interface JevLinkOptions extends JevClientOptions {
  maxPerSecond?: number;
  retryMs?: number;
  now?: () => number; // wall clock in ms
  ask?: AskFn; // replaces the HTTP client entirely
}

export class JevLink {
  status: JevStatus = 'unknown';
  lastError: string | null = null;
  lastErrorStatus: number | null = null;
  private sentAt: number[] = [];
  private nextRetryAt = 0;
  private probing = false;
  private readonly maxPerSecond: number;
  private readonly retryMs: number;
  private readonly now: () => number;
  private readonly ask: AskFn;

  constructor(opts: JevLinkOptions = {}) {
    this.maxPerSecond = opts.maxPerSecond ?? MAX_REQUESTS_PER_S;
    this.retryMs = opts.retryMs ?? RETRY_MS;
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
    return !this.probing && this.now() >= this.nextRetryAt;
  }

  /** Sends one request. Caller must check canSend() first. Rejects on any failure. */
  async send(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult> {
    const isProbe = this.offline;
    if (isProbe) this.probing = true;
    this.sentAt.push(this.now());
    try {
      const res = await this.ask(state, questions);
      this.status = 'online';
      this.lastError = null;
      this.lastErrorStatus = null;
      return res;
    } catch (e) {
      this.markFailed(e);
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
    this.nextRetryAt = this.now() + this.retryMs;
  }
}
