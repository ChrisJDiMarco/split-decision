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
