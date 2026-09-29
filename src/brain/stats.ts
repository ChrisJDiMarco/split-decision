// Per-fighter request accounting: latency percentiles and token usage.
import type { BrainStats, LatencySummary } from './types';

const LATENCY_SAMPLES = 256;

export function percentile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(samples: readonly number[]): LatencySummary {
  if (!samples.length) return { n: 0, mean: 0, p50: 0, p90: 0, p99: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  return { n: sorted.length, mean, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), p99: percentile(sorted, 0.99), max: sorted[sorted.length - 1] };
}

export class BrainStatsTracker {
  requests = 0;
  answered = 0;
  errors = 0;
  droppedStale = 0;
  droppedSuperseded = 0;
  settledLocal = 0;
  fallbackDecisions = 0;
  inputTokens = 0;
  outputTokens = 0;
  private latencies: number[] = [];

  recordAnswer(latencyMs: number, inputTokens: number, outputTokens: number) {
    this.answered++;
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    this.latencies.push(latencyMs);
    if (this.latencies.length > LATENCY_SAMPLES) this.latencies.shift();
  }

  snapshot(inFlight: number): BrainStats {
    return {
      requests: this.requests,
      answered: this.answered,
      errors: this.errors,
      droppedStale: this.droppedStale,
      droppedSuperseded: this.droppedSuperseded,
      settledLocal: this.settledLocal,
      fallbackDecisions: this.fallbackDecisions,
      inFlight,
      latency: summarize(this.latencies),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
  }
}
