// The balance switch (docs/design/balance-engine.md §7). 'legacy' runs the old path: the gait's
// capture-point COM plan, the stance-step planner (stepping.ts) and the posture gyro terms.
// 'dcm' runs the balance engine in this folder: one footstep plan, one DCM reference, the soles
// first and the gyro for emergencies. Tools and tests pick a mode with SD_BALANCE=legacy|dcm
// (read once at load); the worker uses the default below.
export type BalancePath = 'legacy' | 'dcm';

const ENVS = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const ENV = ENVS?.SD_BALANCE;
const PATH: BalancePath = ENV === 'dcm' || ENV === 'legacy' ? ENV : 'legacy';
const INERT = ENVS?.SD_INERTIALIZE;

export const CONTROL: { balance: BalancePath; inertialize: boolean } = {
  balance: PATH,
  // Inertialized target switches (inertialize.ts); SD_INERTIALIZE=0|1 overrides for measurements.
  inertialize: INERT === '1' ? true : INERT === '0' ? false : PATH === 'dcm',
};
