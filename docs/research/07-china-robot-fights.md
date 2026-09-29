# Humanoid Robot Combat, 2025 to September 2026: Events, Fighters and Design Dossier for Split Decision

Research date: 2026-09-29. Every claim carries a link. Where sources disagree, both versions are given (see section 7). Visual descriptions marked "observed" come from photos I looked at directly, and the image URL is cited next to each one.

---

## 0. Bottom line

1. **No robot that has fought in these events uses hydraulics.** Every one is electric. Each joint has a permanent-magnet synchronous motor (PMSM), a gear reducer and a crossed-roller output bearing. Unitree uses quasi-direct-drive (QDD): a large motor with a low-ratio planetary gearbox. EngineAI's T800 uses planetary joints, and its Pro and Max editions add linear force control ([EngineAI T800 spec page](https://en.engineai.com.cn/product-t800), [Unitree H2 spec page](https://www.unitree.com/H2/), [antonrobots T800 review](https://antonrobots.com/engineai-t800-review/)). Boston Dynamics retired its hydraulic Atlas in April 2024 and replaced it with an all-electric Atlas ([TechCrunch](https://techcrunch.com/2024/04/17/boston-dynamics-atlas-humanoid-robot-goes-electric/), [Boston Dynamics blog](https://bostondynamics.com/blog/electric-new-era-for-atlas/)). Chris is right on this point.
2. **Two size classes do all the fighting:**
   - **Kid-size:** 1.2 to 1.4 m, 30 to 45 kg, peak knee torque about 90 to 164 N·m. Models: Unitree G1, Booster T1, EngineAI PM01.
   - **Full-size:** 1.73 to 1.82 m, 70 to 85 kg, peak leg torque 360 to 450 N·m. Models: EngineAI T800, Unitree H2, Unitree H1.
   - The WHRG 2026 Free Combat event used **40 kg, 58 kg and 80 kg** weight classes ([RoboPodium](https://robopodium.com/whrg-2026)).
3. **The current Split Decision roster is 2 to 5 times heavier than any real fighter.** Bruiser is 236 kg, Striker 146 kg and Goliath about 380 kg. The heaviest real combat humanoid is the T800 at 75 to 85 kg.
4. **Control is mostly teleoperated, with learned balance underneath.** Pilots use joysticks, VR rigs or motion capture. EngineAI's URKL league moved toward partial autonomy in 2026: operators choose pre-trained skills, and in Shanghai the robots were "autonomous for parts of the competition."
5. **The fights have changed quickly.**
   - **2025 (Unitree G1):** robots from one maker. Strikes looked "more like pushes than strikes." Falls were frequent, and there was an 8-second get-up rule.
   - **2026 (T800):** committed tornado and spinning kicks, jumping knees, kip-ups, a head knocked clean off (the robot kept fighting), sparks on contact, three-robot "last robot standing" bouts, and a human knocked across a cage.

---

## 1. Timeline

| Date | Event | Place | Robots | Control |
|---|---|---|---|---|
| 25 May 2025 | CMG World Robot Competition, Mecha Fighting Series. Unitree streamed it as "Iron Fist King: Awakening." | Hangzhou | 4× Unitree G1 | Remote (joystick) by human operators |
| Jul 2025 and 3 Oct 2025 | "Silicon Colosseum" underground fight nights | San Francisco (SoMa warehouse) | Booster T1, K-Scale robot, "Gladiator" (a dog-like biped) | Not stated |
| 2025 | REK0, then an REK tour across the USA | San Francisco, US | Modified Unitree G1 | VR or gamepad |
| 29–30 Jul 2025 | WAIC 2025 boxing showcase | Shanghai | 2× Unitree G1 | Not specified |
| 14–17 Aug 2025 | World Humanoid Robot Games (WHRG) boxing (a peripheral event) | Beijing | Unitree G1 | Mostly teleoperated |
| Aug 2025 | T800 prototype shown at World Robot Conference (WRC) 2025 | Beijing | EngineAI T800 prototype | Display only |
| 3–9 Dec 2025 | Unitree H2 vs G1 sparring video | Company video | H2, G1 | Motion-capture suit |
| 6 Dec 2025 | T800 kicks EngineAI's CEO (answering claims the footage was CGI) | Shenzhen | T800 | Not stated |
| 6 Jan 2026 | UFB bout at CES 2026 | Las Vegas | 2× G1 | Controllers |
| 7 Feb 2026 | REK1 tournament, Kezar Pavilion | San Francisco | Modified G1 | VR |
| 9 Feb 2026 | URKL season launch | Shenzhen | T800 | See below |
| 25 Jul 2026 | REK TOKYO 2026 | Akihabara, Tokyo | Humanoids (model unconfirmed) | Remote pilots |
| 11–16 Jul 2026 | URKL pre-show exhibitions, COCO Park mall | Shenzhen | T800 | Not stated |
| 16 Jul 2026 | URKL opening gala, Nanshan Cultural and Sports Center | Shenzhen | 32 teams on T800 | Semi-autonomous |
| 15 Aug 2026 | REK2, the first US fights on 6-ft humanoids | San Francisco | T800 | VR or gamepad |
| 19–23 Aug 2026 | WRC 2026: G1 boxing, plus 2 T800s | Beijing | G1, T800 | Motion-capture, controller or voice |
| 22–26 Aug 2026 | WHRG 2026 Free Combat, weight classes 40, 58 and 80 kg | Beijing (Ice Ribbon) | Not found | Games billed as autonomous |
| 9 Sep 2026 | CyberHero x Riyadh | Riyadh | 10× T800 | Teams managed by creators |
| 18 Sep 2026 | REK human vs robot (Frankie LaPenna) | San Francisco | T800 ("Rekbot") | VR teleoperation |
| 19 Sep 2026 | URKL city tour, first stop, Baoshan | Shanghai | T800 | Partly autonomous |
| Nov/Dec 2026 or early 2027 | URKL Grand Final | Dubai | T800 | Not yet held |
| 2026 (recruiting) | CMG 2026 Mecha Fighting | Not found | Unitree says the H2 will enter | Remote, voice or motion |

---

## 2. Event dossiers

### 2.1 CMG Mecha Fighting Series / Unitree "Iron Fist King: Awakening"

Hangzhou, 25 May 2025, broadcast on CCTV.

- **Organizer:** China Media Group (CMG). Unitree marketed the same bouts as a livestream called "Iron Fist King: Awakening." The robot names match across sources, so these are one event ([Global Times](https://www.globaltimes.cn/page/202505/1334812.shtml), [PopSci](https://www.popsci.com/technology/humanoid-robots-boxing-match/), [Unitree boxing page](https://www.unitree.com/mobile/boxing/)).
- **Robots:** four Unitree G1s, 1.32 m and 35 kg.
- **Teams:** black, pink, green and red helmets ([CGTN via search](https://news.cgtn.com/news/2025-05-27/-AI-Strategist-wins-CMG-s-humanoid-robot-fighting-competition-1DId4cqqLmw/p.html)).

| Robot | Operator | Helmet colour |
|---|---|---|
| AI Strategist | Lu Xin | Black |
| Silk Artisan | Jiao Tianqi | Pink |
| Armored Mulan | Chen Liangyu | Red (inferred) |
| Energy Guardian | Hu Yunqian | Green |

- **Rules:**
  - Each match had two parts: a skills demonstration, then 3 rounds of 2 minutes.
  - Only hits to the head or torso count: 1 point for a punch, 3 for a kick.
  - A fall costs 5 points.
  - Failing to rise within 8 seconds costs 10 points and ends the round (Asia Times). CGTN says it disqualifies.
  - Sources: [Asia Times](https://asiatimes.com/2025/05/china-stages-first-ever-humanoid-robot-kickboxing-match/), [CGTN](https://news.cgtn.com/news/2025-05-27/-AI-Strategist-wins-CMG-s-humanoid-robot-fighting-competition-1DId4cqqLmw/p.html), [TechEBlog](https://www.techeblog.com/first-robot-boxing-match-unitree-g1-hangzhou/).
- **Control:** human operators with joysticks controlled the robots remotely. Moves were trained by motion capture, and a few autonomous pre-programmed actions were shown ([Asia Times](https://asiatimes.com/2025/05/china-stages-first-ever-humanoid-robot-kickboxing-match/), [PopSci](https://www.popsci.com/technology/humanoid-robots-boxing-match/)).
- **What the fights looked like:**
  - Moves included straight punches, hooks, side kicks, knee strikes and aerial spin kicks, and robots got up after falling ([Global Times](https://www.globaltimes.cn/page/202505/1334812.shtml)).
  - Asia Times said the attacks were "soft and more like pushes than strikes."
  - **Viral moment:** Silk Artisan fell into an accidental split. AI Strategist gloated over it, tripped on its opponent's head and face-planted. AI Strategist then won the final against Energy Guardian with knockdowns in all three rounds ([PopSci](https://www.popsci.com/technology/humanoid-robots-boxing-match/)).
- **Gear (observed):** padded full-face headgear in team colours with "FORCE" branding and matching boxing gloves. There was a human female referee in a white shirt and bow tie, and a roped boxing ring. [CGTN photo](https://news.cgtn.com/news/2025-05-27/-AI-Strategist-wins-CMG-s-humanoid-robot-fighting-competition-1DId4cqqLmw/img/484ee2918c56456987470ea1d0eeb13e/484ee2918c56456987470ea1d0eeb13e.jpeg)
- **Video:** [Unitree Iron Fist King: Awakening (YouTube)](https://www.youtube.com/watch?v=StLp4Z-ul44), [Robotics 24/7 video article](https://www.robotics247.com/article/video_unitree_g1_humanoids_compete_in_robot_combat_tournament_in_china).

### 2.2 WAIC 2025 "fight club"

Shanghai, 29–30 July 2025. Two G1s fought "nonstop for over two minutes," trading jabs, kicks and defensive moves. One robot played defence and turned its opponent, while the other led with kicks ([Interesting Engineering](https://interestingengineering.com/innovation/chinas-humanoid-robot-ring-fighters-show-off)).

### 2.3 World Humanoid Robot Games 2025

Beijing, 14–17 August 2025. The Games had 280 teams, more than 500 robots and 26 events; boxing and free combat were peripheral events ([Wikipedia](https://en.wikipedia.org/wiki/World_Humanoid_Robot_Games), [Beijing gov](https://english.beijing.gov.cn/latest/news/202508/t20250811_4170955.html)).

- Two G1s, about 130 cm and 35 kg, boxed in gloves and helmets.
- They threw left and right hooks, side kicks and knee strikes, dodged blows, and got up unassisted after knockdowns ([Global News](https://globalnews.ca/news/11336205/world-humanoid-robot-games-beijing/), [Smithsonian](https://www.smithsonianmag.com/smart-news/worlds-first-robot-olympics-features-soccer-kickboxing-and-lots-of-falling-down-180987199/), [PopSci](https://www.popsci.com/technology/worlds-first-robot-games-china/)).
- Many "competitors" were teleoperated by a wrangler using a joystick or tablet.
- **Video:** [Robots compete in soccer, boxing, dancing (YouTube)](https://www.youtube.com/watch?v=9nBQtlg4-M4).

### 2.4 Silicon Colosseum

San Francisco, July and 3 October 2025. A warehouse event in the SoMa district organized by Verda Korzeniewski, with a caged octagon and $30 tickets.

- The house robot "Booster" was a Booster T1: 4 ft tall, 66 lb, wearing boxing gloves.
- It knocked down a taller, headless K-Scale robot of about 80 lb several times.
- It was then repeatedly tipped over by "Gladiator," a dog-like biped, but kept righting itself to cheers ([Local12/Sinclair](https://local12.com/news/nation-world/verda-korzeniewski-silicon-colosseum-young-americans-flocking-to-underground-robot-fight-clubs-held-in-warehouses-cincinnati-caged-octagon-taser-knife-fights-volunteers-booster-t1-boxing-gloves-k-scale-gladiator-quadrupeds-humanoid-robotics-industry-tech), [NewsNation](https://www.newsnationnow.com/us-news/west/just-the-right-amount-of-weird-a-look-inside-san-franciscos-underground-robot-fight-club/)).

### 2.5 Unitree H2 vs G1 sparring

Company video, December 2025.

- The H2 (1.8 m, 70 kg, 31 DoF, 360 N·m) threw fast combinations of punches, kicks and knees. One knee strike lifted the G1 clear off the ground.
- The H2 was driven by a full-body motion-capture suit ([Interesting Engineering](https://interestingengineering.com/ai-robotics/unitree-h2-humanoid-robot-boxing), [eWeek](https://www.eweek.com/news/unitree-h2-humanoid-robot-fighting/)).
- Unitree also released H2 flying-kick, backflip and sandbag training clips on 4 January 2026 ([Interesting Engineering](https://interestingengineering.com/ai-robotics/unitrees-humanoid-robot-knocks-down-sandbags)).
- Sources disagree on whether the G1 was damaged. Interesting Engineering says the H2 broke parts of the G1; eWeek reports no damage.

### 2.6 EngineAI T800 debut

December 2025.

- The T800 was unveiled after months of teasers. Its launch video claimed "no CGI, no speed-up," and online skepticism followed.
- On 6 December 2025, CEO Zhao Tongyang took a kick from the robot while wearing padding ([Interesting Engineering](https://interestingengineering.com/ai-robotics/engineai-t800-humanoid-robot-kicks-ceo), [Humanoids Daily](https://www.humanoidsdaily.com/news/engineai-officially-unveils-the-t800-an-action-movie-star-with-industrial-ambitions)).
- A "Robot Boxer" / "Mecha King" free-combat event was announced for 24 December 2025 in Shenzhen ([Humanoids Daily teaser](https://www.humanoidsdaily.com/news/engineai-teases-combat-ready-t800-humanoid-ahead-of-robot-boxing-event), [Global Times May 2025](https://www.globaltimes.cn/page/202505/1334732.shtml)). I found no clear coverage of that bout. The league's formal launch came on 9 February 2026.
- **Video:** [T800 at CES 2026 (YouTube)](https://www.youtube.com/watch?v=bzkYiapsY3c).

### 2.7 URKL (Ultimate Robot Knock-out Legend)

**Organizer and schedule**
- EngineAI, with Quanmingxing Robotics as co-organizer. Launched 9 February 2026 ([Global Times](https://www.globaltimes.cn/page/202602/1355090.shtml), [Wikipedia](https://en.wikipedia.org/wiki/Ultimate_Robot_Knock-out_Legend)).
- Registration ran March to May 2026, then online simulation qualifiers.
- Play-in for the top 32 was July to August, the group stage for the top 16 September to October, and the finals November to December ([EngineAI rules page](https://en.engineai.com.cn/tournament-rules.html)).
- The Grand Final is reportedly in Dubai in late December 2026 or early 2027 ([Wikipedia](https://en.wikipedia.org/wiki/Ultimate_Robot_Knock-out_Legend)).

**Prize:** 10 million yuan (about US$1.4 million) plus a 10 kg gold belt.

**Robots:** every team gets the same free T800, so the contest is decided by software. Teams are "encouraged to innovate by developing custom armor" ([Shenzhen gov](https://www.sz.gov.cn/en_szgov/aboutsz/photos/content/post_12893048.html)). EngineAI also sells official armor called FA01 ("Fighting Armor"): foam impact zones, quick-detach pieces, open joints for cooling, and a white base that can be personalised ([search summary citing urkl.org/t800](https://urkl.org/t800)).

**Rules as reported:**
- **Qualification:** a recovery test. Standing up from a fall in 3 seconds or less earns top score; 20 seconds earns zero. Algorithms need approval before the fight, and dangerous modifications are banned ([Wikipedia](https://en.wikipedia.org/wiki/Ultimate_Robot_Knock-out_Legend)).
- **Match format:** five rounds of five minutes. The robot that wins the most rounds wins the match ([urkl.org](https://urkl.org/what-is-urkl), [RobotBoxe](https://robotboxe.com/analysis/how-urkl-fights-are-won/)). The broadcast graphic below backs this up.
- **Scoring:**
  - 1 point per clean strike and 3 points per knockdown ([Mike Kalil](https://mikekalil.com/blog/engineai-urkl-begins/), [RobotBoxe](https://robotboxe.com/analysis/how-urkl-fights-are-won/)).
  - Poses, taunts and victory dances can also score.
  - A strike only counts if the robot returns to an upright stance afterwards. Strikes thrown while falling are invalid.
  - A robot has at most 20 seconds to recover from a fall, with no human help ([Wikipedia](https://en.wikipedia.org/wiki/Ultimate_Robot_Knock-out_Legend)).
- **Judging:** effective strikes, body stability, defence and evasion, and durability ([Global Times Jul 2026](https://www.globaltimes.cn/page/202607/1366175.shtml)). Wikipedia adds balance, power, motion control, perception, structural protection, smoothness, rhythm and "postural aesthetics."
- **Broadcast graphic (observed):** a round-5 frame shows the round tally (1–3), in-round points (16–10), a clock at 3:04, and each team's **remaining timeouts** (2 and 1) ([TechEBlog frame](https://images.techeblog.com/wp-content/uploads/2026/07/18101847/urkl-mma-robot-fight.jpg)).

**Control:**
- **Shenzhen opener:** the robots ran pre-programmed combat skills and balanced themselves, while human operators chose actions or issued high-level commands ([Mike Kalil](https://mikekalil.com/blog/engineai-urkl-begins/), [Wikipedia](https://en.wikipedia.org/wiki/Ultimate_Robot_Knock-out_Legend)).
- **Shanghai:** "autonomous mode for parts of the competition," covering navigation, opponent tracking and strike selection, according to the co-founder ([Robots Daily](https://robots-daily.com/engineai-t800-robots-fight-in-shanghai-inside-urkls-humanoid-robot-combat-test/)). Euronews reported autonomous posture-reading ([Euronews](https://www.euronews.com/video/2026/09/21/humanoid-robots-battle-it-out-in-shanghai-fight-night)), and Kalil wrote "without ringside pilots" ([Kalil](https://mikekalil.com/blog/engineai-t800-fights-globally/)).

**Shenzhen opening gala, 16 July 2026:**
- Held in an octagonal cage, broadcast live on Guangdong TV, with actor Donnie Yen in attendance.
- **Headline bout:** "White Eagle" (white) against "Matador," also translated "Bullfighter" (black, dark chrome).
  - White Eagle landed a high tornado or roundhouse kick. Matador's head rocked in its socket, swung by its cables, and came off as Matador fell.
  - Matador got up and kept fighting headless, using torso sensors and torso-mounted compute.
  - It reportedly won 3–2 over five rounds ([Wikipedia](https://en.wikipedia.org/wiki/Ultimate_Robot_Knock-out_Legend), [URKL News](https://urklnews.com/news/urkl-shenzhen-opening-recap/), [Kalil](https://mikekalil.com/blog/engineai-urkl-begins/), [TechEBlog](https://www.techeblog.com/urkl-mma-robot-fight/)).
- Fights included punches, spinning kicks, flying kicks, takedowns, defence and deliberate taunts. They were also "at times awkward," with robots struggling to track each other and "often attacked empty space" ([Kalil](https://mikekalil.com/blog/engineai-urkl-begins/)).
- Reach: 320 million views in 72 hours ([URKL News](https://urklnews.com/news/urkl-shenzhen-opening-recap/)).
- **Media:** [SCMP decapitation video](https://www.scmp.com/video/technology/3361043/chinese-humanoid-robots-mma-clash-ends-decapitation-fighting-league-shenzhen), [CTV video](https://www.ctvnews.ca/video/2026/07/18/robot-mma-league-debuts-in-china/), [YouTube short](https://www.youtube.com/shorts/zCqaw0wDWWk), [COCO Park exhibition photo 1](https://www.sz.gov.cn/img/4/4462/4462088/12893048.jpg), [photo 2](https://www.sz.gov.cn/img/4/4462/4462092/12893048.jpg).

**Shanghai, Baoshan Gymnasium, 19 September 2026:**
- Two sold-out shows. Three new techniques were shown: the kip-up, evasive footwork and a jumping knee strike.
- White Eagle kipped up "almost immediately" after being knocked down.
- The final was a three-robot "Last Robot Standing" match between White Eagle, "Golden Flash" and Matador. One robot fought on with severe head and neck damage, and sparks flew ([Robots Daily](https://robots-daily.com/engineai-t800-robots-fight-in-shanghai-inside-urkls-humanoid-robot-combat-test/), [Euronews](https://www.euronews.com/video/2026/09/21/humanoid-robots-battle-it-out-in-shanghai-fight-night), [Kalil](https://mikekalil.com/blog/engineai-t800-fights-globally/)).
- **Photos (observed):**
  - [Flying knee, white vs gold](https://robots-daily.com/wp-content/uploads/2026/09/EngineAI-T800-Robots-Fight-in-Shanghai.jpg)
  - [Cartwheel or kip-up against the cage](https://robots-daily.com/wp-content/uploads/2026/09/EngineAI-T800-Robots-Fight-in-Shanghai-2.jpg)
  - [Three-way bout](https://robots-daily.com/wp-content/uploads/2026/09/EngineAI-T800-Robots-Fight-in-Shanghai-3.jpg)
  - [Simultaneous high kicks](https://robots-daily.com/wp-content/uploads/2026/09/EngineAI-T800-Robots-Fight-in-Shanghai-4.jpg)

### 2.8 REK (Robot Entertainment Kombat)

San Francisco, founded by Cix Liv.

- **History:** REK0 in 2025, a US tour, then REK1 at Kezar Pavilion on 7 February 2026 ([Eventbrite](https://www.eventbrite.com/e/rek1-humanoid-robot-fighting-tournament-tickets-1982219192966)).
- **REK1 format:** modified G1s (about 80 lb, 4.5 ft) in a cage. Two bouts of five 60-second rounds, with a human referee, two commentators and $60 to $80 tickets. Robots sometimes fell and needed human help. A 13-year-old VR pilot won a bout ([Rest of World](https://restofworld.org/2026/chinese-robot-boxing-unitree-rek/)).
- **Scoring:** every clean hit scores, and ties go to sudden death ([Reflex Arc](https://reflexarc.co.uk/projects/rek-robots)).
- **Control:** pilots use VR or a gamepad, and the only AI is the learned balance system ([Reflex Arc](https://reflexarc.co.uk/projects/rek-robots)). Another account says pilots trigger pre-trained RL movement policies ([RoboSports Global](https://robosportsglobal.com/robot-combat-sport-2026-urkl-rek-ufb/)).
- **REK TOKYO:** 25 July 2026 in Akihabara, in an octagon with 1.2 m sides. Three regular matches plus one demo; Hiroyuki Osone was champion ([MSN summary via search](https://www.msn.com/en-xl/sports/general/humanoid-robots-clash-in-tokyo-s-rek-2026-fighting-competition/ar-AA29zJma), [YouTube](https://www.youtube.com/watch?v=jO4aNdzFTGg)).
- **T800 arrives:** the T800's US debut was a 25 June 2026 warehouse event ([RoboSports Global](https://robosportsglobal.com/rek-robots-san-francisco-engineai-t800-fighting-humanoid/)).
- **REK2:** 15 August 2026, with remotely piloted T800s (a Japanese pilot against an American) ([REK on X](https://x.com/REK/status/2088838249599086811), [Atoms Not Bits on X](https://x.com/AtomsNotBits/status/2088856501607972912), [YouTube](https://www.youtube.com/watch?v=h5P5haxN7Gs)). REK reportedly puts the cost of a T800 at about $100k.
- **Human vs robot, 18 September 2026:**
  - Creator Frankie LaPenna, in padding, fought "Rekbot," a T800 with a "Terminator-style head" controlled over VR.
  - One kick sent him across the cage, and he reportedly injured his hand or wrist ([Interesting Engineering](https://interestingengineering.com/ai-robotics/human-fights-humanoid-robot-in-cage), [Supercar Blondie](https://tech.supercarblondie.com/human-vs-humanoid-robot-rekbot-mma-fight/), [Startup Fortune](https://startupfortune.com/engineais-t800-robot-knocked-out-a-human-fighter-in-san-francisco/), [YouTube short](https://www.youtube.com/shorts/8RbhRIZ96FM)).
  - One eyewitness account also mentions a teleoperated Unitree H1 in a human-vs-robot exchange ([explainx](https://www.explainx.ai/blog/humanoid-robot-vs-human-fight-san-francisco-rek-2026)). This is unverified.

### 2.9 UFB (Ultimate Fighting Bots, run by FrodoBots)

- Started in 2025 in San Francisco and Las Vegas, with standard G1s driven by game controllers.
- The "Ultimate Bot Studio" turns uploaded videos of a pilot's own movements into robot motion. Season 1 ran in the Bay Area in summer 2026 ([RoboSports Global](https://robosportsglobal.com/robot-combat-sport-2026-urkl-rek-ufb/), [ultimatebots.com](https://www.ultimatebots.com/)).
- CES 2026 bout on 6 January: G1s in headgear and gloves, with a human referee ([Interesting Engineering](https://interestingengineering.com/ai-robotics/humanoid-robots-fight-ces-2026)).
- Booster lists "Building Robot Fighting Game – Frodobots" as a T1 customer case ([booster.tech](https://www.booster.tech/booster-t1/)).
- **Look (observed):** silver G1s with tan canvas hood-style headgear, red vs blue corner gloves, and UFB sponsor decals on chest, arms and shins ([Getty via Rest of World](https://fastly.restofworld.org/uploads/2026/02/GettyImages-2254510712.jpg)).

### 2.10 CyberHero x Riyadh (Hero Esports)

9 September 2026. Ten T800s split into two three-robot teams, each managed by a creator (AboFlah vs Bashar Arabi). The first six rounds finished 3–3, and Bashar Arabi's team won the seventh by knockout to take it 4–3. An eight-city season is planned across four regions ([PR Newswire](https://www.prnewswire.com/news-releases/worlds-first-robot-sports-league-launched-in-riyadh-plans-to-hit-8-cities-worldwide-302874350.html), [RADII](https://radii.co/article/cyberhero-riyadh-global-humanoid-sports-league), [Runtime Wire](https://runtimewire.com/article/hero-esports-launches-cyberhero-robot-fight-circuit-riyadh)).

### 2.11 WRC 2026 and WHRG 2026, Beijing, August 2026

- **WRC 2026 (19–23 August):** Unitree G1 boxing was one of the most-watched demos. The robots threw straight punches, hooks and front kicks, recovered from heavy impacts, and could be driven by motion sensing, a controller or voice ([International News & Views](https://www.internationalnewsandviews.com/world-robot-conference-2026-beijing-humanoid-robots-unitree-boxing-406533-2/)). Two T800s also fought there ([Kalil](https://mikekalil.com/blog/engineai-t800-fights-globally/)).
- **WHRG 2026 (22–26 August, Ice Ribbon):** 51 events and 2,056 robots. Boxing and free-choice routines became scored events, judged on how humanlike, continuous and stable the motion was ([RobotTesters](https://robottesters.com/article-world-humanoid-robot-games-2026)).
- **Free Combat** had divisions of **40 kg, 58 kg and 80 kg**. The rules were published 2 July 2026 and the finals held on 26 August ([RoboPodium](https://robopodium.com/whrg-2026), [RoboHorizon](https://robohorizon.com/en-us/events/world-humanoid-robot-games-2026-4x-more-robots-way-more-mayhem/)). I could not find English sources naming the winners or the robot models.

### 2.12 CMG 2026 Mecha Fighting

CMG is recruiting teams and operators; control can be remote, voice or motion-sensing. Unitree founder Wang Xingxing said he will bring the H2 ([RoboHub on X](https://x.com/XRoboHub/status/2065138621007712475)). I found no results yet.

### 2.13 Other makers

I found no combat bouts by **AgiBot, Fourier, UBTech, Robotera or Deep Robotics**. They appeared at WAIC 2025 alongside the G1 boxing but did not fight ([Interesting Engineering](https://interestingengineering.com/innovation/chinas-humanoid-robot-ring-fighters-show-off)). EngineAI's **SE01** and **PM01** are known for gait and flips, not fights ([Wikipedia EngineAI](https://en.wikipedia.org/wiki/Engine_AI)). **Unitree R1** has not fought.

---

## 3. Robot dossiers: specifications

| Model | Height | Mass | DoF | Peak torque | Actuators | Speed | Battery | Materials |
|---|---|---|---|---|---|---|---|---|
| **EngineAI T800** | 173 cm (production "closer to 6 ft"; WRC-2025 prototype 185 cm) | 75–85 kg by edition (prototype 85 kg) | Basic and Open Source 25; Pro 29 body + 14 hand = 43; Max 32 + 14 = 46 | 450 N·m max (knee); 14 kW instantaneous joint power | High-speed inner-rotor PMSM, crossed-roller bearings, planetary joints; Pro/Max add linear force control; leg joints actively air-cooled | ≥2 m/s (EngineAI) or ≥3 m/s (others) | 71.4 V 20 Ah ternary Li standard; optional 74.8 V 40 Ah solid-state; 3–5 h; quick-swap | Aviation aluminium + titanium (EngineAI); magnesium-aluminium alloy (New Atlas) |
| **Unitree G1** | 132 cm | ~35 kg | 23 base / 23–43 EDU | Knee 90 N·m (120 EDU / Comp) | Low-inertia inner-rotor PMSM with low-ratio two-stage planetary (QDD, about 20.6:1 per teardown), crossed-roller bearings | Up to 4 m/s claimed after the 2026 Gala; Comp version 3.3 m/s | 13S Li 9 Ah 54 V, ~2 h, quick-release | Not officially stated |
| **Unitree H1** (H1-2) | ~180 cm (H1-2: 178 cm) | ~47 kg (H1-2: ~70 kg) | 18/19 (H1-2: 27, 7-DoF arms) | Knee 360, hip 220, ankle 59, arm 75 N·m (H1-2: shoulder and elbow 120, wrist 30) | M107 PMSM, 189 N·m/kg peak | 3.3 m/s recorded | 15 Ah, 0.864 kWh, 67.2 V max | Not stated |
| **Unitree H2** | 182 cm | ~70 kg | 31 (7-DoF arms, 3 waist, 2 neck) | Legs 360 N·m, arms 120 N·m; arm payload 15 kg peak | Low-inertia inner-rotor PMSM, crossed-roller bearings, local air cooling | Not published | 15 Ah, 0.972 kWh, 75.6 V, ~3 h | Aircraft aluminium + titanium alloy + engineering plastics |
| **EngineAI PM01** (did not fight) | 140 cm | ~44 kg | 24 | 164 N·m; 145 N·m/kg | Inner-rotor PMSM, crossed-roller bearings | >2 m/s | ~2 h, 54.6 V charger | Aviation aluminium |
| **Booster T1** | 118 cm | ~30 kg | 23–41 | 130 N·m | Full force control, dual encoders | Not listed | ~2 h walking | Not listed |

Sources by row:
- **T800:** [EngineAI T800](https://en.engineai.com.cn/product-t800), [New Atlas](https://newatlas.com/ai-humanoids/engineai-t800-humanoid/), [Interesting Engineering, CES](https://interestingengineering.com/ces-2026/ceo-kicking-combat-ready-humanoid-robots), [antonrobots](https://antonrobots.com/engineai-t800-review/), [Kalil WRC 2025](https://mikekalil.com/blog/engineai-t8000-debut/).
- **G1:** [Unitree G1](https://www.unitree.com/g1/), teardown via search snippet from [EEWorld](https://en.eeworld.com.cn/news/robot/eic733333.html) (I could not load the page directly), [36Kr](https://eu.36kr.com/en/p/3687105642737545), [G1-Comp listing](https://www.robotsasia.com/Unitree-G1-Comp-G1-Comp.htm).
- **H1 and H2:** [Unitree H1](https://www.unitree.com/h1/), [Unitree H2](https://www.unitree.com/H2/).
- **PM01 and T1:** [EngineAI PM01](https://en.engineai.com.cn/product-pm01.html), [Booster T1](https://www.booster.tech/booster-t1/).

**Prices:**
- T800: $25k (early claims), 180k–360k yuan ([Shenzhen Robot Combat](https://shenzhenrobotcombat.com/robots/engineai-t800/)), or $40.5k (Basic) to $80.8k (Max) ([antonrobots](https://antonrobots.com/engineai-t800-review/)).
- G1: $13.5k. H2: $29,900.

**Joint speeds (rad/s)** are not published for any of these robots.

**Unreliable source:** [humanoid.guide's T800 page](https://humanoid.guide/product/t800/) lists harmonic drives, 60 kg and a "US-based" maker. That contradicts EngineAI's own spec sheet; ignore it.

---

## 4. Visual descriptions (observed, with image sources)

### EngineAI T800

Sources: [COCO Park photo](https://www.sz.gov.cn/img/4/4462/4462088/12893048.jpg), [Shanghai photos](https://robots-daily.com/wp-content/uploads/2026/09/EngineAI-T800-Robots-Fight-in-Shanghai.jpg), [broadcast frame](https://images.techeblog.com/wp-content/uploads/2026/07/18101847/urkl-mma-robot-fight.jpg), [EngineAI product hero video](https://en.engineai.com.cn/product-t800).

- **Silhouette:** adult-male proportions. Moderate shoulders, trim waist, long legs (91 cm leg, 60 cm arm).
- **Head:** smooth helmet-like dome with a dark horizontal visor band. The promo shows a thin white LED line across the visor, and Matador's detached head showed a curved white light strip.
- **Shell:** gloss plates on chest, upper arms, forearms, thighs and shins, with a round emblem at the chest centre.
- **Joints:** large round disc-shaped caps over the hip, knee and shoulder actuators. Mechanics at the waist, elbows and ankles are exposed and dark graphite.
- **Feet:** chunky, sneaker-like, white with dark soles.
- **Hands:** bare, dark mechanical fists. No gloves in URKL.
- **Liveries seen:** gloss white with grey (White Eagle, and the stock COCO Park units); chrome gold torso with silver limbs (Golden Flash); dark chrome or gunmetal with red accents (Matador).
- **Promotional statue:** a 6 m black-and-gold mech with an Iron-Man-style faceplate and disc joints ([Shenzhen gov](https://www.sz.gov.cn/en_szgov/aboutsz/photos/content/post_12893048.html)). Spectators compare the robot to Iron Man ([RoboSports Global](https://robosportsglobal.com/rek-robots-san-francisco-engineai-t800-fighting-humanoid/)).
- **Customisation:** REK dressed it with a "Terminator-style head"; Kalil mentions "Gundam-style" helmets. FA01 armour is white foam and made to be personalised.

### Unitree G1

Sources: [G1 page](https://www.unitree.com/g1/), [CGTN fight photo](https://news.cgtn.com/news/2025-05-27/-AI-Strategist-wins-CMG-s-humanoid-robot-fighting-competition-1DId4cqqLmw/img/484ee2918c56456987470ea1d0eeb13e/484ee2918c56456987470ea1d0eeb13e.jpeg), [Unitree boxing page](https://www.unitree.com/mobile/boxing/), [UFB photo](https://fastly.restofworld.org/uploads/2026/02/GettyImages-2254510712.jpg).

- **Build:** kid-sized and slender. Satin silver or light-grey metallic shells and a boxy, flat-fronted chest.
- **Joints:** dark grey cylindrical actuators left exposed at shoulders, elbows, hips and knees. The narrow waist-yaw actuator is visible.
- **Head:** glossy black rounded dome with a black glass face ringed by a glowing blue rounded-rectangle "halo" light.
- **Hands and feet:** black three-finger hands (Dex3-1) or stubs; flat black feet.
- **Fight dress:**
  - CMG: padded full-face headgear in team colours with matching gloves strapped over the forearm ends.
  - Unitree boxing promo: black-and-red headgear, red gloves, and two red diagonal stripes on silver thighs.
  - UFB: tan hood-style headgear, red or blue gloves, and sponsor decals.

### Unitree H1 / H1-2

Source: [H1 page](https://www.unitree.com/h1/).

- Matte black all over, very skinny for 1.8 m (47 kg), with exposed black cylindrical motors.
- The head is an elongated faceless helmet: a black face edged by a white crescent outline.
- The base H1 has perforated spherical "ball" hands.
- Unitree often shows it wearing a grey knit sweater.

### Unitree H2

Source: [H2 page](https://www.unitree.com/H2/).

- 182 cm, slim, balletic proportions. White or silver shells with dark grey disc actuators at the hips, knees and elbows.
- A sculpted silver **bionic human face** with eyes, nose and lips.

### EngineAI PM01

Source: [PM01 page](https://en.engineai.com.cn/product-pm01.html).

- Gunmetal or silver metallic shell and a helmet head with a glowing horizontal visor slit. It clearly shares the T800's family look.
- Orange-red shield emblem on the chest, a round chest sensor, grey disc joints and a black waist.

### Booster T1

Source: [Booster T1 page](https://www.booster.tech/booster-t1/).

- Silver-grey box torso with a wordmark on the chest, black limbs with exposed black actuators, and orange ankle linkage rods.
- A small black boxy head with a horizontal camera slot, and rounded mitten-like hands.

### Arenas (generic)

- **URKL:** chain-link octagon, black mat with gold lines, amber LED edge lighting, reflective floor. Broadcast graphics show round tally, points, clock and timeouts.
- **CMG:** a roped boxing ring with a human referee.
- **REK and UFB:** cages, a human referee and commentators.

### 4.1 Trade dress: what NOT to copy

- **Names and marks:**
  - Company and event marks: "Unitree," "EngineAI"/"众擎," "URKL," "Iron Fist King," "REK," "UFB," "CyberHero," "FORCE" (the headgear branding), and CMG/CCTV logos.
  - **"T800"/"T-800"** itself, because it references the *Terminator* franchise.
  - Robot names: AI Strategist, Silk Artisan, Energy Guardian, Armored Mulan, White Eagle, Matador/Bullfighter, Golden Flash, Rekbot.
- **Signature head shapes:**
  - G1: black dome with a blue halo face ring.
  - H1: elongated faceless helmet with a white crescent outline.
  - H2: sculpted silver bionic face.
  - T800/PM01: helmet with a single horizontal LED visor slit plus a round chest emblem (T800) or orange shield emblem (PM01).
  - Also any Iron Man-style faceplate (Marvel).
- **Exact colour schemes:**
  - G1 satin-silver body with the blue halo, and the red twin-stripe boxing livery.
  - H1 all-black body with ball hands and a sweater.
  - T800 white with grey discs and white sneaker feet as one package.
  - Gold-chrome torso with silver limbs (Golden Flash).
  - The black-and-gold mech statue.
  - UFB's tan hoods with UFB decals.
- **Silhouettes to avoid cloning:** Booster T1's box torso with orange ankle rods.

### 4.2 Generic to the category: safe to use

- Adult (1.7–1.85 m, 70–90 kg) and kid-size (1.2–1.4 m, 30–45 kg) electric humanoids.
- Exposed rotary actuator "pucks," disc joint caps and crossed-roller bearing housings.
- White, grey, black, silver or gunmetal shells; metallic or chrome finishes used as your own combinations.
- Faceless visors and LED status strips in general; sneaker-like soled feet.
- Boxing gloves in red and blue corners, padded headgear, team colours, number and sponsor decals (I observed no number decals in these events, so numbers would be a way to set Split Decision apart).
- Foam armour kits, chain-link octagons, roped rings, referees, round clocks, scoreboards and timeouts.

---

## 5. What the fights actually look like (motion reference)

- **Striking vocabulary:**
  - Jab, cross and hooks; uppercuts; front, side, roundhouse and spinning kicks.
  - Tornado and flying kicks; jumping knee; knee strikes; leg sweeps; takedowns.
  - Taunts, poses and victory dances.
  - Sources: [Global Times](https://www.globaltimes.cn/page/202505/1334812.shtml), [Kalil](https://mikekalil.com/blog/engineai-urkl-begins/), [Robots Daily](https://robots-daily.com/engineai-t800-robots-fight-in-shanghai-inside-urkls-humanoid-robot-combat-test/).
- **Force:**
  - 2025 G1 strikes looked like pushes ([Asia Times](https://asiatimes.com/2025/05/china-stages-first-ever-humanoid-robot-kickboxing-match/)).
  - T800 strikes show "visible commitment, not trade-show shadow-boxing" ([Shenzhen Robot Combat](https://shenzhenrobotcombat.com/robots/engineai-t800/)).
  - An H2 knee lifted a 35 kg G1 off the ground. A T800 kick knocked a padded human across a cage.
- **Pace and tracking:** URKL robots sometimes "attacked empty space" and lost track of each other ([Kalil](https://mikekalil.com/blog/engineai-urkl-begins/)). WAIC G1s fought for 2+ minutes without stopping.
- **Falls and get-ups:**
  - Frequent in every event.
  - Rules set the pace: an 8 s count (CMG); 3 s scores best and 20 s is the cap (URKL).
  - The T800's kip-up gets it up "almost immediately." REK G1s sometimes needed human help to get up.
- **Damage:** heads detached by cable failure, a robot kept fighting headless, sparks on impact, and one robot fought on with head and neck damage. Organizers cite "shock-absorbing" joints and redundant torso sensors.

---

## 6. Implications for Split Decision (suggestions, not decisions)

1. **Re-mass the roster into real classes.** WHRG 2026's 40, 58 and 80 kg divisions are a ready-made real-world anchor.
2. **Suggested torque budgets for the MuJoCo actuators:**

   | Class | Hip/knee peak | Arms | Ankles |
   |---|---|---|---|
   | ~80 kg full-size | 360–450 N·m | 75–120 N·m | ~60 N·m (H1 figure) |
   | ~35–40 kg kid-size | 90–130 N·m | Well below legs | — |

   All actuation should be modelled as electric QDD, with no hydraulics.
3. **Three original chassis archetypes**, grounded in the categories above:
   - **Featherweight:** ~1.3 m, 35–40 kg, ~25–29 DoF. Fast and quick to get up.
   - **Full-size striker:** ~1.75 m, ~80 kg, 29 DoF, 450 N·m legs.
   - **Long-reach rangy fighter:** ~1.85 m, ~70 kg, 31 DoF, 360/120 N·m.

   Give each an **original head** (for example a split or vertical light-bar visor, or an asymmetric sensor cluster), its own colour system and **number decals**, plus generic gloves and headgear or a foam armour kit.
4. **Rules template to borrow:**
   - Round length: CMG 3×2 min, REK 5×60 s, or URKL 5×5 min.
   - Scoring: punch 1 and kick 3 (CMG), or strike 1 and knockdown 3 (URKL).
   - Strikes thrown while falling do not count, and the robot must regain its stance after striking.
   - A count of 8 s or 20 s; timeouts; a "last robot standing" three-way mode.
5. **Spectacle beats to model:** kip-up recovery in under 3 s, head detachment with the torso still fighting, sparks, spinning and tornado kicks, jumping knees, taunts, and the occasional whiff on empty space.

---

## 7. Discrepancies and confidence

- **Who won White Eagle vs Matador:** Matador 3–2 according to [Wikipedia](https://en.wikipedia.org/wiki/Ultimate_Robot_Knock-out_Legend), [URKL News](https://urklnews.com/news/urkl-shenzhen-opening-recap/), [Kalil](https://mikekalil.com/blog/engineai-urkl-begins/) and [urkl.org](https://urkl.org/what-is-urkl), which also calls it an exhibition. The broadcast graphic's 1–3 round tally going into round 5 is consistent with that. [TechEBlog](https://www.techeblog.com/urkl-mma-robot-fight/) says White Eagle won. **Best evidence: Matador won.**
- **URKL round length:** five 5-minute rounds ([urkl.org](https://urkl.org/what-is-urkl), [RobotBoxe](https://robotboxe.com/analysis/how-urkl-fights-are-won/), and the 3:04 broadcast clock) vs "5 minutes per match" ([Wikipedia](https://en.wikipedia.org/wiki/Ultimate_Robot_Knock-out_Legend)). **Best evidence: 5×5 min.**
- **URKL control:** semi-autonomous at the opener ([Kalil](https://mikekalil.com/blog/engineai-urkl-begins/)) and partly autonomous in Shanghai. The claims of "fully autonomous" ([RoboSports Global](https://robosportsglobal.com/robot-combat-sport-2026-urkl-rek-ufb/)) and "operators must remotely control" ([Shenzhen Bay Area](https://www.cnbayarea.org.cn/english/News/content/post_1332413.html)) conflict. **Best evidence: hybrid.**
- **Event dates:**
  - URKL opener: 16 July (most sources) vs 17 July ([Global Times](https://www.globaltimes.cn/page/202607/1366175.shtml)).
  - Shanghai stop: 19 September (Euronews' 21 September is its publication date).
  - REK human vs robot: 18 September (most sources) vs 20 September ([GadgetReview](https://www.gadgetreview.com/a-human-fought-a-6-foot-tall-humanoid-robot-in-a-san-francisco-cage-he-lost)) vs 21 September ([explainx](https://www.explainx.ai/blog/humanoid-robot-vs-human-fight-san-francisco-rek-2026)).
- **T800 size, DoF and price:** see section 3. The spec sheet (173 cm, 75–85 kg) is authoritative for the stock robot, but REK's production units are described as "closer to 6 ft."
- **Not found:** WHRG 2026 Free Combat winners and robot models; whether EngineAI's 24 December 2025 "Robot Boxer" event actually happened; CMG 2026 results.

---

## 8. Media index

- **Photos:**
  - [CMG G1 finalists, CGTN](https://news.cgtn.com/news/2025-05-27/-AI-Strategist-wins-CMG-s-humanoid-robot-fighting-competition-1DId4cqqLmw/img/484ee2918c56456987470ea1d0eeb13e/484ee2918c56456987470ea1d0eeb13e.jpeg)
  - [UFB G1s, Getty](https://fastly.restofworld.org/uploads/2026/02/GettyImages-2254510712.jpg)
  - [T800 COCO Park exhibition](https://www.sz.gov.cn/img/4/4462/4462088/12893048.jpg)
  - [URKL decapitation broadcast frame](https://images.techeblog.com/wp-content/uploads/2026/07/18101847/urkl-mma-robot-fight.jpg)
  - URKL Shanghai: [1](https://robots-daily.com/wp-content/uploads/2026/09/EngineAI-T800-Robots-Fight-in-Shanghai.jpg), [2](https://robots-daily.com/wp-content/uploads/2026/09/EngineAI-T800-Robots-Fight-in-Shanghai-2.jpg), [3](https://robots-daily.com/wp-content/uploads/2026/09/EngineAI-T800-Robots-Fight-in-Shanghai-3.jpg), [4](https://robots-daily.com/wp-content/uploads/2026/09/EngineAI-T800-Robots-Fight-in-Shanghai-4.jpg)
- **Video:**
  - [Iron Fist King](https://www.youtube.com/watch?v=StLp4Z-ul44)
  - [WHRG boxing](https://www.youtube.com/watch?v=9nBQtlg4-M4)
  - [T800 at CES](https://www.youtube.com/watch?v=bzkYiapsY3c)
  - [G1 boxing at CES 2026](https://www.youtube.com/watch?v=xZ49AC4LEj0)
  - [SCMP decapitation](https://www.scmp.com/video/technology/3361043/chinese-humanoid-robots-mma-clash-ends-decapitation-fighting-league-shenzhen)
  - [CTV URKL](https://www.ctvnews.ca/video/2026/07/18/robot-mma-league-debuts-in-china/)
  - [Euronews Shanghai](https://www.euronews.com/video/2026/09/21/humanoid-robots-battle-it-out-in-shanghai-fight-night)
  - [REK $10K 6-ft league](https://www.youtube.com/watch?v=h5P5haxN7Gs)
  - [REK human vs robot](https://www.youtube.com/shorts/8RbhRIZ96FM)
  - [REK Tokyo](https://www.youtube.com/watch?v=jO4aNdzFTGg)

---

*Session note: several plugin MCP servers (plugin:engineering asana, atlassian, datadog, github, linear, notion, pagerduty, slack) need authorization in claude.ai connector settings or via /mcp. They were not needed for this research. No files were written or modified.*