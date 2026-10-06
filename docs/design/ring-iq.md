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

