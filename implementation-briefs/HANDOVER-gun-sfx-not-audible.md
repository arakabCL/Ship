# Handover — patrol gun sound effect not audible

**Branch:** `claude/sound-effects-integration-c3923d`
**File:** `dark-vessel-lite.html` (single-file app) + new `audio/` folder
**Status: RESOLVED.** The recommended fix below was applied: clips now decode into the same
AudioContext as the synth (`clipBus`, unity gain, alongside `master`) and play via
`AudioBufferSourceNode`; the `<audio>` element survives only as a `file://` / pre-decode
fallback. `prime()` is deleted. Verified with a destination-node tap during a real PATROL
click: gun audible for its full 3.36 s (−15.2 dB peak), countdown re-seeks across clock jumps
and stops at 0:00, breach plays, SFX chip silences everything. The rest of this document is
kept as the investigation record.

## The symptom

Click PATROL on a card. The boat transits, reaches the ship, and starts circling it. The circling
animation and tracers are visible, so the combat engagement is definitely running — but no gun
sound is heard. The user has confirmed this after the cache-busting fix below.

## What was built

Three recorded clips replace or supplement the existing oscillator synth. They play through plain
`HTMLAudioElement`s, not the Web Audio graph, so the page still has sound when opened off disk.

| Clip | Trigger | Source file |
|---|---|---|
| `audio/breach-facility.mp3` (5.15 s) | a threat reaches a facility | `3-Ship attacks facility.mp3`, untrimmed |
| `audio/patrol-gun.mp3` (3.36 s) | patrol boat firing | `4-When shooting enemy sound effect.mp3`, trimmed to 0.47–3.83 s |
| `audio/round-tick.mp3` (18.0 s) | last 18 s of the tasking window | `ticktimer.mp3`, first 18 s |

Key code, all in `dark-vessel-lite.html`:

- `2770` — start of the rewritten `SFX` module. Synth cues below `2845` are unchanged.
- `2793` — `CLIP_V`, appended as `?v=N` to every clip URL. Bump when replacing a file in `audio/`.
- `2795` — `clip(file, vol, pool)`: lazy `new Audio()` with a round-robin pool.
- `2782` — `fade(a, ms, v0)`: `setInterval` volume ramp, then pause + reset.
- `2814` — `prime()`: on the first `pointerdown`/`keydown`, plays each clip at volume 0 and pauses
  it in a `.then()`, to satisfy autoplay policy. **See suspect 2.**
- `2849`/`2850` — `gunStart()` / `gunStop()` (180 ms fade).
- `3131` — `SHOOT_FRAC = .72`. The boat fires for the first 72% of an engagement.
- `3135` — combat duration is derived from the clip: `SFX.gunSecs() / SHOOT_FRAC` = 4.67 s, so the
  3.36 s shooting phase exactly matches the clip and the boom lands as it ends.
- `4049` — `SFX.gunStart()` fires once when the combat branch of `stepPatrol` first runs.
- `4052` — `SFX.gunStop()` when the shot lands. `3141` stops it again in `engageResolve`.

## What was verified, and how

Not just "`play()` was called" — the browser's real output was measured.

1. **Served file is correct.** `fetch(..., {cache:'no-store'})` → `decodeAudioData` → RMS per 0.25 s
   window: −16 to −19 dB of gunfire from t=0 through 3.36 s, no dead air at either end.
2. **The real button path produces audible output.** Clicked the actual PATROL button on a card,
   with the gun element routed through `createMediaElementSource` → `AnalyserNode` → destination.
   During the engagement: 56 of 75 samples audible, −13.9 dB peak, sustained −15 to −23 dB across
   the full 3.36 s, silent exactly when `paused` flips true at the boom.
3. **Animation intact.** Boat rotates ~1.07 full circles; up to 10 live tracers throughout.
4. No console errors at any point.

So on that machine the chain works. The failure is environmental or a race that headless Chrome
did not hit.

## Ranked suspects

**1 — HTMLAudioElement path is dead on the user's browser, Web Audio is not.**
The synth cues (`ping`, `boom`, `good`, `bad`) go through `AudioContext`; the three clips go
through `<audio>` elements. These can route to different output devices or be blocked
independently, notably on Safari.

*Diagnostic that settles it:* ask whether they hear the **explosion at the end of the engagement**
(synth, Web Audio) and the **breach sound** when a threat reaches a facility (clip, HTMLAudio).
- explosion yes, breach no → HTMLAudioElement path is the problem. Go to the recommended fix.
- both no → SFX chip off, muted tab, or system output.
- both yes → the fault is specific to `gunStart()`; look at suspect 2.

**2 — `prime()` race pausing the clip mid-playback.** `prime()` at `2814` calls `a.play()` at
volume 0 and pauses the element inside `p.then()`. If that promise resolves late — cold cache,
slow disk, a browser that defers resolution until enough data is buffered — the `.then()` fires
*after* a legitimate `gunStart()` and calls `pause()` on a clip that is meant to be playing.
Headless Chrome on localhost resolves this in milliseconds, which is why it never reproduced.
Cheap to rule out: guard the `.then()` with `if(!primedDone) return;` style state, or drop
`prime()` entirely and see whether the sound returns.

**3 — Stale cache.** `audio/patrol-gun.mp3` was overwritten twice at the same URL while the user's
tab held it with `preload='auto'`. Addressed with `CLIP_V='3'` at `2793`, verified refetching as
`?v=3` at 51,246 bytes (the stale copy was 144,333). The user reports the problem persists after
this, so it is probably not the remaining cause — but confirm they are on a reloaded page and on
the current server port, not an older one.

**4 — Wrong contact type.** Guns only fire on `kind === 'real'`. A decoy engagement is `'ghost'`,
a neutral is `'board'` — neither has gunfire *or* tracers. The user reports seeing the circling,
which suggests a real combat engagement, so this is unlikely, but worth confirming.

## Recommended fix

Move the three clips onto the Web Audio graph instead of `HTMLAudioElement`: `fetch` →
`decodeAudioData` once at startup, then play via `AudioBufferSourceNode` through the existing
`master` gain node at `2815`-ish. That:

- puts clips and synth on one output path, so anything that works for the boom works for the gun;
- makes the SFX chip and master volume apply uniformly;
- removes `prime()`, the fade `setInterval`, and the element pool entirely — a `BufferSource` plus
  a `GainNode` ramp does all of it more precisely;
- kills suspects 1, 2 and 3 at once.

The only cost is that `file://` loses sound, because `fetch` of a local file is blocked. The
project is already served over `python3 -m http.server` via `.claude/launch.json`, so this is
likely acceptable — confirm with the user before committing to it.

`updateRoundTick()` at `4122` and the countdown's re-seek logic are independent of the transport
and should carry over unchanged.
