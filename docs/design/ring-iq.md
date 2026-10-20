# Ring IQ: distance and range awareness

Chris (2026-09-29): "the robots just walk up to each other and it looks like they have no awareness of the distance they have from each other, their arm length and effective range for strikes. I do want them to just go full force at each other in crazy ways, but they should also be slightly aware of the moment a bit more."

## The layers
- **Body (control, 500 Hz) owns distance.** Jev decides at 2-4 Hz, so it can't steer range step by step. The body has to manage range the whole time.
- **Mind (Jev / LOCAL / HOUSE) picks what to do from here.** It needs compact range facts, so it doesn't choose a head kick in the clinch or a jab from 2 m.

## Body rules (balance-engine P5 footwork and the pace stage)

**Facts the body works from:**
- its own strike ranges per weapon (`def.range(geo)`);
- the opponent's longest reach (from his design);
- the gap and the closing speed.

**Zones:**
- **Outside:** just beyond his longest reach.
- **Edge:** my longest weapon lands but his doesn't. Only exists when I have the reach advantage.
- **Pocket:** inside both. The exchange happens here.

**How to move:**
- Approach to the edge or just outside, never to contact.
- Enter the pocket WITH a strike: a step-in jab or cross, a lunge, a kick from the edge. Never walk in.
- After a combination, step out or pivot back to the edge, unless the tactic is pressure. Pressure keeps the pocket with short forward steps and cuts off the cage.
- When both advance, predict the meeting point from the closing speed and stop earlier. That prevents guard-to-guard collisions at 0.6 m and treading on the opponent's feet.
- No walking into guard contact unless the intent is clinch.
- Aggression changes how often and how hard they enter, not whether they respect range.

**Measure** (tools/fight-metrics.ts):
- time in contact without a clinch intent (target about 0);
- strikes started out of range, and whiffs from too far or too close;
- share of pocket entries made with a strike;
- time at edge, pocket and outside;
- exchanges per minute (the pace targets still apply).

## Mind rules (serializer, questions, House Mind)
- **"From here" line:** which weapons land now, which need one step in, and which are too close. For example: "from here: jab and cross land, head kick needs a step in, uppercut is too far".
- **Reach advantage:** my longest reach vs his.
- **His threat:** whether he can hit me from here.
- **Meeting time:** the predicted time to contact when closing.
- **Tactic options:** each is annotated as lands from here / needs a step / too close, so the choice matches the geometry.
- **Keep it short:** Jev's own docs say irrelevant state distracts it.
- **House Mind:** uses the same facts.

## Mind side: built (2026-10-06)

**One source of truth.** `src/brain/ranges.ts` reads each strike's landing range from the skill the body actually throws for it: `TACTIC_SKILL[fallbackTactic(t)]`, or, when the design lacks that skill, the design's first strike of the same kind (as `TacticRunner.usable` picks it) → `def.range(humanoidGeometry(design))`. It keeps no table of its own. "Lands from here" ends where the body throws without a step, `lo + throwAt · (hi − lo)` (`def.approach.throwAt`, else `THROW_ZONE` 0.85, mirrored from control/tactics.ts with a guard test), not at `hi`: between the two the body walks in first. A test sweeps every strike of every modern design at 1 cm against that throw-or-step rule. "One step in" is the walk's longest stride (`MAX_STRIDE`, 0.46 × leg length; a test fails if walk.ts changes it). A weapon goes out of the facts when its striker is torn off or a joint it needs is limp or seized, which mirrors `abilities.canUse`. Per design (m, COM to COM, the farthest gap each own weapon is thrown from): FIRECRACKER 0.51-0.61 with a 0.27 step, SAVATE 0.70-0.78 with 0.37, HAYMAKER 0.75-0.91 with 0.37, PYLON 0.76-0.81 with 0.42.

**What Jev reads** (`geometry`, about 20-25 tokens more state):
- `distance` now follows the weapons. Striking range means one of mine lands, just outside reach means one step in, and mid range means nothing reaches. It never contradicts `from_here`. The brain's own cadence still uses the reach band.
- `from_here` gives my working weapons grouped by fit, e.g. "head kick needs a step in; the rest land".
- `his_weapons` says whether his reach me, e.g. "his hook reaches you" or "all his weapons one step off".
- `reach` is the edge in words, e.g. "he out-reaches you by ~15 cm". A body without skill ranges keeps the old inside/outside-his-reach line.
- `closing` adds a meeting-time band when closing, e.g. "closing slowly, in range in about a second".

**Tactic options.** Each strike option ends with "lands from here", "needs a step in", "too close for it", "too far from here" or "out of action". Footwork and defence options don't change. Every option stays at 20 words or fewer. This adds about 25-30 tokens to the tactic question.

**House Mind** (same facts, `weaponFit`):
- It throws what lands. At the edge it steps in WITH a strike (a feint 20% of the time) instead of walking in.
- In the clinch it uses short weapons only. Never a head kick, even where the table says it lands.
- It never picks a weapon that is too far, too close or out of action. That covers combinations by their opener, opening gambles and the staggered finisher.
- When everything is too close, it clinches or makes room.

**A/B switch.** `RANGE_FACTS.enabled` (ranges.ts) turns the facts off for measurement.

**Measured** (`tests/brain/measure-range.ts`, headless House-Mind fights on the legacy controller, frozen tree snapshot, the four modern matchups; logs in `tests/brain/.out/`):

| | off | on |
|---|---|---|
| 2 seeds × 4 matchups, 60 s: chosen strikes that land when the intent applies | 65% | 59% |
| ... lands or one step in / too far | 93% / 6% | 98% / 2% |
| ... landed per minute, whiffs | 12.6, 11% | 8.3, 25% |
| 6 seeds × 4 (24 fights each): land / lands-or-step / too far | 61% / 90% / 8% | 68% / 99% / 1% |
| ... thrown / landed per minute, whiff share | 13.3 / 11.1, 16% | 13.9 / 11.5, 17% |

The mind now picks weapons that fit: too-far choices fall from 8% to 1%. Landed per minute is noise-bound at this sample (per-fight SD about 4-5 per minute). Seeds 1-2 alone read worse and seeds 3-6 read better. The body decides what lands: the legacy TacticRunner walks into each strike's range before throwing whatever is chosen. Every whiff measured started in range, so whiffs are a body/aim issue.

**Live Jev A/B** (`tests/brain/live-range.ts`, 24 requests: 12 frozen fight states serialized old vs new, log in `tests/brain/.out/live-range-2026-10-06.json`):

| | old | new |
|---|---|---|
| Pocket: top choice a strike that lands | 1/4 | 4/4 |
| Outside: top choice a strike from too far | 3/4 | 0/4 (close_distance instead) |
| Share of strike probability on misfits | 35% | 14% |
| Input tokens per request | ~1,680 | ~1,745 |

Open on the mind side: from the edge, Jev with the new wording mostly closes or holds (3 of 4) rather than stepping in with a strike. Two possible fixes: word the note "lands with a step in", or let the body's pace stage turn close_distance into a step-in strike. Re-test with a small A/B.

### Independent review (2026-10-06)

Two defects fixed in `ranges.ts`:
- **"Lands from here" overclaimed.** The range read used `hi` as the edge. The body only throws from `lo + throwAt · (hi − lo)` and steps in beyond that, so for every own weapon of every modern design the last 3-12 cm said "lands from here" while the body walked in first. The "one step" band was shifted by the same amount. It now uses the body's throw edge. The reach edge and meeting time use it too.
- **Menu moves on a body without the fallback skill** (e.g. HAYMAKER's tornado kick, FIRECRACKER's head kick) read the range of a skill the body never throws. The body substitutes the design's first strike of the same kind. The table now mirrors that.

Re-measured with an independent yardstick: `measure-range.ts` now classifies chosen strikes by the body's own throw-or-step rule, not by the helper under test. The builder's table above used the helper's pre-fix `hi` edge. It also counts falls, referee breaks and strikes started during a break. Setup: 4 seeds × 4 modern matchups, 60 s, one frozen tree; logs in `tests/brain/.out/measure-range-review-*.json`.

| | off | builder's version | fixed |
|---|---|---|---|
| Chosen strikes that land / lands-or-step / too far | 50% / 89% / 10% | 51% / 94% / 5% | 58% / 97% / 2% |
| Thrown / landed per minute | 13.8 / 11.9 | 12.8 / 10.0 | 12.5 / 9.7 |
| Whiff share | 14% | 22% | 22% |
| Falls per minute; strikes started in a break | 1.98; 0 | 2.10; 0 | 2.29; 0 |

Range fitness is clearly better. Landed per minute is about 2 lower with the facts on, but the standard error of the difference is about 1.8, so it is not established. The whiff share rise (14% to 22%, about 2 SE) is the one to watch. With the facts on, the House Mind throws fewer jabs (37% of throws to 31%; jabs land 96% of the time) and more long hooks and head kicks, which whiff more (head kick 5 of 9). Whiffs are not concentrated at the far end of the range. A tuning question for the House Mind's weights, not a range-fact error.

Live Jev A/B, 12 requests (6 frozen states from the fixed tree, old vs new; `tests/brain/.out/live-range-review-2026-10-06.json`):
- Pocket: top choice a strike that lands, 0/2 before and 2/2 after.
- Outside: top choice a strike from too far, 1/2 before and 0/2 after.
- Share of strike probability on misfits: 49% before, 20% after.
- Input tokens: about 1,590-1,690 before, 1,640-1,750 after.


## Edge, pressure and the House Mind's temperament, mind side (2026-10-20)

Chris: "they need to be going at each other, this is a fight not dancing and hesitating", "more aggressive and clever".

**Edge wording (live Jev A/B, `tests/brain/live-edge.ts`, 20 requests).** Ten edge states (none of my weapons lands, the longest one step out), across five modern matchups, with him standing or advancing. Log: `tests/brain/.out/live-edge-2026-10-20.json`.

| | A: "needs a step in" | B: "lands with a step in" |
|---|---|---|
| Top choice a step-in strike | 3/10 | 6/10 |
| Top choice close_distance | 7/10 | 4/10 |
| Probability on step-in strikes and the combo | 0.33 | 0.66 |
| Out-of-range strikes on top | 0 | 0 |

B is in (`RANGE_WORDING.step = 'lands'`, ranges.ts). It applies to `from_here` ("everything lands with a step in") and to the tactic options. 'Too far' and 'too close' did not change, so nothing out of range gets promoted. HAYMAKER at 1.03 m and FIRECRACKER still mostly close the distance.

**House Mind** (house-mind.ts):
- **Pressure.** Base aggression is 0.7 + 0.5 × damage lead, clamped to 0.45-0.95. When even it sits at the body's pressure line. It falls below that when losing badly. Closing and step-in entries run at 0.75 or more.
- **Weapon choice.** Strikes are weighted by a prior from the measured landing rates (jab 2, cross and hook 1.3, uppercut 1.2, overhand 1, low kick 0.6, front kick 0.5, head kick 0.35). That prior is multiplied by the fight's own record, `FightMemory.landingFactor`: committed throws by weapon, landed when an impact of ours of at least 4 N·s arrives during the swing or within 0.1 s after. Feints never commit, so they are not counted.
- **Combos and setups.** These are weighted by the geometric mean of their strikes' weights, so one strike that keeps whiffing drags the whole combo down.
- **Never the combo the body is still finishing.** The House does not send the combination the body is still throwing; the body would treat it as the same one and then throw its first step again.
- **From the edge.** It steps in WITH a strike, by preference a punch: a kick one step out weighs 0.1, a punch 0.5. Now and then (12%) it runs a setup that opens with a feint, and 5% of the time a lone feint.
- **His windup in range.** 45% of the time it beats him to it with the straight that has been landing best (cross, jab or hook, only if it lands from there). Otherwise it slips and counters, or covers.
- **His blow already in the air.** It slips and counters (65%) or covers. It never swings into the blow, and it takes no creative gamble then either.
- **Armed lunge answer.** Half the time it is a counter straight that lands from here, otherwise the slip.
- **Pinned on the cage.** Half the time it fights off the fence with what lands, otherwise it circles out.

**Jev and LOCAL** (policy.ts, shared by both):
- The aggression answer maps to 0.25 + 0.75 × level, so 'balanced' is 0.625 and 'pressing' is 0.81.
- An unsure answer (confidence under 0.35) is thrown as a probe when its favourite is a strike that lands from right here and he is not coming. Before, it was always guard and circle.
- The `record` line now also gives the most-thrown weapons' landing ("your head kicks: 0 of 6 landed").

LOCAL vs House on 10 edge and pocket states (`tests/brain/live-minds.ts`, local model, no cloud calls):
- LOCAL attacked in 9 of 10, all in commit mode, mean aggression 0.69. The House attacked in 10 of 10 at 0.72.
- LOCAL answered in about 3 s per decision (one prompt per question on a loaded Mac). That is past `LOCAL_SLOW_MS`, so in play the link goes offline and the House Mind fights. This is a bridge and latency problem, not a mind one.

**Measured** (`tools/fight-metrics.ts --mind house --balance dcm`):
- Setup: 4 modern matchups × 4 seeds × 60 s. Before and after ran on the same frozen physics tree; only `src/brain` differs.

| | before | after |
|---|---|---|
| Committed strikes per minute (both) | 23.2 | 28.2 |
| Landed per minute | 18.2 | 25.1 |
| Whiffs per minute (share) | 5.0 (22%) | 3.1 (11%) |
| Idle in range | 39% | 34% |
| First two-way exchange, median | 9.5 s | 7.8 s |
| Strikes traded within 1 s of his | 25% | 47% |
| Strikes started too far | 34 of 594 | 16 of 472 |
| Pocket entries with a strike | 52% | 60% |
| Self-falls (strict) per minute | 0.86 (12) | 1.14 (13) |
| Fights stopped | 3 | 6 (5 FIRECRACKER head pops, 1 down after a self-fall) |

Landed per fight: 19.2 ± 6.8 before, 23.1 ± 9.9 after (SD). The difference is about 1.3 SE, so it is suggestive only. The whiff share and the trading share moved clearly.

Head kicks went from 103 thrown with 0 landed to 27 thrown with 0 landed. Kicks on the dcm path still almost never land: 1 of 187 before, 0 of 74 after. That is the body's to fix (strike-power P3).

More landed blows mean more FIRECRACKER head pops (its 13 N·s head). That is the damage-calibration item in HANDOFF.

Idle in range is still above the pace target (20%). The causes are the body's: the balance gate 29%, strikes out of their range (the walk-in) 24%, and mid-step 19%.

### Review (2026-10-20, independent)

**Defect fixed: the payoff was pulled.** The brain decided again as soon as the body *started* the last step, while that blow was still in its windup. The next intent (the `hold_range` reset for Jev or LOCAL, or the House Mind's guard, circle or hold) reached the body 0.3 s later, and the body pulls a strike still in its windup for a defensive tactic (`TacticRunner.run`). So the combination lost its payoff.
- Measured with `tests/brain/review-combo-cancel.ts` (dcm, 4 matchups × 2 seeds × 40 s), last steps pulled in their windup:
  - Model mind (a fake Jev answering in 0.5 s): 37% (22 of 59) before the fix, 2% (1 of 47) after.
  - House Mind: 19% (14 of 75) before, 6% (2 of 31) after.
  - Earlier steps stayed at 0-4% throughout.
- **Fix.** `ComboSequencer.follow` waits for `RobotTelemetry.committed` on the last step.
- **Also changed:**
  - A plan that drops mid-way also resets for a model mind.
  - When the model comes back, it no longer aborts a House combination the body is running whole. Before, the panel went blank while the body kept throwing, and nothing reset the standing intent.
  - Tests are in `combo-body.test.ts`.
- **Cost.** Re-throws in House fights went from 4% (4 of 113) to 7% (7 of 106) of combos (`measure-combos.ts`, 8 fights). The decision now comes later, so the body more often finishes before the next intent arrives. That is still the body-side item in the control contract.

**Re-measured.** `tools/fight-metrics.ts --mind house --balance dcm`, 4 matchups × 4 seeds × 60 s. All three arms ran on one snapshot of today's physics tree (14:31), which has moved since the builder's run:
- before: the HEAD brain
- builder: the builder's brain
- after: the builder's brain plus the review fixes

| | before | builder | after |
|---|---|---|---|
| Fight time (min) | 9.6 | 7.7 | 8.7 |
| Landed per minute | 27.8 | 35.1 | 32.6 |
| Landed per minute per fight, mean ± SD | 24.8 ± 14.9 | 29.6 ± 12.3 | 28.8 ± 13.7 |
| Committed per minute | 35.7 | 43.9 | 40.2 |
| Whiffs per minute (share of committed) | 7.9 (22%) | 8.7 (20%) | 7.7 (19%) |
| Idle in range | 46% | 53% | 52% |
| First two-way exchange, median | 6.3 s | 6.0 s | 6.1 s |
| Strikes traded within 1 s of his | 33% | 49% | 50% |
| Jabs landed | 97 of 125 | 133 of 191 | 131 of 199 |
| Kicks landed | 1 of 108 | 0 of 73 | 1 of 71 |
| Head kicks landed | 0 of 41 | 0 of 26 | 0 of 26 |
| Self-falls (strict) | 11 | 6 | 4 |
| Strikes started too far | 14 of 497 | 14 of 492 | 20 of 520 |
| Fight ends: head pop / down / time | 9 / 1 / 6 | 11 / 0 / 5 | 9 / 2 / 5 |

What held up on today's physics:
- More throwing and trading, and fewer head kicks.
- Landed per minute is up about 17%, but under 1 SE per fight.

What did not:
- The halved whiff share: it is 22% → 19%.
- The idle drop: idle in range rose 46% → 52%. Part of that is the pace recorder's 'feint' label for gaps inside setup combos, 5% → 11% of idle; even without it, idle did not drop.
- The head pops are not only FIRECRACKER's now: SAVATE's head popped in 3 of the 4 SAVATE v PYLON fights.

Determinism: the same fight run twice gave identical results (the wall-clock control µs aside).

**His windup** (House Mind, `tests/brain/review-windup-answers.ts`, 16 fights; outcome within 1 s):

| House answer | He landed | We landed |
|---|---|---|
| "beat him to it" (78) | 68% | 55% |
| "cover up" (54) | 74% | 28% |
| "slip and counter" (163) | 71% | 28% |

The counter-straight does not eat more than slipping or covering does, and lands about twice as often. With the 0.3 s reaction delay, none of the three avoids much.

**Live Jev** (10 requests, 'lands with a step in'; `tests/brain/review-live-edge.ts`, log in `tests/brain/.out/review-live-edge-2026-10-20.json`):
- **Mixed gap** (the jab lands, the rest a step out): 5 of 5 took a strike that lands. It never took a step-in kick over it.
- **At the edge with him winding up:**
  - Jab stepping in: 2
  - Closing: 2
  - PYLON's front kick from a step out: 1
  - Slipping: 0
- No out-of-range strikes. The step-in kick is the wording's soft spot: kicks from a step out land 0-1% on dcm.
