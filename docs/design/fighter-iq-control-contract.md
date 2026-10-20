# Control contract: feints and setup → payoff combos (fighter IQ)

From the fighter-IQ build (2026-09-29). The brain and physics sides are done: weak-spot map, feint and bite reads, habit model, setup → payoff combos in the Jev call, the MIND panel's plan and READ lines. The control build owns `src/physics/control` and needs to do the following. Until it does, the brain runs combos step by step (`COMBO_SEQUENCING = 'brain'` in `src/brain/sequencer.ts`) on top of the existing `TODO(control-build)` fallbacks.

## What exists for control to read

- `Intent.combo` + `Intent.comboPlan` (`src/core/protocol.ts`): `setup` (how many leading steps are the setup), `zones[i]` (where step i shows or lands), `payoffZone`, `fishing` (the reaction the setup wants), `tempo[i]` (seconds to hold before step i), `step` (set only on brain-sequenced step intents).
- `latestRead(ctx, corner)` from `src/physics/openings`: the newest read of this robot's feints (`FeintRead`: level, limb, skill, `bit`, `reactions`). A bite is published 0.06 s after it is seen; "no bite" when the 0.5 s window closes.
- `openingsNow(ctx, corner)` as before, and `RobotTelemetry.weakSpots` (zone, score, reasons, open side of the head).

## 1. A feint must look like this

The physics reads a feint as **a strike windup of the setup limb, cancelled by choice before the strike phase**. So:

1. **Use the real strike's windup.** The same `SkillDef` or mocap clip the strike would use, aimed at the step's zone (`comboPlan.zones[step]`, or `intent.target` for a lone `feint`):
   - head: high feint, with the rear hand (cross or overhand) by preference, or the jab;
   - torso: body feint (cross or hook at the torso);
   - a leg: low feint, a `low_kick` windup (`front_kick` if that is all it has);
   - `feint_left` / `feint_right`: that hand.
2. **Sell it.** Show at least 60-70% of the windup and at least 0.18 s of motion: hip turn, weight shift onto the front foot, shoulder dip, gaze in `aim` mode on the zone. The physics needs 30% of the windup shown (`MIN_SHOWN`) before it counts. Today's fallback (`feintStrike`) shows a jab windup for about 60 ms. That is too short to sell, it never trips a reflex, and it is always high, which is why reads are rare in live fights.
3. **Telegraph like the real thing.** `r.windup` should ramp the way the faked strike's would (`runner.windup()` = telegraph × u). A feint meant to draw a guard should reach at least the opponent's reflex threshold (`REFLEX_WINDUP` 0.55 in `tactics.ts`) at the pull point. The jab (0.25) and cross (0.45) never reach it; the overhand (0.85) and front kick (0.55) do. Either fake a strike with a high telegraph or give feints their own telegraph of about 0.6 or more at the pull.
4. **Abort by choice.** `skills.cancel(env)`, so `lastEnd` is `'cancelled'`. A forced cancel (knockdown or timeout) or a windup that reaches the strike phase is not a feint and produces no read. Only a windup shown while `r.intent` asks for a feint is read: `tactic` is `feint` / `feint_left` / `feint_right`, the brain-sequenced step (`comboPlan.step`) is a feint, or a `combo` the body runs whole contains a feint. A strike the body pulls for a reflex, a switch to defence or a referee break gives no read, because his attack usually caused the pull and would read as a counter.
5. **Recover ready to fire.** Get back to guard with the weight over the base and both feet planted within about 0.25 s. The payoff comes 0.06-0.3 s after the pull.

## 2. Combo sequencing (`tactic: 'combo'`)

1. **Order.** Run `combo` in order, step i aimed at `zones[i]`. A `feint` step is done as in section 1. A `switch_stance` step finishes with both feet planted and held (the 0.4 s stance rule).
2. **Tempo.** `tempo[i] > 0` means hold guard in stance, with no strikes, for that long before step i. That pause is the rhythm break.
3. **Chaining.** Start the next step's windup from about 70% of the previous step's recovery. Don't wait for the TacticRunner cooldown (`nextStrikeAt`), which is for single strikes.
4. **The payoff (steps from `setup` on).**
   - Throw it at aggression `max(intent.aggression, 0.8)`.
   - Commit weight: step in, rotate hips then shoulders, follow through.
   - Launch it within 0.1 s of the setup ending, or at once when `latestRead(ctx, corner)` shows a new bite for this setup.
   - Adapt it to the read, the same way the brain's sequencer does:

     | Read | Payoff |
     |---|---|
     | `retreated` | a long shot instead: front kick to the torso, else cross, else jab |
     | `countered` | keep the move, and also arm it as the `missed_recovering` / `overcommitted` opening reflex so it lands on his whiff |
     | `covered`, `flinched` or no bite | the planned move, at `payoffZone` |
5. **Abort** on any of these:
   - the robot goes down, or the opponent does;
   - the next step can't reach (the opponent is more than 0.8 m beyond its range);
   - a new intent arrives whose combo differs (compare the step lists).
6. **Brain-sequenced steps.** An intent that carries `comboPlan.step` is one step the brain is sequencing, so run `intent.tactic` as a single tactic (today's behaviour) and do not restart the combo. Only `tactic: 'combo'` without `step` means "run the whole thing".
7. **Visibility (recommended).**
   - Set `robot.skill` to the step's skill id, so the brain's step detection and the reads keep working.
   - Add `RobotTelemetry.comboStep?: number`, additive, so the MIND panel can follow a body-run combo.
8. **Switching over.** When 1-7 are in, set `COMBO_SEQUENCING = 'body'` in `src/brain/sequencer.ts`. The brain then sends one `combo` intent and shows the plan without stepping it.

## What the audience should see

**The setup.** The feint is a real, readable start of a strike:

- the shoulder turns and the weight goes onto the front foot;
- he reacts (guard up, a step back, a flinch, a counter);
- the READ line says so.

**The payoff.** It lands where the setup opened him:

- a low kick into the knee he just stopped guarding;
- a head kick over hands that dropped for a low fake.

It's thrown with the whole body, hips first, the support leg driving and the arms counter-rotating for balance, and it snaps back to guard.

## Note (2026-10-20): body sequencing is on

`COMBO_SEQUENCING = 'body'` (src/brain/sequencer.ts).
- **What the brain sends.** One combo intent per combination, with no `comboPlan.step`. The body throws every step.
- **What the brain does while the combo runs.** It only follows `RobotTelemetry.comboStep` and the read, for the plan and READ lines. A retreat read shows the long shot the body throws instead.
- **When it decides again.** Once `comboStep` reaches the step count AND the last blow is past its windup (`RobotTelemetry.committed`), so the next intent lands while the last blow does. For a model mind (Jev or LOCAL), a `hold_range` reset goes out meanwhile (also when the plan is dropped mid-way); the answer still applies.
- **Review fix (2026-10-20).** The first version decided at the last step's windup start. The body pulls a strike still in its windup for a defensive intent (`hold_range`, `guard`, a circle: `TacticRunner.run`), so the reset, or the House Mind's next guard, pulled the payoff. Measured on dcm (`tests/brain/review-combo-cancel.ts`, 8 fights of 40 s): last steps pulled in their windup 37% (22 of 59) with a model mind and 19% (14 of 75) with the House Mind before the fix, 2% (1 of 47) and 6% (2 of 31) after; earlier steps 0-4% throughout. A House-run combination is also no longer aborted when the model comes back mid-way (the body is running it whole anyway).
- **Fallback for a body that does not run combos whole.** Such a body shows the intent applied and no `comboStep` for `BODY_PROOF_S` (the legacy path). The brain then steps the combo as before.
- **Measured.** House-Mind fights on `SD_BALANCE=dcm`, 8 fights each run (`tests/brain/measure-combos.ts`):

| | before | after |
|---|---|---|
| Brain step intents | 121 | 0 |
| Combos with a step thrown again | 16% (12 of 76) | 6% (6 of 107) |

**For the control build (body side).** What is left of the re-throws comes from the body:
- When a whole combo ends (done, or dropped for a reflex), the standing `tactic: 'combo'` intent runs `fallbackTactic('combo')`, its first step, as a single tactic until the next intent arrives.
- A finished whole combo could hold instead.
- A new intent identical to the combination already running is absorbed, then replays step 0 the same way.

Also, `tests/balance/pace-recorder.ts` labels idle time under a whole combo intent by its first step, so a setup that opens with a feint shows its idle gaps as 'feint'.
