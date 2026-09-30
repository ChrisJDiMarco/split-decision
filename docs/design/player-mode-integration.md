# Player mode: integration into the main game

Chris asked (2026-09-29) for a third-person view where a human takes over one robot and fights with WASD, other keys and the mouse, easily, and in a way that is fun.

Player mode is built as a self-contained module (`src/player/**`) with a playable harness (`harness/player.html`). The harness runs a real fight: physics worker, robot kit, arena, VFX, and one Jev Brain for the opponent. `src/main.ts`, `src/ui/select-screen.ts` and `src/render/camera/**` were not edited, because other agents own them. This document gives the exact steps to wire player mode into the main game later, and the control contract for continuous footwork.

## What exists

| File | What it does |
|---|---|
| `src/player/keymap.ts` | Actions, default bindings, Shift chords, rebind, per-browser persistence (`localStorage`, every access wrapped in try/catch) |
| `src/player/input.ts` | Keyboard, mouse buttons, pointer-locked mouse look. While enabled, it swallows the keys it uses in the window capture phase (`preventDefault` + `stopImmediatePropagation`) |
| `src/player/driver.ts` | Pure logic that turns held keys and presses into `Intent`s: input buffer, combos, commit gating, WASD → footwork |
| `src/player/chase-camera.ts` | Over-the-shoulder, lock-on chase camera. It avoids collisions using the director's analytic sightlines (read-only import) and gets shake from `CameraShake`. While the plain view is blocked it keeps last frame's swing and lift as long as they still frame well, so a fighter pinned on the fence doesn't make the lens hop |
| `src/player/hud.ts`, `player.css` | Your robot's damage silhouette, battery, heat, gyro saturation, current move and strike buffer. Also the opponent's JEV MIND and body (the broadcast's `CornerPanel`, reused as is), the fight bar, a lock-on reticle, hit markers, a hurt flash, and key hints with click-to-rebind |
| `src/player/player-mode.ts` | `PlayerMode`, the glue a host instantiates, plus input-to-motion probes |
| `src/player/config.ts` | All tuning: `PLAYER_REACTION_DELAY_S`, combo window, buffer, commit phases, camera |
| `src/harness/player.ts`, `harness/player.html` | The playable fight |
| `tests/player/*.test.ts` | Unit tests for the keymap, input (no stuck keys, pointer-lock fallback), driver and camera solve (25 tests) |
| `tests/player/measure-latency.ts` | Headless physics check of circle direction and input-to-motion latency |

### Default controls

Footwork is relative to the opponent (lock-on): the camera angle never changes what W means.

| Input | Action | Tactic sent today |
|---|---|---|
| W / S | step in / back out | `close_distance` / `retreat` |
| A / D (W+A, W+D) | circle left / right (closing on an angle) | `circle_right` / `circle_left` (names crossed, see below) |
| nothing held | hold range (~1.2 m) | `hold_range` |
| LMB / RMB | jab (lead) / cross (rear) | `jab` / `cross` |
| Shift+LMB / Shift+RMB | uppercut / overhand | `uppercut` / `overhand` |
| Q / E | lead hook / rear hook | `hook` + `Intent.hand` |
| F / R / Shift+R | front kick / low kick / head kick | as named |
| Z / X | tornado kick / spinning backfist | as named (falls back until the flashy build) |
| G (hold) | guard (moved off Ctrl, see "Integrated in the main game") | `guard` |
| C (hold) | clinch | `clinch` |
| Space | slip and counter; kip-up while down | `sidestep_counter` for 0.9 s; `getupStyle: 'kip_up'` |
| Tab | feint | `feint` for 0.6 s |
| B | aim punches at the head or the body | `target: 'head'` or `'torso'` |
| V | chase camera or broadcast director | none |
| H | key hints (click a key to rebind; RESET KEYS) | none |
| mouse | orbit the camera (±72°, pitch -5°..49°); recentres after 1.2 s idle | none |
| click | take the pointer (Esc releases it) | none |

Strikes pressed within 0.25 s of each other chain into one combo (`Intent.combo`, `comboPlan.step`). Up to 4 strikes wait in the buffer. A buffered strike fires as soon as the one before it passes its commit point, and a strike older than 1.2 s is dropped.

## Protocol additions (all additive, already in place)

- `Intent.source` gains `'player'`.
- `Intent.move?: MoveVector`, where `MoveVector = { forward, strafe }`. This is the contract below.
- `Intent.hand?: 'lead' | 'rear'`, which says which hand throws a strike that exists on both sides (today, the hook). It is advisory; control ignores it until two-sided hooks exist.
- `FighterSetup.controller?: 'jev' | 'player'`, the type `FighterController`.
- `FighterSetup.reactionDelayS?: number`, a per-corner override of `MatchSetup.reactionDelayS`.
- `src/physics/worker.ts`, the one intent-delay line: `delayTicks = round((setup.fighters[corner].reactionDelayS ?? setup.reactionDelayS) / dt)`.

## Control contract: `Intent.move`

This is for the balance engine, which will own footwork. Until the balance engine consumes it, the player maps the vector to the footwork tactics (see `footworkTactic` in `driver.ts`), so it works with today's controller. The control code was not edited.

1. **Frame.** The fighter's own frame, locked on to the opponent. `forward` is along the unit vector from this fighter's COM to the opponent's COM (ground plane). `strafe` is along `forward × z`, which is this fighter's own right. Each axis is in -1..1 and |v| ≤ 1. The driver normalises diagonals.
2. **Meaning.** The vector is a velocity request, scaled to the design's safe walking speed (a bantam is faster than a heavy): v_cmd = |v| · v_safe(design, damage) in the direction forward·f̂ + strafe·r̂. Strafing is an arc around the opponent at the current range, not a straight line, so +1 strafe held for a while orbits him counter-clockwise (seen from above, z up) at constant distance.
3. **`{0,0}` means plant.** Stop at the next foot placement and stand, with no auto-ranging. The current `hold_range` walks back to 1.2 m on its own; with `move` present it must not.
4. **Presence switches ownership.** While `move` is present, footwork follows it and `tactic` only selects the strike or defence. The footwork tactics (`close_distance`, `retreat`, `circle_*`, `hold_range`) are then redundant, and `move` wins. Brain intents never carry `move`, so their behaviour is unchanged.
5. **Physics can refuse.** The balance engine owns foot placement and may slow or refuse a step it cannot take (gyro saturated, a limp or seized leg, mid-kick, down). It must never teleport, and never exceed torque or heat.
6. **Strikes from where you stand.** A player strike intent (`source: 'player'`) is thrown from the current footing, with no walk-in to the skill's sweet spot. A whiff is the player's fault, and that is the fun. If the robot is mid-step, the balance engine finishes that step (or throws from single support where the move allows) and then throws: at most one step, about 150 ms. **This is the single biggest feel item; see the measurements below.**
7. **Walking while striking.** `move` may keep changing while a strike runs. Footwork resumes from the strike's recovery, and it may blend earlier for arm strikes.
8. **Commit readout (recommended, additive).** Publish `RobotTelemetry.committed?: boolean`, true once the current skill is past its windup. Today the driver infers it from `skillPhase` using a table taken from the skill durations (`COMMIT_PHASE` in `config.ts`). A published flag would stay correct when durations or mocap timing change.
9. **Combos natively (later).** Once control runs `tactic: 'combo'` itself (docs/design/fighter-iq-control-contract.md), the driver can send one combo intent instead of sequencing step by step. Until then it sends each step as the tactic, with `combo` and `comboPlan.step` filled in for the HUD and the telemetry.

**Naming bug found in passing (control's to fix).** In `src/physics/control/tactics.ts`, `circle_left` uses `+CIRCLE_RAD` around the opponent, which is counter-clockwise, which is the fighter's own **right**. `tests/player/measure-latency.ts` measured it: `circle_left` moved the fighter 0.23 m to its right, and `circle_right` 0.31 m to its left. `sidestep_counter`'s comment ("a right hand is answered by moving left" with sign +1) has the same inversion. The player maps keys by the measured geometry (`CIRCLE_TO` in `driver.ts`). If control fixes the names, flip that map; the script prints the check.

## Wiring into the main game

### 1. Select screen (`src/ui/select-screen.ts`, owned by the select-screen agent)

- Add a **JEV / YOU** toggle per corner card. At most one corner can be YOU, since there is one keyboard (a second player would need a gamepad later).
- YOU sets `setup.fighters[i].controller = 'player'` and `reactionDelayS = PLAYER_REACTION_DELAY_S` (0.05 s, from `src/player`). The plan textarea is irrelevant for that corner, so grey it out.
- Add a Settings toggle, **FAIR MODE** (off by default). When on, leave `reactionDelayS` unset, so the player feels Jev's 0.3 s.

### 2. `src/main.ts`

```ts
import { PlayerMode } from './player';

let player: PlayerMode | null = null;
const playerCorner = () => setup.fighters.findIndex((f) => f.controller === 'player') as Corner | -1;

function buildBrains(m: WorldMeta) {
  for (const b of brains) b.stop();
  const pc = playerCorner();
  brains = ([0, 1] as Corner[]).filter((c) => c !== pc).map((corner) => new Brain({ /* unchanged */ }));
  player?.dispose();
  player = pc === -1 ? null : new PlayerMode({
    stage, corner: pc, designs: [design(setup.fighters[0].design), design(setup.fighters[1].design)],
    hudRoot: document.getElementById('hud')!, fightBar: false, // the broadcast has one
    send: (intent, issuedAtTick) => send({ type: 'intent', corner: pc, intent, issuedAtTick }),
    onCamera: (mode) => broadcast.camera.setExternal?.(mode === 'chase'), // see step 3
  });
  player?.setWorld(m);
}
```

- `brains` is no longer indexed by corner. Change `minds()` to look brains up by `b.corner`, and give the player's corner `null` (or a small "YOU" `MindView`, if the broadcast wants to show something there).
- `onFrame`: after `broadcast.onFrame(...)`, call `player?.onFrame(msg, brains.find((b) => b.corner !== player.corner)?.latest ?? null)`.
- `onPhase`: on `'fight'`, call `player?.setEnabled(true)`. On `'break' | 'ko' | 'decision' | 'over'`, call `player?.setEnabled(false)`. Before the release (`'intro'`) it stays disabled.
- Render loop order: `broadcast.update(dt)` → `player?.update(dt)` → `post.render()`. The chase camera must be the last thing to write the camera before rendering.
- Replays: while `broadcast.replaying()`, call `player.setCamera('director')` and `setEnabled(false)`, then restore both when the replay ends. The chase camera reads live frames, not replay frames.
- Key clashes: while it is enabled, the player swallows every key it has bound. That makes main.ts's **S** (slow motion), **Q** (quality) and **R** (reselect), and the broadcast's **C** (free cam) and **H** (HUD density), unreachable in player mode. **P** (replay) and **M** (mute) still work. Suggestion: move slow motion, quality and reselect to keys the player doesn't use (e.g. `Backquote`, F-keys), or make them active only when no corner is YOU.
- Hit-stop and KO slow motion (`TimeWarp`) scale the worker's timescale. Player inputs still land in sim ticks, so nothing breaks, but a hit-stop freezes your controls for its length. Keep it off for the player's own landed strikes (`warp.onEvents` filter on `striker !== player.corner`) if it feels sticky.

### 3. Camera handoff with the director (`src/render/camera/**` and `broadcast.ts`, owned by the camera agent)

This works today with no edits: the broadcast's `rig.apply` writes the director's pose, and then `player.update` overwrites it (last writer wins). The chase camera lifts the OrbitControls limits the same way `CameraRig` does.

The clean version is a small hook in the broadcast: `camera.setExternal(on: boolean)`. When it is on, the broadcast keeps running the director (so V cuts straight to a live shot, and replays still work) but skips `rig.apply(...)`. When V hands the camera back to the director, call `rig.setFree(false)` once, so the rig's internal ease starts from the current camera. It currently eases from its last director pose; this is only visible as a short glide.

Shake: the chase camera has its own `CameraShake`, fed by `player.onFrame` (hits on your own robot shake it 1.25×). The broadcast's shake only applies through `rig.apply`, so the two never add up.

### 4. HUD

- In player mode, hide the broadcast's two corner stacks (`.corner-stack`) or only the player's corner stack. The player HUD brings its own bottom-left panel for you, and the opponent's full `CornerPanel` (JEV MIND + body) at bottom right. Keep the broadcast's fight bar and pass `fightBar: false`.
- The broadcast's key hints (`C camera · P replay · H hud · M mute`) are wrong in player mode. Replace them with `H keys · V camera · P replay · M mute`.
- The CLICK-to-play prompt hides once the pointer is locked or the hints are open.

## Measurements

**Headless physics** (`npx tsx tests/player/measure-latency.ts`, SAVATE vs HAYMAKER, issuedAtTick emulated half a frame stale):

| From | Player delay 0.05 s | Jev delay 0.3 s |
|---|---|---|
| Standing, in range: press → strike running | **43 ms** (jab, hook, front kick, head kick) | 293 ms (front kick 727 ms) |
| Standing, in range: cross, uppercut, overhand, low kick | never in 2 s (the controller first steps to its own sweet spot) | never |
| 1.3 m away: press → strike running | never in 2 s (walk-in too slow) | never |
| Press → COM moving the requested way at > 0.15 m/s | close_distance 241 ms, retreat 571 ms | 481 / 831 ms |

**Live fight, in the harness** (SAVATE vs HAYMAKER with Jev on, scripted inputs, measured press → the telemetry frame showing it on the main thread):

- Strike start: p10 422 ms, p50 1116 ms, p90 1824 ms. Only 8 of 22 presses started at all, and 0 of 22 presses caught the robot planted. In a live exchange today's controller is stepping 100% of the time: `hold_range` against a Jev who keeps closing. It throws only from planted double support with a balance margin. The fastest live start in an earlier run was 87 ms.
- Movement start: 147-673 ms (median about 420 ms over 8 samples), which is gait initiation.
- Main-thread frame CPU (poses, robot kit, both cameras, HUD, VFX, render submit): p50 4.1 ms, p95 9.4 ms. Physics ran at 0.18 ms/step and real time (1.00 sim s per wall s). The chase solve costs about 0.01 ms per frame on average (0.9 ms worst, a JIT warm-up). GPU time was not measured: the checks ran in a hidden browser tab, where the page ticks from a 16 ms timer instead of rAF.

**Reading:** the input side is responsive. An intent is on the wire the moment a key goes down and lands 42-50 ms later. The body is the bottleneck: strikes wait for a planted stance that a live exchange never gives. Contract items 3 and 6 above (plant on `{0,0}`, strikes thrown from where you stand) are what make player mode feel good. They belong to the balance engine build, which is next in Chris's approved order.

## Known limits

- The hook has one side in control today (`hook` is the left hand), so Q and E both throw it. `Intent.hand` carries the request.
- Tornado kick and spinning backfist run their `TODO(control-build)` fallbacks: a head kick and a hook.
- The move-start probe discards a sample when the robot was already moving that way (auto-ranging), so it under-counts rather than flatters.
- Mouse strikes need the pointer lock, so a click into the page never throws. Keyboard strikes work without it. If the browser refuses the lock (an embedded view, a denied permission, a re-lock too soon after Esc), mouse strikes fire without it and each click asks for the lock again; mouse orbit needs the lock.
- Moves the robot doesn't have are marked N/A on the key sheet. Control throws a stand-in strike for a missing strike (SAVATE's uppercut and overhand come out as a jab). A clinch on a robot without one is not sent at all, because control would substitute a jab for as long as C is held.
- A released key always lets go, even while input is disabled (KO, break), with Cmd held, or with focus in a text field, and releasing Cmd releases everything (macOS drops those keyups). The host doesn't need to clear keys around `setEnabled`.
- Referee breaks (`SimEvent` `'break'` / `'fight'`, being added to the protocol by another agent) make the body obey the referee over any intent. Player input can stay enabled through a break; for clearer feedback, show BREAK in the player HUD and `setEnabled(false)` until `'fight'`.
- One human per fight. Local two-player would need gamepad input (`navigator.getGamepads`) mapped into the same driver.

## Integrated in the main game (2026-09-29)

Built with the mind picker. Chris asked for "a toggle for either robot or global to turn on or off Jev and turn on or off local open-source jev".

### Minds

Each corner is fought by one of four minds:

| Pick | What decides | Stored as |
|---|---|---|
| JEV | cloud Jev through `/api/jev` | `FighterSetup.mind` absent or `'jev'` |
| LOCAL | an open-source Jev-compatible model on this Mac through `/api/local-jev` (docs/design/local-mind.md) | `mind: 'local'` |
| HOUSE | the House Mind rules, no network | `mind: 'house'` |
| YOU | the player | `controller: 'player'` (the corner's `mind` is kept, so dropping YOU restores it) |

- **Select screen**: a JEV / LOCAL / HOUSE / YOU row on each corner card. Only one corner can be YOU; picking YOU in one corner puts the other back on the mind it had before. Under each row is a live status line. JEV shows the link's state (no call is made for it). LOCAL reads `/api/local-jev/health`: READY with the model and latency, or NOT RUNNING with the reason and a pointer to `docs/design/local-mind.md`. It is re-read every 5 s, but only while a corner has LOCAL. HOUSE reads "no network calls". YOU shows the input delay. A YOU corner greys out its plan and temperament. The tale of the tape on the card and in the walkout has a MIND row.
- **Global MINDS setting** (`src/core/settings.ts`, `settings().minds`): PER CORNER (default), ALL JEV, ALL LOCAL or ALL HOUSE. It overrides every corner except YOU. The overridden pick is shown struck through and the forced mind in gold. Like the other settings it is saved in the browser and synced across tabs.
- **In the fight**: the MINDS chip under the camera bug (top right, click only) opens the global row and a row for each corner. A change hot swaps the brains with `Brain.setSource()` without restarting the fight. The MIND panel badge follows (`HOUSE`, `LOCAL OFFLINE → HOUSE`, ...). YOU is fixed for the fight. A per-corner change carries into REMATCH.
- **FAIR MODE** (setting, off by default): the YOU corner leaves `reactionDelayS` unset, so it feels Jev's 0.3 s. `finalizeSetup()` (`src/ui/mind-picks.ts`) applies it at every fight start, including rematches. A setup with no YOU comes back as the same object, so JEV v JEV starts exactly as before.

Checked in a browser: ALL HOUSE made 0 network calls. LOCAL with no model made one failed `/api/local-jev` call, then went to the House Mind with health polls only and no `/api/jev` call. JEV v JEV had the same setup keys as before, Jev answering at about 250-350 ms, the director camera and the old hints.

### Player mode wiring (`src/main.ts`)

- The YOU corner gets no Brain. `minds()` looks brains up by corner, and the player's corner is `null`. `PlayerMode` is created when the world is ready (`buildPlayer`) with `fightBar: false`. It is fed `onFrame(msg, opponentBrain.latest)` and updated after `arena.update` and just before `post.render()`.
- `playerHostState()` (`src/player/host.ts`, pure and tested) decides input and camera every frame. Input is on only in the live fight: not in the walkout, the break between rounds, the KO, the decision, a replay or while the sim is paused. The camera is the director in the walkout, replays and the winner card, and the player's own choice (V) in the fight and the KO. The player HUD hides behind the winner card. Going back to select disposes the player.
- Camera handoff: `broadcast.camera.setExternal(on)` goes to `CameraRig.setExternal()`. The director keeps running, but `rig.apply` is skipped while the chase camera drives. Handing the camera back eases from wherever the chase lens is.
- HUD: in player mode (`.player-mode` on `#hud`) both broadcast corner stacks are hidden. The player HUD has your panel and the opponent's MIND + body panel. The broadcast's fight bar, ticker, camera bug and MINDS chip stay.
- Referee breaks: `PlayerMode` reads `RobotTelemetry.referee` every frame. During a break a band shows BREAK with what to do, and input waits for FIGHT. The exception is a downed fighter: it keeps input, so Space can still pick the kip-up. FIGHT! flashes only when the referee called it; a KO also ends a break, and no flash shows then.

### Keys

Player mode swallows the keys it binds, so with a YOU corner the host keys move to keys it does not use:

| Action | Spectating (no YOU) | Player mode |
|---|---|---|
| slow motion | S or T | T |
| render quality | Q or L | L |
| new fight (reselect) | R or N | N |
| free orbit camera | C or O | O (when the director has the camera) |
| HUD density | H or I | I |
| replay / mute | P / M | P / M |
| chase or broadcast camera | none | V |
| key sheet | none | H |

The on-screen hints switch to `V camera · H keys · P replay · T slow-mo · M mute · N new fight` in player mode. The host shortcuts ignore Ctrl, Alt and Cmd combinations.

**Guard moved off Ctrl to G (hold).** Ctrl+Tab, Ctrl+W, Ctrl+Space and Ctrl+click are browser and OS shortcuts. Ctrl, Alt and Cmd can no longer be bound at all (`validBinding`), since they turn the other game keys into shortcuts. Saved keymaps are migrated on load: Ctrl bindings are dropped, and an action left empty gets its default back. If a saved rebind already uses that key, the action gets the first free fallback key (G, Y, U, J, K).

### Open

- Hit-stop still freezes the player's controls for its length on the player's own landed strikes. Not filtered yet (the `warp.onEvents` filter from step 2); decide once it has been felt.
- The opponent panel is still titled "JEV MIND" for LOCAL and HOUSE; the badge and chip carry the real mind (`src/ui/hud/mind-panel.ts`).
- Real pointer lock and feel in Chrome (outside the embedded pane) still need Chris's hands.
