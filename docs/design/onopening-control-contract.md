# Control contract: Intent.onOpening (pre-armed opening reflexes)

From the brain-gaps build (builder + reviewer). The brain side is done; the control layer must implement this.

## Builder's contract

The control build owns src/physics/control and needs to add all of the following. The intelligence side (protocol field, `openingsNow`, telemetry) is already in place.

1. **Arming.** Keep an `armed` flag per robot. Set it to true every time a new Intent is applied to the robot (every intent message, including one identical to the last). Each arming fires at most once.

2. **Polling.** In the tactic update (TacticRunner), next to the existing counterIfLunge reflex, when `intent.onOpening` is set and `armed` is true, call `openingsNow(ctx, robot.corner)` from src/physics/openings. It is cached per tick, so calling it every control tick is cheap; if you want it cheaper, poll every 4 ms. Then check each opening in `intent.onOpening` in this order: `missed_recovering`, then `overcommitted`, then any others. The first entry that meets every condition below fires; if none does, stay armed and check again next poll.

3. **Conditions to fire.** All of these must hold:
   - (a) the opening appears in the list `openingsNow()` returned;
   - (b) the robot is not down and is not already in a strike phase (abandoning a strike still in windup is fine, same rule as the existing reflex);
   - (c) the move can run: `canUse(robot, SKILLS[TACTIC_SKILL[fallbackTactic(move)]])`, or the real flashy MotionPlayer move once it exists, and the robot's current `moveRisk[move]` is below 0.97;
   - (d) the opponent's centre of mass is inside that skill's range (the same range check used before throwing a strike);
   - (e) counterIfLunge is not firing on this same tick; if both trigger together, counterIfLunge wins.

4. **Firing.** Start the move once, aimed at `intent.target`, with aggression `max(intent.aggression, 0.8)`. For flashy moves this means the MotionPlayer move with its take-off readiness check; until that exists, run the `fallbackTactic`. Set `armed` to false. Afterwards fall back to `intent.tactic` as usual. `sidestep_counter` only ever arrives under the `overcommitted` key; run it like the existing sidestep counter.

5. **Visibility (recommended).** Set the robot's `skill` string to `reflex.opening.<move>` for the move's duration, or emit an equivalent event. That lets tools/fight-metrics.ts count fired reflexes and whether they land; the brain's fight memory does not record them yet.

6. **Other additive fields to consume.** Where control or metrics look at openings, `side_on` is a new Opening value (60-120° off square), and `turned_away` now means only more than 120°. `BodySnapshot.planted` (true when both feet are planted per `gait.bothPlanted()`, the robot isn't down and no leg skill is running) is the moment stance and move risk are read. Do not rely on stance changing mid-step: the published `stance` changes only after a new lead foot has held, planted, for 0.4 s. Stance switching (`switch_stance`) should therefore finish with both feet planted and held.

7. **Get-ups.** No new contract. `getupStyle: 'kip_up'` will now arrive much more often for light, wild fighters (chance about 0.55-0.65) and occasionally for heavy ones (about 0.05-0.1), so the kip-up attempt path, including a visible failure, is what shows up on stream.

## Reviewer's amended contract

The builder's contract for `Intent.onOpening` (in its report and the protocol.ts comment) is correct and matches the existing counterIfLunge rules. The brain side needs nothing more. What control must do, with my amendments marked NEW:

1. **Arming.** Keep an `armed` flag per robot. Set it true whenever an intent message is applied, even one identical to the last. Each arming fires at most once.

2. **Polling.** In TacticRunner, next to `reflex()`: when `intent.onOpening` is set and `armed` is true, call `openingsNow(ctx, robot.corner)` from src/physics/openings. It is cached per tick, but its first call in a tick builds snapshots of both bodies. Polling every step costs about 6% of sim time, so poll every 4-5 ms instead. Check `missed_recovering` first, then `overcommitted`, then any other key.

3. **Conditions to fire.** All of these must hold:
   - (a) the opening is in the list `openingsNow()` returned;
   - (b) the robot is not down and `!this.c.skills.committed()`; a strike still in windup may be cancelled, the same as `reflex()`;
   - (c) the move can run: `canUse(robot, SKILLS[TACTIC_SKILL[fallbackTactic(move)]])`, or the real MotionPlayer move once it exists, and the robot's current `moveRisk[move]` is below 0.97;
   - (d) the opponent's centre of mass is inside that skill's range;
   - (e) NEW, stronger than "not on the same tick": if counterIfLunge already fired for this same opponent strike (its latch is set), do not also fire the `overcommitted` reflex for that strike. counterIfLunge fires on the windup and `overcommitted` opens in the strike phase of the same blow, so a single-tick exclusion still lets a guard be followed straight away by a spinning backfist. The `missed_recovering` reflex may still fire after the whiff.

4. **Firing.** Run the move once, aimed at `intent.target`, at aggression `max(intent.aggression, 0.8)`. Until MotionPlayer exists, run `fallbackTactic(move)`. Then set `armed` to false and go back to `intent.tactic`. `sidestep_counter` only ever arrives under the `overcommitted` key. It has no `TACTIC_SKILL`, so send it to the existing `sidestepCounter()` path and skip condition (c) for it.

5. **Rate limit (NEW, recommended).** Measured on sparring fights, reflex openings start within 1.3 m 4-14 times a minute, almost all of them `overcommitted`. Jev almost always arms something, usually spinning_backfist, and the House Mind arms 70% of the time. Uncapped, that is about 10-40 flashy reflexes per 3-minute round, against the design doc's "a few times a round". Suggest at most one flashy-move reflex (FLASHY_MOVES) per fighter every 8-10 s of sim time; plain strikes and sidestep_counter uncapped. Tune from the metrics below.

6. **Visibility.** While a reflex runs, set `robot.skill` to `reflex.opening.<move>`, or emit an equivalent event, so tools/fight-metrics.ts can count fired reflexes and whether they land. The brain's fight memory does not see reflexes otherwise.

7. **Openings and snapshot fields.**
   - `side_on` is a new Opening (60-120° off square); `turned_away` now means more than 120° only.
   - `BodySnapshot.planted` means both feet planted per `gait.bothPlanted()`, not down, and no leg skill running.
   - Published `stance` changes only after a new lead foot has held, planted, for 0.4 s, so `switch_stance` must finish with both feet planted and held.
   - NEW: no reflex is armed while the opponent is down (the brain-side fix above), so a stale `onOpening` can only survive about one decision interval after he gets up.

8. **Get-ups.** No new fields. `getupStyle: 'kip_up'` will arrive often for light, wild fighters (chance about 0.55-0.65) and occasionally for heavy ones (about 0.05-0.1). A visible, failed kip-up attempt path is what will show on stream.

9. **Existing failure, control side.** tests/openings/fallback.test.ts fails (thrown = 2, test needs more than 2) with the brain and openings files reverted to HEAD, so it comes from the concurrent control/robots edits and should be fixed there.
