// Measures real Jev round-trip latency from this machine with a fight-shaped request.
import { execFileSync } from 'node:child_process';

const key = execFileSync('security', ['find-generic-password', '-s', 'com.chrisdimarco.cabinet.api-keys', '-a', 'typesafe-jev', '-w'], { encoding: 'utf8' }).trim();
const body = {
  model: 'jev-1.13.0',
  state: {
    you: { chassis: 'heavy humanoid boxer', damage: 'left knee actuator at 55% torque', balance: 'stable', heat: 'right shoulder warm' },
    opponent: { chassis: 'quadruped with hydraulic jaw', phase: 'advancing, jaw open', damage: 'front-left leg weak' },
    geometry: { distance: 'just outside striking range', closing: 'slow', bearing: 'opponent at 12 o\'clock', cage: 'open space behind you' },
    round: { round: '2 of 3', clock: '1:48 left' },
    plan: 'Stay off the jaw line. When he lunges, sidestep toward his weak front-left leg and hammer it.',
  },
  questions: {
    tactic: { type: 'choice', instructions: 'Which tactic should `you` run for the next second?', criteria: { hold_range: null, circle_left: null, circle_right: null, sidestep_counter: 'wait for a lunge, step off the line, strike', jab: null, overhand: null, low_kick: null, clinch: null, retreat: null } },
    opp_commit: { type: 'noul', instructions: 'Will the opponent commit to a full lunge within half a second?' },
    counter_if_lunge: { type: 'choice', instructions: 'If the opponent lunges now, what should `you` do?', criteria: { sidestep_left: null, sidestep_right: null, brace: null, uppercut: null } },
    aggression: { type: 'score', instructions: 'How aggressive should `you` be for the next two seconds?', criteria: ['fully defensive', 'cautious', 'balanced', 'pressing', 'all-out'] },
  },
};

const times = [];
let last;
for (let i = 0; i < 6; i++) {
  const t0 = performance.now();
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  times.push(performance.now() - t0);
  if (!res.ok) { console.log('HTTP', res.status, JSON.stringify(json).slice(0, 300)); process.exit(1); }
  last = json;
}
console.log('round trips ms:', times.map((t) => t.toFixed(0)).join(', '));
console.log(JSON.stringify(last, null, 1).slice(0, 1500));
