# Agent 2 — Scenarios, Ships & the Economy

**Context:** DARKVESSEL (`dark-vessel-lite.html` in this repo) is a maritime-intelligence game where sensors flag ships and the player judges each one — patrol it, watch it, dismiss it, or task imagery of it. The game is being upgraded to a design with three earned sensor levels (radar → satellite with ground processing → satellite edge AI), and **this note covers your slice of that design: what exists in each playthrough** — the ship types, how many appear and when, the randomness that makes runs replayable, the fairness rules that keep them winnable, and the points economy.

**Essential notes (read once, then design freely):**
- The whole game is one self-contained HTML file; a 2D chart renderer and a 3D scene both draw from one shared simulation state. The user also edits this file by hand between sessions, so always re-read before changing anything.
- A prior prototype exists on the git branch `claude/sensor-tiers-acts` (read-only reference). Its scenario was a fixed hand-written table — exactly what we are replacing.
- Two other agents are building, in parallel: the clock/movement engine (rounds are 90-second timed windows; ships move continuously; a ship's spawn distance follows from its speed and countdown) and the sensor levels + interface (what the player sees and may do at each level). **Your boundary:** you decide what spawns, when, and what it's worth. You never decide how it moves (speed + countdown are your inputs to the engine; position falls out) and you never consider the player's current level — the content of a run is identical whether the player is blind or all-seeing; the sensors decide what's *visible*.
- The full design prose lives at https://claude.ai/code/artifact/f4c5703d-f1b3-483f-bfec-cca7cfb75718 if you need surrounding context.

**The shared numbers** (all three agents build to these; keep them in one obvious, editable place):
Rounds: 8. Round window: 90 seconds. Satellite pass: ~4 seconds. Downlink: none at Level 1, 20 seconds at Level 2, under one second at Level 3. Verify: ~8 seconds. Time warnings at 30 / 15 / 5 seconds remaining. Speed convention: 1 knot = 0.2 map-units per second. Patrol boat: ~50 units/second. Patrol visually acquires a ship within 120 units; a blind sweep finds a hidden ship within 150 units of the searched area's center. Radar coverage: 405 units around the coastal station. Board caps by round: 2, 3, 4, 5, 5, 6, 7, 7 contacts. Maximum live real threats at once: 3. Upgrade thresholds: +150 and +550 cumulative score; free satellite grant at round 6. Scores: +100 stop a threat, +25 correct dismissal, −75 wasted patrol, −150 dismissed threat or breach, −25 empty blind sweep. Uncertainty circle: seconds of staleness × (last measured speed × 1.25), display-capped around 160 units. Cloud bank: exists from round 5, covers ~20% of the map. Ghost reports start round 2; the first unseen hit cannot happen before round 5; at most one unseen hit per round.

---

## The design you are building

### The stance: authored spine, generated contents
A hand-authored scenario with an unchanging answer key kills replayability — and reads badly in a demo the moment someone says "run it again." The rule: **the structure of a session stays authored; its contents are generated fresh every run.** What stays fixed: eight rounds; the difficulty curve below; which mechanics are active when (clouds only from mid-game, fast movers only late, ghost pressure ramping from round 3); the fairness guarantees; and each stretch of rounds keeping its teaching purpose — early rounds are behavior-reading inside the radar rings, mid rounds are living with satellite latency, late rounds are speed and saturation. What varies: every individual ship. No specific ship is ever scripted to a specific round. The player's skill shifts from memorizing a script to reading behavior — which is the skill the whole product story is about.

### The ship archetypes
Each contact in a run is an instance of an archetype — a bundle of behavior rules with randomized parameters, never a fixed entry:

- **Dark runner** — a real threat. Broadcasting nothing, visible to radar if it comes inside the rings. Moves on a curved approach toward one of the two facilities (the water plant or the navy base, chosen per instance) at a speed drawn from roughly 6–14 knots, arriving in 1–3 rounds.
- **Ghost** — the dark runner's deep-water cousin, and the punishment mechanic's spine: a real, low-observable dark ship whose entire approach stays **outside** radar coverage. Only satellite imagery ever sees it. Roughly 6–10 knots, 2–3 rounds out, approaching along the deep-water side of the map. It must never be radar-detectable, regardless of geometry.
- **Decoy transmitter** — a fake. A loud broadcast identity (signal-match in the high 80s to mid 90s) with **no hull under it** (or a towed barge). Perfectly stationary, always — stillness is the fake's permanent tell. Imagery of its position shows empty water.
- **Spoofer** — the archetype that breaks answer-memorization: a **real threat wearing a stolen legitimate identity**. Its broadcast looks clean and strong — but the hull is moving, and moving toward something. Players who learned "loud means fake" get burned; players who learned "behavior over signal" catch it. Some runs contain one, some contain none.
- **Local traffic** — innocents. Honest broadcasts, honest speeds (drifting fishing boats around 2–5 knots, coasters around 8–12 on lane routes), honest wandering routes, no target. They exist to make paranoia expensive: boarding one wastes the patrol (−75).
- **Fast mover** — a late-game real threat at ~22 knots, entering from far outside the imaged area (its speed and countdown put its spawn at the far edge of the map). It is the showcase for satellite-to-satellite cueing: with edge AI the warning arrives a full round early; below that, it's brutal. Cued in round 7, on the map and arriving by round 8.

Names come from a pool (keep the phonetic-alphabet flavor); signal percentages, speeds, spawn bearings, and targets are rolled per instance within each archetype's bands.

### The per-round budget (the difficulty curve)

| Round | New contacts | Max on the board (new + carried) | What the mix may include |
|---|---|---|---|
| 1 | 2 | 2 | 1 real threat on an in-ring approach, 1 innocent |
| 2 | 2–3 | 3 | 1 real, 1 decoy, 0–1 innocent; the first ghost report fires |
| 3 | 2–3 | 4 | The first ghost afloat (satellite-only), plus an in-ring real or an innocent |
| 4 | 2–3 | 5 | 1 real, 1 innocent, 0–1 decoy |
| 5 | 2–3 | 5 | The cloud bank arrives; a second ghost window opens |
| 6 | 3 | 6 | 1–2 real (this is the spoofer's window); a decoy parked in the ghost lane is allowed |
| 7 | 3–4 | 7 | The fast mover is cued from off-map; 1–2 real; the mix fills the rest |
| 8 | 3–4 | 7 | The loudest decoy of the run, plus the fast mover on the map |

Totals that must fall out of the table: **20–25 contacts per run — 8–10 real threats, 2–4 decoys, and the rest innocent** (typically 8–11). At least one real threat exists every round, so every round has teeth. Never more than 3 real threats alive at once. The board never exceeds its round's cap, counting carried-over contacts. Decorative background traffic doesn't count and never gets a card.

### The solvency rule (the binding fairness constraint)
The player can neutralize exactly one ship per round — one patrol boat, one dispatch. So the one-sentence rule your generation must always satisfy: **no two live threats may ever share the same arrival round.** Since every threat's countdown ticks down one per round, distinct arrival rounds guarantee that for any stretch of *h* upcoming rounds, at most *h* threats are due in it — which means a player who correctly identifies every threat can always kill them in arrival order and lose nothing. Difficulty must come from identification and prioritization under the clock, never from arithmetic impossibility.

The worst board your rules may legally produce — and it must remain solvable: three live threats arriving next round, in two, and in three, plus two decoys and two innocents. Seven cards against one 90-second window. The correct play exists: patrol the one arriving next round, spend the imagery look on the scariest ambiguity, dismiss what behavior has already cleared, watch the rest.

### How a run gets generated
For each round, roll the spawn list from the curve's budget: which archetypes, how many, where (within each archetype's legal spawn zones and approach lanes); speeds and signal strengths within their bands; names from the pool; each threat's target facility. **Pick a ship's speed and countdown first — its spawn position follows from those** (that relationship belongs to the movement engine; you supply the two numbers). Also roll, per run: where the cloud bank sits and how it drifts round to round (about a fifth of the map, present from round 5, with a predictable drift direction); when the intelligence reports fire; and **whether each report is accurate — sometimes the reported suspicion area holds a real dark ship, sometimes a decoy, and that strategic uncertainty is deliberate.** Place decoys where a ship would be plausible.

**Seeding:** every run has a visible seed, and replaying a seed reproduces the run exactly — consistent rehearsed runs for live demos, shareable challenges for everyone else. Two different seeds must produce visibly different runs.

### Ghost scheduling and the punishment clock
Ghosts are how the game punishes not upgrading, and your scheduling carries the fairness:
- Third-party reports (the telegraphs — an allied aircraft, a merchant sighting, marking a rough suspicion area beyond the rings) begin in round 2 and escalate.
- The first ghost is afloat in round 3; a second window opens around rounds 5–6; a ghost-lane decoy to bait newly-sighted players is allowed in round 6.
- **The first possible unseen hit cannot occur before round 5** — that is at least two full rounds after the satellite becomes affordable and three rounds after the first warning. Schedule ghost countdowns so this holds.
- At most one unseen hit per round, ever. The run always continues to round 8 and the results screen, no matter the damage.
- Honesty rule for blind sweeps: when a report is real, the ghost's route actually passes within finding range (150 units) of the reported area's center during the rounds the report is active. A sweep of an honest report must be able to succeed.

### Cloud fairness (you place the weather; others decide what it does per level)
Cloud may **delay** the truth, never **deny** it: a threat the player must act on is never solvable *only* through a photo the cloud takes away — anything that matters was visible before it went under, or is covered by reports. At most one must-act threat may be obscured at a time. The bank drifts predictably and must eventually clear any lane it covers. And you are allowed — encouraged, in some runs — to deliberately route a dark runner under the bank: using weather as cover is exactly what real dark traffic does, and the rules above keep it fair.

### The economy (numbers you own and the pacing they must produce)
Scoring stays exactly: +100 for stopping a real threat, +25 for a correct dismissal, −75 for a wasted patrol, −150 for dismissing a real threat or letting one arrive, −25 for an empty blind sweep. No streaks, combos, or multipliers. Upgrades unlock at cumulative score thresholds, never spent: **+150** qualifies the satellite, **+550** the edge package; a player still below +150 at round 6 is granted the satellite anyway (the interface presents that; you just make sure decent play rarely needs it).

The pacing guarantees your generation must enforce in **every** run, not just the average one:
- Round 1's maximum earnable score is 125 (one threat stopped, one innocent dismissed) — so the satellite is mathematically impossible in round 1 and everyone plays at least two radar rounds.
- Good play crosses +150 by the end of round 2.
- The cumulative maximum through round 4 stays below +550 — so the edge package is impossible before the end of round 5 and everyone genuinely lives with ground-processing latency first. Good play crosses +550 at the end of round 5.

### The no-coin-flips rule
Every contact must be solvable from its behavior plus whatever sensors the player could have — deducible from speed, course, track history, the broadcast-versus-radar crosscheck, or imagery. Never generate a ship whose only tell is hidden behind luck. Spot checks: a decoy is always stationary and always hull-less; a spoofer always moves toward a target (motion gives it away); a ghost is always covered by at least one report while it matters; an innocent's claimed identity always matches its speed and route.

---

## How to implement
That's your call — read the current game, design the generator however you judge best, and prove it with volume: generate a large number of seeded runs and check that every rule above holds in all of them (budgets and caps, the solvency rule, the totals, the economy pacing, the ghost and cloud fairness, seed reproducibility). Coordinate with the other two agents only through the shared numbers and the boundaries stated at the top.
