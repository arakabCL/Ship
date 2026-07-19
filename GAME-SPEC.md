# DARKVESSEL — Complete Game Specification

*Reverse-engineered from `dark-vessel-lite.html` (v2.4.1 DEMO, "MERIDIAN" build). Everything needed to recreate the game — concept, loop, mechanics, numbers, timings, visuals, audio, and platform dressing.*

---

## 1. Concept in one line

You command a spy satellite that automatically finds ships hiding in your waters. You never spot ships yourself — the satellite flags them; **you** decide what to do about each one with far fewer resources than suspects, against fakes designed to bait you. The skill: judge ships by **where they're heading**, not how loud their signal is.

The ending drives the thesis home: your score is compared against a pure-AI autopilot (gets baited) and an unaided human (never resolves the picture) — a well-played human+satellite team beats both.

---

## 2. Technical shape

- **One self-contained HTML file**, no backend, no build step. Open in a browser.
- Three layers, cleanly separated:
  1. **Platform shell** ("MERIDIAN — Operational Intelligence") — the enterprise-console dressing: top bar, alerts, status bar, event/audit stores, entity catalog. Pure theater, driven by game events.
  2. **Simulation** — the actual game. Owns all state, rules, movement math, and a complete 2D canvas renderer (the fallback).
  3. **3D ocean engine** — Three.js (v0.161 via CDN import map) progressive enhancement. Renders the *same game state* as a tilted bird's-eye night scene. If Three.js fails to load (offline), the 2D canvas keeps running unchanged. Bridge: sim exposes `window.__DV` (state getter + geometry + helpers); 3D exposes `window.MAP3D.frame()` which the sim's render loop calls instead of drawing 2D.
- Fonts: **IBM Plex Sans / Sans Condensed / Mono** (Google Fonts; needs network on first load).
- Sound: tiny WebAudio synth, zero assets.
- Sim must keep advancing when the tab is hidden: a 250 ms `setInterval` watchdog calls the tick if `requestAnimationFrame` starved for >400 ms.

---

## 3. Screen layout

```
┌──────────────────────────────────────────────────────────────┐
│ classification bar: TRAINING // DEMO — SYNTHETIC DATA ONLY   │
│ TOPBAR  ◆ MERIDIAN · clock (UTC) · secure channel · user     │
├──────────────────────────────────────────────────────────────┤
│ OPSBAR  OP DARKVESSEL · Round 00/05 · Score · resource pips  │
│         (Patrol Boat 1 · Re-scans 2 · Sat Photos 1)          │
│         Overlay chips: GRID RINGS DEPTH TRAFFIC LABELS SFX   │
├───────────────────────────────────┬──────────────────────────┤
│                                   │ SIDE (~360px)            │
│  MAP (canvas #map / #map3d)       │ "Ships // Flagged by     │
│  corner-bracket frame             │  Satellite"  count       │
│  center top: big status note      │ contact cards, scroll    │
│                                   │                          │
├───────────────────────────────────┴──────────────────────────┤
│ FOOTER  hint text (plain language)  ·  [primary action btn]  │
│ STATUSBAR session timer · user · grid ref · v2.4.1 DEMO      │
└──────────────────────────────────────────────────────────────┘
```

- **Intro overlay** (modal, corner brackets): DhowLantir logo (inline SVG ship-in-circle + wave), tag line "DARKVESSEL · Satellite Watch · Training Run · 5 Rounds", 2 short paragraphs of premise, a 5-tile row showing each action with icon + 2–4 word summary, START button.
- **End overlay**: title (AREA HELD / RESULTS), verdict sentence, 3 horizontal diverging bars from a center axis (You / Autopilot / No Satellite) with animated count-up scores, PLAY AGAIN.
- **Tooltip** (`#tip`): fixed-position hover card; every action button explains itself in plain language.
- **Theme dock** (bottom-right, collapsed to one dot, expands on hover): 4 color profiles — Obsidian (azure, default), Recon Green (jade), Tactical Amber (night-ops gold), Graphite Ice (gunmetal). Sets `data-theme` on `<html>`, persisted to localStorage.

---

## 4. Visual design language

Palantir-style intelligence console:
- Near-black backgrounds (`#04070C`–`#10151C`), 1px hairline borders (3 line weights), corner brackets on panels and the map frame, uppercase condensed micro-labels with wide letter-spacing, tabular mono numerals.
- Base tokens (default theme): text `#DCE3EA`, dim `#9CA7B3`, accent blue `#4C86AE`/`#82B1CF`, green `#4C9C7C`, amber `#C2933F`, red `#C9626F`.
- Color meaning is consistent everywhere: **amber = unknown/suspicious**, **red = confirmed threat**, **gray = cleared/harmless**, **blue/cyan = your assets**, **green = positive score**.
- Classification rails top and bottom of viewport ("TRAINING // DEMONSTRATION ENVIRONMENT").

---

## 5. World & mission data

World is a fixed 900 × 560 coordinate space (letterboxed to fit).

- **Protected zones**: `water` = WATER PLANT at (150, 430) r30 · `navy` = NAVY BASE at (800, 250) r30.
- **Patrol base**: (58, 300), west edge.
- Chart dressing: two irregular coastlines (north + south, ~17 vertices each), 2 small islands, 14 depth soundings ("27"–"61"), 4 radar range rings + 12 bearing spokes from coastal station STN-4 at (110, 486) with radii 95/185/290/405, compass rose (top-right), 20 NM scale bar (bottom-left), 4 sinusoidal bathymetric contour lines, 45-unit reference grid.

### The scripted scenario (5 rounds, 12 contacts)

`kind`: **real** = genuine threat (must be stopped) · **fake** = decoy/ghost signal (patrol finds nothing) · **neutral** = harmless fishing boat (patrol wasted if sent).
`dist` = rounds until a real threat reaches its zone. `conf` = signal-match %. `kn` = speed readout in knots. `arc` = curvature of its approach route.

| Rnd | Name | Pos | conf | kind | target (dist) | kn | Context line (shown on card) |
|---|---|---|---|---|---|---|---|
| 1 | ALPHA | 520,250 | 70 | real | water (2) | 11 | No ID signal, trying to stay hidden — heading straight for the WATER PLANT. |
| 1 | MIKE | 470,405 | 44 | neutral | — | 4.5 | Small boat broadcasting a normal ID. Looks like a local fishing boat. |
| 2 | BRAVO | 620,320 | **92** | fake | — | 0.3 | Broadcasting a strong 92% navy ID — but it's sitting still and going nowhere. |
| 2 | CHARLIE | 360,250 | 55 | real | water (2) | 7.5 | Weak signal, no ID — quietly moving toward the WATER PLANT. |
| 2 | ECHO | 650,350 | 50 | real | navy (3) | 5 | Signal keeps dropping in and out — slowly drifting toward the NAVY BASE. |
| 3 | DELTA | 300,300 | **95** | fake | — | 0 | Perfect 95% signal — but radar shows no actual ship there. It's a ghost. |
| 3 | FOXTROT | 470,410 | 38 | neutral | — | 0.8 | Normal ID, just drifting in place. Looks like a fishing boat. |
| 4 | HOTEL | 340,300 | 65 | real | water (**1**) | 14 | No ID, moving in fast — almost at the WATER PLANT. |
| 4 | GOLF | 600,330 | 60 | real | navy (2) | 9 | No signal, staying hidden — heading steadily for the NAVY BASE. |
| 4 | INDIA | 470,205 | **90** | fake | — | 0.2 | Blasting a strong 90% navy ID — but dead still. Loud bait. |
| 5 | JULIET | 300,320 | **95** | fake | — | 0.1 | Textbook 95% signal, but no actual ship under it. Another ghost. |
| 5 | LIMA | 500,400 | 42 | neutral | — | 4.2 | Normal ID, slow and steady. A fishing boat. |

**The arc of difficulty**: R1 teaches (one obvious threat). R2 is the core lesson — the loudest signal (92%) is bait while two quiet ones are real; you can't patrol both, so cue one forward. R3 pays off the cue and adds a pure ghost. R4 is peak pressure — two real threats, one patrol, plus loud bait; HOTEL arrives in 1 round so it *must* be hit now and GOLF *must* be deferred. R5 resolves the carried threat with two last distractors. **Every fake sits still (kn ≤ 0.3); every real threat moves.** That's the tell — motion over signal strength.

Per-round hint text (footer) walks the player through exactly this reasoning in plain language.

---

## 6. Resources & state

Per-round allowances (reset every round):
- **Patrol boat: 1** — the only way to stop a ship.
- **Re-scans (cues): 2** — sharper look *next* round.
- **Sat photos (verify): 1** — instant truth *this* round.

Game state: `{phase, round (1–5), score, patrol, cue, verify, subs[], ships[], fx[], sweepX, sweepOn, patrolAsset, engage, breached{}, selected}`. Phases: `intro → (sweep → act → resolve)×5 → end`.

Contact fields beyond the scenario data: `id, trk ('TRK-'+(4200+id*17)), sx/sy (spawn), dist0, creep, shown, verified, known, reimaged, action, resolved, persist, caught/wasted/reached` flags, and bezier control point `cpx/cpy`.

---

## 7. The round loop

### Phase A — SWEEP (~2.8 s)
- A vertical scan line sweeps left→right across the whole map at `W/2.6 ≈ 346 units/s` (band gradient trailing 80 px, dotted leading edge, glow).
- The satellite icon rides the top edge with a translucent sensor cone.
- Each contact is invisible until the line crosses its x — then it pops in with a ping sound and its card appears in the sidebar ("flagged").
- Big note: "SATELLITE SCANNING…". No actions possible.

### Phase B — ACT (untimed — player-paced)
- Primary button: **LOCK IN ROUND**.
- Player applies at most one action per contact (buttons disable once a contact has an action or the resource is spent).
- **Threat creep**: flagged real threats keep sailing during the decision window — `creep += dt × 0.014`, capped at 0.42 of the next route leg. Visible pressure, never a full leg.
- Patrol dispatch/engagement plays out live during this phase (see §9).

### Phase C — RESOLVE (instant on Lock In)
Order of operations:
1. Any in-flight patrol is fast-forwarded to its outcome (`snapPatrol`).
2. Per unresolved contact: `cue` → mark for re-image, persist; `watch` → persist; **no action** → if real+zoned: **it reaches its target** (−150, breach FX, facility catches fire), else it just clears.
3. Only persisted (cued/watched) contacts carry to the next round.
4. Note: "ROUND LOCKED IN" or "A THREAT GOT THROUGH". Button becomes **NEXT ROUND** (or **SEE RESULTS** after round 5).

### Round rollover (`nextRound`)
1. Restore resources (1/2/1).
2. For each carried contact: clear `action`; if `_reimage` → apply re-image (see Cue below); if real+zoned → `dist--`, reposition along route; **if `dist ≤ 0` → breach** (−150, boom+alarm, facility fire) — i.e. *watching a nearly-arrived threat still loses it*.
3. Spawn this round's scenario contacts (hidden until swept).
4. Start the sweep.

---

## 8. The five actions

| Action | Cost | Timing | Effect |
|---|---|---|---|
| **PATROL** | 1 boat | resolves this round (animated) | Boat chases the contact's live position, circles it, engages. Real → destroyed, **+100**. Fake → nothing there, **−75**. Neutral → boarding finds fishermen, **−75**. |
| **RE-SCAN** (cue) | 1 of 2 | next round | Contact persists; on rollover it's re-imaged: `known=true`; real → conf `min(97, conf+35)`; else conf `max(8, conf−45)`. Card shows RE-SCANNED; classification revealed. |
| **VERIFY** (sat photo) | 1 | instant | `known=true` immediately. conf → 97 (real) / 8 (fake) / ≤32 (neutral). Card verdict updates: CONFIRMED · REAL THREAT / FAKE · NO SHIP THERE / HARMLESS. |
| **WATCH** | free | defers | Contact persists to next round unchanged — but real threats advance (`dist--`). |
| **DISMISS** | free | instant | Removes the contact. Harmless/fake → **+25** "good call". Real → **−150** immediately, the worst mistake. |

Rules: one action per contact per round; `verify` doesn't consume the contact's action slot (it's a knowledge action — you can verify *then* patrol/dismiss); everything locks outside the ACT phase.

Hover tooltips (plain language, e.g. Watch: "Keep tracking it and decide next round. Free — but the ship keeps moving toward its target.").

---

## 9. Patrol behavior (the showpiece)

Dispatch → launch ring + splash FX at base, launch sound (filtered noise whoosh + low triangle).
- **Transit**: accelerates `v += W×0.9/s²` capped at `W/1.35 ≈ 667 units/s`; steers to the contact's live position; leaves a fading wake ribbon (last 18 points).
- **Engage** (within 24 units): circles the target at radius 30 (1.5 rad/s), duration by type:
  - **real → combat, 2.8 s**: tracer rounds every 0.16 s until 72% mark (bright segments racing to the target ± 8 units of scatter, gunfire sound ~55% of shots), then **explosion** (fireball, expanding shock ring, smoke puffs, camera shake in 3D) and the contact becomes a burnt wreck. +100.
  - **fake → ghost, 2.0 s**: searching… at 50% the signal "pops" — dissolving ring + scattering particles + eerie descending synth. −75.
  - **neutral → board, 2.2 s**: quiet boarding, then "JUST A FISHING BOAT". −75.
- **Return**: sails back to base, despawns.
- Locking the round mid-flight snap-resolves the engagement with the same outcome + FX.

---

## 10. Scoring

```
Stop a real threat        +100
Correct dismissal          +25
Patrol wasted (fake/neutral) −75
Real threat dismissed     −150
Threat reaches facility   −150   (breach; facility burns for the rest of the run)
```
Fixed comparison baselines on the end screen: **Autopilot −450** ("chases strongest signal"), **No Satellite −250** ("plain radar only"). Perfect play ≈ **+575** (5 threats stopped +500, 4–5 correct dismissals +75–100, no losses — resource-constrained slightly below theoretical max). You "win" (AREA HELD) if you beat both baselines, i.e. score ≥ −250… but the real bar is positive score.

Floating +/− score text rises off the map at every scoring event; big center-top note narrates each outcome in plain words.

---

## 11. Ambient world (non-game traffic)

10 friendly vessels with waypoint steering (no billiard bounces):
- **3 cargo ships** running an east–west shipping lane (y ≈ 212–262), speed 7–10, slow turn rate 0.25 rad/s, bounce between x=60 and x=840;
- **4 trawlers** loitering mid-water (speed 3.5–6, random waypoints ±60/±40);
- **3 skiffs** near shore (speed 9–14, ±80/±30).
Turn rate for non-cargo: 0.8 rad/s. Trails: last 14 positions. They're set dressing — the satellite never flags them.

---

## 12. Movement math (threat routes)

Real threats follow **quadratic bezier arcs** from spawn to their zone:
- Control point = midpoint + perpendicular offset scaled by `arc` (e.g. ALPHA `arc:.22` curves one way, CHARLIE `−.18` the other).
- Route progress `t = 1 − dist/dist0`, plus the intra-round `creep` interpolating toward the next leg's t.
- Heading = bezier tangent; the card shows it as a nautical bearing (`HDG 037°`), plus `UNDERWAY 11 KN · WATER PLANT 2 ROUNDS AWAY`.
- Non-zoned contacts sit at their spawn (fakes hold still — that's the tell) with card lines like "HOLDING POSITION · 0.3 KN".

---

## 13. Contact cards (sidebar anatomy)

```
NAME                              70
TRK-4217 · RE-SCANNED       SIGNAL %
Context sentence (plain language)…
▸ UNDERWAY 11 KN · HDG 214° · WATER PLANT 2 ROUNDS AWAY
[verdict banner if known/resolved]
[PATROL 1 LEFT][RE-SCAN 2 LEFT][VERIFY 1 LEFT][WATCH FREE][DISMISS CLEAR]
```
- Left edge color-codes state (amber unknown / red threat / gray cleared); selected card gets an accent border and a matching reticle on the map; clicking a boat on the map selects its card (3D: raycast, click = press without drag).
- Verdict banners: STOPPED · THREAT REMOVED / FAKE · PATROL BOAT WASTED / GOT THROUGH · REACHED TARGET / RE-SCAN · CLOSER LOOK NEXT ROUND / WATCHING · DECIDE LATER / CONFIRMED · REAL THREAT etc.
- Signal % is colored by knowledge: amber → red (real) or gray (cleared).

---

## 14. 2D renderer (canvas fallback)

Nautical chart aesthetic, all procedural:
- Layered radial sea gradient over near-black; grid / rings / depth / traffic / labels each toggleable via opsbar chips.
- Land: gradient-filled irregular polygons with glowing coast stroke; coast labels in spaced caps.
- Ship glyph: curved-bow hull path (quadratic curves), superstructure rect, deck line; length by type (fake 21 / real 16 / neutral 11, friendlies 8–34). Oriented to route tangent or heading.
- Contacts: pulsing ring (`1 + 0.35 sin(t·5 + x)`), dashed bezier route line to target, velocity leader, name + conf% label, action tag (RE-SCAN/WATCH) under the label.
- Zones: bracket-target corners + dashed outer range ring + tiny facility footprint; turns amber when a suspected-real inbound exists, red when breached.
- Sweep: bright leading edge with 8px shadowBlur glow, gradient band trailing, dotted ticks.
- FX (one-shot pool, `t += dt/life`, default life 0.87 s): verify = converging zoom brackets + scanline sweep; cue = amber sensor beam from satellite top + rotating partial arc; launch ring; tracers; boom (fireball + shockwave + 5 drifting smoke circles); breach (same ×1.6, red ring); ghostpop (dissolving ring + 8 radial particles); score floats (rise 30 px, fade quadratically).

## 15. 3D renderer (Three.js night scene)

- **Camera**: 42° perspective at (CX, 660, CZ+800); OrbitControls clamped — polar 0.22–1.16 rad, azimuth ±0.6 (north stays up), distance 380–1750, target clamped over the map. Left rotate / wheel dolly / right pan.
- **Lighting / post**: a procedural night environment is filtered through PMREM for roughness-aware PBR lighting. One texel-snapped moon key casts a tightly fitted PCF-soft shadow map. The chain is Render → GTAO (high only) → restrained bloom → low-mid night grade → SMAA → Output, with ACES exposure 1.18 and fog 1150–3200. Water, holograms, labels and additive FX are excluded from GTAO/shadow geometry.
- **Water**: a camera-following custom shader plane; 4-component Gerstner-ish sine wave field (`{k:0.030,a:1.8,s:1.5}` etc.) shared as a JS function so **everything afloat rides the same waves** (boats bob and tilt to the wave gradient, wakes hug the surface). Multi-scale distance-faded normals, broad broken moon sheen, higher-resolution coast distance foam, shallow tint and five capped facility/city reflection streaks add local detail without changing buoyancy.
- **Terrain / materials**: cached semantic PBR materials separate paint, bare metal, glass and concrete. Terrain adds deterministic world-space triplanar macro tint, micro-normal and roughness variation using coast distance, slope and elevation; the shoreline gets a localized dark/wet band. High tier can load one optional packed local detail texture, while a deterministic procedural CanvasTexture remains the default/failure fallback. Opaque surfaces no longer depend on a generic cyan emissive tint.
- **Sky**: camera-centered dome with layered non-quantized stars, faint cloud/noise modulation, a cleaner moon disc and restrained horizon haze. Cool hemisphere light + moon key + teal fill maintain readable midtones while bloom remains limited to real emitters.
- **Vessels**: procedural typed fleet from one extruded hull shape (3 beams: std/wide/fast) + box superstructures: attack craft (gun mount, sensor mast, dim stern light), trawler (warm lit wheelhouse, boom, red/green nav lights), coaster, cargo (3 colored container stacks, lit castle), skiff, patrol PB-1 (cyan trim rails, spinning radar bar, strobe, searchlight cone). Solid vessels cast/receive moon shadows and use a silhouette LOD at distance.
- **Contact rendering by knowledge state**: unknown = amber **hologram** of the *claimed* identity (additive ghost fill + glowing edges); revealed fake = pale-cyan hologram; confirmed real = solid attack craft; caught = blackened wreck. Under each: soft shadow blob, state ring, hidden selection ring, curved route line.
- **Wake ribbons**: 26-segment triangle-strip ribbons with custom shader, width flares 1.7→0.45 toward the tail, alpha `u^1.6`.
- **Facilities**: modeled water plant / navy base with pulsing status ring (accent → amber inbound → red breached); breach spawns a **persistent fire** (fire sprites + smoke + flickering light) for the rest of the run. Facilities cast/receive shadows and use a reduced distance LOD.
- **FX**: launch ring + water splash with ballistic droplets, tracer streaks, explosions with camera **shake impulse** (decays `×0.001^dt`, applied per-render then removed so orbit stays clean), ghost-pop, floating score sprites, cue beam, verify brackets.
- **Props**: lighthouse (rotating beam), radar station (spinning dish), wave-synchronized instanced buoys, batched city lights and instanced coast rocks.
- **Scale seam / quality**: construction routes through `RenderSpace` (`projection`, `extent`, `metersPerUnit`, `localOrigin`, `toLocal()`, stable sampling coordinates). Water/terrain shaders receive origin and physical extent as uniforms, sky/water follow the camera, and camera near/far planes tighten dynamically. `MAP3D.setQuality('high'|'balanced'|'low')`, `getQuality()` and `getRenderStats()` expose centralized presets; `?quality=` forces deterministic QA, `?assets=off` forces the procedural texture path, otherwise the renderer may demote one-way after sustained budget failure.
- Boats are clickable (raycast → select card). Pools and their ribbons reset and dispose when a new game starts (`G` identity change), while shared geometry/material caches remain bounded.

## 16. Sound (WebAudio synth, no files)

Master gain 0.16. Recipes:
- `ping` (contact flagged): two descending sine chirps 1180→880 / 1770→1320.
- `launch`: bandpass noise sweep 240→900 Hz + rising triangle 70→140.
- `gun`: 3× (noise burst @1500 Hz + square blip 190→70) spaced 55 ms.
- `boom`: 1.4 s noise 120→45 Hz + 58→26 sine sub + crack transient.
- `ghost`: descending saw 900→110 + sine 1350→160 + hissy noise sweep — eerie.
- `shutter` (verify): two clicks of high noise + square tick — camera shutter.
- `good`/`bad`: major two-note up / saw two-note down. `alarm`: 3 square beeps 640→470. `tick`: 940 Hz blip.

## 17. Platform dressing (the "enterprise" layer)

Every game event mirrors into the fake platform via `opsEvent(kind, payload)`:
- **Intel feed** entries (severity info/ok/warn/crit, source IMINT/OPS/SIGINT/…): sweeps, flags, dispatches, intercepts, verifies, breaches, mission start/end.
- **Audit log** rows (actor/role/action/target/result — errors flagged, e.g. DISMISS of a real threat logs `RESULT: ERROR`).
- **Alert banners** (top of main column, ACK to dismiss, auto-expire 8 s unless sticky): confirmed-threat and breach alerts are sticky crits.
- **Entity catalog** pre-seeded with every scenario track (UNCATALOGUED until flagged) + facilities + PB-1 + sensors KRONOS-9 / STN-4; status/class/risk update live (FLAGGED → INTERCEPTING → INTERCEPTED/FAKE/BREACH…).
- Ambient background events fire every 55–95 s (weather advisories, key rotations, fusion-queue degradations that self-recover) + drifting region-risk numbers and fake network stats — the world feels alive even when idle.
- Login screen exists (user/role picker, fake auth sequence with staged "VALIDATING CREDENTIALS… ACCESS GRANTED" lines) but the current build **auto-boots** straight into ops.
- UTC clock ticks 1 s; session timer in the status bar; keyboard: `1–6` switch views, `/` focuses search, Esc closes profile drawer.

## 18. Key constants (copy these exactly)

| Constant | Value |
|---|---|
| World | 900 × 560 |
| Rounds | 5 |
| Resources / round | patrol 1 · cue 2 · verify 1 |
| Sweep speed | W/2.6 per sec (~2.8 s crossing + 50 unit overshoot) |
| Patrol max speed / accel | W/1.35 · W×0.9 per s² |
| Engage radius / orbit | 24 · radius 30 @ 1.5 rad/s |
| Engage durations | combat 2.8 s · ghost 2.0 s · board 2.2 s |
| Tracer cadence | 0.16 s until 72% of combat |
| Threat creep | +0.014/s, cap 0.42 leg |
| Re-image deltas | real +35 (cap 97) · other −45 (floor 8) |
| Verify conf | 97 / 8 / ≤32 |
| Scores | +100 / +25 / −75 / −150 / −150 |
| Baselines | autopilot −450 · no-AI −250 |
| FX default life | 0.87 s (score 1.4–1.8, boom 1.5, breach 2.2) |
| Frame dt clamp | 50 ms · hidden-tab watchdog 250 ms interval, 400 ms threshold |
| Score count-up | ~24 steps @ 28 ms · bars ease 1.1 s |

## 19. Build order (if recreating from scratch)

1. Static shell + design tokens + one theme.
2. World data (zones, scenario table) + game state + round loop with instant phases.
3. The five actions + scoring + carry-over/persistence. **Playtest here — the triage tension must already work with rectangles.**
4. Sweep reveal + 2D chart + ship glyphs + patrol transit/engage.
5. Cards with live tags/verdicts, tooltips, hints, intro/end screens (comparison bars).
6. FX pool + synth sounds.
7. Platform dressing (feed/audit/entities/alerts) driven off one `opsEvent` switch.
8. Optional: 3D engine as a drop-in renderer reading the same state through a bridge object — never let it own game logic.

**Design invariants** (don't break these while reskinning): fakes never move; every real threat moves toward a named place; the loudest signal in rounds 2–5 is always bait; round 4 must be unwinnable without deferring one real threat; the player never detects anything themselves — the satellite flags, the human judges.
