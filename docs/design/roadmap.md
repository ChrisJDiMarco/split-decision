# JEV KUNE DO roadmap

Chris's vision, captured 2026-09-29. The order below is the build order; later items can shift.

## Now

1. **Tracking core** (running): mocap punches, get-ups, kicks where they beat the procedural ones.
2. **Heads, eyes, hands** (running): gaze, reactive eyes and lights, loadout slot with stock/gloves/knuckles/dexterous tendon hands, HANDS picker, workshop design doc.
3. **Realistic fight audio** (running): Kenney CC0 recorded impacts layered with physics-tuned synthesis by material, mass and energy.
4. **Balance engine** (next, `docs/design/balance-engine.md`): mocap style fused with DCM footstep planning, weight-transfer strikes, Euphoria/Bodycam-style reactions. First milestone: walk in like a fighter, no falls.
5. **Flashy moves and kip-ups**: tornado, spinning and jump kicks, superman punch, spinning backfist, feints, pre-armed `onOpening` reflexes in the body, per-robot kip-up search.
6. **Live critic pass**, then fixes.

## Next

- **Jev council** (`docs/design/jev-council.md`): several specialist Jev minds per robot, fused by their calibrated probabilities, with the debate on the HUD.
- **Offline move optimisation** on the CPU (SAMCON-style) for signature moves per robot, stored as parameters.
- **Look loop**: for each robot, render the model at the reference image's angle, have a vision critic score the differences, fix the kit, repeat until the model matches the concept art.

- **Parked by Chris (2026-09-29): local and in-browser minds.** Julia 1 (Apache 2.0, 144M) runs in the browser at about 16 ms per decision, but it ranks low and is overconfident. Mapika Decider 2B is the stronger local candidate. Plan: an offline eval on about 500 outcome-labelled fight states (Julia 1 vs Decider 2B vs Kev), then temperature scaling, then maybe a fine-tune on our own non-Jev data. Details: `docs/research/11-julia-1.md`. Downloads need Chris's OK.

## Workshop and upgrades

Every upgrade is a slot with real mass, power and heat (`docs/design/loadouts-and-workshop.md`).

- **Weapons**:
  - **Energy blades** (laser swords) as a hand-slot weapon that cuts armor. This needs detachable limbs (arms and legs, not just heads) and a cutting damage model, so a clean hit can take a limb off.
  - **Pop-up shoulder gatlings**: a shoulder slot that deploys and fires short barrages of simulated rounds that push the target and chew armor, with muzzle flash and brass, and ammo and barrel-heat limits. Jev gets deploy and fire tactics.
- **Internal**: faster joint modules, bigger gyro cores, better batteries, cooling.
- **Armor**: plate materials and thickness per part.
- **Repair** between fights; damage persists across a season.

## Live and community (Chris, 2026-09-29)

- **24/7 Twitch stream** of Jev fights: Twitch Channel Points Predictions on every fight (no real money), chat votes the corner plan between rounds, channel-point/bit redemptions for fair flavour (name the next challenger, pick the arena).
- **Build and compete**: a public submission page (build + fight plan) feeding a fight queue on stream, public Elo ladder, weekly title fights; free entry, prizes funded by sponsors or the channel.
- **Money**: subs/bits/ads, sponsors (TypeSafe as the natural first; robotics and AI labs for a bring-your-own-brain league), Patreon, later a Steam game with cosmetic skins.
- **No real-money betting or paid-entry prize pools**: that is regulated gambling (state licences in the US; Twitch bans unlicensed gambling streams).
- **Cost**: ~$0.16 per full Jev fight, ~10 fights/hour -> ~$40/day on Jev, or $0 on the local Kev model; fights are deterministic, so they can be simulated server-side and broadcast, and every KO is a shareable clip.

## Always

Physics stays honest (every part has real specs), Jev stays the mind, and it runs in any browser.
