// Applies brain decisions after the fixed reaction delay, so network jitter never
// changes a fight: both fighters feel exactly the same latency.
import type { SimSystem } from '../sim-context';

export const intentSystem: SimSystem = {
  name: 'intents',
  pre(ctx) {
    for (const r of ctx.robots) {
      if (!r.pendingIntents.length) continue;
      const due = r.pendingIntents.filter((p) => p.applyAtTick <= ctx.tick);
      if (!due.length) continue;
      r.intent = due[due.length - 1].intent;
      r.pendingIntents = r.pendingIntents.filter((p) => p.applyAtTick > ctx.tick);
    }
  },
};
