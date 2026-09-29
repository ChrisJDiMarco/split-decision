// Shared fixtures for brain tests: telemetry built from real designs, frames, mock Jev.
import type { RobotTelemetry, SimEvent, WorldMeta } from '../../src/core/protocol';
import type { Corner, FighterSetup, RobotDesign } from '../../src/core/types';
import type { JevQuestion, JevResult } from '../../src/brain/jev-client';
import type { BrainFrame } from '../../src/brain/types';
import { DESIGNS } from '../../src/robots/designs';

export function telemetry(design: RobotDesign, corner: Corner, over: Partial<RobotTelemetry> = {}): RobotTelemetry {
  const joints = design.parts.flatMap((p) => (p.joints ?? []).map((j) => ({ name: j.name, health: 1, state: 'ok' as const, tempC: 30, torqueFrac: 0 })));
  return {
    corner,
    upright: 1,
    balance: 1,
    down: false,
    comWorld: corner === 0 ? [-1, 0, 1] : [1, 0, 1],
    heading: corner === 0 ? 0 : Math.PI,
    velocity: [0, 0, 0],
    battery: 0.95,
    gyroHealth: design.gyro ? 1 : 0,
    gyroSaturation: 0.1,
    hydraulicPressure: Object.fromEntries((design.hydraulics ?? []).map((h) => [h.id, 1])),
    skill: 'idle',
    skillPhase: 0,
    windup: 0,
    parts: design.parts.map((p) => ({ id: p.id, hp: 1, smoke: 0, heat: 0, attached: true, leak: 0 })),
    joints,
    damageTotal: 0,
    intent: null,
    ...over,
  };
}

/** Places the two fighters `distance` metres apart on the x axis, facing each other. */
export function apart(distance: number): [Partial<RobotTelemetry>, Partial<RobotTelemetry>] {
  return [{ comWorld: [-distance / 2, 0, 1], heading: 0 }, { comWorld: [distance / 2, 0, 1], heading: Math.PI }];
}

export interface Scene {
  red: RobotDesign;
  blue: RobotDesign;
  meta: WorldMeta;
}

export function scene(red = 'bruiser', blue = 'striker'): Scene {
  return {
    red: DESIGNS[red],
    blue: DESIGNS[blue],
    meta: {
      nbody: 0,
      timestep: 0.001,
      robots: [
        { corner: 0, design: red, prefix: 'r_', parts: [] },
        { corner: 1, design: blue, prefix: 'b_', parts: [] },
      ],
      props: [],
    },
  };
}

export function frame(sc: Scene, time: number, distance: number, opts: {
  events?: SimEvent[];
  red?: Partial<RobotTelemetry>;
  blue?: Partial<RobotTelemetry>;
} = {}): BrainFrame {
  const [a, b] = apart(distance);
  return {
    tick: Math.round(time * 1000),
    time,
    events: opts.events ?? [],
    telemetry: [telemetry(sc.red, 0, { ...a, ...opts.red }), telemetry(sc.blue, 1, { ...b, ...opts.blue })],
  };
}

export const RED_SETUP: FighterSetup = {
  design: 'bruiser', skin: 'factory', temperament: 1,
  plan: 'Walk him down. Jab to set up the overhand. Punish every kick with a body shot.',
};

/** A Jev-shaped answer that favours `favourite` on the tactic question. */
export function answerFor(questions: Record<string, JevQuestion>, favourite?: string, confidence = 0.8): JevResult {
  const answers: JevResult['answers'] = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria);
      const top = id === 'tactic' && favourite && keys.includes(favourite) ? favourite : keys[0];
      const rest = (1 - 0.7) / Math.max(1, keys.length - 1);
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === top ? 0.7 : rest]));
      answers[id] = { type: 'choice', choice: top, confidence: id === 'tactic' ? confidence : 0.7, probabilities };
    } else if (q.type === 'noul') {
      answers[id] = { type: 'noul', noul: 0.3 };
    } else {
      answers[id] = { type: 'score', score: 2, confidence: 0.5, probabilities: Object.fromEntries(q.criteria.map((c) => [c, 1 / q.criteria.length])) };
    }
  }
  return { answers, latencyMs: 120, inputTokens: 900, outputTokens: 20 };
}

/** Lets pending promise chains (link.send → brain.onAnswer) settle. */
export function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
