#!/usr/bin/env node
/* geo-build.mjs — offline geodata pipeline for the DARKVESSEL globe/Gulf upgrade.

   Reads Natural Earth GeoJSON from ./geodata/, projects the real Qatar coast into the
   sim's 900×560-unit frame (1 unit = METERS_PER_UNIT of real ocean), simplifies and
   quantizes every dataset, then splices one packed payload into dark-vessel-lite.html
   between the DVGEODATA markers. The sim never changes: the coastline is placed around
   the authored facility coordinates, never the other way round.

   Sources (downloaded once, kept in the repo — this script never fetches):
     geodata/ne_110m_land.geojson           https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson
     geodata/ne_10m_land.geojson            https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson
     geodata/ne_10m_minor_islands.geojson   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_minor_islands.geojson

   Usage:
     node geo-build.mjs               build + splice into dark-vessel-lite.html
     node geo-build.mjs --check       regenerate and byte-compare against the spliced payload (CI guard)
     node geo-build.mjs --calibrate   grid-search AO_ORIGIN / AO_BEARING candidates and print a report
     node geo-build.mjs --dry         build + report sizes, do not write the HTML                          */

import {readFileSync, writeFileSync} from 'node:fs';

/* ============================== tunables ============================== */

const CONFIG = {
  METERS_PER_UNIT: 250,              // the one declared binding: 1 sim unit = 250 m of real ocean
  ANCHOR_SIM: {x: 150, y: 430},      // the water plant — pinned to AO_ORIGIN by construction
  // Calibrated with --calibrate (2026-07, 2534 clean candidates): the water plant pins to
  // 25.90°N 51.59°E — Ras Laffan, which really does host Qatar's desalination capacity.
  // The peninsula fills the map's southwest; the sea box scores 407/408 water samples
  // (the shipped fictional bay scored 339/441). The patrol base has no real coast at
  // 250 m/u, so it becomes a small offshore forward-platform islet.
  AO_ORIGIN: {lat: 25.90, lon: 51.59},
  AO_BEARING: 52,                    // compass bearing (deg) that map-up (−y) points toward

  // dataset boxes and simplification tolerances
  GULF_BOX:  {lat0: 22.6, lat1: 30.6, lon0: 46.6, lon1: 57.8},   // theater clip (lat/lon)
  AO_BOX:    {lat0: 24.3, lat1: 27.0, lon0: 50.2, lon1: 53.0},   // AO source clip (lat/lon)
  THEATER_RECT: {x0: -5200, y0: -4600, x1: 6200, y1: 5000},      // theater clip (sim units)
  AO_RECT:      {x0: -520,  y0: -160,  x1: 1560, y1: 1180},      // AO clip incl. off-frame land skirt
  CHART_RECT:   {x0: 0, y0: 0, x1: 900, y1: 560},                // the 2D radar chart frame
  TOL_GLOBE_DEG2: 0.045,             // Visvalingam area threshold, squared degrees
  TOL_THEATER_U2: 340,               // sim units² (~ (26u)²/2 triangles → ~4-6 km detail)
  TOL_AO_FINE_U2: 1.6,               // keep everything the 10m source has (~0.3 km)
  TOL_AO_MEDIUM_U2: 34,              // cliff/relief/foam geometry budget (organic() adds character back)
  TOL_AO_COARSE_U2: 260,             // ~150-point ring budget for distance-field consumers
  MIN_RING_PTS: {globe: 5, theater: 5, ao: 6},
  MIN_RING_AREA: {globe_deg2: 0.35, theater_u2: 900, ao_u2: 120},

  // the three islands the sim demands (DVGEN keep-outs + the navy base), r in units.
  // Shapes are real islet outlines from ne_10m used as donors, scaled and translated.
  ISLETS: [
    {x: 800, y: 250, r: 46, donor: 0, name: 'navy'},     // navy base island (Halul flavor)
    {x: 236, y: 256, r: 34, donor: 1, name: 'keepA'},    // DVGEN keep-out (r40) — lighthouse islet
    {x: 715, y: 427, r: 28, donor: 2, name: 'keepB'},    // DVGEN keep-out (r34)
    {x: 58, y: 300, r: 14, donor: 3, name: 'patrol'},    // patrol-base forward platform
  ],

  HTML: new URL('./dark-vessel-lite.html', import.meta.url),
  B: '/* DVGEODATA:BEGIN */', E: '/* DVGEODATA:END */',
};

/* ============================ small geometry ============================ */

const D2R = Math.PI / 180;
const M_PER_DEG_LAT = 110574, M_PER_DEG_LON_EQ = 111320;

function makeProjection(origin, bearingDeg, M, anchorSim) {
  const cosLat = Math.cos(origin.lat * D2R);
  const b = bearingDeg * D2R;
  // map-up (−y) points at compass bearing B; map +x at B+90° (screen-clockwise from up).
  const ux = Math.sin(b + Math.PI / 2), uy = Math.cos(b + Math.PI / 2);   // ENU dir of +x
  const vx = Math.sin(b),               vy = Math.cos(b);                 // ENU dir of map-up
  return {
    toMap(lon, lat) {
      const e = (lon - origin.lon) * M_PER_DEG_LON_EQ * cosLat;
      const n = (lat - origin.lat) * M_PER_DEG_LAT;
      return {
        x: (e * ux + n * uy) / M + anchorSim.x,
        y: -(e * vx + n * vy) / M + anchorSim.y,
      };
    },
    toLatLon(x, y) {
      const px = (x - anchorSim.x) * M, py = -(y - anchorSim.y) * M;      // meters along +x / map-up
      const e = px * ux + py * vx, n = px * uy + py * vy;
      return {lon: origin.lon + e / (M_PER_DEG_LON_EQ * cosLat), lat: origin.lat + n / M_PER_DEG_LAT};
    },
  };
}

function ringArea(ring) {                       // signed, shoelace
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToRing(x, y, ring) {
  let best = Infinity;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % n];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    const px = ax + t * dx - x, py = ay + t * dy - y;
    best = Math.min(best, px * px + py * py);
  }
  return Math.sqrt(best);
}

/* Visvalingam–Whyatt: drop the vertex forming the smallest triangle until every
   remaining vertex's triangle exceeds its tolerance. Closed-ring aware. O(n²) — data
   is small. tol may be a number or a per-point function (adaptive simplification:
   fine detail where the camera lives, aggressive far away, ONE seamless ring). */
function simplifyRing(ring, tol) {
  const tolAt = typeof tol === 'function' ? tol : () => tol;
  const pts = ring.slice();
  const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  while (pts.length > 4) {
    let minR = Infinity, minI = -1;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const r = tri(a, b, c) / tolAt(b);
      if (r < minR) { minR = r; minI = i; }
    }
    if (minR >= 1) break;
    pts.splice(minI, 1);
  }
  return pts;
}

/* Sutherland–Hodgman clip of a closed ring to an axis-aligned rect.
   Vertices introduced by clipping land exactly ON the rect edges (the 2D chart needs that). */
function clipRing(ring, rect) {
  const edges = [
    (p) => p[0] >= rect.x0, (p) => p[0] <= rect.x1,
    (p) => p[1] >= rect.y0, (p) => p[1] <= rect.y1,
  ];
  const cross = [
    (a, b) => [rect.x0, a[1] + ((b[1] - a[1]) * (rect.x0 - a[0])) / (b[0] - a[0])],
    (a, b) => [rect.x1, a[1] + ((b[1] - a[1]) * (rect.x1 - a[0])) / (b[0] - a[0])],
    (a, b) => [a[0] + ((b[0] - a[0]) * (rect.y0 - a[1])) / (b[1] - a[1]), rect.y0],
    (a, b) => [a[0] + ((b[0] - a[0]) * (rect.y1 - a[1])) / (b[1] - a[1]), rect.y1],
  ];
  let out = ring;
  for (let e = 0; e < 4; e++) {
    const inp = out; out = [];
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i - 1 + inp.length) % inp.length];
      const curIn = edges[e](cur), prevIn = edges[e](prev);
      if (curIn) { if (!prevIn) out.push(cross[e](prev, cur)); out.push(cur); }
      else if (prevIn) out.push(cross[e](prev, cur));
    }
    if (!out.length) return [];
  }
  return out;
}

/* ============================ data loading ============================ */

const _ringCache = new Map();
function loadRings(file) {
  if (_ringCache.has(file)) return _ringCache.get(file);
  const gj = JSON.parse(readFileSync(new URL(`./geodata/${file}`, import.meta.url), 'utf8'));
  const rings = [];
  for (const f of gj.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates]
      : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    for (const poly of polys) if (poly.length) rings.push(poly[0]);   // outer rings only; holes are inland lakes
  }
  _ringCache.set(file, rings);
  return rings;
}

const ringTouches = (ring, box) =>
  ring.some(([lon, lat]) => lon >= box.lon0 && lon <= box.lon1 && lat >= box.lat0 && lat <= box.lat1);

/* =========================== payload packing =========================== */

function quantizeRings(rings, q) {
  const idx = [], vals = [];
  for (const r of rings) {
    idx.push(r.length);
    for (const [x, y] of r) {
      const qx = Math.round(x * q), qy = Math.round(y * q);
      if (qx < -32768 || qx > 32767 || qy < -32768 || qy > 32767)
        throw new Error(`int16 overflow at q=${q}: (${x.toFixed(1)},${y.toFixed(1)})`);
      vals.push(qx, qy);
    }
  }
  const buf = Buffer.from(new Int16Array(vals).buffer);
  return {q, idx, b64: buf.toString('base64')};
}

const packedBytes = (p) => Buffer.from(p.b64, 'base64').length;

/* ============================== pipeline ============================== */

function build(cfg, light = false) {
  const proj = makeProjection(cfg.AO_ORIGIN, cfg.AO_BEARING, cfg.METERS_PER_UNIT, cfg.ANCHOR_SIM);
  const toUnits = (ring) => ring.map(([lon, lat]) => { const p = proj.toMap(lon, lat); return [p.x, p.y]; });

  /* -- globe: 110m everything, lat/lon ×100 (skipped in calibration) ---- */
  const globeRings = light ? [] : loadRings('ne_110m_land.geojson')
    .map((r) => simplifyRing(r, cfg.TOL_GLOBE_DEG2))
    .filter((r) => r.length >= cfg.MIN_RING_PTS.globe && Math.abs(ringArea(r)) >= cfg.MIN_RING_AREA.globe_deg2);

  /* -- theater: 10m Gulf, sim units ×4 (skipped in calibration) ---------
     The Arabian mainland ring is EXCLUDED here: the AO mainland below spans the whole
     theater rect with adaptive detail, so Qatar/Saudi/UAE come from that one seamless
     ring and the theater set only carries the other landmasses (Iran, Bahrain, islands). */
  const land10 = loadRings('ne_10m_land.geojson');
  const theaterAll = light ? [] : land10
    .filter((r) => ringTouches(r, cfg.GULF_BOX))
    .map(toUnits)
    .map((r) => clipRing(r, cfg.THEATER_RECT))
    .map((r) => simplifyRing(r, cfg.TOL_THEATER_U2))
    .filter((r) => r.length >= cfg.MIN_RING_PTS.theater && Math.abs(ringArea(r)) >= cfg.MIN_RING_AREA.theater_u2);
  const arabiaProbe = proj.toMap(51.0, 24.8);      // deep inland Saudi — inside only the Arabian ring
  const theaterRings = theaterAll.filter((r) => !pointInRing(arabiaProbe.x, arabiaProbe.y, r));

  /* -- AO: 10m Qatar box in units, fine + coarse ------------------------
     The MAINLAND is clipped to the full theater rect and simplified adaptively (medium
     detail near the playable frame, aggressive far away) so the coast continues
     seamlessly to the horizon — no clip-edge slab wall at the AO boundary. Islets and
     small rings keep the tight AO clip. */
  const aoSource = land10.filter((r) => ringTouches(r, cfg.AO_BOX)).map(toUnits)
    .map((r) => clipRing(r, cfg.AO_RECT)).filter((r) => r.length >= 4);
  const nearFrame = ([x, y]) => x > cfg.AO_RECT.x0 && x < cfg.AO_RECT.x1 && y > cfg.AO_RECT.y0 && y < cfg.AO_RECT.y1;
  const adaptive = (tolNear, tolFar) => (p) => (nearFrame(p) ? tolNear : tolFar);
  const arabiaProbe0 = proj.toMap(51.0, 24.8);
  const mainlandTheater = light ? null : (() => {
    const src = land10.filter((r) => ringTouches(r, cfg.GULF_BOX)).map(toUnits)
      .map((r) => clipRing(r, cfg.THEATER_RECT))
      .find((r) => r.length >= 6 && pointInRing(arabiaProbe0.x, arabiaProbe0.y, r));
    return src || null;
  })();

  /* islets: real islet outlines from ne_10m_minor_islands used as shape donors —
     lon/lat normalized to local meters, ranked by compactness (facilities need a
     platform, not a sliver), scaled to the sim's islet radius and translated. */
  const donorRings = loadRings('ne_10m_minor_islands.geojson')
    .filter((r) => r.length >= 12)
    .sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)))
    .slice(0, 20)
    .map((r) => {
      const cy = r.reduce((s, p) => s + p[1], 0) / r.length;
      const k = Math.cos(cy * D2R);
      const cx = r.reduce((s, p) => s + p[0], 0) / r.length;
      const local = r.map(([lon, lat]) => [(lon - cx) * k, lat - cy]);   // centered, isotropic
      let maxR = 0;
      for (const [px, py] of local) maxR = Math.max(maxR, Math.hypot(px, py));
      const compact = Math.abs(ringArea(local)) / (Math.PI * maxR * maxR);
      return {local, maxR, compact};
    })
    .sort((a, b) => b.compact - a.compact);
  const isletRings = cfg.ISLETS.map((sp) => {
    const d = donorRings[sp.donor % donorRings.length];
    const s = sp.r / d.maxR;
    return d.local.map(([px, py]) => [sp.x + px * s, sp.y - py * s]);   // −lat → +y (map-down)
  });

  const aoMainland = aoSource
    .map((r) => simplifyRing(r, cfg.TOL_AO_FINE_U2))
    .filter((r) => r.length >= cfg.MIN_RING_PTS.ao && Math.abs(ringArea(r)) >= cfg.MIN_RING_AREA.ao_u2);
  const aoFine = [...aoMainland, ...isletRings.map((r) => simplifyRing(r, cfg.TOL_AO_FINE_U2))
    .filter((r) => r.length >= 5)];
  // area-adaptive tolerance so small islets survive coarsening (they must exist in the
  // distance fields that drive shore foam, shallows tint and terrain height); the
  // mainland member is the seamless theater-spanning ring when available
  const mainlandFine = aoFine.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a), aoFine[0]);
  const isletsMedium = aoFine.filter((r) => r !== mainlandFine)
    .map((r) => simplifyRing(r, Math.min(cfg.TOL_AO_MEDIUM_U2, Math.abs(ringArea(r)) / 20)))
    .filter((r) => r.length >= 5);
  const isletsCoarse = aoFine.filter((r) => r !== mainlandFine)
    .map((r) => simplifyRing(r, Math.min(cfg.TOL_AO_COARSE_U2, Math.abs(ringArea(r)) / 14)))
    .filter((r) => r.length >= 5);
  const aoMedium = [
    mainlandTheater ? simplifyRing(mainlandTheater, adaptive(cfg.TOL_AO_MEDIUM_U2, 2600))
                    : simplifyRing(mainlandFine, cfg.TOL_AO_MEDIUM_U2),
    ...isletsMedium];
  const aoCoarse = [
    mainlandTheater ? simplifyRing(mainlandTheater, adaptive(cfg.TOL_AO_COARSE_U2, 4200))
                    : simplifyRing(mainlandFine, cfg.TOL_AO_COARSE_U2),
    ...isletsCoarse];
  const ao2d = aoFine.map((r) => clipRing(r, cfg.CHART_RECT)).filter((r) => r.length >= 4);

  /* -- props: everything the renderers used to hardcode ------------------ */
  const mainland = aoFine.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a), aoFine[0]);
  const lh = cfg.ISLETS[1];                                   // lighthouse on the fairway keep-out islet

  // surf rocks: deterministic walk along the visible mainland coast, ≥70u apart, plus
  // one off each keep-out islet's seaward side
  const frame = cfg.CHART_RECT;
  const rocks = [];
  for (const [px, py] of mainland) {
    if (px < frame.x0 + 14 || px > frame.x1 - 14 || py < frame.y0 + 14 || py > frame.y1 - 6) continue;
    if (rocks.every(([rx, ry]) => Math.hypot(px - rx, py - ry) >= 70)) rocks.push([Math.round(px), Math.round(py)]);
    if (rocks.length >= 6) break;
  }
  rocks.push([cfg.ISLETS[1].x + 6, cfg.ISLETS[1].y + cfg.ISLETS[1].r + 6]);
  rocks.push([cfg.ISLETS[2].x - 8, cfg.ISLETS[2].y + cfg.ISLETS[2].r + 5]);

  const props = {
    lighthouse: {x: lh.x, y: lh.y},
    islets: cfg.ISLETS.map(({x, y, r, name}) => ({x, y, r, name})),
    // water-shader point "reflectors": [x, y, intensity, radius] facility + settlement lights
    reflectors: [[150, 430, 0.62, 18], [800, 250, 0.56, 20], [58, 300, 0.45, 14],
      [lh.x, lh.y, 0.48, 11], [120, 510, 0.24, 28]],
    // city-light boxes on verified land: Qatar coastal strip, two inland clusters
    // just south of the frame (read as glow over the shoulder), navy islet settlement
    towns: [
      {x0: 16, x1: 235, y0: 478, y1: 556, n: 110},
      {x0: 40, x1: 170, y0: 585, y1: 675, n: 36},
      {x0: 130, x1: 260, y0: 700, y1: 790, n: 30},
      {x0: 786, x1: 814, y0: 236, y1: 264, n: 26},
    ],
    // fairway buoys marking the approach into the water plant + one off the navy island
    buoys: [[368, 266, 1], [318, 308, 0], [268, 350, 1], [218, 392, 0], [744, 286, 0]],
    rocks,
  };

  // town boxes must sit on land (5×5 deterministic samples, ≥60% each)
  const allLand = (x, y) => aoFine.some((r) => pointInRing(x, y, r));
  for (const t of props.towns) {
    let hit = 0;
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++)
      if (allLand(t.x0 + ((t.x1 - t.x0) * (i + 0.5)) / 5, t.y0 + ((t.y1 - t.y0) * (j + 0.5)) / 5)) hit++;
    if (hit < 15) throw new Error(`town box ${JSON.stringify(t)} only ${hit}/25 samples on land`);
  }

  const nIslets = isletRings.length;
  const payload = {
    v: 1,
    M: cfg.METERS_PER_UNIT,
    origin: cfg.AO_ORIGIN,
    bearing: cfg.AO_BEARING,
    globe: quantizeRings(globeRings, 100),
    theater: quantizeRings(theaterRings, 4),
    ao: quantizeRings(aoFine, 8),
    aoMedium: quantizeRings(aoMedium, 4),   // spans the theater rect — q=4 keeps int16 range
    aoCoarse: quantizeRings(aoCoarse, 4),
    ao2d: quantizeRings(ao2d, 8),
    props,
  };
  return {payload, aoFine, aoMainland, aoMedium, aoCoarse, theaterRings, globeRings, mainland, proj, nIslets};
}

/* ============================== land tests ============================== */

function landTests(cfg, built) {
  const {aoFine} = built;
  const aoMainland = built.aoMainland || aoFine;
  const fails = [];
  const onLand = (x, y) => aoFine.some((r) => pointInRing(x, y, r));
  const onMainland = (x, y) => aoMainland.some((r) => pointInRing(x, y, r));
  const mainlandDist = (x, y) => Math.min(...aoMainland.map((r) => distToRing(x, y, r)));

  const BASE = {x: 58, y: 300}, STN = {x: 110, y: 486}, PLANT = cfg.ANCHOR_SIM;
  // Real Qatar has no coast up the map's west edge at 250 m/unit, so the patrol base is an
  // offshore forward-platform islet — the MAINLAND must leave clear water around it.
  if (onMainland(BASE.x, BASE.y) || mainlandDist(BASE.x, BASE.y) < 16)
    fails.push(`patrol base platform (${BASE.x},${BASE.y}) needs ≥16u of clear water off the mainland`);
  if (!onMainland(STN.x, STN.y)) fails.push(`radar station (${STN.x},${STN.y}) is not on land`);
  const pd = mainlandDist(PLANT.x, PLANT.y);
  // 10m source vertices sit 1-2 km apart, so "on the coast" means within ~3 km of the polyline
  if (!(onMainland(PLANT.x, PLANT.y) || pd <= 12)) fails.push(`water plant is ${pd.toFixed(1)}u from the coast (want on land or ≤12u)`);

  // DVGEN's sea box was never all-water: the shipped bay has land on 102/441 samples,
  // intruding up to 80u from the box edges (both flanks wrap north to y=150), and the
  // generator's rejection-retries have always coped (audit gate: attempts p99 ≤ 8).
  // The bar here is "strictly no worse": box interior (≥90u from every edge) fully
  // water, and total edge-fringe intrusion well under the incumbent's 102.
  const sea = {x0: 60, x1: 860, y0: 150, y1: 450};
  const islets = cfg.ISLETS;
  let wet = 0, tested = 0, fringeLand = 0;
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
    const x = sea.x0 + ((sea.x1 - sea.x0) * i) / 20, y = sea.y0 + ((sea.y1 - sea.y0) * j) / 20;
    if (islets.some((s) => Math.hypot(x - s.x, y - s.y) <= s.r + 12)) continue;
    tested++;
    if (!onLand(x, y)) { wet++; continue; }
    const depth = Math.min(x - sea.x0, sea.x1 - x, y - sea.y0, sea.y1 - y);
    if (depth >= 90) fails.push(`sea box INTERIOR sample (${x.toFixed(0)},${y.toFixed(0)}) is on land`);
    else if (++fringeLand > 40) fails.push(`sea box edge-fringe land exceeds budget (${fringeLand} samples; incumbent bay had 102)`);
  }

  // the peninsula must fill the frame's southwest: coast along the WESTERN half of the
  // south edge (the rest of the south is honest open Gulf — Qatar's north coast is only
  // ~40 km long at 250 m/u), plus solid land in the SW corner; open water across the north
  let southLand = 0;
  for (let x = 60; x <= 380; x += 40) if (onLand(x, 545)) southLand++;
  if (southLand < 5) fails.push(`south-west edge land coverage weak: ${southLand}/9 samples at y=545`);
  let swLand = 0;
  for (let x = 20; x <= 120; x += 50) for (let y = 480; y <= 550; y += 35) if (onLand(x, y)) swLand++;
  if (swLand < 6) fails.push(`SW corner not solidly land (${swLand}/9)`);
  for (let x = 60; x <= 860; x += 80) if (onLand(x, 60)) fails.push(`north strip has land at (${x},60)`);

  for (const s of islets) {
    const near = aoFine.filter((r) => r.some(([px, py]) => Math.hypot(px - s.x, py - s.y) <= s.r + 4));
    if (!near.length) fails.push(`islet ${s.name} missing near (${s.x},${s.y})`);
    for (const r of near) for (const [px, py] of r)
      if (Math.hypot(px - s.x, py - s.y) > s.r + 6 && Math.hypot(px - s.x, py - s.y) < 140)
        fails.push(`islet ${s.name} outline exceeds r=${s.r} cap`);
  }
  return {fails, wet, tested};
}

/* ============================== calibrate ============================== */

function calibrate(cfg) {
  console.log('grid-searching AO_ORIGIN / AO_BEARING …');
  const results = [];
  for (let lat = 25.55; lat <= 26.06; lat += 0.04)
    for (let lon = 51.25; lon <= 51.86; lon += 0.04)
      for (let brg = -40; brg <= 65; brg += 5) {
        const c = {...cfg, AO_ORIGIN: {lat: +lat.toFixed(2), lon: +lon.toFixed(2)}, AO_BEARING: brg};
        let t;
        try { t = landTests(c, build(c, true)); } catch { continue; }
        results.push({lat: c.AO_ORIGIN.lat, lon: c.AO_ORIGIN.lon, brg, fails: t.fails.length, wet: t.wet, tested: t.tested});
      }
  results.sort((a, b) => a.fails - b.fails || b.wet - a.wet);
  for (const r of results.slice(0, 14))
    console.log(`  lat ${r.lat} lon ${r.lon} brg ${r.brg} → ${r.fails} fails, sea ${r.wet}/${r.tested}`);
  const clean = results.filter((r) => r.fails === 0);
  console.log(clean.length ? `\n${clean.length} clean candidates — median: ${JSON.stringify(clean[Math.floor(clean.length / 2)])}` : '\nno clean candidate — widen the search or relax a test');
}

/* ================================ main ================================ */

export {CONFIG, build, landTests, makeProjection, loadRings, pointInRing, distToRing};
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (!isMain) { /* imported as a library — skip main */ } else {
const mode = process.argv[2] || '';
if (mode === '--calibrate') { calibrate(CONFIG); process.exit(0); }

const built = build(CONFIG);
const {payload} = built;
const t = landTests(CONFIG, built);

const sizes = Object.fromEntries(['globe', 'theater', 'ao', 'aoCoarse', 'ao2d'].map((k) => [k, packedBytes(payload[k])]));
const json = JSON.stringify(payload);
console.log('datasets:',
  Object.entries(sizes).map(([k, v]) => `${k} ${(v / 1024).toFixed(1)}KB`).join('  '),
  `| payload total ${(json.length / 1024).toFixed(1)}KB`);
console.log('rings:',
  `globe ${payload.globe.idx.length} theater ${payload.theater.idx.length}`,
  `ao ${payload.ao.idx.length} (${payload.ao.idx.reduce((a, b) => a + b, 0)} pts)`,
  `aoCoarse ${payload.aoCoarse.idx.length} (${payload.aoCoarse.idx.reduce((a, b) => a + b, 0)} pts)`);
console.log(`land tests: sea box ${t.wet}/${t.tested} water, ${t.fails.length} failure(s)`);
t.fails.slice(0, 12).forEach((f) => console.log('  ✗ ' + f));
if (t.fails.length) process.exit(1);

const block = `${CONFIG.B}
/* Generated by geo-build.mjs — DO NOT EDIT BY HAND. Real-world coastline data
   (Natural Earth, public domain) projected into the sim's 900×560-unit frame at
   ${CONFIG.METERS_PER_UNIT} m/unit, anchor ${CONFIG.AO_ORIGIN.lat}°N ${CONFIG.AO_ORIGIN.lon}°E, bearing ${CONFIG.AO_BEARING}°.
   Regenerate with: node geo-build.mjs */
window.DVGEODATA=${json};
${CONFIG.E}`;

const html = readFileSync(CONFIG.HTML, 'utf8');
const i0 = html.indexOf(CONFIG.B), i1 = html.indexOf(CONFIG.E);

if (mode === '--check') {
  if (i0 < 0 || i1 < 0) { console.error('CHECK FAIL: no DVGEODATA block in the HTML'); process.exit(1); }
  const current = html.slice(i0, i1 + CONFIG.E.length);
  if (current === block) console.log('CHECK PASS: spliced payload matches regeneration byte-for-byte');
  else { console.error('CHECK FAIL: payload drifted — rerun node geo-build.mjs'); process.exit(1); }
  process.exit(0);
}
if (mode === '--dry') process.exit(0);

let next;
if (i0 >= 0 && i1 >= 0) {
  next = html.slice(0, i0) + block + html.slice(i1 + CONFIG.E.length);
} else {
  // first run: give the payload its own classic <script> right before the main sim script
  const anchor = html.indexOf('<script>\n"use strict";');
  if (anchor < 0) { console.error('cannot find the sim <script> anchor for first-time insertion'); process.exit(1); }
  next = html.slice(0, anchor) + `<script id="dvgeodata">\n${block}\n</script>\n\n` + html.slice(anchor);
}
writeFileSync(CONFIG.HTML, next);
console.log(`spliced ${(block.length / 1024).toFixed(1)}KB into dark-vessel-lite.html ${i0 >= 0 ? '(replaced)' : '(inserted)'}`);
}
