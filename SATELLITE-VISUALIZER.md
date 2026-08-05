# Satellite Visualizer landing page

The new landing experience is `index.html`. It keeps the existing `dark-vessel-lite.html` simulation intact and links to it from **Skip Tutorial**.

## Run locally

Serve the repository over HTTP so browser modules and data files can load:

```sh
python3 -m http.server 4173
```

Then open `http://127.0.0.1:4173/`.

## Orbital data

- The page downloads a whole catalogue in a single request, trying sources in order: CelesTrak's active group (≈16,000 element sets, day-fresh, but its edge sometimes blocks clients it mistakes for bots) and then KeepTrack's CDN mirror (≈33,000 tracked objects including debris, never blocks, but staler elements). The debug dock's slider chooses how many are rendered (100 by default).
- `satellite.js` propagates each element set with SGP4 at the current UTC time. Latitude, longitude, and displayed altitude in the object tooltip come from that propagation.
- The element-set response is cached in `localStorage` for two hours. Positions continue updating locally between feed refreshes.
- `data/satellites-fallback.json` keeps the visualizer usable if the network is unavailable; the status line explicitly distinguishes cached elements from a current feed.
- Radial altitude is logarithmically exaggerated only in the rendering so LEO objects remain visible. Ground position and tooltip altitude are not altered.

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
