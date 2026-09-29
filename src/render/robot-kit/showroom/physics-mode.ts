// Showroom physics mode: runs the real MuJoCo worker and drives the kit exactly the way the
// game will: WorldMeta → buildRobotKitViews, pose buffer → applyPoses, telemetry →
// updateRobotKit, impact events (physics space) → applyImpact (scene space).
import * as THREE from 'three/webgpu';
import type { MainToWorker, SimEvent, WorkerToMain } from '../../../core/protocol';
import type { MatchSetup, SkinId } from '../../../core/types';
import { applyPoses } from '../../robot-view';
import { applyImpact } from '../damage';
import { buildRobotKitViews } from '../build';
import { updateRobotKit } from '../animate';
import type { RobotKitView } from '../types';

export interface PhysicsShow {
  views(): RobotKitView[];
  release(): void;
  reset(): void;
  update(dt: number): void;
  status(): string;
  dispose(): void;
}

type Frame = Extract<WorkerToMain, { type: 'frame' }>;

const tmpP = new THREE.Vector3();
const tmpN = new THREE.Vector3();

function handleEvent(e: SimEvent, views: RobotKitView[], physicsRoot: THREE.Group): number {
  if (e.kind !== 'impact' || e.victim === null || !e.part) return 0;
  const view = views.find((v) => v.corner === e.victim);
  if (!view) return 0;
  physicsRoot.updateMatrixWorld(true);
  const p = physicsRoot.localToWorld(tmpP.set(...e.pos));
  const n = tmpN.set(...e.normal).transformDirection(physicsRoot.matrixWorld);
  applyImpact(view, e.part, p, n, e.energyJ);
  return 1;
}

export function startPhysicsShow(physicsRoot: THREE.Group, designs: [string, string], skins: [SkinId, SkinId]): PhysicsShow {
  const setup: MatchSetup = {
    fighters: [
      { design: designs[0], skin: skins[0], plan: 'Showroom sparring.', temperament: 1 },
      { design: designs[1], skin: skins[1], plan: 'Showroom sparring.', temperament: 1 },
    ],
    seed: 11,
    timestep: 0.001,
    reactionDelayS: 0.3,
  };
  const worker = new Worker(new URL('../../../physics/worker.ts', import.meta.url), { type: 'module' });
  const send = (m: MainToWorker) => worker.postMessage(m);
  let views: RobotKitView[] = [];
  let bodyGroups = new Map<number, THREE.Group>();
  let latest: Frame | null = null;
  const pending: SimEvent[] = [];
  let impacts = 0;
  let state = 'loading physics…';

  worker.onmessage = (ev: MessageEvent<WorkerToMain>) => {
    const msg = ev.data;
    if (msg.type === 'ready') {
      for (const v of views) v.dispose();
      // A reset rebuilds the world: drop the old world's last frame and its unapplied impacts.
      latest = null;
      pending.length = 0;
      impacts = 0;
      const built = buildRobotKitViews(msg.meta, physicsRoot, skins);
      views = built.views;
      bodyGroups = built.bodyGroups;
      state = `ready · ${msg.meta.nbody} bodies`;
    } else if (msg.type === 'frame') {
      latest = msg;
      pending.push(...msg.events);
    } else {
      state = `physics error: ${msg.message.split('\n')[0]}`;
    }
  };
  worker.onerror = (e) => {
    state = `worker failed: ${e.message}`;
  };
  send({ type: 'init', setup });

  return {
    views: () => views,
    release: () => send({ type: 'release' }),
    reset: () => send({ type: 'reset' }),
    update(dt) {
      if (!latest || views.length === 0) return;
      applyPoses(latest.poses, bodyGroups);
      for (const e of pending.splice(0)) impacts += handleEvent(e, views, physicsRoot);
      updateRobotKit(views, latest.telemetry, dt);
    },
    status: () => `${state} · t=${(latest?.time ?? 0).toFixed(1)}s · ${impacts} impacts · ${(latest?.stepMs ?? 0).toFixed(3)} ms/step`,
    dispose() {
      worker.terminate();
      for (const v of views) v.dispose();
      views = [];
    },
  };
}
