# Satellite Visualizer landing page

The new landing experience is `index.html`. It keeps the existing `dark-vessel-lite.html` simulation intact and links to it from **Skip Tutorial**.

## Run locally

Serve the repository over HTTP so browser modules and data files can load:

```sh
python3 -m http.server 4173
```

Then open `http://127.0.0.1:4173/`.

## Orbital data

- The page downloads a whole catalogue in a single request, trying sources in order: KeepTrack's v4 API first (`api.keeptrack.space/v4/sats/brief`, ≈50,000 element sets refreshed hourly, day-fresh for active objects, country metadata in the same response, authenticated with a free key), then CelesTrak's active group directly (the freshest elements there are, but gp.php allows one download per group per IP every two hours and 403s the rest). The old KeepTrack static mirror was dropped after its elements measured ~5 months old. The debug dock's slider chooses how many are rendered (100 by default).
- `satellite.js` propagates each element set with SGP4 at the current UTC time. Latitude, longitude, and displayed altitude in the object tooltip come from that propagation.
- The element-set response is cached in `localStorage` for two hours, and the cache records which source filled it — the status line shows that source (`· CACHED`, or `· STALE` when every source failed and an expired cache was pressed back into service). Positions continue updating locally between feed refreshes, and a tab that stays open re-pulls the catalogue once its elements pass the TTL — on a five-minute check while visible, or immediately on return to a backgrounded tab.
- `data/satellites-fallback.json` keeps the visualizer usable if the network is unavailable. When a live catalogue lands it replaces the fallback's aged element sets in the pool, so the famous objects the fallback carries are propagated from current elements rather than the bundled snapshot.
- Radial altitude is logarithmically exaggerated only in the rendering so LEO objects remain visible. Ground position and tooltip altitude are not altered.

## Owner and status

- No element-set feed says who flies an object or whether it still answers, so CelesTrak's SATCAT bulk file (`/pub/satcat.csv`) is pulled separately — at most once a day, cached in `localStorage` as a compact on-orbit projection (~0.4 MB) — and joined by NORAD id at hover time. It supplies the owner code and the operational status (`OPS_STATUS_CODE`: `+` operational, `P` partial, `B` standby, `S` spare, `X` extended, `-` nonoperational, `D` decayed; blank for nearly all debris and rocket bodies, which therefore draw no status row).
- The hover card shows the owner's flag in its top-right corner (emoji, from ISO regions; joint programmes get two flags, multinationals like Intelsat get 🌐), spells the owner out on the origin line, and adds a Status row — green while active, rust once inactive.
- When SATCAT has no row (or its edge blocks the fetch), the KeepTrack mirror's own `country` column — captured during its catalogue parse — stands in for the flag. The mirror carries no operational status, so that row simply stays absent.
- Note the default CelesTrak catalogue is the *active* group, already filtered to working satellites; inactive ones appear when the KeepTrack mirror is the source (its ~33k objects include dead payloads and debris).

## Mission focus

- Every use case in the panel is anchored to a region of the globe (`region: { lat, lon, label }` in the `missions` object in `app.js`): Defence → Arabian Gulf (Qatar), Disaster Response → Western Pacific (Philippines), Infrastructure → North Sea corridor (Rotterdam), Insurance & Reinsurance → Atlantic hurricane basin (Miami), Agriculture → Mato Grosso belt (Brazil).
- Selecting a use case finds the satellite currently nearest that region (great-circle distance on the live ground track), slews the camera around the globe until it faces that spacecraft, then dollies in and re-centres on it.
- On lock the spacecraft tints mission green (instance colours, so the model stays legible), keeps a dimmed corona as an aura, and a pulsing targeting ring lands around it. The camera soft-follows the moving spacecraft.
- A focus card is projected beside the locked satellite with its name, NORAD id, altitude, region, and a placeholder **Enter** button. Exit via the card's ×, Escape, or by picking another use case (which re-slews directly).
- Changing the debug fleet size mid-focus re-anchors the highlight, or re-acquires the nearest spacecraft if the focused one leaves the render set. `prefers-reduced-motion` replaces the flight with a jump cut.

## Link network

Two layers of line are drawn between the moving objects, both solved as geometry rather than decorated on. The debug dock's **Link network** switch turns them off, and its **Links** readout reports the two counts separately.

- **Mesh (green).** The edge-compute overlay the page is selling: nodes hosted across the fleet, peering with whoever is in reach. A link needs both ends in the same shell (within 220 km of altitude), inside a 5,200 km optical terminal's range, and on a line that clears the atmosphere by 80 km. Each spacecraft carries two terminals, allocated a round at a time so everything acquires its nearest peer before anything acquires a second — that is what leaves chains through the shell instead of a few dense hubs. Debris is excluded.
- **Downlinks (cyan).** Real gateway and teleport sites, each working the two satellites highest above its own horizon, at 14° elevation or better and below 2,000 km. The sites are LEO tracking stations, so geostationary traffic is deliberately not drawn. A station marker brightens while it holds a pass.

Topology is re-solved every 3.6 s with hysteresis on the way out, so links hand over rather than chatter; endpoints are rewritten every frame, because the fleet glides between propagation ticks. Links fade in and out over 0.75 s. A packet runs down each one — switched off outright under `prefers-reduced-motion`, with the resting weight raised to compensate.

**Curved links** (on by default) chooses the shape. Straight is the chord between the terminals, which is the honest path for a beam and also the one that cuts down through the shell it spans; curved holds each segment at the radius its ends are flying at, so it rides over the globe the way the ground tracks do, and bows a little further out with length. Both are drawn from the same subdivided ribbon — the switch is a uniform, travelled over 0.5 s rather than cut.

Note that link density follows fleet density, and the horizon is usually the binding constraint: at 420 km altitude, line of sight runs out at about 4,240 km, well inside the terminal's range. A sparse fleet therefore has genuinely few closable links — at 100 satellites the mesh is nearly empty, which is correct rather than broken.

## Rendering

- Three.js handles the high-DPI WebGL scene and damped drag/zoom controls.
- All satellite markers share one `THREE.Points` geometry, so the moving objects stay a single draw call however many the slider selects.
- Natural Earth GeoJSON is converted in-browser to vector geometry: a shader-drawn dot grid (world-sized points) plus subdivided coastline segments, so the land stays crisp at mission-focus zoom instead of magnifying texels.
- Fourteen representative ground tracks are drawn to keep the orbital structure legible without turning the page into the full tracker UI.
- The link network is one instanced draw call. Each link is a quad expanded in the vertex shader into a screen-space ribbon: `THREE.Line` is a hairline on every desktop GL driver, which aliases into dashes at this density, and a ribbon also gives the fragment shader room for a soft edge and the packet travelling along it.
