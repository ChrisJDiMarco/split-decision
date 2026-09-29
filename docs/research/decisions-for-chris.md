# Decisions for Chris

- Should this ship as a show first or a game first? Recommended: show first. Fights compute in lockstep in the browser and people watch them as replays and X clips. Live sandbox play comes after the day-14 gate.
- Which robot scale leads v1: about 40 kg wheeled middleweights in a ten-sided cage, or 12 lb NHRL-real bots with bill-of-materials export? Recommended: 40 kg. Add a 12 lb bench class later only if engineers ask for export.
- Does Jev pass if it loses to a behavior tree on win rate but wins the blind watchability test? Recommended: yes, and Mind vs Script becomes a public weekly storyline instead of a hidden benchmark.
- How much will you spend on a house Jev key, and will you email TypeSafe in week one about public use, showing probabilities on screen, league quota and browser CORS? Recommended: a hard cap of about $20 a day on the house key, with BYOK and the House Mind beyond that. Send the email during Phase 0.
- Will a human ever drive a robot? Recommended: never. The player builds, writes the fight plan and coaches between rounds; Jev is the only pilot.
- Do you lock the name, the cage shape and the money rules now? Recommended: 'Split Decision' with a ten-sided cage called the Kiln, a one-hour trademark review before any public launch, and a permanent ban on real-value currency and betting.

Candidate names: Split Decision, Tell, Tenside

Headline: Yes, it can be built with zero training and run in anyone's browser, if the v1 robots are wheeled or tracked brawlers with real jointed arms and weapons. Physics runs on MuJoCo's official WebAssembly build, and every Jev answer takes effect after a fixed simulated reaction delay, so network latency never changes a fight. Three things are hard: nobody has measured two contact-heavy robots plus sampling planners in a browser, legged bodies can't balance without learned control, and Jev fights may not beat a behavior tree on watchability. Start with a two-week, two-robot proof (Cage Zero) that has a kill gate on day 14, then grow it into a league where fights are computed and watched as replays.
