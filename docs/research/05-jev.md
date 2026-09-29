# Jev as the fight mind

**Headline:** Jev works as each robot's tactical "System 1" mind if it chooses tactics 2-5 times a second while code handles reflexes, geometry and motor control. Cost is not the limit: about $0.07-0.70 per 3x3-minute fight. The real limits are TypeSafe's 1,200 requests/minute per-account quota (only about 2 live fights at once at 5 Hz), 150-250 ms round trips from the East Coast, and a contract clause that forbids distilling Jev into a local policy.

**Recommendation:** 1. **Put Jev in exactly one place:** the tactical layer. Each fighter makes one request per decision at an adaptive 2-5 Hz: fast in range, slow apart, and skipped when the answer is obvious. Each request asks about 6 questions: a tactic choice over ~12 options, a target choice, a noul on "is the opponent committing?", a pre-computed counter choice, an aggression score and a "who is winning" score.
2. **Keep everything fast or numeric in deterministic code.** That covers skills (IK/PD), reflexes gated by Jev's last distribution, legality masks, commit windows, and turning geometry into word bands. Use the contingency counter answer to hide latency. Fire an immediate re-query on big hits, falls, wind-ups and cage contact.
3. **Use the distribution itself:**
   - a builder "temperament" slider (temperature) and style reweighting;
   - confidence-gated commitment with hysteresis;
   - a live probability HUD;
   - logged p(tactic) against whether the tactic landed, to keep the calibration claim honest.
4. **Make Claude the System 2.** It lints the builder's English plan, writes a scouting report from telemetry only (never opponent-authored text), and rewrites the plan, temperature and options between rounds. Jev also runs three differently weighted judges per 10 s window (code computes the objective facts) and an auto-director with a minimum shot length.
5. **Ship two modes.**
   - Lockstep tournament mode is the default for ranked fights: simulate, then broadcast on a delay, with equal simulated reaction delay for both fighters and no fallback mid-fight.
   - Live mode is for the sandbox: latency-equalized, with a same-API local fallback (behavior tree or decider/Kev) shown as "JEV OFFLINE".
   - Replays re-simulate from a decision log with pinned `jev-1.13.0`; never re-query.
   - Run the authoritative sim in AWS us-west-2 next to `api.typesafe.ai`.
6. **Hide the model behind the `/v1/systemone` wire format** so Jev, OpenRouter Jev, Kev-4B and local decider are drop-in swaps.
7. **Do not plan on distilling Jev** (MCA §2.3(b)). Either get a written exception from TypeSafe, or distill from an Apache-2.0 open decider, or use RL from outcomes after a legal check.
8. **PoC gate before anything big.** Build two blocky three.js robots with a tuned behavior-tree baseline, then run 50 behavior-tree-vs-Jev fights and a blind "which was more fun to watch" test. If Jev loses on both win rate and watchability, keep it only for the HUD, judge, director and plan-programmability.

# Jev as the fighter's mind: design and pressure test

## (a) What Jev actually is today (verified 2026-09-29)

**API.** There is one endpoint, `POST https://api.typesafe.ai/v1/systemone`, with Bearer auth. The request body has `state` (a string, JSON object or array of text), `model`, and a `questions` map keyed by your own IDs ([API ref](https://docs.typesafe.ai/api)). The three question types:
- `choice`: `criteria` maps each option name to a description, up to **255 options**. Returns `choice`, `probabilities` (summing to 1) and `confidence` ([choice](https://docs.typesafe.ai/primitives/choice.md)).
- `score`: an ordered `criteria` array of **2-10 levels**. Returns `score` (the probability-weighted mean of the level indices), `probabilities`, `confidence` and `legend` ([score](https://docs.typesafe.ai/primitives/score.md)).
- `noul`: returns P(yes) in the `noul` field.

`confidence` is a summary of how concentrated the distribution is. It is not a separate estimate. The docs recommend risk-scaled thresholds (act / hedge / fall back) ([confidence](https://docs.typesafe.ai/confidence.md)). Instructions can reference state fields in backticks.

**Limits and pricing** ([models](https://docs.typesafe.ai/models)) [vendor]:
- Model: `jev-1.13.0`. The aliases `jev-latest` and `jev-preview` both point at it today. Pin the exact version for replays.
- Context: 64k tokens per request, of which 32k covers state plus the longest question.
- Input: text only.
- Price: $0.042 per million input tokens; output is free.
- **Rate limit: 250,000 tokens/s and 1,200 requests/minute, which "can change without notice."**

The docs give **no cap on the number of questions** per request. The 64-question and 64 KiB caps in Chris's Cabinet client (`CabinetJev.swift`, lines 8 and 66) are his own client-side guards. His token estimate also assumes the state is repeated for every question. TypeSafe's cookbook says the state is billed **once per request**: 13 questions cost $0.000497 in one call versus $0.006090 as 13 separate calls, and took 0.27 s versus 2.71 s ([parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions.md)) [vendor]. The Python SDK's default timeout is 10 s ([constants](https://docs.typesafe.ai/sdk/python/api/constants.md)). Retry 429/529 with backoff. Jev is also served on OpenRouter as `typesafe/jev-1.13` at `https://openrouter.ai/api/v1/systemone` ([OpenRouter](https://openrouter.ai/typesafe)).

**Known weaknesses** ([Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)) [vendor]:
- It is not a calculator and does not count reliably.
- It "cannot reliably judge whether two values are near each other."
- It reads instructions literally.
- Irrelevant state acts as a distractor.
- It does not treat data as hostile, so adversarial text in the state can steer it.

For a fight this is the design constraint: **code must turn geometry into categories** (for example "just outside spinner reach", "opponent at 1 o'clock") before Jev sees the state.

**Latency.**
- Vendor figures: 70-500 ms end to end, "most around 100", measured from their West Coast laptops ([launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev)) [vendor].
- `api.typesafe.ai` sits within 2 ms of AWS us-west-2. From US East the network alone is about 67-71 ms p50 ([latency-probe](https://github.com/lowspecbot-GH/latency-probe), via [search summary](https://jev.pro/explainers/jev-decision-latency/)) [indep].
- Implied server time is about 76 ms, from a 239 ms p50 measured in France against a 163 ms network floor ([jev-exploration #4](https://github.com/SamuelSacco/jev-exploration/issues/4)) [indep].
- From Tokyo, p50 was 149-211 ms and **flat from 1 to 40 questions** ([qualiteg](https://github.com/qualiteg/jev-typesafe-demo)) [indep].
- A driving simulator measured a 130 ms median and 199 ms p90 ([jev_fsd](https://github.com/BrendanH18/jev_fsd)) [indep builder].

My estimate from Philadelphia, with a kept-alive connection: **about 140-200 ms p50 and about 250-300 ms p95**. This is not measured yet.

**Determinism.** Jev is near-deterministic but not bit-exact. In TypeSafe's own consistency cookbook, answers flipped on 2 of 8 borderline questions across 15 repeats. Raw agreement was 90.8%, rising to 99.2% with a 0.60 abstain threshold ([cookbook](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md)) [vendor].

**Contract.** In the Master Customer Agreement, **§2.3(b) bans using Output "to perform model distillation, train a model to imitate the output of the Services, or develop a similar or competing product."** §9.3 disclaims liability for service interruptions and there is no SLA ([MCA](https://typesafe.ai/legal/mca)).

**Game and robotics prior art.**
- **Doom demo:** about 10 queries/s for about $7/hour on text game state. The vendor itself says "a non-AI doom bot could play better" ([launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev); [The Register](https://www.theregister.com/ai-and-ml/2026/09/16/typesafe-ai-debuts-model-for-machines-that-plays-doom/5296711)) [vendor].
- **jevbox**, the closest prior art: a three.js AI boxing game. It polls Jev **about once per second** for a distribution over 22 actions, reweights it by fighter style plus a per-fight jitter, and samples from it. A separate **reflex layer** blocks or slips telegraphed punches, weighted by how defensive Jev's last distribution was. It caps at 120 Jev calls/min per IP and **falls back to a local heuristic brain** ([jevbox](https://github.com/duc-minh-droid/jevbox)) [indep].
- **MuJoCo arm:** code proposes moves, simulates each ahead in a scratch copy of the physics, and Jev picks one. The stack took 19.1 s and cost $0.0006, versus 158.8 s and $0.75 for Opus 5 ([jev-robotics-demo](https://github.com/FazalAAli/jev-robotics-demo)) [indep builder].
- **jev_fsd driving sim:** decides every 250 ms near hazards and every 650 ms on open road. The last maneuver keeps running while the next decision is in flight, and each decision costs about $0.00008. The **rules-based control brain drove 12/12 clean runs, while Jev ran one red light** ([jev_fsd](https://github.com/BrendanH18/jev_fsd)) [indep].

The pattern across all of these: **code owns the math, Jev owns the judgment, and a scripted bot is a strong baseline.**

**Open clones are real, and several speak the same `/v1/systemone` wire format:**
- **Mapika decider** (Apache-2.0; 2B, 4B, 35B-A3B on Qwen3.5). JevBench hard tier: 0.649 for decider-4b vs 0.730 for Jev. ECE on hard items is about 0.18. On a B300 GPU it runs 5-32 ms. Apple Silicon (MPS) support was merged 2026-09-22 and GGUF support arrived in v1.6.0. On an 8-thread CPU a 4B Q4 model takes 0.3-0.7 s ([repo](https://github.com/Mapika/decider), [card](https://huggingface.co/Mapika/decider-4b)) [self-reported].
- **Kev** (Jared Palmer; 0.8B/4B/9B, Apache-2.0, MLX). Kev-4B is on OpenRouter at the same price as Jev with an 8k context. Model time is 36-179 ms on an L40S and **495 ms on an Apple M5**. On Decision Index 0.2, Kev-9B scored 35.4 vs Jev's 51.7, with ECE 0.138 vs 0.074 ([systemonemodels](https://systemonemodels.org/models/kev/)) [third-party aggregator].
- **Jev-Omni** (Gemma 4 12B plus a classification head, Apache-2.0; text, image, audio and video). On a warm H200 it runs 26 ms per image and about 83 ms per text decision. It has no affiliation with TypeSafe ([HF](https://huggingface.co/akhilaaa3/Jev-Omni)) [self-reported]. Its in-browser WebGPU port needs about 7 s per text question on an M4 Max ([jev-omni.js](https://huggingface.co/ai-ecoverse/jev-omni.js)). Image JevBench v0.1.2 lists it at a 76 ms median.
- **"Reflex 4B"** is actually two projects: [matu79go/reflex-1](https://github.com/matu79go/reflex-1) (Gemma 4 E4B, about 0.10 s on a GB10, NVIDIA only) and [nateGeorge/reflex](https://github.com/nateGeorge/reflex) (Qwen3.5).
- **Ollaya** serves several of these locally behind TypeSafe's API. It claims 89 ms on an RTX 4090 against 236-276 ms for hosted Jev ([ollaya.dev](https://ollaya.dev/)) [competitor claim].

## (b) Architecture: five layers, and Jev owns exactly one

1. **Physics** (240-1000 Hz, another stream's choice). Actuators are modeled with torque-speed curves and heat.
2. **Skill layer** (deterministic code, 60-240 Hz). Each tactic is a parameterized motor program (IK, PD targets, trajectory), for example `hammer_overhead(target, commit)`.
3. **Reflex plus arbiter** (code, 60 Hz), the jevbox pattern. It handles guard, brace, fall recovery and spinner-dodge without waiting for the network. Reflex gains come from Jev's last distribution. The arbiter masks illegal options (weapon not spun up, limb disabled) and enforces commit windows like fighting-game frame data: once a strike passes its commit point it plays out.
4. **Jev: tactical System 1** (async, adaptive 2-5 Hz). One request per fighter per decision.
5. **Claude: corner coach and scout (System 2)**, run between rounds.

**Cadence and latency hiding:**
- **Adaptive rate.** Decide at 5 Hz in striking range and 1-2 Hz when the fighters are apart (jev_fsd uses 250 and 650 ms). Settle obvious ticks locally for free: far apart with no threat means "close distance", with no call.
- **Act on the last decision.** Keep at most 2 requests in flight per fighter, and tag each with its sim tick. When a response arrives, apply it only if the coarse state hash (distance band, opponent phase, own balance) is unchanged. Otherwise drop it.
- **Serialize the predicted state.** Extrapolate the opponent pose about 150 ms forward in code, so the decision fits the moment it lands.
- **Contingency questions.** Extra questions cost essentially no latency, so ask "if the opponent lunges now, what do I do?" alongside "what do I do now?". The arbiter then fires the pre-computed counter the instant the reflex layer detects the lunge, with zero round trips. This is the single most useful trick in the design.
- **Interrupts.** A fresh request goes out immediately, cancelling stale ones, on any of: a hit over a damage threshold, a knockdown or balance loss, a detected opponent wind-up, weapon stall, cage contact, or round clock under 10 s. Reflexes cover the gap in between.

**What goes in the state (≤600 tokens; Jev penalizes distractors).** Your chassis and weapons and their readiness, stance and balance, and a damage map in words ("left knee actuator 55% torque"). Weapon state as a band ("spinner about 90% of max"). Battery and heat as bands with consequences ("shoulder throttles in about 8 s"). Distance band, closing-speed band, clock-face bearing and cage proximity. The opponent's phase ("winding up, about 60% through"), the opponent's damage, their last 3 actions, round, clock, scorecards, the plan and the personality. **No raw floats.**

**Example request** (illustrative; I did not call the API):
```json
{"model":"jev-1.13.0",
 "state":{
  "you":{"name":"RIVET (red)","chassis":"biped, heavy","weapons":"right hydraulic hammer (charged); left shield arm",
         "balance":"stable","damage":"left knee actuator at 55% torque","battery":"61%, normal","heat":"right shoulder warm"},
  "opponent":{"name":"GNASH (blue)","chassis":"quadruped wedge","weapon":"horizontal spinner, spun up",
              "phase":"advancing, spinner facing you","damage":"front-left drive leg weak","recent":"two short lunges in last 5 s"},
  "geometry":{"distance":"just outside spinner reach","closing":"slow","bearing":"opponent at 12 o'clock","cage":"open space behind you"},
  "round":{"round":"2 of 3","clock":"1:48 left","cards":"lost round 1 on 2 of 3 cards"},
  "plan":"Stay off the spinner line. When he lunges, sidestep toward his weak front-left leg and drop the hammer on it.",
  "personality":"Patient counter-puncher; hates backing into the cage."},
 "questions":{
  "tactic":{"type":"choice","instructions":"Which tactic should `you` run for the next second?",
    "criteria":{"hold_range":"stay just outside reach","circle_left":null,"circle_right":null,
      "sidestep_counter":"wait for a lunge, step off the line, strike","hammer_overhead":"step in, drop hammer",
      "hammer_low":"swing at legs/drive","shield_brace":"absorb behind shield","feint":"show wind-up, don't commit",
      "cage_pin":"drive opponent into cage","retreat_reset":"back into open space","taunt":null}},
  "target":{"type":"choice","instructions":"Best target on the opponent right now?",
    "criteria":{"front_left_leg":null,"spinner_hub":null,"sensor_mast":null,"battery_bay":null}},
  "opp_commit":{"type":"noul","instructions":"Will the opponent commit to a full lunge within half a second?"},
  "counter_if_lunge":{"type":"choice","instructions":"If the opponent lunges now, what should `you` do?",
    "criteria":{"sidestep_left":null,"sidestep_right":null,"shield_brace":null,"hammer_overhead":null}},
  "aggression":{"type":"score","instructions":"How aggressive should `you` be for the next two seconds?",
    "criteria":["fully defensive","cautious","balanced","pressing","all-out"]},
  "winning":{"type":"score","instructions":"Who is winning this round?",
    "criteria":["opponent clearly","opponent slightly","even","you slightly","you clearly"]}}}
```
**Response shape** (the values are made up): `{"model":"jev-1.13.0","answers":{"tactic":{"type":"choice","choice":"sidestep_counter","confidence":0.58,"probabilities":{"sidestep_counter":0.61,"hold_range":0.17,"feint":0.09,"circle_left":0.07,...}},"opp_commit":{"type":"noul","noul":0.72},"counter_if_lunge":{"type":"choice","choice":"sidestep_left",...},"aggression":{"type":"score","score":1.4,...},...},"usage":{"input_tokens":~1300,"output_tokens":~20}}`

## (c) Using the distribution itself

- **Temperature knob.** Sample from p_i^(1/T), renormalized, with a seeded PRNG keyed on (fightSeed, fighter, tick). T→0 always takes the top choice: robotic and exploitable. T=1 follows Jev's belief. T>1 makes a wild brawler. jevbox already does a style reweighting (log p + β·log w_style) plus per-fight jitter.
- **Confidence-gated commitment.** Above about 0.7 confidence, commit fully (high gains, long commit window). From 0.4 to 0.7, run a probing version with lower commit and a sooner re-ask. Below 0.4, default to a guard-and-circle tactic and re-query at a higher rate. Add hysteresis so the fighter switches tactics only when the new favorite beats the current one by a margin; this stops 5 Hz dithering.
- **Broadcast HUD.** Show a live bar per fighter ("61% sidestep-counter, 17% hold, 9% feint"), a READ meter ("opponent committing: 72%"), and a flash when a pre-computed counter fires. After the fight, show a tactic heatmap. This spectacle is something only a distribution-returning mind gives you.
- **Honesty caveat.** The "calibrated" claim is about benchmark labels. For "which tactic is best" there is no ground truth. Log p(tactic) against whether the tactic landed, then show both: "Jev 71% → historically lands 40%."

## (d) Fighter identity without retraining

- **The builder writes a fight plan and a personality** (under 150 words) that go straight into `state`. Because Jev reads literally, have **Claude lint the plan** into explicit conditions ("when he lunges → sidestep toward the weak leg").
- **Never put opponent-authored text in your fighter's state.** Jev doesn't treat data as hostile, so a malicious robot name or bio could steer it. Scouting reports are written by your own corner from telemetry only.
- **Scouting (Claude).** Read the opponent's past decision logs and telemetry and distill 5 tendencies ("drops guard after an overhead 60% of the time") into `state.scouting`.
- **Corner coach between rounds (Claude Sonnet 5 or Opus 5.5).** Input: a round summary (damage exchanged, tactic histograms, what landed, Jev's `winning` scores). Output: a rewritten plan, a new T and style weights, and optionally new tactic options such as an `exploit_dropped_guard` choice. This is TypeSafe's own System 1 / System 2 framing, applied literally. Note that Opus 5.5's thinking cannot be disabled (per the Claude API reference), which is fine between rounds and bad per tick.
- **Jev as judge.**
  - Split each round into 10 s windows. Physics code computes objective facts (damage dealt, time in control, cage pins), since Jev can't do arithmetic.
  - Jev scores the fuzzy criteria per window with `score` questions: effective striking, aggression, control, damage severity.
  - Code aggregates to 10-9 / 10-8 using a `score` question for "how dominant was the round" (close / clear / dominant / overwhelming).
  - Run three "judges" with differently weighted rubrics. Jev is near-deterministic, so three identical judges would never split.
  - The MMA and BattleBots-style criteria are my adaptation; I did not re-verify the official rule texts this session.
- **Jev as director.** At 2-4 Hz, a `choice` over about 8 camera presets plus a `noul` ("decisive moment imminent?") that arms a slow-motion replay buffer. Enforce a minimum shot length of 2-3 s in code. It costs about $0.04 per fight.

## (e) Fairness, determinism, replays, failure

- **Tournament mode (lockstep, the default for ranked fights).** Physics pauses at each decision tick. Both fighters' requests fire on the same frozen state. Each response is applied after a fixed simulated reaction delay that is identical for both (for example 150 ms of sim time). The outcome is then independent of network latency and API speed. At 5 Hz with about 200 ms responses the sim runs at about real time; at higher rates it runs slower. So **simulate the fight, then broadcast it** on a short delay, like TV. On API errors: back off and retry, never fall back mid-fight, and declare "no contest" after N seconds.
- **Live mode (casual/sandbox).** Decisions apply on arrival. Equalize latency by holding the faster fighter's decision until a fixed target (about 250 ms). Past about 400 ms, the fighter keeps its last tactic, then falls back.
- **Replays.** Log per decision: tick, fighter, pinned model version, request hash, the full distributions, the sampled action and the PRNG seed. That is about 5,400 rows, roughly 1.6 MB per fight. Replays **re-simulate from the log and never re-query Jev**, which is not bit-exact and whose `jev-latest` alias moves. This requires a deterministic fixed-step physics build (the engine stream's job).
- **Fallback brain.** Put a behavior tree or local decider/Kev behind the same `/v1/systemone` interface, and mark it "JEV OFFLINE" on the HUD. jevbox ships exactly this.
- **Run the authoritative sim server in AWS us-west-2**, next to `api.typesafe.ai`. That removes about 70 ms of network time from every decision, and the API key stays server-side instead of in the browser.

## (f) Cost, latency, and where Jev loses

**Jev cost for a 9-minute fight (540 s of action, 2 fighters, about 1,500 input tokens per call; jev_fsd ≈ 1,900 and Doom ≈ 4,600 back-solved from their published costs):**

| Rate per fighter | Calls | Jev $ / fight | Share of 1,200 RPM quota |
|---|---|---|---|
| 1 Hz | 1,080 | $0.07 | 120 RPM (10%) |
| 2 Hz | 2,160 | $0.14 | 240 RPM (20%) |
| 5 Hz | 5,400 | $0.34 | 600 RPM (50%) |
| 10 Hz | 10,800 | $0.68 | **1,200 RPM (100%)** |

Add about $0.05 for the judge and director, and about $0.2-0.5 for 6 Claude coach and scout calls (Sonnet 5 at $2/$10 per MTok, Opus 5.5 at $4/$20, [pricing](https://platform.claude.com/docs/en/about-claude/pricing.md)). **Dollars are not the constraint; the per-account quota is.** At 5 Hz, one key supports about 2 concurrent live fights. Lockstep broadcast fights, bring-your-own-key, or an enterprise limit would be needed to scale. At consumer scale, 10k fights/day at 5 Hz is about $3.4k/day, which argues for a local model in the free sandbox.

**The same tactical layer, done other ways, at 5 Hz:**
- **Claude Haiku 4.5 with tool calls:** about $0.0019/call, so about $10/fight (about $4-5 with prompt caching). The latency (unverified here) is likely 0.5-2 s per call, so ≤1 Hz is realistic. LLM Colosseum on Street Fighter III found latency and refusals sank a slower model ([repo](https://github.com/OpenGenerativeAI/llm-colosseum)). Sonnet 5 would be about $20/fight and Opus 5.5 about $41. **Claude is the right System 2, not System 1.**
- **Local decider-2b/4b or Kev:** $0 marginal cost and no quota. Accuracy is lower (JevBench hard 0.649 vs 0.730). On a Mac it is probably *slower* than hosted Jev (Kev at 495 ms on an M5; decider CPU at 0.3-0.7 s), but it runs in tens of ms on an RTX GPU. Distilling it is legally clean (Apache-2.0).
- **Learned RL tactical policy:** sub-millisecond, deterministic, and it can outfight everything above once trained. The prior art is two-player boxing and fencing with physically simulated characters ([Won, Gopinath, Hodgins, SIGGRAPH 2021](https://research.facebook.com/publications/control-strategies-for-physically-simulated-characters-performing-two-player-competitive-sports/)), boxing and sword-shield with categorical skill priors ([Zhu et al. 2023](https://arxiv.org/abs/2308.07200)), and self-play sumo ([Bansal et al. 2017](https://arxiv.org/abs/1710.03748)). **But interchangeable parts break it.** Each new body needs retraining, or a universal-controller research effort like [MetaMorph](https://arxiv.org/abs/2203.11931). RL is the right tool for the *skill* layer per limb type, not for the free-text plan.
- **Behavior tree / utility AI:** microseconds, deterministic, $0. Expect a tuned one to **beat Jev on raw win rate**, as rules beat Jev in jev_fsd and the vendor conceded for Doom.

**Where Jev is the right tool:**
- Plain-English plans change behavior with no training.
- It generalizes across any build, because the state describes the parts in words.
- Contingency questions come at no extra latency.
- The calibrated distribution is a spectacle and a sampling policy.
- It costs pennies per fight.

**Where it is the wrong tool:** reflexes under 100 ms, motor control, geometry and arithmetic, bit-exact determinism, offline play, and high concurrency.

**Distillation.** Technically it is standard: policy distillation ([Rusu et al.](https://arxiv.org/abs/1511.06295)), with DAgger-style relabeling of states the student visits ([Ross et al.](https://arxiv.org/abs/1011.0686)), and lockstep mode can relabel offline. **But MCA §2.3(b) forbids training a model to imitate Jev's output.** The legal paths are:
1. Ask TypeSafe for a written exception or partnership. A robot fight league is a marquee demo for a startup a few weeks past launch.
2. Distill from an Apache-2.0 decider/Kev teacher instead.
3. Train with RL on fight outcomes. Whether outcome data from Jev-driven fights counts as "Output" is unclear and needs counsel.

Logging decisions for analytics, HUDs and replays is fine.

## Open questions
- What are the actual Philadelphia-to-Jev p50/p95 with a 1-2k-token fight state and ~6 questions over a kept-alive connection? Does latency grow with state size in that range? (Question count is shown not to matter; state size is unmeasured.)
- Will TypeSafe raise the 1,200 RPM per-account limit (enterprise tier) or grant a written distillation exception for a robot-fighting league? Both change the scaling and offline plans.
- Can Jev make good tactical calls from categorical fight descriptions? This needs an eval of ~200 hand-labeled fight snapshots before building the full game.
- Does a Jev-driven fighter beat, or at least out-entertain in a blind test, a tuned behavior tree? Prior art (jev_fsd, the Doom demo) suggests scripted bots win on raw performance.
- How do local open deciders (decider-2b/4b, Kev-0.8B/4B via MLX or llama.cpp) actually perform on Chris's Apple Silicon Mac? This is unmeasured and decides the free-sandbox and fallback brain.
- Does using Jev-driven fight outcomes as reinforcement-learning data count as 'Output' under MCA §2.3(b)? This needs legal review before any learned-policy plan.
- Which physics engine and build gives bit-exact fixed-step determinism (the engine stream's question)? Decision-log replays depend on it.
- Should both fighters ever share one Jev request (halving quota use)? Every question sees the whole state, so each fighter's private plan would leak to the other fighter's decisions.