# Jev council: several specialist minds per robot (proposal)

Status: proposal from Chris ("multiple Jevs for each robot ... a swarm of Jevs to make decisions in a super unified interesting way"), 2026-09-29. Queue after the balance engine as a proof of concept.

## Idea

Each fighter's mind is a council of specialist Jev minds instead of one. Each specialist sees a focused slice of the state, which suits Jev: its own docs say irrelevant state acts as a distractor.

| Mind | Sees | Decides | Cadence |
|---|---|---|---|
| Aggressor | range, openings, what has landed, opponent damage | strike, target, gamble, combo | 2-4 Hz |
| Guardian | opponent windup and skill, own damage, balance, gyro | guard, slip, exit, counter | 2-4 Hz |
| Ring general | positions, angles, cage, stance | footwork tactic, angle, pivot | 1-2 Hz |
| Strategist | round, scorecard, fight memory, damage trends | plan emphasis, temperament shift | every 5-10 s |

## Fusion

Jev returns calibrated probabilities, so votes fuse without ad-hoc rules: a weighted logarithmic opinion pool over a shared action set, `log p(a) = Σ w_i log p_i(a) + const`. Weights come from the fighter's personality (a brawler weights the Aggressor), live context (low health raises the Guardian) and the Strategist's emphasis. Fusion runs in code, so there is no extra round trip. Pre-armed reflexes (`onOpening`, `counterIfLunge`) come from whichever mind owns them.

## Show

The MIND panel shows the council: each mind's top pick and confidence, the fused decision, and disagreement. Example: "AGGRESSOR overhand 64% · GUARDIAN cover 71% → COUNCIL counter-hook".

## Budget

TypeSafe allows about 1,200 requests/min per account; the local proxy caps at 600 and the brain at 8/s. Aggressor and Guardian can share one call (one state, two question sets). The Ring general and Strategist run slower. Two robots then stay around 6-8 requests/s. Tokens stay trivial at $0.042 per million input.

## Proof of concept and kill criteria

A three-mind council (Aggressor+Guardian in one call, Ring general, Strategist) against today's single mind: 20 headless House-Mind-matched fights plus live Jev fights, and a blind "which was better to watch" review. Keep it if it wins on watchability or on landed strikes and fewer self-inflicted losses. If it loses on both, keep only the council HUD as a flourish.
