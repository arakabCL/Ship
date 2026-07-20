# Agent 3 — Sensor Levels & the Interface

**Context:** DARKVESSEL (`dark-vessel-lite.html` in this repo) is a maritime-intelligence game where sensors flag ships and the player judges each one — patrol it, watch it, dismiss it, or task imagery of it. The game is being upgraded to a design with three earned sensor levels (radar → satellite with ground processing → satellite edge AI), and **this note covers your slice of that design: everything the player sees and is allowed to do** — the three levels themselves, the upgrade moments, the fused sensor picture, the imagery pop-ups, the clock display, and every line of new text.

**Essential notes (read once, then design freely):**
- The whole game is one self-contained HTML file; a 2D chart renderer and a 3D scene both draw from one shared simulation state. Four color themes exist. The user also edits this file by hand between sessions, so always re-read before changing anything.
- A prior prototype exists on the git branch `claude/sensor-tiers-acts` (read-only reference) — its levels were scripted to round numbers, which we are NOT doing, but its downlink staging, anonymous radar blips, stale-snapshot markers, and upgrade-brief modal are worth studying before you design your own.
- Two other agents are building, in parallel: the clock/movement engine (90-second timed rounds; ships move continuously; the world never pauses inside a round — your modals and pop-ups must not stop the clock) and the scenario generator (what spawns, when; it never considers the player's level). **Your boundary:** you own the player's level, everything gated by it, and everything drawn or written. You don't decide ship motion or run content.
- The full design prose lives at https://claude.ai/code/artifact/f4c5703d-f1b3-483f-bfec-cca7cfb75718 if you need surrounding context.

**The shared numbers** (all three agents build to these; keep them in one obvious, editable place):
Rounds: 8. Round window: 90 seconds. Satellite pass: ~4 seconds. Downlink: none at Level 1, 20 seconds at Level 2, under one second at Level 3. Verify: ~8 seconds. Time warnings at 30 / 15 / 5 seconds remaining. Speed convention: 1 knot = 0.2 map-units per second. Patrol boat: ~50 units/second. Patrol visually acquires a ship within 120 units; a blind sweep finds a hidden ship within 150 units of the searched area's center. Radar coverage: 405 units around the coastal station. Board caps by round: 2, 3, 4, 5, 5, 6, 7, 7 contacts. Maximum live real threats at once: 3. Upgrade thresholds: +150 and +550 cumulative score; free satellite grant at round 6. Scores: +100 stop a threat, +25 correct dismissal, −75 wasted patrol, −150 dismissed threat or breach, −25 empty blind sweep. Uncertainty circle: seconds of staleness × (last measured speed × 1.25), display-capped around 160 units. Cloud bank: exists from round 5, covers ~20% of the map. Ghost reports start round 2; the first unseen hit cannot happen before round 5; at most one unseen hit per round.

---

## The design you are building

### Two voices, and a rule about jargon
Everything you write lives in one of two registers, and they never mix. The **platform** — alerts, briefs, incident reports, the feed, the audit trail — speaks like professional operations software: factual, cold, precise, written by adults. The **coaching voice** — hints and tooltips that talk the player through decisions — stays plain and human. And professional never means opaque: the game must be fully playable by someone with zero maritime background, so every technical term carries a short plain gloss in parentheses at the point of use — "11 knots (speed)," "AIS (the ID signal honest ships broadcast)," "closest point of approach (how near its path will come to you)" — and every control keeps a plain-language hover tooltip.

### Earning levels: the authorization flow (you own the player's level)
Levels are earned by cumulative score, never spent: crossing **+150** qualifies the satellite; crossing **+550** qualifies the edge package. Present this as performance-based tasking authorization — the player's rating is what convinces command to allocate a national asset to their sector. Never a shop, never a level-up, nothing pops, nothing celebrates.

The flow: when the score crosses a threshold, a notice arrives the way real tasking authority would grant it — a feed entry plus a brief titled like a system document, with plain columns for what the asset provides and what it does not:

> **ORBITAL TASKING AUTHORIZED — KRONOS-9** · Effective next pass
> Provides: full-sector imaging, once per round · detection, classification and signal-match via ground processing · re-scan tasking
> Does not provide: onboard analysis · in-pass response · imagery on demand
> [ ACCEPT TASKING ]

The brief is offered between rounds (the only time the clock is paused); accepting activates the level at the next round's start; the player may decline and claim it at any later round boundary. On activation, the change should read as an operations console acknowledging a new asset: the top-bar sensor label switches — RADAR ONLY (amber) → SAT·GROUND (blue) → SAT·EDGE AI (green) — the ships panel retitles to match, and newly provided buttons are simply present and enabled, because the system that provides them now exists.

**The safety valve:** a player still below +150 at round 6 receives the satellite unconditionally, framed as command surging assets to the sector after repeated unattributed incidents — which is faithful to how surge tasking really gets triggered. There is no equivalent handout for the edge package.

**The map switch:** Level 1 shows the 2D chart only — the 3D view is the satellite's product and doesn't exist yet. Satellite activation plays a one-time transition, the orbital view initializing like a data feed coming online, and the 3D scene is primary from then on.

### Level 1 — Radar only
Detection exists only inside the coastal station's coverage rings (405 units); beyond them, darkness — draw the coverage limit so the boundary of the player's world is visible. A contact is an anonymous blip with a track number: no name, no signal-match percentage, because identification requires imagery the player doesn't have. What the card *does* show is everything a real shore radar derives from watching a hull move:

- Position, range, and bearing — where it is now, how far from the facilities.
- **Speed**, in knots with a gloss. Vessel classes live in speed bands: a drifting fishing boat does 2–5 knots, a cargo ship holds a steady 8–12, an attack run looks like 10+ in a straight line — so a ship *broadcasting* "fishing vessel" while doing 14 knots is lying about something, and the claim came from the ship, not the radar.
- Course, held over time — wandering (fishing), following the shipping lane (commerce), or one steady bearing that intersects the water plant (a problem).
- Track history — the trail. Loitering circles near infrastructure, a course that keeps correcting toward a facility, or two tracks that converge and sit together (a rendezvous — how smuggling transfers look).
- **Closest point of approach** (glossed: how near its path will come to you) — the projected pass distance and rough time; the "is it actually coming at me?" line.
- Echo strength as a rough size class — small / medium / large hull, nothing finer. A contact claiming to be a 200-meter cargo ship while returning the echo of a small skiff is a catchable mismatch.
- **The broadcast crosscheck** — AIS claims compared against radar physics: a broadcast with no radar return under it is a decoy transmitter; a radar return with no broadcast is a ship running dark; a claimed type that doesn't match the blip's speed or size is a spoofer.

Be precise in the copy: at this level, any claim about *what* a ship is comes from the ship itself. The radar never identifies — it measures size and motion, which is exactly enough to confirm or contradict the ship's story. A silent contact makes no claim at all; the player judges it purely by behavior. What the radar can never give: a name, a type beyond rough size, what's on deck, a photograph, anything beyond its horizon.

The framing that keeps this level a real game, and the hints should carry it: inside its rings the radar is the *best* sensor in the game — live, continuous, updating every second. The satellite will show the whole map, but as photographs already minutes old. Level 1 shows a small circle, perfectly, in real time; it's a complete skill (reading behavior) with real stakes (one patrol boat against several contacts means ranking suspicion, not just spotting it).

**Actions at Level 1:** Patrol, Watch, Dismiss. Re-scan and Verify are visible but disabled, labeled with the reason — "requires orbital tasking" — never a padlock icon. **The blind sweep:** third-party reports mark a rough suspicion area beyond coverage (an allied aircraft, a merchant sighting — "allied fishermen reported a dark ship around here"); render the marked area on the chart and a report-only card ("REPORTED ONLY — NO TRACK") with a single Blind Sweep button that sends the patrol boat to search it. Finding a real ship plays the normal interception; finding nothing costs −25 points for the wasted trip. Its tooltip should say what it structurally is: the only lever against the water you cannot see.

### The fused picture — who's live and who's frozen (Levels 2 and 3)
The satellite doesn't replace the other sensors; it joins them. From Level 2 on, the map is one fused picture from three sources, and each contact's card names the sources feeding it:
- **The ship's own broadcast:** broadcasting ships stay live at every level. A live track only proves the ship is *talking*, not that it's honest — a decoy is a live track with no hull under it; a spoofer is a live track wearing a stolen name.
- **Shore radar:** still running, still live, still limited to its rings, at every level.
- **Satellite imagery:** the only source that sees dark ships beyond the rings — and at Level 2, the only source that runs late.

So the frozen treatment applies to exactly one kind of contact: **not broadcasting and not inside the rings** — a dark ship, seen only by the camera. In 3D, its hologram appears frozen at its photographed position — no motion, no wake, no bobbing — framed by small photo-corner brackets with a capture-time tag ("LAST IMAGE · 4 MIN AGO"), and around it on the water a thin dotted **uncertainty circle**: everywhere the ship could have reached since the photo, growing as the picture ages (the engine supplies the honest radius). That growing circle is exactly how real maritime-intelligence products draw "it was here; by now it could be anywhere in this ring." The 2D chart draws the same furniture: frozen blip, timestamp, widening dashed circle. When the patrol boat gets close enough to see the real ship, the frozen marker snaps to the live hull and stays live.

Sell the consequence once in a hint: the map's look does half the analysis. A contact that moves live is talking or near shore — ordinary. A contact sitting frozen with a growing circle is dark and offshore by definition — the exact profile worth watching. The boring ships are live; the suspicious ships are stale. And at Level 3 the frozen furniture disappears entirely, because imagery goes live — meaning the tracks that visibly change at the upgrade are precisely the dark ones, the only ships that were ever stale.

### The downlink strip, and the Level 3 reveal (felt, not announced)
At Level 2, every round, the player watches the downlink strip do real work during the 20 seconds: "4.7 GB queued · transferring… · processing at ground station · est. queue 3 h 40 m (played as 20 s of your 90 s window)" — then the ground picture lands, stale. Make it visibly true that radar and broadcast contacts are actionable while the strip grinds.

At Level 3's first pass, **the same strip — same position, same styling — reads "2.1 KB · delivered" and completes in a blink** while detections plot live during the pass. No pause, no staged comparison card, no "look how much better": the same instrument showing different physics is the whole moment. One feed line marks the transition once — "First pass processed onboard · full-sector product delivered in 0.9 s" — and that is all the ceremony it gets. From then on, two quiet session counters accumulate in the status bar the way any ops dashboard tracks statistics: data kept off the downlink (+4.7 GB per pass) and cumulative time saved (+3 h 39 m per pass, in fiction). Worth one hint, once: mechanically, each Level 3 round returns the ~20 seconds Level 2 spent waiting — a quarter of the window.

### Imagery reports — the product behind Re-scan and Verify
One pop-up design serves both tools, styled as a real intelligence product: the photo itself (**placeholder images for now** — a plausible overhead frame of a trawler with nets, a vessel with visible mounted weapons, or empty sea where a decoy transmitted); capture metadata (sensor, time, resolution); analysis annotations drawn on the image — bounding boxes with detected features like "fishing gear identified," "2× mounted weapon systems identified," "no vessel present at transmitted position" — and then the verdict. The player judges partly by looking at the picture themselves, which is a far better moment than watching a percentage change.

Who gets which tool, and when the report arrives, is the ladder itself: **Level 1 — no imagery at all. Level 2 — Re-scan only:** order it this round, the report opens at the start of the next round (the collect–downlink–process cycle); Verify is present but disabled, labeled "requires onboard processing," because an instant answer requires the analysis to happen where the image is captured — in orbit. **Level 3 — Verify comes alive:** ~8 seconds from click to report ("TASKING → COLLECT → ONBOARD ANALYSIS" as a brief progress line), annotated by the onboard model; Re-scan still exists for next-pass looks. Budgets per round: Level 1 — 1 patrol only. Level 2 — 1 patrol, 2 re-scans. Level 3 — 1 patrol, 2 re-scans, 1 verify. No pop-up ever pauses the clock.

### Level 3 capabilities
- **AI reads on cards:** the analysis's honest take — "LIKELY DECOY," "LIKELY DARK VESSEL," "LIKELY FISHING," or "UNRESOLVED — RECOMMEND VERIFY" when it genuinely isn't sure. Classification exists at both satellite levels (same intelligence, different clock — at Level 2 it arrives with the downlink, one beat behind; at Level 3 it's live). It never lies, hedges honestly, and never makes the final call. The player does.
- **Autonomous retasking, once per round, free:** the satellite takes an extra look at whatever its model finds most anomalous, on its own, and files the reason in the feed — "EDGE AUTO-CUE: wake signature inconsistent with transmitted class." The feature that makes the satellite feel like a teammate instead of a camera. (The real-world grounding, for copy: a ground-tasked satellite flies a shot list uploaded before the pass and can't change its own plan mid-orbit; onboard processing closes that loop in orbit — "I just saw something anomalous, take a follow-up shot right now.")
- **Cloud recovery, once per round:** the satellite re-points through gaps on its own and recovers one cloud-obscured contact, noted "re-targeted through cloud gap." Taskings are never wasted into cloud at this level — the satellite re-sequences instead of shooting blind. (Grounding: "that area is cloudy — skip it, image this other spot instead.")
- **Crosslink tip-and-cue:** a wide-area radar scout satellite (add it to the entity catalog — e.g. SEN-03 SENTINEL) watches a huge swath at low detail; when the generator's fast mover appears outside the imaged area, at Level 3 the cue arrives **the same round** — a cue card plus a map-edge vector: "CROSSLINK CUE — SENTINEL→KRONOS-9 · fast contact inbound · no ground station in the loop" — a full round of early warning on the fastest threat in the game. At Level 2 the same cue routes through the ground segment and arrives one round later, already stale — and with no working Verify there, the only imagery response is a re-scan that pays another round. At Level 1 the cue never exists.

### Cloud, as the player experiences it
The weather layer is always visible with its drift arrow — forecasts are public. At Level 1, no effect: radar sees through weather (say so once). At Level 2: contacts under the bank are tagged "obscured — no new frame this pass" and their markers just keep aging; ships never yet seen stay absent; and a re-scan aimed at a contact under forecast cloud triggers a warning **before** the player commits — "target under forecast cloud — product likely unusable" — so a wasted re-scan is always a warned choice, never bad luck. At Level 3: the recovery behavior above.

### Ghosts, reports, and the incident
Ghost-class contacts are never rendered at Level 1 — not on the chart, not as cards, regardless of geometry. Their existence reaches a blind player only through the reports and, if one gets through, the incident. At Levels 2–3 there is no separate ghost mechanic at all: the pass reveals them as ordinary detections flagged uncorrelated — "no AIS transmission associated with this track" — which is itself a suspicion signal, since honest traffic broadcasts. At Level 2 they carry the frozen-photo treatment; at Level 3 they track live.

The incident (an unseen ghost reaching a facility) is reported in the professional register, exactly this shape — factual, cold, with the last line quietly naming what was missing:

> INCIDENT 0347Z — WATER TREATMENT FACILITY
> Damage sustained from seaborne approach.
> Track correlation: none — no contact history in surveillance coverage.
> Post-incident assessment: vessel transited outside radar horizon, AIS inactive.
> Coverage gap: orbital imaging not tasked to this sector.

Keep the existing consequences (the facility burns); the words change, not the stakes.

### The clock, on screen
A countdown in the ops bar. A status note at 30 seconds remaining; amber at 15; red with a soft tick at 5 — "TASKING WINDOW 0:15 — UNADDRESSED CONTACTS WILL BE CARRIED." Lock In always available to end the round early. When time runs out, the aftermath is stated plainly ("window closed — unaddressed contacts carried").

### The end-state reference (the whole ladder on one card)

| Capability | Level 1 · Radar | Level 2 · Sat·Ground | Level 3 · Sat·Edge AI |
|---|---|---|---|
| Map view | 2D chart | 3D orbital view | 3D orbital view |
| Coverage | Inside the radar rings | Whole sector, once per pass | Whole sector + cues from beyond it |
| The 90-second window | All decision time | First ~20 s downlinking; imagery lands late, stale | Live picture from second one |
| Positions | Live, inside the rings only | Live for broadcasters & in-ring ships; dark ships: frozen photo + growing circle | Live for everything |
| Identity | None — track number, size, motion | Names, types, signal-match — one beat behind | The same, live |
| Imagery | None | Re-scan — report next round | Verify — report in ~8 s |
| Ghost vessels | Invisible; secondhand reports only | Visible as uncorrelated detections | Visible, live |
| Clouds | No effect on radar | No new frame under the bank; warned re-scans wasted | One recovery per round; nothing wasted |
| Fast movers | Never seen | Cue a round late, stale | Cued same round |
| Extra intelligence | — | — | One autonomous re-look per round |
| Actions | Patrol · Watch · Dismiss · Blind sweep | + Re-scan | + Verify |
| Per-round budget | 1 patrol | 1 patrol · 2 re-scans | 1 patrol · 2 re-scans · 1 verify |
| Earned at | Start | +150 score (granted round 6 if never reached) | +550 score |

One scoping note: the existing results screen still reflects the old five-round design; leave it functional and flag its retuning as a follow-up — it belongs to none of the three agents.

---

## How to implement
That's your call — study the current interface and the prototype branch, design your own approach, and build until everything above is what a player actually experiences: the right things visible, hidden, enabled, and worded at each level, in both map views and all four themes, with no pop-up ever stopping the world. Coordinate with the other two agents only through the shared numbers and the boundaries stated at the top.
