# Agent 1 — Time, Pacing & Movement

**Context:** DARKVESSEL (`dark-vessel-lite.html` in this repo) is a maritime-intelligence game where sensors flag ships and the player judges each one — patrol it, watch it, dismiss it, or task imagery of it. The game is being upgraded to a design with three earned sensor levels (radar → satellite with ground processing → satellite edge AI), and **this note covers your slice of that design: the round clock, the time pressure, and how ships physically move** — the metronome everything else sits on.

**Essential notes (read once, then design freely):**
- The whole game is one self-contained HTML file; a 2D chart renderer and a 3D scene both draw from one shared simulation state, and the simulation owns all ship positions. The user also edits this file by hand between sessions, so always re-read before changing anything.
- A prior prototype of the three-level idea exists on the git branch `claude/sensor-tiers-acts` (read-only reference — its levels were scripted to round numbers, which we are NOT doing, but its downlink phase and staging patterns are worth a look).
- Two other agents are building, in parallel: the scenario generator (what ships spawn, when, with what stats) and the sensor levels + interface (what the player sees and may do at each level). **Your boundary:** you own time and motion; you don't decide what spawns, and you don't decide what's visible. Ship movement must not depend on whether anything can see the ship.
- The full design prose lives at https://claude.ai/code/artifact/f4c5703d-f1b3-483f-bfec-cca7cfb75718 if you need surrounding context.

**The shared numbers** (all three agents build to these; keep them in one obvious, editable place):
Rounds: 8. Round window: 90 seconds. Satellite pass: ~4 seconds. Downlink: none at Level 1, 20 seconds at Level 2, under one second at Level 3. Verify: ~8 seconds. Time warnings at 30 / 15 / 5 seconds remaining. Speed convention: 1 knot = 0.2 map-units per second. Patrol boat: ~50 units/second. Patrol visually acquires a ship within 120 units; a blind sweep finds a hidden ship within 150 units of the searched area's center. Radar coverage: 405 units around the coastal station. Board caps by round: 2, 3, 4, 5, 5, 6, 7, 7 contacts. Maximum live real threats at once: 3. Upgrade thresholds: +150 and +550 cumulative score; free satellite grant at round 6. Scores: +100 stop a threat, +25 correct dismissal, −75 wasted patrol, −150 dismissed threat or breach, −25 empty blind sweep. Uncertainty circle: seconds of staleness × (last measured speed × 1.25), display-capped around 160 units. Cloud bank: exists from round 5, covers ~20% of the map. Ghost reports start round 2; the first unseen hit cannot happen before round 5; at most one unseen hit per round.

---

## The design you are building

### The round clock
Every round is a fixed 90-second tasking window. Eight rounds means exactly 12 minutes of play; with the intro, upgrade briefs, and results screen the whole session lands at about 14 minutes **regardless of player skill** — protect that property, it's what makes the game demo-safe. Skill changes what happens inside the windows, never how long a session runs.

What the 90 seconds contain differs by level, and that difference is the heart of the design:

- **Level 1 (radar only):** there is no satellite pass. The radar is continuous, so contacts appear whenever they enter its coverage, at any second of the round. All 90 seconds are decision time. Simple and learnable — this is where the player internalizes the rhythm.
- **Level 2 (satellite, ground processing):** the round opens with the pass (~4 seconds, the camera recording silently), and then the **downlink runs for 20 seconds while the clock keeps counting**. During those seconds the player is not idle — ships that broadcast their ID and ships inside the radar rings are live and fully actionable from second one — but the imagery layer, meaning the dark ships, only lands when the downlink completes. The player gets roughly 66 seconds with the full picture, and what lands is already stale. Less time and older data: the double cost of ground processing, felt every single round.
- **Level 3 (satellite edge AI):** the pass runs ~4 seconds and detections appear live *during* it; the downlink is effectively instant. The player gets the whole window with a live picture — the ~20 seconds Level 2 spent waiting come back as decision time, about a quarter of every round.

The clock pauses only at round boundaries (upgrade briefs, the results screen). Nothing inside a round pauses it — if the player opens an imagery report and reads it, the seconds spent reading are spent. Escalating warnings fire at 30, 15, and 5 seconds remaining (the last with a soft audio tick); the interface agent decides how they look, you make sure they happen at the right moments and that the countdown stays honest even when the browser tab is backgrounded or throttled.

### Ending a round
"Lock In" is always available and ends the window early — fast players gain momentum, not points, and a presenter can pace a live demo. When the timer hits zero, the round resolves itself: everything the player assigned executes; a patrol boat still in transit fast-forwards to its outcome; every contact the player never addressed is treated as "watch" — it persists into the next round and keeps sailing; and any threat whose arrival moment has come reaches its target. Indecision is never a fail state — it is punished by the world advancing. (A stricter rule where a too-late patrol dispatch simply fails to arrive was considered and rejected as too punishing; treat it as a tuning idea, not the design.)

### Continuous movement, tied to the clock
The current game moves threats in hops between rounds with a little cosmetic creep in between. Replace that with one rule:

> A threat that spawns with a countdown of *d* rounds travels its route (the existing curved approach toward its target) over exactly *d* × 90 seconds of running clock, and reaches the target at the exact second its countdown implies.

Consequences you must make true:
- Ships move smoothly every tick the clock runs — **including during the pass and the downlink**, because the world does not wait for the player's data. A threat is measurably closer when the Level 2 downlink finishes than when the pass started.
- The countdown shown on a contact's card ("arrives in 2 rounds") is *derived* from remaining travel time divided by the round length, rounded up — so the card and the map can never disagree.
- **Speed readouts are derived from actual motion, never decorative.** With the convention 1 knot = 0.2 units/second, a card's knots equal the ship's true on-screen speed. Worked examples that must hold: a 14-knot threat one round out spawns 252 units from its target; a 10-knot threat two rounds out spawns 360 units; a 22-knot fast mover two rounds out spawns 792 units — the far edge of the 900-unit map.
- **Spawn distance is the derived quantity:** the generator picks a ship's speed and countdown; where it starts follows from those two numbers along its approach route. Position, speed, and arrival round can never contradict each other.
- Ghosts (satellite-only dark ships) move by exactly the same rules whether or not anything can currently see them. Visibility is someone else's concern; motion is yours.
- Decoys never move at all — their perfect stillness is now verifiable against a live clock. Innocent ships wander at their class speeds (drifting fishing boats, steady coasters) rather than following attack routes.

### Radar space and the pass snapshot
- A ship's presence inside radar coverage is a continuous fact: the moment its true position crosses the 405-unit boundary around the coastal station, it is in radar space — mid-round, at any second. Radar has its own tempo; the satellite has the pass.
- Each satellite pass records, per ship, a snapshot of where it was at capture time. That snapshot is what the Level 2 "frozen photo" markers are drawn from (the interface agent draws them; you keep the snapshot true while the real ship keeps sailing).
- Provide the honest math behind the growing **uncertainty circle** around a stale contact: seconds since its snapshot × its assumed top speed (last measured speed plus a 25% margin), capped for readability at about 160 units.

### The patrol boat and travel time
The boat currently crosses the map in about a second and a half — far too fast for a timed game. Slow it to ~50 units/second so a close intercept takes ~5 seconds and a far corner ~22. That makes *when* you dispatch a real decision: far intercepts want early dispatch, and at Level 2 the downlink eats exactly the seconds you'd want to dispatch in. The boat chases the ship's **true** position (not the stale marker); when it gets within 120 units of a ship whose marker was frozen, it "gets eyes on" — from that moment the ship is truly located. A blind sweep is the same boat making the same trip to a reported suspicion area: if a hidden ship is really within 150 units of the area's center, the boat finds it and the normal engagement plays out; if not, the boat returns and the −25 penalty applies. Keep the existing engagement staging (approach, circle, resolve — a few seconds).

### Tool timing
Verify (a Level 3 capability) takes ~8 seconds from click to answer — fast enough to act on this round, slow enough to feel like a real system working, and a genuine spend out of a 90-second window. Re-scan is fulfilled at the start of the *next* round's window — meaning 30 to 90 real seconds away depending on how early in the round it was ordered, so ordering early is strictly better. Watch and dismiss are instant. (Which tools are *allowed* at which level is the interface agent's domain; you make the timing true.)

### One flavor note, held loosely
The whole game runs on a single implied time compression of roughly 1:500 — a 90-second window stands for about half a day of sector time, which is why a 10-knot ship plausibly crosses the map in a round and why a 20-second downlink honestly dramatizes a multi-hour ground processing queue. Edge products are near-real-time in fiction, so verify's 8 seconds is presentation, not compression. This is bookkeeping for copy, not a rule that constrains you.

---

## How to implement
That's your call — read the current game, choose your own architecture, and build until every behavior described above is true and observable in play: arrivals land on the exact second their countdown implies, displayed speeds match real motion, the Level 2 downlink visibly steals decision time while ships keep closing, timeouts resolve as described, and a full 8-round session runs fixed-length start to finish. Coordinate with the other two agents only through the shared numbers and the boundaries stated at the top.
