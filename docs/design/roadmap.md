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

## Workshop and upgrades

Every upgrade is a slot with real mass, power and heat (`docs/design/loadouts-and-workshop.md`).

- **Weapons**:
  - **Energy blades** (laser swords) as a hand-slot weapon that cuts armor. This needs detachable limbs (arms and legs, not just heads) and a cutting damage model, so a clean hit can take a limb off.
  - **Pop-up shoulder gatlings**: a shoulder slot that deploys and fires short barrages of simulated rounds that push the target and chew armor, with muzzle flash and brass, and ammo and barrel-heat limits. Jev gets deploy and fire tactics.
- **Internal**: faster joint modules, bigger gyro cores, better batteries, cooling.
- **Armor**: plate materials and thickness per part.
- **Repair** between fights; damage persists across a season.

## Always

Physics stays honest (every part has real specs), Jev stays the mind, and it runs in any browser.
