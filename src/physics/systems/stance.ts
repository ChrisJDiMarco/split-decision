// Placeholder controller: holds the design's stance. The control module replaces this
// with balance, locomotion and fighting skills driven by the brain's intent.
import type { SimSystem } from '../sim-context';

export const stanceSystem: SimSystem = {
  name: 'control',
  pre(ctx) {
    for (const r of ctx.robots) {
      r.joints.forEach((j, i) => { r.targets[i] = r.design.stance[j.name] ?? 0; });
      r.skill = 'stance';
    }
  },
};
