import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// The query string tracks satellite-model.js releases the same way index.html
// tracks app.js — bump it when the models change or long-lived tabs keep the
// old fleet.
import { createSatelliteFleet, classifySatellite, ARCHETYPE_LABELS } from './satellite-model.js?v=hifi-fleet-2';
import * as satellite from 'satellite.js';

const EARTH_RADIUS = 2.48;

// Real-world constants, used only to turn orbital elements into the figures the
// inspector shows — the scene itself works in the scaled radius above.
const EARTH_RADIUS_KM = 6378.137;
const GRAVITY_PARAMETER = 398600.4418; // km^3/s^2
// How far past its own apogee a propagated position may sit before the
// solution counts as diverged rather than merely perturbed. Across the full
// catalogue the two populations separate cleanly: objects still on a sane
// orbit top out around 1.15× — the widest belong to ancient deep-space debris,
// where the mean elements a TLE carries and the instantaneous radius SGP4
// returns drift furthest apart — while diverged ones start near 1.27× and run
// to 1e8×. Almost nothing sits between, so the exact cut matters little; it is
// biased low because dropping a real object costs one row in thirty thousand,
// and keeping a diverged one costs a spacecraft visibly tearing across the sky.
const DIVERGENCE_RATIO = 1.25;
// Below this separation two catalogue entries are not two spacecraft flying
// close, they are one structure counted twice. See collapseDockedGroups.
const DOCKED_SEPARATION_KM = .5;
// One instant, fixed at load, that every record is screened and compared at.
const REFERENCE_EPOCH = new Date();

// Whole-catalogue sources, tried in order until one answers — no paging
// anywhere. KeepTrack's v4 API leads: element sets refreshed hourly (measured
// median age ~2 days across all 50k records, day-fresh for active objects),
// the country column riding along in the same response, and a free key in
// place of CelesTrak's bot wall. CelesTrak direct is the fallback: its
// elements are the freshest there are, but gp.php allows one download per
// group per IP every two hours and 403s the rest — which a dev loop's
// reloads, or a second browser on the same network, trip constantly. The old
// KeepTrack static mirror (app.keeptrack.space/tle/tle.json) is gone from
// this list: its elements measured ~5 months old, so positions propagated
// from it moved convincingly and were fiction.
const KEEPTRACK_API_KEY = 'kt_fe1113623b3dcffc7f2e3db267d3562f'; // free tier: 500 req/h, 5k/day — a page load spends one
const CATALOG_SOURCES = [
  {
    label: 'LIVE DATA',
    url: 'https://api.keeptrack.space/v4/sats/brief',
    headers: { 'X-API-Key': KEEPTRACK_API_KEY },
    parse: (text) => JSON.parse(text).map((item) => {
      // The brief records carry heavy metadata (purpose, launch, dimensions);
      // the country column survives as join metadata for the hover card even
      // though only the element lines and name enter the pool.
      const id = Number(item.tle1?.slice(2, 7));
      if (Number.isFinite(id) && item.country) mirrorCountry.set(String(id), item.country);
      return { name: item.name, tle1: item.tle1, tle2: item.tle2 };
    }),
  },
  {
    label: 'CELESTRAK DIRECT',
    url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',
    parse: parseTleText,
  },
];
const CATALOG_TIMEOUT = 45000;
const MIN_SATELLITES = 10;
// SGP4 cadence. Display positions glide between ticks at constant velocity,
// so this only bounds how often the expensive maths runs — not motion
// smoothness, which is per-frame.
const PROPAGATION_INTERVAL = 850;
// Opening fleet size. The bundled fallback only holds 100 objects, so a cold
// start renders what it has and grows to this once the live catalogue lands.
const DEFAULT_SATELLITES = 1000;
// v5: the cache now records which source filled it, and the v4 caches — where
// stale mirror data could sit labelled as live — are left behind entirely.
const CACHE_KEY = 'satellite-visualizer:catalog:v5';
const CACHE_TTL = 2 * 60 * 60 * 1000;
// The full catalogue would flirt with the localStorage quota, so only its head
// is kept for instant cold starts; the recorded total still sizes the slider,
// and dragging past the cached head pulls the full set once.
const CACHE_MAX_ITEMS = 4000;

// Each mission is anchored to a patch of the globe. Selecting a use case finds
// the satellite currently nearest that point and flies the camera onto it, so
// the coordinates below are the one thing to edit when a mission moves region.
// `model` overrides the spacecraft that target is drawn as for as long as the
// lock holds: whichever object is over the Arabian Gulf at the time, Defence
// puts the viewer nose to nose with the hardware the use case is about. Any
// archetype key from satellite-model.js works; omit it to fly to the object as
// the catalogue has it.
const missions = {
  defence: {
    index: '01', title: 'Defence',
    region: { lat: 25.3, lon: 51.2, label: 'Arabian Gulf' },
    model: 'recon',
    description: 'Satellites already photograph vast stretches of ocean, but those images wait hours for analysis on the ground. <strong>With onboard AI, the satellite itself flags a suspicious ship the moment it appears.</strong> Security teams get the time to stop a threat, not just track it.'
  },
  disaster: {
    index: '02', title: 'Disaster Response',
    region: { lat: 12.9, lon: 121.8, label: 'Western Pacific' },
    description: 'After a storm or wildfire, rescue teams need to know which areas were hit and which roads are still open. <strong>Onboard AI maps the damage right on the satellite and delivers that picture in minutes instead of hours.</strong> In an emergency, that time saves lives.'
  },
  infrastructure: {
    index: '03', title: 'Infrastructure',
    region: { lat: 51.9, lon: 4.5, label: 'North Sea Corridor' },
    description: 'Pipelines, railways and ports stretch too far to inspect constantly on the ground. <strong>AI on the satellite compares every new image with the last one and reports only what has changed.</strong> Small problems get caught and repaired before they turn into costly outages.'
  },
  insurance: {
    index: '04', title: 'Insurance & Reinsurance',
    region: { lat: 25.8, lon: -80.2, label: 'Atlantic Hurricane Basin' },
    description: 'After a major storm, insurers often wait weeks for ground crews to confirm the damage. <strong>AI running on the satellite assesses damage as it flies over and delivers that answer within hours.</strong> Valid claims get paid sooner, and loss estimates stop being guesswork.'
  },
  agriculture: {
    index: '05', title: 'Agriculture',
    region: { lat: -12.5, lon: -55.7, label: 'Mato Grosso Belt' },
    description: 'Crop problems like water stress start small and are easy to miss across thousands of fields. <strong>Onboard AI checks the crops on every flyover and flags struggling fields as soon as signs appear.</strong> Farmers act days earlier, and the harvest is protected.'
  },
  telecom: {
    index: '06', title: 'Telecom & Connectivity',
    region: { lat: -1.2, lon: 21.5, label: 'Congo Basin' },
    model: 'comsat',
    description: 'Remote regions depend on satellites for a signal, but the traffic is normally routed down through a ground station before it goes anywhere. <strong>AI on the satellite handles that routing in orbit and shifts capacity to wherever demand is highest.</strong> Connections stay fast, and they hold when the ground network does not.'
  }
};

const canvas = document.querySelector('#globe-canvas');
const dataStatus = document.querySelector('#data-status');
const tooltip = document.querySelector('#satellite-tooltip');
const tooltipName = document.querySelector('#satellite-name');
const tooltipKind = document.querySelector('#satellite-kind');
const tooltipOrbit = document.querySelector('#satellite-orbit');
const tooltipAltitude = document.querySelector('#tip-altitude');
const tooltipSpeed = document.querySelector('#tip-speed');
const tooltipDetail = document.querySelector('#satellite-detail');
const tooltipOrigin = document.querySelector('#tip-origin');
const tooltipFlag = document.querySelector('#tip-flag');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Debug dock handles; the behaviour lives at the foot of this file, but the
// lookups sit here because the data layer reports into them from its first tick.
const debugDock = document.querySelector('#debug-dock');
const debugToggle = document.querySelector('#debug-toggle');
const debugPanel = document.querySelector('#debug-panel');
const debugSlider = document.querySelector('#debug-slider');
const debugCount = document.querySelector('#debug-count');
const debugMaxLabel = document.querySelector('#debug-max');
const debugPresets = document.querySelector('#debug-presets');
const debugGlow = document.querySelector('#debug-glow');
const debugLinks = document.querySelector('#debug-links');
const debugLinkCurve = document.querySelector('#debug-link-curve');
const debugNote = document.querySelector('#debug-note');
const debugRetry = document.querySelector('#debug-retry');
const debugFields = {
  rendered: document.querySelector('#debug-rendered'),
  pool: document.querySelector('#debug-pool'),
  catalog: document.querySelector('#debug-catalog'),
  links: document.querySelector('#debug-links-count'),
  fps: document.querySelector('#debug-fps'),
  propagate: document.querySelector('#debug-propagate'),
};

const useCaseShell = document.querySelector('#use-case-shell');
const useCaseTrigger = document.querySelector('#use-case-trigger');
const useCasePanel = document.querySelector('#use-case-panel');
const useCasePanelInner = useCasePanel.querySelector('.panel-inner');
const missionDetail = document.querySelector('#mission-detail');
let panelOpen = false;

// The panel always carries an explicit pixel height, so revealing the mission
// copy animates from the current box size instead of snapping open. On short
// viewports the height is capped to what is left below the panel and the
// overflow scrolls inside the box rather than running off screen.
const PANEL_BOTTOM_GAP = 30;

function syncPanelHeight(animate = true) {
  const content = useCasePanelInner.getBoundingClientRect().height;
  const budget = Math.max(200, innerHeight - useCasePanel.getBoundingClientRect().top - PANEL_BOTTOM_GAP);
  const target = panelOpen ? Math.min(content, budget) : 0;
  useCasePanel.classList.toggle('is-scrollable', panelOpen && target < content - 1);
  if (animate && !reducedMotion) {
    useCasePanel.style.height = `${target}px`;
    return;
  }
  useCasePanel.style.transition = 'none';
  useCasePanel.style.height = `${target}px`;
  useCasePanel.getBoundingClientRect();
  useCasePanel.style.transition = '';
}

function setPanelOpen(open) {
  if (panelOpen === open) return;
  panelOpen = open;
  useCaseShell.classList.toggle('is-open', open);
  useCaseTrigger.setAttribute('aria-expanded', String(open));
  useCasePanel.inert = !open;
  syncPanelHeight();
}

// CSS cannot interpolate from `max-content` to the open width, so the collapsed
// pill's natural size is measured and pinned as a pixel value it can animate
// out of. Re-measured once webfonts land, since they change the label's width.
function measurePillWidth() {
  if (panelOpen) return;
  useCaseShell.style.removeProperty('--pill-w');
  useCaseShell.style.setProperty('--pill-w', `${Math.ceil(useCaseShell.getBoundingClientRect().width)}px`);
}

useCasePanel.inert = true;
measurePillWidth();
document.fonts?.ready.then(measurePillWidth);
useCaseTrigger.addEventListener('click', () => setPanelOpen(!panelOpen));

document.addEventListener('pointerdown', (event) => {
  if (panelOpen && !useCaseShell.contains(event.target)) setPanelOpen(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !panelOpen) return;
  setPanelOpen(false);
  useCaseTrigger.focus();
});

addEventListener('resize', () => {
  // `max-width: 100%` clamps the pill, so a measurement taken while the tab was
  // hidden or the window was tiny pins a wrong width — re-take it while closed.
  measurePillWidth();
  syncPanelHeight(false);
});

// Catches reflows the resize event misses — breakpoint changes, font swaps,
// description copy wrapping to a different number of lines. Revealing the
// mission copy also lands here, in the same frame as the animated resize
// selectMission just asked for, so this correction has to animate too — a
// jump-to-target here would cancel that transition and snap the box open.
let lastContentHeight = 0;
new ResizeObserver(() => {
  const height = useCasePanelInner.getBoundingClientRect().height;
  if (Math.abs(height - lastContentHeight) < 1) return;
  lastContentHeight = height;
  if (panelOpen) syncPanelHeight();
}).observe(useCasePanelInner);

document.querySelectorAll('.use-case').forEach((button) => {
  button.addEventListener('click', () => selectMission(button.dataset.case, button));
});

const notice = document.querySelector('#notice');

function showNotice(message) {
  notice.textContent = message;
  notice.classList.add('is-visible');
  clearTimeout(notice.hideTimer);
  notice.hideTimer = setTimeout(() => notice.classList.remove('is-visible'), 2400);
}

document.querySelector('#start-tutorial').addEventListener('click', () => beginMissionEntry());

function selectMission(key, selectedButton) {
  const mission = missions[key];
  if (!mission) return;
  document.querySelectorAll('.use-case').forEach((button) => {
    const selected = button === selectedButton;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.querySelector('#mission-number').textContent = mission.index;
  document.querySelector('#mission-title').textContent = mission.title;
  document.querySelector('#mission-description').innerHTML = mission.description;
  document.querySelector('.mission-actions').hidden = key !== 'defence';
  missionDetail.hidden = false;
  missionDetail.classList.remove('is-changing');
  syncPanelHeight();
  requestAnimationFrame(() => missionDetail.classList.add('is-changing'));
  focusOnMission(key);
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.8));
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, .1, 80);
const globeRoot = new THREE.Group();
scene.add(globeRoot);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = .045;
controls.enablePan = false;
controls.minDistance = 4.6;
controls.maxDistance = 12.5;
controls.autoRotate = !reducedMotion;
controls.rotateSpeed = .42;
controls.zoomSpeed = .55;

// Where the opening shot sits in the zoom range: 0 is fully zoomed out at
// controls.maxDistance, 1 is fully zoomed in at controls.minDistance. A fifth
// of the way in keeps the wide establishing framing while pulling the globe
// close enough to read the fleet.
const START_ZOOM_FRACTION = .2;

// Idle drift: after the pointer has been off the globe for a beat, the display
// rotation eases back in rather than snapping to full speed.
const AUTO_ROTATE_SPEED = .22;
const RESUME_DELAY = 2000;
const RESUME_RAMP = 1.8; // seconds to reach full speed
let autoRotateRamp = reducedMotion ? 0 : 1;
controls.autoRotateSpeed = AUTO_ROTATE_SPEED * autoRotateRamp;

// The first framing pins the camera to the opening zoom; later ones (resize)
// keep wherever the viewer has orbited and zoomed to.
let sceneFramed = false;

let resumeRotationTimer;
controls.addEventListener('start', () => {
  controls.autoRotate = false;
  autoRotateRamp = 0;
  clearTimeout(resumeRotationTimer);
});
controls.addEventListener('end', () => {
  if (!reducedMotion) resumeRotationTimer = setTimeout(() => { controls.autoRotate = true; }, RESUME_DELAY);
});

scene.add(new THREE.HemisphereLight(0xdde9e5, 0x020302, .92));
const keyLight = new THREE.DirectionalLight(0xb9ccc6, .42);
keyLight.position.set(-4, 5, 6);
scene.add(keyLight);
const rimLight = new THREE.PointLight(0x22f0b4, 8.5, 19, 2);
rimLight.position.set(5, -1, -5);
scene.add(rimLight);

/* -------------------------------------------------------------------------
   Mission focus — flying the camera to the satellite over a mission's region

   Selecting a use case picks the satellite nearest that mission's patch of
   the globe, slews the view around until that satellite faces the camera,
   then closes in and locks on: the spacecraft tints green (its additive
   corona fades so the model stays legible), a targeting ring lands around
   it, and the focus card offers the placeholder mission entry. The camera
   keeps tracking the spacecraft while locked, since it never stops moving.
   ------------------------------------------------------------------------- */

const FOCUS_ALIGN_DISTANCE = 10.4; // slew radius while the globe turns to face the target
const FOCUS_LOCK_GAP = 1.32;       // camera-to-satellite distance once locked
const FOCUS_CAMERA_TILT = .3;      // along-track lean, so the lock is not a flat top-down view
const FOCUS_FOLLOW_RATE = 5;       // per-second catch-up while tracking the moving spacecraft
// How far out the reticle's marks sit as fractions of its sprite's half-width —
// 112 and 88 of 128 in makeFocusRingTexture. The focus card clears the outer
// ticks when the viewport has the room and the ring itself when it does not.
const FOCUS_CARD_RING_CLEAR = 112 / 128;
const FOCUS_CARD_MODEL_CLEAR = 88 / 128;
const FOCUS_CARD_GAP = 16;         // breathing room below whichever mark it clears
const FOCUS_TINT = new THREE.Color(0x2df2ae);
const INSTANCE_WHITE = new THREE.Color(0xffffff);

const focusState = {
  active: false,
  phase: 'idle', // align → approach → locked → exit
  key: null,
  record: null,
  index: -1,
  pendingKey: null,
  pendingAt: 0,
  phaseStart: 0,
  alignDuration: 0,
  approachDuration: 0,
  exitDuration: 0,
  alignFromDir: new THREE.Vector3(),
  alignFromDistance: 0,
  alignFromTarget: new THREE.Vector3(),
  returnDistance: 12.5,
  ringScale: .3,
  tint: 0,
  tintFrom: 0,
  exitFromTint: 0,
  // A mission switch hands the outgoing spacecraft's highlight to this fade so
  // it dims on its own clock while the camera is already flying to the next one.
  releaseRecord: null,
  releaseIndex: -1,
  releaseTint: 0,
  lockedAt: 0,
  lookTarget: new THREE.Vector3(),
  smoothCamera: new THREE.Vector3(),
  smoothTarget: new THREE.Vector3(),
  exitFromCamera: new THREE.Vector3(),
  exitFromTarget: new THREE.Vector3(),
  exitDir: new THREE.Vector3(),
};

// Scratch space for the per-frame focus solve.
const focusUp = new THREE.Vector3();
const focusWorld = new THREE.Vector3();
const focusDir = new THREE.Vector3();
const focusTangentVec = new THREE.Vector3();
const focusRadial = new THREE.Vector3();
const focusCameraTarget = new THREE.Vector3();
const focusCardEdge = new THREE.Vector3();
const focusSwing = new THREE.Quaternion();
const focusSwingEased = new THREE.Quaternion();
const FOCUS_QUAT_IDENTITY = new THREE.Quaternion();
const focusColor = new THREE.Color();

const focusRing = (() => {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeFocusRingTexture(),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
  }));
  sprite.visible = false;
  sprite.renderOrder = 8;
  globeRoot.add(sprite);
  return sprite;
})();

const focusCard = document.querySelector('#focus-card');
const focusMissionLabel = document.querySelector('#focus-mission');
const focusName = document.querySelector('#focus-name');
const focusMeta = document.querySelector('#focus-meta');
document.querySelector('#focus-close').addEventListener('click', () => exitFocus());
document.querySelector('#focus-enter').addEventListener('click', () => beginMissionEntry());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !panelOpen && focusState.active) exitFocus();
});

/* -------------------------------------------------------------------------
   Mission entry — the committed dive after Enter / Launch Simulation

   The chrome fades out first, then the camera accelerates past the locked
   spacecraft toward the ground beneath it while the frame fades to black,
   and the tutorial page takes over from the darkness.
   ------------------------------------------------------------------------- */

const TUTORIAL_URL = './dark-vessel-lite.html';
const blackout = document.querySelector('#blackout');
const experienceShell = document.querySelector('.experience');

const entryState = {
  active: false,
  start: 0,
  diveStarted: false,
  diveStart: 0,
  navigated: false,
  uiFade: .38,    // seconds of chrome fade before the dive begins
  duration: 1.15, // seconds of dive
  fromCamera: new THREE.Vector3(),
  fromTarget: new THREE.Vector3(),
  toCamera: new THREE.Vector3(),
  toTarget: new THREE.Vector3(),
};

function beginMissionEntry() {
  if (entryState.active) return;
  entryState.active = true;
  entryState.start = performance.now();
  entryState.diveStarted = false;
  entryState.navigated = false;
  experienceShell.classList.add('is-entering');
  controls.enabled = false;
  controls.autoRotate = false;
  clearTimeout(resumeRotationTimer);
  hideTooltip();
  // Reduced motion: no dive, straight to the destination behind a hard cut.
  if (reducedMotion) {
    entryState.navigated = true;
    blackout.style.opacity = '1';
    location.href = TUTORIAL_URL;
  }
}

function updateMissionEntry(now, deltaSeconds) {
  if (entryState.navigated) return;
  const sinceStart = (now - entryState.start) / 1000;
  if (!entryState.diveStarted) {
    // A locked focus keeps tracking while the chrome fades, so the dive
    // launches from a live framing rather than a frozen one.
    if (focusState.active) updateFocus(now, deltaSeconds);
    if (sinceStart < entryState.uiFade) return;
    entryState.diveStarted = true;
    entryState.diveStart = now;
    entryState.fromCamera.copy(camera.position);
    entryState.fromTarget.copy(focusState.active ? focusState.lookTarget : controls.target);
    // Dive down the local vertical: past the spacecraft, onto the ground
    // beneath it — or straight ahead if no focus ever engaged.
    const anchor = focusState.record
      ? focusDir.copy(focusState.record.position).normalize()
      : focusDir.copy(camera.position).sub(globeRoot.position).normalize();
    entryState.toCamera.copy(globeRoot.position).addScaledVector(anchor, EARTH_RADIUS + .22);
    entryState.toTarget.copy(globeRoot.position).addScaledVector(anchor, EARTH_RADIUS);
    return;
  }
  const p = Math.min(1, (now - entryState.diveStart) / (entryState.duration * 1000));
  // Accelerating ease: a gentle release into the plunge the blackout covers.
  const eased = p * p * (.35 + .65 * p);
  camera.position.lerpVectors(entryState.fromCamera, entryState.toCamera, eased);
  focusCameraTarget.lerpVectors(entryState.fromTarget, entryState.toTarget, eased);
  camera.lookAt(focusCameraTarget);
  focusRing.material.opacity = Math.max(0, focusRing.material.opacity - deltaSeconds * 5);
  blackout.style.opacity = String(THREE.MathUtils.smoothstep(p, .42, .96));
  if (p >= 1) {
    entryState.navigated = true;
    location.href = TUTORIAL_URL;
  }
}

// A glass shell rather than a solid ball: nearly clear where it faces the
// camera, gathering opacity toward the limb the way the edge of a smoked-glass
// sphere does, capped by a thin neutral silhouette line. Depth is still
// written, so orbits, coronas and stars behind the globe stay hidden — the
// see-through look comes from the far hemisphere's own layers, which draw
// just before this shell does.
const earth = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS, 128, 96),
  new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uBase: { value: new THREE.Color(0x0a1712) },
      uRim: { value: new THREE.Color(0x9debcf) },
      // Matches the old rim PointLight's bearing, so when the glow is enabled
      // the green gathers on one shoulder instead of ringing the globe.
      uGlowDir: { value: new THREE.Vector3(5.5, -.9, -5).normalize() },
      uGlow: { value: 0 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 uBase;
      uniform vec3 uRim;
      uniform vec3 uGlowDir;
      uniform float uGlow;
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec3 nrm = normalize(vNormal);
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float facing = clamp(dot(nrm, viewDir), 0.0, 1.0);
        // With the glow off the limb only densifies, capped by the thin
        // neutral line right at the silhouette that sells the glass. Enabling
        // it adds green where the rim light reaches, leaving a dark far limb.
        float fresnel = pow(1.0 - facing, 3.4);
        float edge = pow(1.0 - facing, 7.0);
        float lit = .1 + .9 * pow(clamp(dot(nrm, uGlowDir), 0.0, 1.0), 1.6);
        vec3 color = uBase + uRim * fresnel * .7 * lit * uGlow + vec3(.92, 1.0, .96) * edge * .4;
        float alpha = mix(0.42, 0.72, fresnel) + edge * .2;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  })
);
earth.renderOrder = 2;
globeRoot.add(earth);

// Depth write off: the far hemisphere's layers sit outside this shell and
// still have to draw over it.
const innerGlow = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS * .992, 96, 64),
  new THREE.MeshBasicMaterial({ color: 0x06110e, transparent: true, opacity: .42, side: THREE.BackSide, depthWrite: false })
);
globeRoot.add(innerGlow);

const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS * 1.025, 96, 64),
  new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vNormal; varying vec3 vWorld; void main(){ vNormal=normalize(normalMatrix*normal); vec4 w=modelMatrix*vec4(position,1.0); vWorld=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `varying vec3 vNormal; varying vec3 vWorld; void main(){ vec3 viewDir=normalize(cameraPosition-vWorld); float rim=pow(1.0-abs(dot(vNormal,viewDir)),3.3); gl_FragColor=vec4(vec3(.12,.92,.68)*rim, rim*.23); }`
  })
);
// Off by default; the debug dock's "green glow" switch turns the halo on
// together with the glass shader's directional rim term.
atmosphere.visible = false;
globeRoot.add(atmosphere);

function setGreenGlow(on) {
  atmosphere.visible = on;
  earth.material.uniforms.uGlow.value = on ? 1 : 0;
}

addReferenceGrid();
const starfield = addStarfield();
const shootingStars = addShootingStars();
let landLayer = null;

let satellitePoints = null;
let satelliteRecords = [];
// Raw element sets in catalog order, deduped by NORAD id. The rendered set is
// always a prefix of this pool, so changing the count is a slice plus a rebuild
// rather than another trip to the network.
let elementPool = [];
const poolKeys = new Map(); // elementKey → index into elementPool, so live batches can replace aged entries in place
// Parsed records are memoised per object: rebuilding them on every slider tick
// would re-roll each spacecraft's attitude jitter and make the fleet twitch.
const recordCache = new Map();
let catalogTotal = 0;
// The standing ask ("show me this many") versus what the loaded pool can
// currently satisfy. Keeping them apart means an opening request larger than
// the bundled fallback survives the cold start and is honoured in full once
// the live catalogue arrives, instead of being clamped away for good.
let requestedSatellites = DEFAULT_SATELLITES;
let satelliteTarget = DEFAULT_SATELLITES;
let sourceLabel = 'CACHED ORBITS';
let fetchState = 'idle';
// When the pool last received a live (or cached-live) catalogue. Elements age
// even while a tab stays open, so the refresh check below compares this
// against the cache TTL rather than fetching once per page load and stopping.
let lastCatalogAt = 0;
let lastPropagationMs = 0;
let orbitGroup = new THREE.Group();
let hoveredSatellite = -1;
// The satellite whose card is on screen, and whether that card is still on
// screen — it outlives the index by one fade.
let tooltipIndex = -1;
let tooltipShown = false;
let tooltipHideTimer = 0;
// The card's own size, measured when its contents or the viewport change rather
// than on every frame it follows its satellite across the screen.
let tooltipBox = null;
// The satellite the cursor is currently acquiring, when it arrived, and where
// the cursor stood at that moment.
let hoverTarget = -1;
let hoverSince = 0;
// When the open card's satellite stopped being the cursor's target, and whether
// the cursor was standing still when that happened.
let hoverLostAt = 0;
let lostWhileParked = false;
let pointerDown = false;
let lastMoveAt = 0;
// Pointing at a satellite is the whole gesture. The card lands a fifth of a
// second later whether or not the cursor has come to a stop, which is what
// makes the fleet feel like it answers the pointer.
const HOVER_DWELL_MS = 200;
// Sliding from one satellite to the next with a card already open.
const HOVER_RETARGET_MS = 110;
// A dot drifting a pixel off a standing cursor should not tear the card away —
// leaving the satellite for real should, and does so without waiting.
const HOVER_GRACE_MS = 120;
// How long a card stays up once the cursor is on some other satellite. Long
// enough for a deliberate slide to a neighbour to be settled and taken over,
// short enough that sweeping across a cluster puts the card down.
const HOVER_HANDOVER_MS = 180;
// Past this the cursor counts as parked, and keeps the card it earned even as
// the fleet drifts across it.
const HOVER_STILL_MS = 70;
// How far the cursor may wander and still count as pointing at the same place.
// Two overlapping dots trading the raycast under a near-still cursor stay one
// gesture; travel beyond this is a sweep, and starts the acquisition over.
const HOVER_SLACK_PX = 14;
// Matches the card's fade-out in the stylesheet, which is quicker than its
// fade-in — arriving is earned, leaving is not.
const TOOLTIP_FADE_MS = 90;
let lastPropagation = 0;
let lastOrbitBuild = 0;
const pointer = new THREE.Vector2(9, 9);
// Where the cursor stood when the current acquisition started.
const hoverAnchor = new THREE.Vector2(9, 9);
// Scratch space for the per-frame occlusion test in behindGlobe, and for
// projecting the open card's satellite to the screen.
const hoverCamera = new THREE.Vector3();
const hoverSegment = new THREE.Vector3();
const tooltipAnchor = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = .14;
globeRoot.add(orbitGroup);

const dotTexture = makeGlowTexture();
// Owns one instanced mesh per spacecraft archetype; classifies each record from
// its name and orbit, so a Starlink flat-pack and a GEO comsat do not read as
// the same object.
const satelliteFleet = createSatelliteFleet(renderer);
globeRoot.add(satelliteFleet.object3d);

// Scratch objects for the per-frame attitude solve — a hundred spacecraft times
// several vectors each is not worth allocating every propagation tick.
const scratchUp = new THREE.Vector3();
const scratchForward = new THREE.Vector3();
const scratchSide = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchMatrix = new THREE.Matrix4();
const scratchQuaternion = new THREE.Quaternion();
const FALLBACK_HEADING = new THREE.Vector3(0, 1, 0);

let previousFrame = performance.now();

// Started at the very bottom of the module. Scene objects are built where they
// are described rather than in one block up here, so the entry point has to run
// after the last of those declarations has been evaluated.
async function boot() {
  positionScene();
  const [landResult, fallbackResult] = await Promise.allSettled([
    fetch('./geodata/ne_110m_land.geojson').then(assertOkay).then((r) => r.json()),
    fetch('./data/satellites-fallback.json').then(assertOkay).then((r) => r.json())
  ]);

  if (landResult.status === 'fulfilled') addLandLayer(landResult.value);

  const cached = readCache();
  if (cached?.items?.length && Date.now() - cached.savedAt < CACHE_TTL) {
    catalogTotal = cached.catalogTotal || 0;
    addToPool(cached.items);
    // The label says where the cache came from, not merely that one exists —
    // a fallback-sourced cache must never dress up as the live feed. The
    // cache's own age also seeds the refresh clock, so a session that opened
    // on cached elements still refetches when they pass the TTL.
    lastCatalogAt = cached.savedAt;
    applySatelliteCount(`${cached.label} · CACHED`);
  } else if (fallbackResult.status === 'fulfilled') {
    addToPool(fallbackResult.value);
    applySatelliteCount('CACHED ORBITS');
  }

  initDebugPanel();
  renderer.setAnimationLoop(render);
  loadLiveSatellites();
  loadSatcat();
}

async function loadLiveSatellites(force = false) {
  if (fetchState === 'loading') return;
  // A fresh cache already sized the slider; the full set is only pulled again
  // once something actually asks for more objects than the cache kept.
  if (!force && sourceLabel.endsWith('· CACHED') && catalogTotal) return;
  dataStatus.textContent = satelliteRecords.length ? 'Cached orbits · refreshing' : 'Connecting to live data';
  fetchState = 'loading';
  syncDebugReadout();
  for (const source of CATALOG_SOURCES) {
    try {
      const items = source.parse(await fetchCatalog(source)).filter(isValidElementSet);
      if (!items.length) throw new Error('Catalogue response held no element sets');
      catalogTotal = items.length;
      addToPool(items, true);
      fetchState = 'idle';
      lastCatalogAt = Date.now();
      writeCache(source.label);
      applySatelliteCount(source.label);
      syncDebugReadout();
      return;
    } catch (error) {
      console.warn(`[satellites] Catalogue source failed (${source.label})`, error);
    }
  }
  fetchState = 'offline';
  // Every source failed. An expired cache is still hours-to-days fresher than
  // the bundled fallback, so it re-enters the pool before the page settles for
  // the hundred objects shipped in the file — labelled stale, because it is.
  const expired = readCache();
  if (expired?.items?.length && elementPool.length < expired.items.length) {
    catalogTotal = expired.catalogTotal || 0;
    addToPool(expired.items);
    applySatelliteCount(`${expired.label} · STALE`);
  }
  dataStatus.textContent = satelliteRecords.length ? 'Cached elements · live propagation' : 'Orbital data unavailable';
  syncDebugReadout();
}

// A tab left open across a working day would otherwise keep propagating from
// the elements it booted with. Once the last catalogue passes the cache TTL,
// the next visible five-minute tick — or the return to a backgrounded tab —
// pulls a fresh one. Failed attempts leave lastCatalogAt untouched, so an
// offline page keeps retrying at the same gentle cadence until a source answers.
function refreshCatalogIfStale() {
  if (document.hidden || fetchState === 'loading') return;
  if (Date.now() - lastCatalogAt < CACHE_TTL) return;
  loadLiveSatellites(true);
}
setInterval(refreshCatalogIfStale, 5 * 60 * 1000);
document.addEventListener('visibilitychange', refreshCatalogIfStale);

async function fetchCatalog(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT);
  try {
    const response = await fetch(source.url, { signal: controller.signal, cache: 'no-store', headers: source.headers });
    return await assertOkay(response).text();
  } finally {
    clearTimeout(timer);
  }
}

// CelesTrak's 3LE text: an optional name line sitting above each `1 …`/`2 …`
// pair. Pairs are matched directly so a missing or blank name line never
// derails the objects that follow it.
function parseTleText(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const items = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].startsWith('1 ') || !lines[i + 1].startsWith('2 ')) continue;
    const previous = i ? lines[i - 1] : '';
    const name = previous.startsWith('1 ') || previous.startsWith('2 ') ? '' : previous.trim();
    items.push({ name, line1: lines[i], line2: lines[i + 1] });
    i++;
  }
  return items;
}

function assertOkay(response) {
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response;
}

/* =================== owner + status metadata =================== */
// No element-set feed says who flies an object or whether it still answers —
// a TLE is a name and two lines of orbit. CelesTrak's separate SATCAT bulk
// file carries both, keyed by NORAD id, so it is pulled at most once a day,
// projected down to the joined columns, and consulted at hover time.
const SATCAT_URL = 'https://celestrak.org/pub/satcat.csv';
const SATCAT_CACHE_KEY = 'satellite-visualizer:satcat:v1';
const SATCAT_TTL = 24 * 60 * 60 * 1000;
// NORAD id → { owner: SATCAT owner code, status: OPS_STATUS_CODE character }.
const satcatIndex = new Map();
// NORAD id → the KeepTrack mirror's country column, kept as the fallback for
// ids SATCAT has no row for, or for sessions where its edge blocks the fetch.
const mirrorCountry = new Map();

// SATCAT's OPS_STATUS_CODE legend. Blank means status untracked — true of
// nearly all debris and rocket bodies — and draws no row at all; a wrong
// "unknown" on every fragment would just be noise.
const OPS_STATUS = {
  '+': { label: 'Active', tone: 'tip-status-on' },
  'P': { label: 'Partially active', tone: 'tip-status-on' },
  'X': { label: 'Extended mission', tone: 'tip-status-on' },
  'B': { label: 'Standby', tone: '' },
  'S': { label: 'Spare', tone: '' },
  '-': { label: 'Inactive', tone: 'tip-status-off' },
  'D': { label: 'Decayed', tone: 'tip-status-off' },
};

// SATCAT owner codes → ISO regions ('US', or 'CN BR' for a joint programme) or
// named multinationals (no honest national flag; the card shows 🌐). Country
// display names come from Intl.DisplayNames, so only the exceptions carry one
// here. TBD and UNK are deliberately absent: no flag beats a wrong flag.
const SATCAT_OWNERS = {
  AB: { name: 'Arabsat' }, ABS: { name: 'Asia Broadcast Satellite' }, AC: { name: 'AsiaSat' },
  ALG: 'DZ', ANG: 'AO', ARGN: 'AR', ARM: 'AM', ASRA: 'AT', AUS: 'AU', AZER: 'AZ',
  BEL: 'BE', BELA: 'BY', BERM: 'BM', BGD: 'BD', BHR: 'BH', BHUT: 'BT', BOL: 'BO',
  BRAZ: 'BR', BUL: 'BG', BWA: 'BW', CA: 'CA', CHBZ: 'CN BR', CHTU: 'CN TR', CHLE: 'CL',
  CIS: { iso: 'RU', name: 'Russia (CIS)' }, COL: 'CO', CRI: 'CR', CZCH: 'CZ',
  DEN: 'DK', DJI: 'DJ', ECU: 'EC', EGYP: 'EG',
  ESA: { iso: 'EU', name: 'European Space Agency' }, ESRO: { iso: 'EU', name: 'ESRO' },
  EST: 'EE', ETH: 'ET', EUME: { iso: 'EU', name: 'EUMETSAT' }, EUTE: { name: 'Eutelsat' },
  FGER: 'FR DE', FIN: 'FI', FR: 'FR', FRIT: 'FR IT', GER: 'DE', GHA: 'GH',
  GLOB: { name: 'Globalstar' }, GREC: 'GR', GRSA: 'GR SA', GUAT: 'GT', HRV: 'HR',
  HUN: 'HU', IM: { name: 'Inmarsat' }, IND: 'IN', INDO: 'ID', IRAN: 'IR', IRAQ: 'IQ',
  IRID: { name: 'Iridium' }, IRL: 'IE', ISRA: 'IL', ISS: { name: 'ISS partnership' },
  IT: 'IT', ITSO: { name: 'Intelsat' }, JOR: 'JO', JPN: 'JP', KAZ: 'KZ', KEN: 'KE',
  KWT: 'KW', LAOS: 'LA', LKA: 'LK', LTU: 'LT', LUXE: 'LU', MA: 'MA', MALA: 'MY',
  MCO: 'MC', MDA: 'MD', MEX: 'MX', MMR: 'MM', MNE: 'ME', MNG: 'MN', MUS: 'MU',
  NATO: { name: 'NATO' }, NETH: 'NL', NICO: { name: 'New ICO' }, NIG: 'NG', NKOR: 'KP',
  NOR: 'NO', NPL: 'NP', NZ: 'NZ', O3B: { name: 'O3b Networks' }, ORB: { name: 'ORBCOMM' },
  PAKI: 'PK', PERU: 'PE', POL: 'PL', POR: 'PT', PRC: 'CN', PRES: 'CN EU', PRY: 'PY',
  QAT: 'QA', RASC: { name: 'RascomStar-QAF' }, ROC: 'TW', ROM: 'RO', RP: 'PH',
  RWA: 'RW', SAFR: 'ZA', SAUD: 'SA', SDN: 'SD', SEAL: { name: 'Sea Launch' },
  SEN: 'SN', SES: { name: 'SES' }, SGJP: 'SG JP', SING: 'SG', SKOR: 'KR', SLB: 'SB',
  SPN: 'ES', STCT: 'SG TW', SVK: 'SK', SVN: 'SI', SWED: 'SE', SWTZ: 'CH', THAI: 'TH',
  TMMC: 'TM MC', TUN: 'TN', TURK: 'TR', UAE: 'AE', UGA: 'UG', UK: 'GB', UKR: 'UA',
  URY: 'UY', US: 'US', USBZ: 'US BR', VAT: 'VA', VENZ: 'VE', VTNM: 'VN', ZWE: 'ZW',
};

// The mirror's country column mixes ISO codes with vehicle-plate letters and
// I-prefixed organisations. Two clean uppercase letters pass straight through
// as ISO; everything else resolves here or not at all.
const MIRROR_COUNTRIES = {
  SU: { iso: 'RU', name: 'Soviet Union' }, UK: 'GB', F: 'FR', J: 'JP', D: 'DE',
  I: 'IT', L: 'LU', E: 'ES', N: 'NO', S: 'SE', B: 'BE', P: 'PT', T: 'TH',
  UAE: 'AE', CYM: 'KY', France: 'FR', HKUK: 'HK GB',
  'I-ESA': { iso: 'EU', name: 'European Space Agency' },
  'I-EU': { iso: 'EU', name: 'Europe' }, 'I-EUM': { iso: 'EU', name: 'EUMETSAT' },
  'I-EUT': { name: 'Eutelsat' }, 'I-INT': { name: 'Intelsat' },
  'I-INM': { name: 'Inmarsat' }, 'I-ARAB': { name: 'Arabsat' },
  'I-NATO': { name: 'NATO' },
};

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

// 'US' → 🇺🇸 by the regional-indicator offset; works for any ISO region
// including EU. Joint programmes get both flags side by side.
function flagEmoji(iso) {
  return [...iso].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join('');
}

// One owner spec — an ISO string, a named organisation, or nothing — folded to
// what the card draws: a flag for the corner and a label for the origin line.
function ownerBadge(spec) {
  if (!spec) return null;
  if (typeof spec === 'string') spec = { iso: spec };
  const regions = spec.iso ? spec.iso.split(' ') : [];
  let label = spec.name;
  if (!label && regions.length) {
    try { label = regions.map((code) => regionNames.of(code)).join(' / '); }
    catch { label = spec.iso; }
  }
  return { label: label || null, flag: regions.length ? regions.map(flagEmoji).join(' ') : '🌐' };
}

// Everything the hover card says beyond the elements, joined by NORAD id:
// SATCAT's row when it has one, the mirror's country otherwise. Status only
// ever comes from SATCAT — the mirror does not track it.
function satelliteMetadata(record) {
  const key = String(Number(record.id));
  const satcat = satcatIndex.get(key);
  const owner = ownerBadge(satcat && SATCAT_OWNERS[satcat.owner])
    || ownerBadge(resolveMirrorCountry(mirrorCountry.get(key)));
  return { owner, status: satcat ? OPS_STATUS[satcat.status] : null };
}

function resolveMirrorCountry(code) {
  if (!code) return null;
  return MIRROR_COUNTRIES[code] ?? (/^[A-Z]{2}$/.test(code) ? code : null);
}

function indexSatcatLines(text) {
  satcatIndex.clear();
  for (const line of text.split('\n')) {
    const [id, owner, status] = line.split(',');
    if (id) satcatIndex.set(id, { owner, status });
  }
}

// The bulk file is ~70k rows of full catalogue history at ~7 MB; only rows
// still on orbit survive into the cache, and only the joined columns, which
// keeps the stored projection near half a megabyte. Columns are found by
// header name so a SATCAT layout change fails loud here, not quietly askew.
function projectSatcat(csv) {
  const rows = csv.split(/\r?\n/);
  const header = rows[0].split(',');
  const idAt = header.indexOf('NORAD_CAT_ID');
  const statusAt = header.indexOf('OPS_STATUS_CODE');
  const ownerAt = header.indexOf('OWNER');
  const decayAt = header.indexOf('DECAY_DATE');
  if (idAt < 0 || statusAt < 0 || ownerAt < 0 || decayAt < 0) {
    throw new Error('SATCAT header is missing a joined column');
  }
  const lines = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i]) continue;
    const cols = rows[i].split(',');
    if (cols[decayAt]) continue;
    const id = Number(cols[idAt]);
    if (!Number.isFinite(id)) continue;
    lines.push(`${id},${cols[ownerAt]},${cols[statusAt]}`);
  }
  if (!lines.length) throw new Error('SATCAT response held no on-orbit rows');
  return lines.join('\n');
}

async function loadSatcat() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(SATCAT_CACHE_KEY)); } catch { /* rebuilt below */ }
  // A stale index is still a good index while the fresh one is on the wire —
  // ownership and status drift on the scale of months.
  if (cached?.lines) indexSatcatLines(cached.lines);
  if (cached?.lines && Date.now() - cached.savedAt < SATCAT_TTL) return;
  try {
    const lines = projectSatcat(await fetchCatalog({ url: SATCAT_URL }));
    indexSatcatLines(lines);
    try { localStorage.setItem(SATCAT_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), lines })); }
    catch (error) { console.debug('[satellites] SATCAT cache not written', error); }
    // A card already up was drawn from the old index (or none); redraw it.
    if (tooltipShown && tooltipIndex >= 0) showTooltip(tooltipIndex);
  } catch (error) {
    // The card stays usable without the join — flags and status just wait for
    // the next successful pull.
    console.warn('[satellites] SATCAT metadata unavailable', error);
  }
}

function readCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    // Only a cache that says where it came from is trusted; anything without
    // a label cannot be told apart from stale mirror data and is discarded.
    return cached?.label ? cached : null;
  }
  catch { return null; }
}

function writeCache(label) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      label,
      catalogTotal,
      items: elementPool.slice(0, CACHE_MAX_ITEMS)
    }));
  } catch (error) {
    // A pool larger than the quota is not worth failing a render over.
    console.debug('[satellites] Element cache not written', error);
  }
}

// Element sets reach us in two shapes: two-line sets from the live API and the
// bundled file (line1/line2 or tle1/tle2), and OMM/JSON records in the bundled
// file. Both are accepted; only the field names differ.
function isValidElementSet(item) {
  if (!item) return false;
  const [line1, line2] = elementLines(item);
  return Boolean((line1 && line2) || (item.OBJECT_NAME && Number.isFinite(Number(item.MEAN_MOTION)) && item.EPOCH));
}

function elementLines(item) {
  return [item.line1 || item.tle1, item.line2 || item.tle2];
}

function elementKey(item) {
  const [, line2] = elementLines(item);
  const raw = item.satelliteId ?? item.NORAD_CAT_ID ?? line2?.slice(2, 7).trim() ?? item.name ?? '';
  // TLE lines zero-pad the NORAD id while JSON records carry it as a number;
  // normalising through Number keeps "00900" and 900 from counting twice.
  const numeric = Number(raw);
  return raw !== '' && Number.isFinite(numeric) ? String(numeric) : String(raw);
}

// `replace` is set when the batch comes from a live fetch: the bundled
// fallback and any cache land in the pool first, and without replacement
// their aged elements would shadow the fresh ones for every object both
// hold — which is exactly the hundred famous spacecraft the fallback keeps.
// Replaced entries also drop their memoised record so the next rebuild
// propagates from the new elements rather than the old object.
function addToPool(items, replace = false) {
  for (const item of items) {
    if (!isValidElementSet(item)) continue;
    const key = elementKey(item);
    const at = poolKeys.get(key);
    if (at !== undefined) {
      if (replace) { elementPool[at] = item; recordCache.delete(key); }
      continue;
    }
    poolKeys.set(key, elementPool.length);
    elementPool.push(item);
  }
}

// Highest count the app will offer: everything the live catalogue reports, or
// the local pool when the API has not answered yet. No renderer-side clamp —
// the debug panel's FPS and propagate readouts are where the real budget shows.
function maxSatellites() {
  return Math.max(MIN_SATELLITES, catalogTotal, elementPool.length);
}

function buildRecord(item) {
  try {
    const [line1, line2] = elementLines(item);
    const satrec = line1
      ? satellite.twoline2satrec(line1, line2)
      : satellite.json2satrec(item);
    if (!satrec || satrec.error) return null;
    // Everything the inspector shows that does not change as the object
    // moves, worked out once here rather than on every hover.
    const profile = orbitProfile(satrec, line1, line2, item);
    // Elements this object can no longer be flown from are rejected here rather
    // than left to render as garbage. Screening at build time also means the
    // slot goes to the next object in the pool, so a requested count still
    // fills with spacecraft that actually fly.
    const referenceFix = referenceFixFor(satrec, profile);
    if (!referenceFix) return null;
    return {
      referenceFix,
      // Filled in by collapseDockedGroups when other catalogue entries turn out
      // to fly this same orbit at this same phase.
      companions: [],
      name: item.OBJECT_NAME || item.name || `OBJECT ${satrec.satnum}`,
      id: item.NORAD_CAT_ID || item.satelliteId || String(satrec.satnum).trim(),
      epoch: item.EPOCH || item.date || tleEpochLabel(line1),
      satrec,
      variant: classifySatellite(item.OBJECT_NAME || item.name || '', satrec),
      profile,
      speed: 0,
      position: new THREE.Vector3(),
      // Endpoints of the current propagation segment; the render loop slides
      // `position` from one to the other so motion never steps.
      glideFrom: new THREE.Vector3(),
      glideTo: new THREE.Vector3(),
      live: false,
      // Along-track direction, smoothed between ticks so the model never snaps
      // around when a propagation step lands almost on top of the last one.
      heading: new THREE.Vector3(),
      // A fixed attitude offset and size jitter per object, so a hundred
      // copies of one model still read as a hundred different spacecraft.
      tilt: new THREE.Quaternion().setFromEuler(new THREE.Euler(
        (Math.random() - .5) * .44,
        (Math.random() - .5) * 1.2,
        (Math.random() - .5) * .36
      )),
      modelScale: .84 + Math.random() * .36,
      altitude: 0,
      latitude: 0,
      longitude: 0,
    };
  } catch (error) {
    console.debug('[satellites] Skipped invalid element set', error);
    return null;
  }
}

// The live feed hands over a name, an id and two TLE lines — nothing else. Every
// figure in the inspector below is therefore derived: the shape of the orbit
// from the mean motion and eccentricity, the launch year from the international
// designator in line 1, and the lifetime orbit count from the revolution number
// in line 2.
function orbitProfile(satrec, line1 = '', line2 = '', item = {}) {
  const meanMotion = satrec.no / 60;                       // radians per second
  const semiMajor = Math.cbrt(GRAVITY_PARAMETER / (meanMotion * meanMotion));
  const eccentricity = satrec.ecco || 0;
  const apogee = semiMajor * (1 + eccentricity) - EARTH_RADIUS_KM;
  const perigee = semiMajor * (1 - eccentricity) - EARTH_RADIUS_KM;
  const mean = semiMajor - EARTH_RADIUS_KM;

  return {
    periodMinutes: (Math.PI * 2) / satrec.no,
    inclination: satrec.inclo * 180 / Math.PI,
    apogee,
    perigee,
    // Only worth a line of its own when the orbit is visibly not a circle.
    elliptical: apogee - perigee > 350,
    orbitClass: orbitClass(mean, eccentricity),
    launchYear: launchYear(line1, item.OBJECT_ID),
    orbits: orbitsAtEpoch(line2, item.REV_AT_EPOCH),
  };
}

// SGP4 has no error code for "these elements have aged out of usefulness".
// Run a decaying object months past its epoch — which the mirrored catalogue
// serves plenty of — and the theory quietly comes apart: it returns a finite
// position hundreds of astronomical units out, moving at walking pace, error
// flag clear. Roughly 200 objects in the full catalogue are in that state on
// any given day, and they read as spacecraft tearing across the globe.
//
// The tell is the orbit itself. An object cannot be further out than the
// apogee its own mean motion and eccentricity describe, so a position past
// that has diverged, and every later step only takes it further.
// Returns the object's position at the shared reference instant, or null when
// its elements have gone bad. Records are built lazily as the count climbs, so
// the instant is fixed at load rather than read per call: collapseDockedGroups
// compares these fixes against each other, and two positions taken minutes
// apart would put a docked pair on opposite sides of the planet.
function referenceFixFor(satrec, profile) {
  const state = satellite.propagate(satrec, REFERENCE_EPOCH);
  if (!state?.position || typeof state.position === 'boolean') return null;
  return withinOrbit(state.position, profile) ? state.position : null;
}

function withinOrbit(position, profile) {
  const radius = Math.hypot(position.x, position.y, position.z);
  return Number.isFinite(radius)
    && radius <= (profile.apogee + EARTH_RADIUS_KM) * DIVERGENCE_RATIO;
}

// A docked complex reaches us as one catalogue entry per component: the ISS is
// eleven of them — six modules plus whatever ferries are berthed that week —
// the Chinese station five, and several deep-space probes still carry the stage
// that pushed them out. Every component shares the station's elements, so they
// propagate to one point and the renderer stacks a pile of spacecraft on a
// single pixel.
//
// So one model stands for the complex and the rest become its companions. The
// keeper is the lowest catalogue number, which lands on the core module or the
// payload every time: modules are numbered as they launch, and a payload is
// catalogued ahead of the stage that lifted it.
//
// The cut is safe because nothing real occupies the space around it. Components
// of one structure mostly share elements exactly, and the rest part by metres —
// the widest is a quarter of a kilometre, between ISS modules whose element sets
// were published milliseconds apart. The closest genuinely distinct objects in
// the catalogue are Starlink pairs mid-manoeuvre, at 1.1 km. Nothing at all
// falls between those two, so the threshold sits in the middle of the gap.
function collapseDockedGroups(records) {
  // Sweep in x: co-located objects share an x, and the shell is sparse enough
  // along any one axis that the inner loop almost never runs twice.
  // Records outlive any one count, so last pass's companions are cleared rather
  // than left to describe a complex that is no longer fully on screen.
  for (const record of records) record.companions = [];
  const order = [...records].sort((a, b) => a.referenceFix.x - b.referenceFix.x);
  const groups = new Map();
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    for (let j = i + 1; j < order.length; j++) {
      const b = order[j];
      if (b.referenceFix.x - a.referenceFix.x >= DOCKED_SEPARATION_KM) break;
      if (separation(a.referenceFix, b.referenceFix) >= DOCKED_SEPARATION_KM) continue;
      // Merge whole groups rather than appending one object, so a complex found
      // as a chain of pairs still ends up as a single group.
      const groupA = groups.get(a) || [a];
      const groupB = groups.get(b) || [b];
      if (groupA === groupB) continue;
      const merged = groupA.concat(groupB);
      for (const member of merged) groups.set(member, merged);
    }
  }
  if (!groups.size) return records;

  const absorbed = new Set();
  for (const group of new Set(groups.values())) {
    const [keeper, ...rest] = [...group].sort((a, b) => catalogNumber(a) - catalogNumber(b));
    keeper.companions = rest.map((record) => record.name);
    for (const record of rest) absorbed.add(record);
  }
  return records.filter((record) => !absorbed.has(record));
}

function separation(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// Unnumbered entries ("TBA - TO BE ASSIGNED") sort last, so a named object
// always wins the keeper slot over one still awaiting a catalogue number.
function catalogNumber(record) {
  const value = Number(record.id);
  return Number.isFinite(value) ? value : Infinity;
}

function orbitClass(altitudeKm, eccentricity) {
  if (eccentricity > .25) return 'Highly elliptical';
  if (altitudeKm > 30000) return 'Geostationary belt';
  if (altitudeKm > 2000) return 'Medium Earth orbit';
  return 'Low Earth orbit';
}

// International designator, e.g. "98067A" on line 1 or "1998-067A" in an OMM.
// The two-digit form rolls over at 57, the convention Space-Track uses.
function launchYear(line1, objectId) {
  const omm = /^(\d{4})-/.exec(String(objectId || ''));
  if (omm) return Number(omm[1]);
  const code = line1.slice(9, 11).trim();
  if (!/^\d{2}$/.test(code)) return null;
  const year = Number(code);
  return year < 57 ? 2000 + year : 1900 + year;
}

function orbitsAtEpoch(line2, ommValue) {
  const value = Number(ommValue ?? line2.slice(63, 68));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function recordFor(item) {
  const key = elementKey(item);
  if (recordCache.has(key)) return recordCache.get(key);
  const record = buildRecord(item);
  recordCache.set(key, record);
  return record;
}

// Renders the first `satelliteTarget` objects the pool can supply. Called on
// every count change, so it does no parsing that memoisation can avoid.
function applySatelliteCount(label = sourceLabel) {
  sourceLabel = label;
  // The pool grows as catalogue pages land, so the standing request is
  // re-reconciled against it here rather than being clamped once and lost.
  satelliteTarget = Math.min(requestedSatellites, maxSatellites());
  const parsed = [];
  for (const item of elementPool) {
    if (parsed.length >= satelliteTarget) break;
    const record = recordFor(item);
    if (record) parsed.push(record);
  }
  if (!parsed.length) return;
  satelliteRecords = collapseDockedGroups(parsed);
  hoveredSatellite = -1;
  hideTooltip();
  buildSatelliteObjects();
  propagateSatellites(new Date(), true);
  buildOrbitPaths(new Date());
  dataStatus.textContent = `${sourceLabel} · ${satelliteRecords.length} satellites`;
  syncDebugReadout();
  refreshFocusAfterRebuild();
}

// Entry point for the debug slider: show what is already loaded straight away.
// The pool may only be the cached head of the catalogue — asking for more than
// it holds pulls the full set, and the fetch re-applies the count when it lands.
function requestSatelliteCount(count) {
  requestedSatellites = Math.round(Math.min(maxSatellites(), Math.max(MIN_SATELLITES, count)));
  applySatelliteCount();
  if (elementPool.length < requestedSatellites) loadLiveSatellites(true);
}

function tleEpochLabel(line = '') {
  const code = line.slice(18, 32).trim();
  return code ? `TLE ${code}` : 'TLE';
}

// Each tracked object is a real (if tiny) spacecraft: one instanced mesh for the
// white bus and its fittings, a second for the solar wings, and a soft green
// corona sprite that sits behind both. The sprite also stays the raycast target,
// so hovering keeps the generous hit radius a 25-pixel model could never offer.
function buildSatelliteObjects() {
  disposeSatelliteObjects();

  // Links are keyed by position in satelliteRecords, and this replaced that
  // array — every standing key now names a different spacecraft. Dropped rather
  // than faded: there is nothing left for them to fade out of.
  activeLinks.clear();
  lastLinkTopology = -Infinity;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(satelliteRecords.length * 3), 3));
  const colors = new Float32Array(satelliteRecords.length * 3);
  for (let i = 0; i < satelliteRecords.length; i++) {
    const color = new THREE.Color(i % 9 === 0 ? 0xa8ffe4 : 0x63f2c4);
    color.toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  satellitePoints = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: .30,
    map: dotTexture,
    vertexColors: true,
    transparent: true,
    opacity: .72,
    depthWrite: false,
    alphaTest: .01,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  }));
  satellitePoints.renderOrder = 6;
  globeRoot.add(satellitePoints);

  satelliteFleet.build(satelliteRecords);
}

function disposeSatelliteObjects() {
  if (satellitePoints) {
    satellitePoints.geometry.dispose();
    satellitePoints.material.dispose();
    globeRoot.remove(satellitePoints);
    satellitePoints = null;
  }
  satelliteFleet.dispose();
}

// SGP4 stays on a coarse cadence — it is the expensive step — and each tick
// only lands new glide endpoints. updateSatellitePositions carries the fleet
// between them every frame, so spacecraft drift continuously instead of
// stepping forward once a tick, which read as stutter with the camera zoomed
// all the way in.
function propagateSatellites(date, snap = false) {
  if (!satellitePoints) return;
  const started = performance.now();
  // Sidereal time depends only on the tick's date, not the satellite; at
  // full-catalogue counts recomputing it per object is a real cost.
  const gmst = satellite.gstime(date);
  for (const record of satelliteRecords) {
    const state = satellite.propagate(record.satrec, date);
    if (!state?.position || typeof state.position === 'boolean') continue;
    // buildRecord already screened this satrec, so this only catches elements
    // that age out during a long-running session. Holding the last good fix
    // reads as a spacecraft that stopped reporting; writing the diverged one
    // would fling it across the globe.
    if (!withinOrbit(state.position, record.profile)) continue;
    const geo = satellite.eciToGeodetic(state.position, gmst);
    record.latitude = satellite.degreesLat(geo.latitude);
    record.longitude = satellite.degreesLong(geo.longitude);
    record.altitude = geo.height;
    // Inertial speed, which is the number that means anything for an orbit —
    // the propagator already computed it, we were just throwing it away.
    const velocity = state.velocity;
    if (velocity) record.speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    const target = latLonToVector(record.latitude, record.longitude, displayRadius(geo.height));
    updateHeading(record, target, snap);
    // A record's first fix (or an explicit snap) starts on the target itself
    // rather than gliding in from wherever the vector happened to point.
    if (snap || !record.live) record.position.copy(target);
    record.live = true;
    record.glideFrom.copy(record.position);
    record.glideTo.copy(target);
  }
  glideStart = started;
  updateSatellitePositions(started);
  satellitePoints.geometry.computeBoundingSphere();
  lastPropagationMs = performance.now() - started;
}

let glideStart = 0;

// Slides every live spacecraft along its current propagation segment — once
// per frame, so motion stays continuous however close the camera sits. Linear
// on purpose: constant velocity reads as gliding, easing would pulse at every
// tick.
function updateSatellitePositions(now) {
  if (!satellitePoints) return;
  const positions = satellitePoints.geometry.attributes.position;
  const alpha = Math.min(1, (now - glideStart) / PROPAGATION_INTERVAL);
  for (let i = 0; i < satelliteRecords.length; i++) {
    const record = satelliteRecords[i];
    if (!record.live) continue;
    record.position.lerpVectors(record.glideFrom, record.glideTo, alpha);
    positions.setXYZ(i, record.position.x, record.position.y, record.position.z);
    writeInstanceMatrix(record);
  }
  positions.needsUpdate = true;
  satelliteFleet.commit();
}

// The tangential component of this step's motion, with the radial part removed
// so the heading stays in the local horizon plane even as altitude drifts.
function updateHeading(record, target, snap) {
  const up = scratchUp.copy(target).normalize();
  const travel = scratchForward.subVectors(target, record.position);
  travel.addScaledVector(up, -travel.dot(up));
  if (travel.lengthSq() < 1e-12) return;
  travel.normalize();
  if (snap || record.heading.lengthSq() === 0) record.heading.copy(travel);
  else record.heading.lerp(travel, .3).normalize();
}

function writeInstanceMatrix(record) {
  const up = scratchUp.copy(record.position).normalize();
  // Nadir-pointing attitude: +Y is zenith, +Z is along-track, so the bus keeps
  // its sensor barrel aimed at Earth and the wings sweep out cross-track.
  const forward = scratchForward.copy(record.heading.lengthSq() ? record.heading : FALLBACK_HEADING);
  forward.addScaledVector(up, -forward.dot(up));
  if (forward.lengthSq() < 1e-10) forward.set(up.z, up.x, up.y);
  forward.normalize();
  const side = scratchSide.crossVectors(up, forward).normalize();

  scratchMatrix.makeBasis(side, up, forward);
  scratchQuaternion.setFromRotationMatrix(scratchMatrix).multiply(record.tilt);
  scratchMatrix.compose(record.position, scratchQuaternion, scratchScale.setScalar(record.modelScale));
  satelliteFleet.setMatrix(record, scratchMatrix);
}

function displayRadius(altitudeKm) {
  const safeAltitude = Math.max(0, Math.min(45000, altitudeKm || 0));
  return EARTH_RADIUS + .13 + Math.log1p(safeAltitude / 260) * .19;
}

function buildOrbitPaths(date) {
  orbitGroup.traverse((object) => {
    object.geometry?.dispose?.();
    object.material?.dispose?.();
  });
  orbitGroup.clear();
  const selection = satelliteRecords.filter((_, index) => index % Math.max(1, Math.floor(satelliteRecords.length / 14)) === 0).slice(0, 14);
  for (let lineIndex = 0; lineIndex < selection.length; lineIndex++) {
    const record = selection[lineIndex];
    const periodMinutes = (Math.PI * 2) / record.satrec.no;
    const points = [];
    for (let i = 0; i <= 72; i++) {
      const sampleDate = new Date(date.getTime() + (i / 72 - .5) * periodMinutes * 60_000);
      const state = satellite.propagate(record.satrec, sampleDate);
      if (!state?.position || typeof state.position === 'boolean') continue;
      if (!withinOrbit(state.position, record.profile)) continue;
      const geo = satellite.eciToGeodetic(state.position, satellite.gstime(sampleDate));
      points.push(latLonToVector(
        satellite.degreesLat(geo.latitude),
        satellite.degreesLong(geo.longitude),
        displayRadius(geo.height)
      ));
    }
    if (points.length < 2) continue;
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    // Lifted from where they were: the tracks are the structure the link mesh
    // is draped over, and at the old weight the grey ones read as smudges.
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
      color: lineIndex % 4 === 0 ? 0x20e7ad : 0x8aa9a0,
      transparent: true,
      opacity: lineIndex % 4 === 0 ? .32 : .155,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    line.renderOrder = 4;
    orbitGroup.add(line);
  }
  lastOrbitBuild = performance.now();
}

// ---------------------------------------------------------------------------
// Link network
// ---------------------------------------------------------------------------
// Two kinds of line genuinely join these objects, and the globe was drawing
// neither: the optical crosslinks a constellation uses to carry traffic between
// its own satellites, and the gateway passes where that traffic reaches the
// ground. Both are solved as geometry rather than decorated on — every segment
// below has to close the way a real link does, which is also what keeps the
// picture honest as the fleet moves: links appear along a plane, hand over, and
// break when the Earth comes between two terminals.
//
// It is the layer the rest of the page is about. On-orbit processing only pays
// off if a spacecraft can reach its neighbours without waiting for a ground
// pass, so the mesh is the product and the downlinks are where its output lands.

// Range of a current-generation optical terminal (Starlink v1.5/v2, Iridium
// NEXT). Past a few thousand kilometres the pointing budget and the link margin
// run out, whatever the geometry allows.
const ISL_RANGE_KM = 5200;
// A beam that grazes the limb is not a link. 80 km of clearance keeps it above
// the atmosphere the real budgets have to shoot through.
const ISL_GRAZE_RADIUS_KM = EARTH_RADIUS_KM + 80;
// Width of the altitude band two spacecraft have to share to count as flying
// the same shell. Wide enough to hold a real shell's spread and the drift
// between raising and station-keeping, narrow enough to keep a 400 km imager
// out of a 1,200 km relay's network.
const ISL_SHELL_BAND_KM = 220;
// Steerable heads per bus. Real hardware carries three or four — fore and aft
// along the plane plus one or two reaching across to the neighbour — but the
// cross-plane pair is what turns the picture into a net: the fleet on screen is
// a thin sample of the catalogue, so its nearest neighbours sit far wider apart
// than a full shell's do and every extra terminal spans most of a hemisphere.
// Two draws the in-plane chain, which is the part of the topology that reads.
const ISL_TERMINALS = 2;
// Below this a gateway dish is looking through too much atmosphere, and through
// whatever the local horizon holds, to keep a pass.
const DOWNLINK_MIN_ELEVATION_DEG = 14;
// Antennas per site. Teleports are antenna farms and could justify far more,
// but the downlinks are the accent here and the mesh is the subject — past two
// per site the beams take the picture over.
const DOWNLINK_PER_STATION = 2;
// Every site listed below is a polar or mid-latitude tracking station: fast
// slewing dishes built to follow something crossing the sky in ten minutes.
// Geostationary traffic is a different facility with a fixed dish, and drawing
// it here also drew a beam to an object so far out it left the frame as a ray
// with no visible other end.
const DOWNLINK_MAX_ALTITUDE_KM = 2000;
// Ceiling on drawn segments — the cap the picture is composed around, not a
// performance guess. Past this the mesh stops reading as a network and starts
// reading as a fill.
const MAX_LINKS = 460;
// Spacecraft hosting a node in any one rebuild. Two jobs: whole-catalogue mode
// puts thousands on screen and the peer search is quadratic in this number, and
// a fleet is never uniformly equipped anyway. A stride keeps the shape of the
// shell at a bounded cost.
const MAX_MESH_NODES = 340;
// Links fade rather than pop. Real handovers are not instant either, and a
// popping mesh reads as flicker.
const LINK_FADE_SECONDS = .75;
// Quads along each ribbon. Only the arc shape needs them — a straight link
// would do with one — so this is the resolution of the curve, and 14 is where
// the longest hops stop showing facets.
const LINK_SEGMENTS = 14;
// How long the straight/curved switch takes to travel. Long enough to read as
// the network reshaping rather than as a redraw.
const LINK_SHAPE_SECONDS = .5;
// Extra bow at the midpoint of an arc, as a fraction of the link's own length.
// The arc already rides the shell without this; the bow is what makes a long
// hop read as a hop rather than as a slightly bent line.
const LINK_ARC_BOW = .25;
// How often the topology is re-solved. Positions are refreshed every frame
// regardless, so this only governs when links are allowed to change partners.
const LINK_RETOPO_MS = 3600;
// Hysteresis on the way out: a link already carrying traffic is held slightly
// past the range it would have needed to be acquired at, so pairs sitting on
// the boundary do not chatter in and out every rebuild.
const LINK_HOLD_MARGIN = 1.1;

// Real gateway and teleport sites, spread the way the ground segment actually
// is: dense at high latitude where every sun-synchronous pass is visible, and
// thin over the oceans, which is exactly why the crosslink mesh exists.
const GROUND_STATIONS = [
  { name: 'Svalbard', lat: 78.23, lon: 15.41 },
  { name: 'Inuvik', lat: 68.32, lon: -133.53 },
  { name: 'Fairbanks', lat: 64.86, lon: -147.85 },
  { name: 'Kiruna', lat: 67.86, lon: 20.96 },
  { name: 'Tromsø', lat: 69.66, lon: 18.94 },
  { name: 'Nuuk', lat: 64.18, lon: -51.72 },
  { name: 'Anchorage', lat: 61.22, lon: -149.90 },
  { name: 'Kourou', lat: 5.25, lon: -52.80 },
  { name: 'Goonhilly', lat: 50.05, lon: -5.18 },
  { name: 'Redu', lat: 50.00, lon: 5.15 },
  { name: 'Weilheim', lat: 47.88, lon: 11.08 },
  { name: 'Madrid', lat: 40.43, lon: -4.25 },
  { name: 'Wallops', lat: 37.94, lon: -75.46 },
  { name: 'Goldstone', lat: 35.43, lon: -116.89 },
  { name: 'Seoul', lat: 37.57, lon: 127.00 },
  { name: 'Tokyo', lat: 35.68, lon: 139.69 },
  { name: 'Dubai', lat: 25.20, lon: 55.27 },
  { name: 'Hawaii', lat: 20.71, lon: -156.26 },
  { name: 'Guam', lat: 13.59, lon: 144.86 },
  { name: 'Bengaluru', lat: 12.97, lon: 77.59 },
  { name: 'Singapore', lat: 1.35, lon: 103.87 },
  { name: 'Nairobi', lat: -1.29, lon: 36.82 },
  { name: 'Alcântara', lat: -2.37, lon: -44.40 },
  { name: 'Hartebeesthoek', lat: -25.89, lon: 27.69 },
  { name: 'Córdoba', lat: -31.52, lon: -64.46 },
  { name: 'Perth', lat: -31.80, lon: 115.89 },
  { name: 'Santiago', lat: -33.15, lon: -70.67 },
  { name: 'Awarua', lat: -46.53, lon: 168.38 },
  { name: 'Punta Arenas', lat: -53.00, lon: -70.85 },
  { name: 'Troll', lat: -72.01, lon: 2.53 },
].map((station, index) => ({
  ...station,
  index,
  // Where the beam lands on the drawn globe, and the true-scale position the
  // elevation angle is actually solved at.
  point: latLonToVector(station.lat, station.lon, EARTH_RADIUS + .012),
  ecef: latLonToVector(station.lat, station.lon, EARTH_RADIUS_KM),
}));

// key -> { a, b, station, kind, seed, weight, fade, target }
const activeLinks = new Map();
// What was actually drawn last frame, for the debug readout, which reports the
// two systems separately — they are tuned against different limits. Counted
// where the instances are written rather than where the topology is solved:
// links keep fading out for a while after a rebuild drops them, so a count
// taken at rebuild time immediately stops matching what is on screen.
let crosslinkCount = 0;
let downlinkCount = 0;
let lastLinkTopology = 0;
let networkVisible = false;
// True-scale positions for the current fleet, rebuilt each topology pass. Flat
// because the pair search touches it far more often than anything else does.
let nodeEcef = new Float64Array(0);
let stationMarkers = null;
let stationColors = null;
// Target for the link shape, travelled to rather than snapped: the switch reads
// as the network reshaping, and a hard cut on 300 links reads as a redraw.
let linkCurveTarget = 1;
const IDLE_STATION_COLOR = new THREE.Color(0x2e6f7a);
const ACTIVE_STATION_COLOR = new THREE.Color(0x9fdcff);

const linkNetwork = buildLinkNetwork();
linkNetwork.object3d.visible = networkVisible;
globeRoot.add(linkNetwork.object3d);
const groundStationMarkers = buildGroundStationMarkers();
groundStationMarkers.visible = networkVisible;
globeRoot.add(groundStationMarkers);

// One instanced ribbon per link, expanded in the vertex shader. THREE.Line is a
// hairline on every desktop GL driver — at this density that aliases into
// dashes and the mesh disappears — and a ribbon also gives the fragment shader
// somewhere to put a soft edge and the packet travelling along it.
//
// The strip is subdivided rather than being a single quad so the same geometry
// can be bent into an arc by the vertex shader. Both link shapes are drawn from
// it, and switching between them is a uniform rather than a rebuild.
function buildLinkNetwork() {
  const geometry = new THREE.InstancedBufferGeometry();
  // x runs 0→1 along the link, y spans -1→1 across the ribbon.
  const strip = [];
  for (let i = 0; i < LINK_SEGMENTS; i++) {
    const near = i / LINK_SEGMENTS;
    const far = (i + 1) / LINK_SEGMENTS;
    strip.push(
      near, -1, 0, far, -1, 0, far, 1, 0,
      near, -1, 0, far, 1, 0, near, 1, 0
    );
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(strip), 3));

  const starts = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LINKS * 3), 3);
  const ends = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LINKS * 3), 3);
  const seeds = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LINKS), 1);
  const kinds = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LINKS), 1);
  const strengths = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LINKS), 1);
  starts.setUsage(THREE.DynamicDrawUsage);
  ends.setUsage(THREE.DynamicDrawUsage);
  strengths.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('iStart', starts);
  geometry.setAttribute('iEnd', ends);
  geometry.setAttribute('iSeed', seeds);
  geometry.setAttribute('iKind', kinds);
  geometry.setAttribute('iStrength', strengths);
  geometry.instanceCount = 0;

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uHalfRes: { value: new THREE.Vector2(innerWidth / 2, innerHeight / 2) },
      // Half-width in CSS pixels. Thin enough to stay a line, wide enough that
      // the gaussian below has room to be a glow rather than a stair-step.
      uWidth: { value: 1.2 },
      uOpacity: { value: 1 },
      // The travelling packet is the one part of this layer that is pure
      // motion. Switched off outright when the reader has asked for less of it,
      // and the resting weight below takes over so the mesh is still legible.
      uPulse: { value: reducedMotion ? 0 : 1 },
      // 0 draws the chord, 1 the arc; the debug switch travels between them.
      uCurve: { value: 1 },
      uBow: { value: LINK_ARC_BOW },
      uMeshColor: { value: new THREE.Color(0x2ff0b4) },
      uDownColor: { value: new THREE.Color(0x9fdcff) },
    },
    vertexShader: `
      uniform vec2 uHalfRes;
      uniform float uWidth;
      uniform float uCurve;
      uniform float uBow;
      attribute vec3 iStart;
      attribute vec3 iEnd;
      attribute float iSeed;
      attribute float iKind;
      attribute float iStrength;
      varying float vAlong;
      varying float vAcross;
      varying float vSeed;
      varying float vKind;
      varying float vStrength;

      // Where the link sits at t. Straight is the chord between the terminals —
      // which is the honest path for a beam, and also the one that cuts down
      // through the shell it is spanning. Curved keeps the segment at the
      // radius its ends are flying at, so it rides over the globe instead, and
      // bows a little further out with length.
      vec3 linkPoint(float t) {
        vec3 chord = mix(iStart, iEnd, t);
        if (uCurve <= 0.0) return chord;
        float reach = length(chord);
        if (reach < 1e-4) return chord;
        float radius = mix(length(iStart), length(iEnd), t)
          + uBow * length(iEnd - iStart) * sin(t * 3.14159265);
        return mix(chord, chord / reach * radius, uCurve);
      }

      void main() {
        vAlong = position.x;
        vAcross = position.y;
        vSeed = iSeed;
        vKind = iKind;
        vStrength = iStrength;

        // The ribbon is widened against the curve's local direction, not the
        // chord's: on an arc those diverge, and widening against the chord
        // twists the strip and pinches it at the ends.
        float here = position.x;
        float step = here > .5 ? -.01 : .01;
        vec4 clipHere = projectionMatrix * modelViewMatrix * vec4(linkPoint(here), 1.0);
        vec4 clipNext = projectionMatrix * modelViewMatrix * vec4(linkPoint(here + step), 1.0);
        // A point behind the eye makes the screen-space direction below
        // meaningless, and the quad would smear across the frame. Mission focus
        // flies the camera in among the fleet, so this does happen.
        if (clipHere.w <= 0.0 || clipNext.w <= 0.0 || iStrength <= 0.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        vec2 screenHere = clipHere.xy / clipHere.w * uHalfRes;
        vec2 screenNext = clipNext.xy / clipNext.w * uHalfRes;
        // Sampled backwards past the midpoint, so flip it back — otherwise the
        // normal reverses halfway along and the ribbon crosses over itself.
        vec2 along = (screenNext - screenHere) * sign(step);
        float span = length(along);
        along = span > 1e-4 ? along / span : vec2(1.0, 0.0);
        // Widen perpendicular to the run of the link, in pixels, then convert
        // back through w so the ribbon holds its weight at any distance.
        vec4 clip = clipHere;
        clip.xy += vec2(-along.y, along.x) * position.y * uWidth / uHalfRes * clip.w;
        gl_Position = clip;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uOpacity;
      uniform float uPulse;
      uniform vec3 uMeshColor;
      uniform vec3 uDownColor;
      varying float vAlong;
      varying float vAcross;
      varying float vSeed;
      varying float vKind;
      varying float vStrength;
      void main() {
        // Gaussian across the ribbon: a bright core with a soft falloff, so the
        // segment reads as a beam instead of an aliased hairline.
        float core = exp(-vAcross * vAcross * 5.2);
        // Both ends taper, so a link leaves its terminal rather than being
        // welded to the model.
        float taper = smoothstep(0.0, .08, vAlong) * smoothstep(0.0, .08, 1.0 - vAlong);
        // A packet running source to destination: tight head, short wake behind
        // it, nothing ahead. Downlinks run quicker — a pass is measured in
        // minutes, a crosslink hop holds for a whole plane.
        float head = fract(uTime * mix(.28, .52, vKind) + vSeed);
        float lead = vAlong - head;
        float packet = (exp(-lead * lead * 380.0)
          + step(lead, 0.0) * exp(min(0.0, lead) * 10.0) * .28) * uPulse;
        vec3 tint = mix(uMeshColor, uDownColor, vKind);
        // The resting weight is deliberately under half: a link at rest should
        // be readable structure, and the packet running down it is what the eye
        // is meant to follow. With the packet off it carries the link alone, so
        // it takes back the brightness the packet would have averaged in.
        float rest = mix(.38, .44, vKind) + (1.0 - uPulse) * .16;
        float amount = (rest + packet * 1.35) * core * taper * vStrength * uOpacity;
        gl_FragColor = vec4(tint + packet * .4, amount);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // Positions live in the instance attributes, so the base geometry's bounds
  // say nothing about where this draws.
  mesh.frustumCulled = false;
  // Above the orbit tracks, below the spacecraft themselves.
  mesh.renderOrder = 5;
  return { object3d: mesh, geometry, material, starts, ends, seeds, kinds, strengths };
}

// The gateways the downlinks terminate at. Without them a beam ends at a bare
// patch of ocean and reads as an artefact; with them it lands on a site.
function buildGroundStationMarkers() {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(GROUND_STATIONS.length * 3);
  GROUND_STATIONS.forEach((station, index) => station.point.toArray(positions, index * 3));
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(GROUND_STATIONS.length * 3), 3));
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: .105,
    map: dotTexture,
    vertexColors: true,
    transparent: true,
    opacity: .9,
    depthWrite: false,
    alphaTest: .01,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  }));
  points.renderOrder = 5;
  stationColors = geometry.attributes.color;
  stationMarkers = points;
  return points;
}

function setLinkCurve(on) {
  linkCurveTarget = on ? 1 : 0;
}

function setNetworkVisible(on) {
  networkVisible = on;
  linkNetwork.object3d.visible = on;
  if (stationMarkers) stationMarkers.visible = on;
  // Coming back on, the standing set was solved against wherever the fleet was
  // when it went off. Re-solve rather than restore a stale topology.
  if (on) {
    activeLinks.clear();
    lastLinkTopology = -Infinity;
  }
}

// Re-solves who is talking to whom. Runs on its own slow cadence — the answer
// only changes as the fleet moves through a plane's worth of geometry — while
// the endpoints themselves are rewritten every frame by updateLinkGeometry.
function rebuildLinkTopology() {
  lastLinkTopology = performance.now();
  if (!networkVisible || !satelliteRecords.length) {
    for (const link of activeLinks.values()) link.target = 0;
    return;
  }

  // True-scale geometry, not the compressed display radius: whether two
  // terminals can see each other is a fact about the orbit, and the drawn
  // altitude is logarithmic. Only the endpoints are taken from the display.
  if (nodeEcef.length < satelliteRecords.length * 3) {
    nodeEcef = new Float64Array(satelliteRecords.length * 3);
  }
  const live = [];
  for (let i = 0; i < satelliteRecords.length; i++) {
    const record = satelliteRecords[i];
    if (!record.live) continue;
    const radius = EARTH_RADIUS_KM + Math.max(0, record.altitude || 0);
    const phi = THREE.MathUtils.degToRad(90 - record.latitude);
    const theta = THREE.MathUtils.degToRad(record.longitude + 180);
    const sinPhi = Math.sin(phi);
    nodeEcef[i * 3] = -radius * sinPhi * Math.cos(theta);
    nodeEcef[i * 3 + 1] = radius * Math.cos(phi);
    nodeEcef[i * 3 + 2] = radius * sinPhi * Math.sin(theta);
    live.push(i);
  }

  // Downlinks are solved first and crosslinks fill whatever budget is left.
  // There are only ever a couple of dozen passes up at once and they are the
  // scarcer, more legible half of the picture; letting a dense shell of
  // crosslinks crowd them out would drop the half that lands somewhere.
  const found = new Map();
  collectDownlinks(live, found);
  collectCrosslinks(live, found);

  // Anything already up that the pass did not re-find starts fading; anything
  // new starts from nothing and fades in. Everything else just carries over,
  // which is what keeps a link's packet phase continuous across a rebuild.
  for (const [key, link] of activeLinks) {
    const fresh = found.get(key);
    if (fresh) {
      link.weight = fresh.weight;
      link.target = 1;
      found.delete(key);
    } else {
      link.target = 0;
    }
  }
  for (const [key, link] of found) {
    if (activeLinks.size >= MAX_LINKS) break;
    activeLinks.set(key, link);
  }
}

// The mesh is this company's own overlay, not any one operator's constellation,
// and that is a deliberate choice worth stating. A strict per-operator mesh is
// the more literal thing to draw, and it was tried: the page renders the head of
// the catalogue, which is ordered by NORAD id and therefore sixty years old, so
// the "constellations" available to link were Thor and Delta debris. Excluding
// those left roughly forty crosslinks across the whole globe — a picture that
// says nothing about the product.
//
// What is drawn instead is the network the page is selling: edge nodes hosted
// across a shell, peering with whoever is in reach. Every constraint that makes
// a link a link still holds — a shared shell, a terminal's range, a line that
// clears the atmosphere, a fixed number of heads per bus — so the mesh forms,
// hands over and breaks exactly as a real one does. Only the question of who is
// allowed to peer is answered by the product rather than by the catalogue.
function collectCrosslinks(live, found) {
  // Spent stages and fragments host nothing. Without this the mesh happily
  // wires up sixty years of debris, which is exactly the kind of line that
  // means nothing.
  const hosts = live.filter((index) => satelliteRecords[index].variant !== 'debris');
  // Sorted by altitude so the shell search below is a walk outward from each
  // node until it leaves the band, rather than a scan of the whole fleet.
  hosts.sort((a, b) => (satelliteRecords[a].altitude || 0) - (satelliteRecords[b].altitude || 0));
  const nodes = sampleEvenly(hosts, MAX_MESH_NODES);
  if (nodes.length < 4) return;
  const altitudeOf = (index) => satelliteRecords[index].altitude || 0;

  const range2 = ISL_RANGE_KM * ISL_RANGE_KM;
  const hold2 = (ISL_RANGE_KM * LINK_HOLD_MARGIN) ** 2;

  // Every node's reachable peers, nearest first. Taking the globally shortest
  // pairs instead would spend the whole budget wherever the sample bunches up
  // and leave the rest of the shell bare — the terminals are on the
  // spacecraft, so the allocation has to be made per spacecraft.
  const candidates = nodes.map((a, i) => {
    const ax = nodeEcef[a * 3];
    const ay = nodeEcef[a * 3 + 1];
    const az = nodeEcef[a * 3 + 2];
    const altitude = altitudeOf(a);
    const reachable = [];
    const consider = (j) => {
      const b = nodes[j];
      const dx = nodeEcef[b * 3] - ax;
      if (dx > ISL_RANGE_KM || dx < -ISL_RANGE_KM) return;
      const dy = nodeEcef[b * 3 + 1] - ay;
      if (dy > ISL_RANGE_KM || dy < -ISL_RANGE_KM) return;
      const dz = nodeEcef[b * 3 + 2] - az;
      const distance2 = dx * dx + dy * dy + dz * dz;
      // An established link is held a little past acquisition range so pairs
      // drifting along the boundary do not chatter in and out.
      const limit2 = activeLinks.has(linkKey(a, b)) ? hold2 : range2;
      if (distance2 > limit2 || distance2 < 1) return;
      if (!clearsAtmosphere(a, b)) return;
      reachable.push({ j, distance2 });
    };
    // A mesh lives inside one shell: a node 400 km up and one at 1,200 km are
    // two networks, however close they pass. The list is altitude-ordered, so
    // walking out in both directions stops as soon as the band is left.
    for (let j = i - 1; j >= 0 && altitude - altitudeOf(nodes[j]) <= ISL_SHELL_BAND_KM; j--) consider(j);
    for (let j = i + 1; j < nodes.length && altitudeOf(nodes[j]) - altitude <= ISL_SHELL_BAND_KM; j++) consider(j);
    reachable.sort((first, second) => first.distance2 - second.distance2);
    // Only ever needs as many fallbacks as there are terminals to place.
    return reachable.slice(0, ISL_TERMINALS + 3);
  });

  // Terminals are placed a round at a time, so every spacecraft acquires its
  // nearest peer before any of them acquires a second. That is what leaves a
  // chain running through the shell rather than a few dense hubs.
  const used = new Int8Array(nodes.length);
  for (let round = 0; round < ISL_TERMINALS; round++) {
    for (let i = 0; i < nodes.length; i++) {
      if (used[i] > round) continue;
      for (const candidate of candidates[i]) {
        if (used[candidate.j] >= ISL_TERMINALS) continue;
        const key = linkKey(nodes[i], nodes[candidate.j]);
        if (found.has(key)) continue;
        if (found.size >= MAX_LINKS) return;
        used[i]++;
        used[candidate.j]++;
        found.set(key, {
          a: satelliteRecords[nodes[i]],
          b: satelliteRecords[nodes[candidate.j]],
          station: null,
          kind: 0,
          seed: hashUnit(key),
          // Short hops are the ones a router prefers, and reading brighter is
          // how that shows without a legend.
          weight: .62 + .38 * (1 - Math.sqrt(candidate.distance2) / ISL_RANGE_KM),
          fade: 0,
          target: 1,
        });
        break;
      }
    }
  }
}

// A pass, resolved the way a scheduler resolves one: the station takes the
// birds highest above its own horizon, because those are the ones it will hold
// long enough to be worth slewing a dish to.
function collectDownlinks(live, found) {
  const minSine = Math.sin(THREE.MathUtils.degToRad(DOWNLINK_MIN_ELEVATION_DEG));
  for (let s = 0; s < GROUND_STATIONS.length; s++) {
    const station = GROUND_STATIONS[s];
    const sx = station.ecef.x;
    const sy = station.ecef.y;
    const sz = station.ecef.z;
    const visible = [];
    for (const index of live) {
      if ((satelliteRecords[index].altitude || 0) > DOWNLINK_MAX_ALTITUDE_KM) continue;
      const dx = nodeEcef[index * 3] - sx;
      const dy = nodeEcef[index * 3 + 1] - sy;
      const dz = nodeEcef[index * 3 + 2] - sz;
      const slant = Math.hypot(dx, dy, dz);
      if (slant < 1) continue;
      // Elevation above the local horizon: the station's own radius vector is
      // its up, so this is the angle a dish would have to sit at.
      const sine = (dx * sx + dy * sy + dz * sz) / (slant * EARTH_RADIUS_KM);
      if (sine < minSine) continue;
      visible.push({ index, sine, slant });
    }
    visible.sort((a, b) => b.sine - a.sine);
    for (let k = 0; k < Math.min(DOWNLINK_PER_STATION, visible.length); k++) {
      if (found.size >= MAX_LINKS) return;
      const pass = visible[k];
      const key = `g${s}:${pass.index}`;
      found.set(key, {
        a: satelliteRecords[pass.index],
        b: null,
        station,
        kind: 1,
        seed: hashUnit(key),
        // Overhead passes carry the clean, fast side of the link budget.
        weight: .58 + .42 * pass.sine,
        fade: 0,
        target: 1,
      });
    }
  }
}

// Does the segment between two spacecraft stay above the atmosphere, or does
// the planet sit in the way? Closest approach of the line to Earth's centre,
// clamped to the segment so two satellites on the same side are never rejected
// by the infinite line passing under the globe behind one of them.
function clearsAtmosphere(a, b) {
  const ax = nodeEcef[a * 3];
  const ay = nodeEcef[a * 3 + 1];
  const az = nodeEcef[a * 3 + 2];
  const dx = nodeEcef[b * 3] - ax;
  const dy = nodeEcef[b * 3 + 1] - ay;
  const dz = nodeEcef[b * 3 + 2] - az;
  const span2 = dx * dx + dy * dy + dz * dz;
  if (span2 < 1) return false;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy + az * dz) / span2));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  const cz = az + dz * t;
  return cx * cx + cy * cy + cz * cz > ISL_GRAZE_RADIUS_KM * ISL_GRAZE_RADIUS_KM;
}

// Thins the fleet to a bounded sample without collapsing it into one region: a
// stride walks the whole list, so the shell keeps its shape.
function sampleEvenly(items, limit) {
  if (items.length <= limit) return items;
  const stride = items.length / limit;
  const out = [];
  for (let i = 0; out.length < limit; i += stride) out.push(items[Math.floor(i)]);
  return out;
}

function linkKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// Stable per-link phase, so a link's packet does not jump when the topology is
// re-solved and the pair keeps its slot.
function hashUnit(key) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10007) / 10007;
}

// Per frame: advance the fades, then rewrite every endpoint from the live
// positions. The endpoints have to be rewritten rather than cached because the
// fleet glides continuously between propagation ticks — a link left where it
// was solved would visibly detach from both of its terminals.
function updateLinkNetwork(elapsed, deltaSeconds) {
  if (!networkVisible) return;
  const { starts, ends, seeds, kinds, strengths, geometry, material } = linkNetwork;
  const step = deltaSeconds / LINK_FADE_SECONDS;
  let count = 0;
  crosslinkCount = 0;
  downlinkCount = 0;

  if (stationColors) {
    for (let i = 0; i < GROUND_STATIONS.length; i++) IDLE_STATION_COLOR.toArray(stationColors.array, i * 3);
  }

  for (const [key, link] of activeLinks) {
    link.fade = Math.max(0, Math.min(1, link.fade + (link.target ? step : -step)));
    if (!link.fade && !link.target) {
      activeLinks.delete(key);
      continue;
    }
    // A record can leave the render set between rebuilds when the slider moves.
    if (!link.a.live || (link.b && !link.b.live)) {
      link.target = 0;
      if (!link.fade) {
        activeLinks.delete(key);
        continue;
      }
    }
    if (count >= MAX_LINKS) break;

    const from = link.a.position;
    const to = link.station ? link.station.point : link.b.position;
    starts.setXYZ(count, from.x, from.y, from.z);
    ends.setXYZ(count, to.x, to.y, to.z);
    seeds.setX(count, link.seed);
    kinds.setX(count, link.kind);
    strengths.setX(count, link.fade * link.weight);
    if (link.station && stationColors) {
      ACTIVE_STATION_COLOR.toArray(stationColors.array, link.station.index * 3);
    }
    if (link.kind) downlinkCount++;
    else crosslinkCount++;
    count++;
  }

  geometry.instanceCount = count;
  starts.needsUpdate = true;
  ends.needsUpdate = true;
  seeds.needsUpdate = true;
  kinds.needsUpdate = true;
  strengths.needsUpdate = true;
  if (stationColors) stationColors.needsUpdate = true;
  material.uniforms.uTime.value = elapsed / 1000;

  const curve = material.uniforms.uCurve;
  if (curve.value !== linkCurveTarget) {
    const travel = deltaSeconds / LINK_SHAPE_SECONDS;
    curve.value = linkCurveTarget > curve.value
      ? Math.min(linkCurveTarget, curve.value + travel)
      : Math.max(linkCurveTarget, curve.value - travel);
  }
}

// The land is vector-drawn rather than baked to a texture: the dot grid is a
// Points cloud sized in world units and the coastlines are real line geometry,
// so both stay crisp however far the mission focus dives toward the surface.
// (The old raster version blurred into enlarged texels at lock distance.)
// Every surface layer is drawn twice: a far pass before the glass shell —
// dimmed, cooled, and masked to the far hemisphere — so the structure of the
// other side reads through the ball the way it would in smoked glass, then a
// near pass over the shell at full strength. The near pass depth-tests against
// the shell, so its far hemisphere culls itself.
function addLandLayer(geojson) {
  const materials = [];
  const layers = [
    { geometry: buildLandDotGeometry(geojson), color: LAND_DOT_COLOR },
    { geometry: buildOceanGridGeometry(), color: OCEAN_DOT_COLOR },
  ];
  for (const { geometry, color } of layers) {
    const far = new THREE.Points(geometry, makeDotMaterial(FAR_SIDE_TINT, FAR_SIDE_OPACITY, 1));
    far.renderOrder = 1;
    const near = new THREE.Points(geometry, makeDotMaterial(color, 1, 0));
    near.renderOrder = 3;
    materials.push(far.material, near.material);
    globeRoot.add(far, near);
  }

  const coastFar = buildCoastlines(geojson, 0xbfe9da, .21);
  coastFar.renderOrder = 1;
  const coastNear = buildCoastlines(geojson, 0xecf4f1, .8);
  coastNear.renderOrder = 3;
  globeRoot.add(coastFar, coastNear);

  landLayer = {
    resize() {
      const scale = innerHeight * renderer.getPixelRatio() / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * .5)));
      for (const material of materials) material.uniforms.uScale.value = scale;
    },
  };
  landLayer.resize();
}

const LAND_DOT_COLOR = new THREE.Color(0xe4eeea).convertSRGBToLinear();
const OCEAN_DOT_COLOR = new THREE.Color(0xcee4dc).convertSRGBToLinear();
const FAR_SIDE_TINT = new THREE.Color(0xbfe9da).convertSRGBToLinear();
const FAR_SIDE_OPACITY = .26;

function buildLandDotGeometry(geojson) {
  // The polygon mask only decides which grid cells are land, so a modest
  // raster is plenty — the rendered dots no longer come from these pixels.
  const width = 2048;
  const height = 1024;
  const mask = document.createElement('canvas');
  mask.width = width;
  mask.height = height;
  const maskContext = mask.getContext('2d', { willReadFrequently: true });
  maskContext.fillStyle = '#fff';
  maskContext.strokeStyle = '#fff';
  maskContext.lineWidth = 1;

  forEachPolygon(geojson, (rings) => {
    maskContext.beginPath();
    for (const ring of rings) traceRing(maskContext, ring, width, height);
    maskContext.fill('evenodd');
    if (rings[0]) {
      maskContext.beginPath();
      traceRing(maskContext, rings[0], width, height);
      maskContext.stroke();
    }
  });

  const maskPixels = maskContext.getImageData(0, 0, width, height).data;

  // Same staggered grid, density and brightness statistics as the old texture;
  // sizes carry the world-space footprint its texels had at the 4096 bake.
  const spacing = 4;
  const texelWorld = Math.PI * 2 * EARTH_RADIUS / 4096;
  const radius = EARTH_RADIUS * 1.004;
  const positions = [];
  const sizes = [];
  const alphas = [];
  for (let y = spacing * .5; y < height; y += spacing) {
    const py = Math.floor(y);
    const stagger = ((py / spacing) & 1) * spacing * .5;
    for (let x = spacing * .5 + stagger; x < width; x += spacing) {
      const px = Math.floor(x);
      if (maskPixels[(py * width + px) * 4 + 3] < 100) continue;
      const variation = ((px * 17 + py * 31) % 11) / 11;
      const latitude = 90 - y / height * 180;
      const longitude = x / width * 360 - 180;
      const point = latLonToVector(latitude, longitude, radius);
      positions.push(point.x, point.y, point.z);
      // The lat/lon grid converges toward the poles; shrinking the dots with
      // it keeps high latitudes from reading brighter than the tropics, the
      // way the old texture's compressed texels did.
      const temper = Math.sqrt(Math.max(.3, Math.cos(latitude * Math.PI / 180)));
      sizes.push((variation > .72 ? 3 : 2) * texelWorld * temper);
      alphas.push((.5 + variation * .34) * .94);
    }
  }

  return makeDotGeometry(positions, sizes, alphas);
}

// The grid no longer stops at the coastline: a faint unstaggered lattice
// covers ocean as well, so the sphere reads as a translucent digital shell
// instead of countries floating on a black ball. Fixed columns matter here —
// they line the dots up into meridians that converge at the poles.
function buildOceanGridGeometry() {
  const width = 2048;
  const height = 1024;
  const spacing = 4;
  const texelWorld = Math.PI * 2 * EARTH_RADIUS / 4096;
  const radius = EARTH_RADIUS * 1.004;
  const positions = [];
  const sizes = [];
  const alphas = [];
  for (let y = spacing * .5; y < height; y += spacing) {
    const py = Math.floor(y);
    for (let x = spacing * .5; x < width; x += spacing) {
      const px = Math.floor(x);
      const variation = ((px * 13 + py * 29) % 7) / 7;
      const latitude = 90 - y / height * 180;
      const longitude = x / width * 360 - 180;
      const point = latLonToVector(latitude, longitude, radius);
      positions.push(point.x, point.y, point.z);
      const temper = Math.sqrt(Math.max(.3, Math.cos(latitude * Math.PI / 180)));
      sizes.push(2 * texelWorld * temper);
      alphas.push((.34 + variation * .2) * .94);
    }
  }
  return makeDotGeometry(positions, sizes, alphas);
}

function makeDotGeometry(positions, sizes, alphas) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(sizes), 1));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(alphas), 1));
  return geometry;
}

function makeDotMaterial(color, opacity, farMask) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: color },
      // Device pixels per world unit at unit distance; refreshed on resize.
      uScale: { value: 1 },
      uOpacity: { value: opacity },
      // 1 restricts the pass to the far hemisphere (for the through-the-glass
      // layer); 0 leaves the geometry untouched.
      uFarMask: { value: farMask },
    },
    vertexShader: `
      uniform float uScale;
      uniform float uOpacity;
      uniform float uFarMask;
      attribute float aSize;
      attribute float aAlpha;
      varying float vAlpha;

      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float pixels = aSize * uScale / max(-mvPosition.z, .0001);
        float size = clamp(pixels, 1.3, 22.0);
        // When the clamp lifts a sub-pixel dot, pay the difference in opacity
        // so the zoomed-out view keeps its density instead of brightening.
        float ratio = pixels / size;
        vAlpha = aAlpha * min(1.0, ratio * ratio) * uOpacity;
        // Fades to nothing on the near hemisphere when uFarMask is 1, easing
        // across the limb so the cut never reads as a hard ring.
        float centerZ = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).z;
        float farSide = smoothstep(centerZ + .3, centerZ - .3, mvPosition.z);
        vAlpha *= mix(1.0, farSide, uFarMask);
        gl_PointSize = size;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform vec3 uColor;
      varying float vAlpha;

      void main() {
        vec2 uv = gl_PointCoord * 2.0 - 1.0;
        // Chebyshev distance: a soft-cornered square, like the old fillRect
        // texels, but with an anti-aliased edge at every magnification.
        float d = max(abs(uv.x), abs(uv.y));
        float alpha = (1.0 - smoothstep(.78, 1.0, d)) * vAlpha;
        if (alpha < .004) discard;
        gl_FragColor = vec4(uColor, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

}

// Outer rings only, matching the raster version's stroke pass. Long edges are
// subdivided so the lines hug the sphere instead of chording through it.
function buildCoastlines(geojson, color, opacity) {
  const radius = EARTH_RADIUS * 1.0045;
  const positions = [];
  forEachPolygon(geojson, (rings) => {
    const ring = rings[0];
    if (!ring?.length) return;
    for (let i = 1; i < ring.length; i++) {
      const [lon1, lat1] = ring[i - 1];
      const [lon2, lat2] = ring[i];
      const dLon = lon2 - lon1;
      // Antimeridian wrap; the raster tracer broke the path here too.
      if (Math.abs(dLon) > 180) continue;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dLon), Math.abs(lat2 - lat1)) / 1.2));
      let previous = latLonToVector(lat1, lon1, radius);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const point = latLonToVector(lat1 + (lat2 - lat1) * t, lon1 + dLon * t, radius);
        positions.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
        previous = point;
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
  }));
  return lines;
}

function forEachPolygon(geojson, callback) {
  for (const feature of geojson.features || []) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === 'Polygon') callback(geometry.coordinates);
    if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(callback);
  }
}

function traceRing(context, ring, width, height) {
  if (!ring?.length) return;
  let previousX = null;
  for (let index = 0; index < ring.length; index++) {
    const [longitude, latitude] = ring[index];
    const x = (longitude + 180) / 360 * width;
    const y = (90 - latitude) / 180 * height;
    if (index === 0 || (previousX !== null && Math.abs(x - previousX) > width * .5)) context.moveTo(x, y);
    else context.lineTo(x, y);
    previousX = x;
  }
  context.closePath();
}

function addReferenceGrid() {
  const material = new THREE.LineBasicMaterial({ color: 0x80b3a4, transparent: true, opacity: .085, depthWrite: false });
  for (let latitude = -60; latitude <= 60; latitude += 30) {
    const points = [];
    for (let longitude = -180; longitude <= 180; longitude += 3) points.push(latLonToVector(latitude, longitude, EARTH_RADIUS * 1.007));
    globeRoot.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
  }
  for (let longitude = -150; longitude < 180; longitude += 30) {
    const points = [];
    for (let latitude = -89; latitude <= 89; latitude += 3) points.push(latLonToVector(latitude, longitude, EARTH_RADIUS * 1.007));
    globeRoot.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
  }
}

// Stars are drawn analytically in the fragment shader rather than from a sprite
// texture, so the core stays a hard pinpoint and the bloom stays smooth at any
// pixel ratio. The shell rides with the camera so the sky reads as infinitely
// far: it rotates when you orbit, but never parallaxes or zooms.
function addStarfield() {
  const COUNT = 9000;
  const SHELL_RADIUS = 60;
  // Main-sequence colours, weighted the way the naked-eye sky actually is:
  // mostly blue-white and white, a warm minority, a handful of deep amber.
  const SPECTRUM = [
    { weight: .10, rgb: [.72, .81, 1.00] },
    { weight: .19, rgb: [.86, .91, 1.00] },
    { weight: .26, rgb: [1.00, 1.00, 1.00] },
    { weight: .16, rgb: [1.00, .98, .93] },
    { weight: .13, rgb: [1.00, .93, .80] },
    { weight: .08, rgb: [1.00, .85, .66] },
    { weight: .04, rgb: [1.00, .75, .55] },
    { weight: .04, rgb: [.79, .97, .93] },
  ];
  // A tilted great circle the field crowds toward, so the sky has structure
  // instead of reading as evenly scattered noise.
  const bandNormal = new THREE.Vector3(.42, .86, -.29).normalize();

  const positions = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 3);
  const sizes = new Float32Array(COUNT);
  const brightness = new Float32Array(COUNT);
  const phases = new Float32Array(COUNT);
  const spikes = new Float32Array(COUNT);
  const direction = new THREE.Vector3();

  for (let i = 0; i < COUNT; i++) {
    const z = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const ring = Math.sqrt(1 - z * z);
    direction.set(ring * Math.cos(theta), z, ring * Math.sin(theta));
    if (Math.random() < .34) {
      const along = direction.dot(bandNormal);
      direction.addScaledVector(bandNormal, -along * (.7 + Math.random() * .26)).normalize();
    }
    direction.multiplyScalar(SHELL_RADIUS).toArray(positions, i * 3);

    // Steep magnitude curve: thousands of faint pinpoints, very few bright ones.
    const magnitude = Math.pow(Math.random(), 4.4);
    brightness[i] = .05 + magnitude * .95;
    // Diffraction spikes are reserved for the brightest few percent.
    spikes[i] = Math.pow(Math.max(0, (magnitude - .9) / .1), 2);
    // Bloom widens faster than brightness rises, the way an overexposed star
    // does, and spiked stars need extra sprite for the arms to reach into.
    sizes[i] = 4.4 + magnitude * magnitude * 30 + spikes[i] * 26;
    phases[i] = Math.random();

    let roll = Math.random();
    let band = SPECTRUM[SPECTRUM.length - 1];
    for (const entry of SPECTRUM) {
      if (roll < entry.weight) { band = entry; break; }
      roll -= entry.weight;
    }
    colors.set(band.rgb, i * 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightness, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute('aSpike', new THREE.BufferAttribute(spikes, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SHELL_RADIUS * 1.01);

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uScale: { value: 1 },
    },
    vertexShader: `
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uScale;

      attribute vec3 aColor;
      attribute float aSize;
      attribute float aBrightness;
      attribute float aPhase;
      attribute float aSpike;

      varying vec3 vColor;
      varying float vBrightness;
      varying float vSpike;
      varying float vSize;

      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

        // Two incommensurate frequencies, so scintillation never reads as a loop.
        float seed = aPhase * 6.2831853;
        float twinkle = 1.0
          + 0.30 * sin(uTime * (0.55 + aPhase * 0.9) + seed)
          + 0.16 * sin(uTime * (1.90 + aPhase * 1.3) + seed * 3.1);
        // Faint stars scintillate hardest; bright ones sit steady.
        twinkle = mix(1.0, twinkle, 0.34 + (1.0 - aBrightness) * 0.5);

        vColor = aColor;
        vBrightness = aBrightness * clamp(twinkle, 0.4, 1.6);
        vSpike = aSpike;
        gl_PointSize = aSize * uPixelRatio * uScale * (0.9 + twinkle * 0.1);
        vSize = gl_PointSize;
      }
    `,
    fragmentShader: `
      precision highp float;

      varying vec3 vColor;
      varying float vBrightness;
      varying float vSpike;
      varying float vSize;

      void main() {
        vec2 uv = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(uv, uv);
        if (r2 > 1.0) discard;
        float edge = 1.0 - sqrt(r2);

        // Two-lobe airy disc: a hard pinpoint sitting on a softer shoulder. The
        // lobes widen on small sprites so the core never falls below a pixel and
        // starts shimmering as the sky turns.
        float core = exp(-r2 * min(130.0, vSize * vSize / 6.5))
                   + exp(-r2 * min(34.0, vSize * vSize / 26.0)) * 0.55;
        float bloom = exp(-r2 * 7.0) * 0.24;   // the glow that reads as a light source
        float halo = pow(edge, 2.4) * 0.11;    // long falloff out to the sprite edge

        // Diffraction spikes: hair-thin and long, every star sharing one optical
        // axis the way a real instrument's would. The 45-degree pair stays
        // shorter and fainter, and the taper keeps arms off the sprite edge.
        vec2 a = abs(uv);
        vec2 d = abs(vec2(uv.x + uv.y, uv.x - uv.y) * 0.7071068);
        float axis = exp(-a.y * a.y * 3000.0) * exp(-a.x * 2.2)
                   + exp(-a.x * a.x * 3000.0) * exp(-a.y * 2.2);
        float diagonal = exp(-d.y * d.y * 5000.0) * exp(-d.x * 4.5)
                       + exp(-d.x * d.x * 5000.0) * exp(-d.y * 4.5);
        float spike = (axis + diagonal * 0.3) * pow(edge, 1.2) * vSpike * 0.8;

        // The halo and spikes already reach zero at the rim; window the wider
        // lobes so a small sprite can never show its own circular cut-off.
        float energy = (core + bloom) * smoothstep(0.0, 0.2, edge) + halo + spike;
        // Only the saturated core burns out to white; softer light keeps the star's colour.
        vec3 tint = mix(vColor, vec3(1.0), clamp(core / max(energy, 1e-4), 0.0, 1.0) * 0.85);
        gl_FragColor = vec4(tint, clamp(energy * vBrightness, 0.0, 1.0));
      }
    `,
  });

  const stars = new THREE.Points(geometry, material);
  stars.frustumCulled = false;
  stars.renderOrder = 20;
  scene.add(stars);

  return {
    update(elapsedMs) {
      // Ride with the camera, so the sky never gets nearer or further.
      stars.position.copy(camera.position);
      if (!reducedMotion) material.uniforms.uTime.value = elapsedMs / 1000;
    },
    resize() {
      material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
      material.uniforms.uScale.value = THREE.MathUtils.clamp(Math.min(innerWidth, innerHeight) / 900, .72, 1.15);
    },
  };
}

// Meteors share the starfield's camera-riding shell, just inside it, so they
// read as part of the sky: orbiting swings them with the stars, zooming never
// brings them closer, and the globe occludes any that cross behind it. Each is
// a camera-facing ribbon laid along a short great-circle arc; the shader
// slides a white-hot head down the arc and decays the ionisation train left
// behind it, so the streak is a genuine trail through the sky rather than a
// stretched sprite. A small pool of ribbons is re-aimed with uniforms —
// spawning never allocates or rebuilds geometry.
function addShootingStars() {
  const POOL = 8;
  const SHELL_RADIUS = 58;
  const SEGMENTS = 72;
  // Sporadic cadence: one every 9–15 seconds, at a random point in that
  // window. The first arrives early enough to be seen without hunting for it.
  const FIRST_DELAY = () => 1800 + Math.random() * 2600;
  const NEXT_DELAY = () => 9000 + Math.random() * 6000;

  // One ribbon serves every meteor. The along coordinate overshoots both ends
  // of the arc so the head glow is never clipped while entering or leaving;
  // the vertex shader collapses whatever stretch is currently unlit.
  const vertexCount = (SEGMENTS + 1) * 2;
  const along = new Float32Array(vertexCount);
  const side = new Float32Array(vertexCount);
  const indices = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const u = -.08 + (i / SEGMENTS) * 1.16;
    along[i * 2] = u;
    along[i * 2 + 1] = u;
    side[i * 2] = -1;
    side[i * 2 + 1] = 1;
    if (i < SEGMENTS) indices.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const geometry = new THREE.BufferGeometry();
  // Placement comes entirely from uniforms; the position attribute only exists
  // because the renderer expects one.
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
  geometry.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  geometry.setIndex(indices);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SHELL_RADIUS * 1.05);

  const vertexShader = `
    uniform vec3 uStart;
    uniform vec3 uEnd;
    uniform float uRadius;
    uniform float uHead;
    uniform float uTrail;
    uniform float uWidth;

    attribute float aAlong;
    attribute float aSide;

    varying float vAlong;
    varying float vSide;

    void main() {
      vAlong = aAlong;
      vSide = aSide;

      // Normalised lerp walks the great circle between the endpoints, and
      // keeps walking it when aAlong steps past them for the glow padding.
      vec3 centre = normalize(mix(uStart, uEnd, aAlong)) * uRadius;

      // The group origin rides at the camera, so the vertex direction is the
      // view ray, and the ribbon turns its width to face it.
      vec3 tangent = normalize(uEnd - uStart);
      vec3 facing = normalize(cross(tangent, normalize(centre)));

      // Width follows the light: a taper thinning toward the tail of the
      // train, a round bulge under the head, nothing where the ribbon is
      // unlit.
      float behind = uHead - aAlong;
      float taper = 1.0 - clamp(behind / uTrail, 0.0, 1.0);
      float train = mix(0.3, 1.0, taper)
        * smoothstep(-0.015, 0.0, behind)
        * (1.0 - smoothstep(uTrail * 0.85, uTrail, behind));
      float head = 1.25 * exp(-behind * behind * 130.0);
      float width = uWidth * max(train, head);

      gl_Position = projectionMatrix * modelViewMatrix * vec4(centre + facing * (aSide * width), 1.0);
    }
  `;

  const fragmentShader = `
    precision highp float;

    uniform float uHead;
    uniform float uTrail;
    uniform float uWidth;
    uniform float uArc;
    uniform float uEnvelope;
    uniform float uBrightness;
    uniform float uWarm;
    uniform float uSeed;

    varying float vAlong;
    varying float vSide;

    void main() {
      float behind = uHead - vAlong;
      float age = clamp(behind / uTrail, 0.0, 1.0);

      // The brightness the head had when it deposited this stretch of train:
      // meteors flare up after onset and die before the end of the path, and
      // the train they leave remembers that.
      float deposit = smoothstep(0.0, 0.16, vAlong) * (1.0 - smoothstep(0.68, 1.0, vAlong));
      float headLife = smoothstep(0.0, 0.16, uHead) * (1.0 - smoothstep(0.68, 1.0, uHead));

      // The train: a hot filament inside a softer sheath, decaying behind the
      // head, with a slight ripple so it reads as turbulence, not airbrush.
      float lit = smoothstep(-0.008, 0.006, behind) * (1.0 - smoothstep(uTrail * 0.8, uTrail, behind));
      float decay = pow(1.0 - age, 1.65);
      float ripple = 0.86 + 0.14 * sin(vAlong * 61.0 + uSeed) * sin(vAlong * 23.0 + uSeed * 1.7);
      float profile = exp(-vSide * vSide * 38.0) + exp(-vSide * vSide * 8.0) * 0.5;
      float train = lit * decay * deposit * ripple * profile;

      // The head: a white-hot core inside a round bloom, measured in world
      // units so it stays circular however the ribbon is angled.
      float alongWorld = behind * uArc;
      float acrossWorld = vSide * uWidth * 1.25;
      float r2 = alongWorld * alongWorld + acrossWorld * acrossWorld;
      float w2 = uWidth * uWidth;
      float head = (exp(-r2 / (w2 * 0.035)) * 1.7 + exp(-r2 / (w2 * 0.5)) * 0.32) * headLife;

      // Fresh train burns close to white and cools toward the scene's teal as
      // it fades — or toward ember-orange for the warm fireballs.
      vec3 fresh = mix(vec3(0.72, 1.0, 0.9), vec3(1.0, 0.8, 0.55), uWarm);
      vec3 faded = mix(vec3(0.42, 0.78, 0.71), vec3(0.85, 0.6, 0.4), uWarm * 0.6);
      vec3 colour = mix(faded, fresh, decay) * train + vec3(0.92, 1.0, 0.97) * head;
      gl_FragColor = vec4(colour * (uEnvelope * uBrightness), 1.0);
    }
  `;

  const group = new THREE.Group();
  scene.add(group);

  const meteors = [];
  for (let i = 0; i < POOL; i++) {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // The camera-facing width comes from a cross product whose screen
      // winding is the same for every ribbon — with front-side culling that
      // is a coin flip away from culling every meteor ever spawned. Render
      // both sides; additive light has no wrong side anyway.
      side: THREE.DoubleSide,
      uniforms: {
        uStart: { value: new THREE.Vector3(0, 0, 1) },
        uEnd: { value: new THREE.Vector3(0, .1, 1) },
        uRadius: { value: SHELL_RADIUS },
        uHead: { value: -1 },
        uTrail: { value: .4 },
        uWidth: { value: .6 },
        uArc: { value: 10 },
        uEnvelope: { value: 0 },
        uBrightness: { value: 1 },
        uWarm: { value: 0 },
        uSeed: { value: 0 },
      },
      vertexShader,
      fragmentShader,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 21;
    group.add(mesh);
    meteors.push({ material, mesh, active: false, start: 0, crossTime: 1, life: 1 });
  }

  // Scratch vectors for aiming a spawn; nothing here allocates per meteor.
  const up = new THREE.Vector3();
  const toGlobe = new THREE.Vector3();
  const candidate = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const acrossSky = new THREE.Vector3();
  const downSky = new THREE.Vector3();
  const travel = new THREE.Vector3();

  let nextSpawn = FIRST_DELAY();

  function spawn(now) {
    const meteor = meteors.find((entry) => !entry.active);
    if (!meteor) return;

    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    pickMidpoint();

    // Travel lives in the tangent plane at the midpoint, flipped to run
    // screen-downward most of the time — the fall the eye expects.
    acrossSky.crossVectors(mid, up).normalize();
    downSky.crossVectors(mid, acrossSky).normalize();
    const roll = Math.random() * Math.PI * 2;
    travel.copy(acrossSky).multiplyScalar(Math.cos(roll)).addScaledVector(downSky, Math.sin(roll)).normalize();
    if (travel.dot(up) > 0 && Math.random() < .74) travel.multiplyScalar(-1);

    aimArc(meteor, now);
  }

  function pickMidpoint() {
    // Aim in screen space: sample points inside the visible frame, unproject
    // them into sky directions, and take the first that clears the globe's
    // disc — a meteor spawned behind the globe is just depth-culled sky. The
    // lower frame is sampled less because the interface lives there. When the
    // globe swallows the whole frame (deep zoom in a narrow window) the
    // least-buried candidate still wins, so streaks graze the rim instead of
    // vanishing entirely.
    const globeDistance = camera.position.distanceTo(globeRoot.position);
    const globeAngle = Math.asin(Math.min(1, (EARTH_RADIUS + .25) / globeDistance));
    toGlobe.copy(globeRoot.position).sub(camera.position).normalize();
    let bestClearance = -Infinity;
    for (let attempt = 0; attempt < 10; attempt++) {
      candidate.set((Math.random() * 2 - 1) * .86, -.7 + Math.random() * 1.6, .5)
        .unproject(camera).sub(camera.position).normalize();
      const clearance = candidate.angleTo(toGlobe) - globeAngle;
      if (clearance > bestClearance) {
        bestClearance = clearance;
        mid.copy(candidate);
      }
      if (clearance > .055) break;
    }
  }

  // Lays the arc through `mid` along `travel` and rolls the meteor's
  // character: a small minority are fireballs — longer arcs that burn wider,
  // brighter, and with a warm cast the ordinary streaks never show.
  function aimArc(meteor, now) {
    const fireball = Math.random() < .16;
    const half = fireball ? .16 + Math.random() * .07 : .07 + Math.random() * .07;
    const uniforms = meteor.material.uniforms;
    uniforms.uStart.value.copy(mid).multiplyScalar(Math.cos(half)).addScaledVector(travel, -Math.sin(half)).normalize();
    uniforms.uEnd.value.copy(mid).multiplyScalar(Math.cos(half)).addScaledVector(travel, Math.sin(half)).normalize();
    uniforms.uArc.value = half * 2 * SHELL_RADIUS;
    uniforms.uTrail.value = fireball ? .5 + Math.random() * .15 : .34 + Math.random() * .18;
    uniforms.uWidth.value = fireball ? .85 + Math.random() * .3 : .5 + Math.random() * .22;
    uniforms.uBrightness.value = fireball ? 1.15 + Math.random() * .35 : .6 + Math.random() * .45;
    uniforms.uWarm.value = fireball ? .25 + Math.random() * .45 : Math.random() * .15;
    uniforms.uSeed.value = Math.random() * 100;
    uniforms.uEnvelope.value = 0;
    uniforms.uHead.value = -.04;

    meteor.crossTime = fireball ? 1.05 + Math.random() * .4 : .62 + Math.random() * .43;
    // Lifetime covers the crossing plus however long the train needs to burn
    // off after the head leaves the far end of the arc.
    meteor.life = meteor.crossTime * (1.1 + uniforms.uTrail.value);
    meteor.start = now;
    meteor.active = true;
    meteor.mesh.visible = true;
  }

  return {
    // Fires one immediately, cadence and reduced-motion preference aside —
    // an explicit request always shows a meteor.
    launch() {
      spawn(performance.now());
    },
    update(elapsedMs) {
      // Ride with the camera, like the stars: never nearer, never further.
      group.position.copy(camera.position);
      if (!reducedMotion && elapsedMs >= nextSpawn) {
        spawn(elapsedMs);
        nextSpawn = elapsedMs + NEXT_DELAY();
      }
      for (const meteor of meteors) {
        if (!meteor.active) continue;
        const age = (elapsedMs - meteor.start) / 1000;
        if (age >= meteor.life) {
          meteor.active = false;
          meteor.mesh.visible = false;
          continue;
        }
        const uniforms = meteor.material.uniforms;
        uniforms.uHead.value = -.04 + age / meteor.crossTime;
        // Guard fades only; the visible rise and die-off are shaped in-shader
        // from where the head is along its path.
        uniforms.uEnvelope.value = Math.min(1, age / .09) * Math.min(1, Math.max(0, meteor.life - age) / .28);
      }
    },
  };
}

// A corona rather than a dot: the spacecraft itself is now the bright thing in
// the middle, so this peaks in a ring just outside the model and stays dim at
// the centre, where it would otherwise wash the white hull green.
function makeGlowTexture() {
  const image = document.createElement('canvas');
  image.width = image.height = 128;
  const context = image.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(150,255,224,.16)');
  gradient.addColorStop(.22, 'rgba(96,248,203,.34)');
  gradient.addColorStop(.45, 'rgba(48,235,180,.15)');
  gradient.addColorStop(.74, 'rgba(32,231,173,.045)');
  gradient.addColorStop(1, 'rgba(32,231,173,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(image);
}

function latLonToVector(latitude, longitude, radius) {
  const phi = THREE.MathUtils.degToRad(90 - latitude);
  const theta = THREE.MathUtils.degToRad(longitude + 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

function positionScene() {
  const narrow = innerWidth <= 760;
  const veryNarrow = innerWidth <= 520;
  const centre = new THREE.Vector3(
    narrow ? 0 : -.52,
    veryNarrow ? -.25 : narrow ? -.05 : -.08,
    0
  );
  const offset = sceneFramed
    ? camera.position.clone().sub(controls.target)
    : new THREE.Vector3(0, .12, THREE.MathUtils.lerp(controls.maxDistance, controls.minDistance, START_ZOOM_FRACTION));
  sceneFramed = true;
  globeRoot.position.copy(centre);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  // While the mission focus owns the camera, leave it alone: the follow logic
  // re-frames against the moved globe next tick, and controls.update() here
  // would clamp the close-in camera back out to minDistance.
  if (!focusState.active) {
    controls.target.copy(centre);
    camera.position.copy(centre).add(offset);
    controls.update();
  }
  starfield.resize();
  landLayer?.resize();
  // The link ribbons are widened in pixels, so the shader needs the viewport it
  // is converting through.
  linkNetwork.material.uniforms.uHalfRes.value.set(innerWidth / 2, innerHeight / 2);
}

function render() {
  const elapsed = performance.now();
  sampleFrameRate(elapsed);
  if (elapsed - lastPropagation > PROPAGATION_INTERVAL) {
    propagateSatellites(new Date());
    lastPropagation = elapsed;
  }
  updateSatellitePositions(elapsed);
  if (satelliteRecords.length && elapsed - lastOrbitBuild > 10 * 60 * 1000) buildOrbitPaths(new Date());

  const deltaSeconds = Math.min(.1, (elapsed - previousFrame) / 1000);
  previousFrame = elapsed;
  // Who is linked to whom is re-solved on its own slow cadence; where those
  // links are drawn is refreshed every frame, because the fleet glides between
  // propagation ticks and a stale endpoint detaches from its spacecraft.
  if (networkVisible && elapsed - lastLinkTopology > LINK_RETOPO_MS) rebuildLinkTopology();
  updateLinkNetwork(elapsed, deltaSeconds);
  if (entryState.active) {
    updateMissionEntry(elapsed, deltaSeconds);
  } else if (focusState.active) {
    updateFocus(elapsed, deltaSeconds);
  } else {
    if (controls.autoRotate && autoRotateRamp < 1) {
      autoRotateRamp = Math.min(1, autoRotateRamp + deltaSeconds / RESUME_RAMP);
      const eased = autoRotateRamp * autoRotateRamp * (3 - 2 * autoRotateRamp);
      controls.autoRotateSpeed = AUTO_ROTATE_SPEED * eased;
    }
    controls.update(deltaSeconds);
  }
  updateReleaseTint(deltaSeconds);
  starfield.update(elapsed);
  shootingStars.update(elapsed);
  updateHover();
  updateTooltipPosition();
  updateFocusCardPosition();
  renderer.render(scene, camera);
}

function updateHover() {
  if (!satellitePoints) return;
  // While the camera is flying, hover results are noise; while locked, the
  // focused spacecraft already has the focus card, so it never re-tooltips.
  if (entryState.active || (focusState.active && focusState.phase !== 'locked')) {
    hoveredSatellite = -1;
    setCursor('default');
    hideTooltip();
    return;
  }
  // Dragging the globe is navigating, not inspecting — and with the card down
  // for the duration there is nothing a raycast could be asked about. The
  // cursor holds the grip for the whole drag rather than flickering to a
  // crosshair over every satellite that happens to pass under it.
  if (pointerDown) {
    hoveredSatellite = -1;
    setCursor('grabbing');
    hideTooltip();
    return;
  }
  const now = performance.now();
  // Past this the cursor counts as standing still, which is what separates the
  // fleet drifting out from under it from the viewer moving away.
  const parked = now - lastMoveAt > HOVER_STILL_MS;

  raycaster.setFromCamera(pointer, camera);
  // The occlusion test below runs in the globe's own space, where the Earth is
  // a sphere about the origin however the globe has turned.
  globeRoot.worldToLocal(hoverCamera.copy(camera.position));
  // Whichever satellite the cursor is already committed to wins the raycast
  // while the cursor is parked: the fleet never stops moving, and a neighbour
  // drifting past must not be able to steal a card the viewer is still reading,
  // or restart an acquisition that is half done.
  const sticky = tooltipShown ? tooltipIndex : hoverTarget;
  let hit = null;
  for (const candidate of raycaster.intersectObject(satellitePoints, false)) {
    if (focusState.active && candidate.index === focusState.index) continue;
    const record = satelliteRecords[candidate.index];
    if (!record || behindGlobe(record)) continue;
    if (parked && candidate.index === sticky) { hit = candidate; break; }
    if (!hit) hit = candidate;
  }
  hoveredSatellite = hit?.index ?? -1;
  setCursor(hoveredSatellite >= 0 ? 'crosshair' : focusState.active ? 'default' : 'grab');

  // Two clocks run against each other, and crossing a dot on the way past
  // restarts neither. One times how long the cursor has been acquiring the
  // satellite it is on; the other, how long the open card's satellite has been
  // abandoned. Whichever lands first decides — so settling on a neighbour hands
  // the card over, and sweeping across a cluster puts the card down instead of
  // dragging a stale one along behind the cursor.

  // Still on the card that is up: hold it, and keep the acquisition clock
  // pinned here so moving on to a neighbour starts that one from scratch.
  if (tooltipShown && hoveredSatellite === tooltipIndex) {
    hoverLostAt = 0;
    hoverTarget = hoveredSatellite;
    hoverSince = now;
    hoverAnchor.copy(pointer);
    return;
  }

  if (hoveredSatellite < 0) {
    hoverTarget = -1;
    hoverSince = 0;
  } else if (hoveredSatellite !== hoverTarget) {
    // A cursor that has not travelled past its anchor is still pointing at the
    // same place, whichever of two overlapping dots currently answers; one that
    // has is sweeping, and has to start earning a card again.
    if (hoverTarget < 0 || pointerTravel(hoverAnchor) > HOVER_SLACK_PX) {
      hoverSince = now;
      hoverAnchor.copy(pointer);
    }
    hoverTarget = hoveredSatellite;
  }

  // A card is earned outright by the dwell; with one already up, a neighbour
  // only has to settle long enough to be taken over.
  if (hoverTarget >= 0 && now - hoverSince >= (tooltipShown ? HOVER_RETARGET_MS : HOVER_DWELL_MS)) {
    tooltipIndex = hoverTarget;
    hoverLostAt = 0;
    showTooltip(tooltipIndex);
    return;
  }
  if (!tooltipShown) return;

  // The open card's satellite is not the target any more. This clock runs from
  // the moment it was lost and is never restarted, so the card comes down in a
  // bounded time however far the cursor wanders in the meantime.
  if (!hoverLostAt) {
    hoverLostAt = now;
    lostWhileParked = parked;
  }
  if (hoveredSatellite < 0) {
    // A dot drifting off a standing cursor gets the grace window. A cursor that
    // was moving when it left has left on purpose, and the card goes at once.
    if (lostWhileParked && now - hoverLostAt < HOVER_GRACE_MS) return;
  } else if (now - hoverLostAt < HOVER_HANDOVER_MS) {
    return;
  }
  hideTooltip();
}

// Cursor travel since an anchor, in screen pixels. The pointer is kept in the
// normalised space the raycaster wants, so the conversion lives here rather
// than a second copy of the cursor position being threaded through the move
// handler.
function pointerTravel(anchor) {
  return Math.hypot((pointer.x - anchor.x) * innerWidth, (pointer.y - anchor.y) * innerHeight) * .5;
}

// Assigning the same cursor every frame is a style write the canvas does not
// need, so only changes are handed to the DOM.
let cursorStyle = '';
function setCursor(value) {
  if (cursorStyle === value) return;
  cursorStyle = value;
  canvas.style.cursor = value;
}

// The globe is a translucent shell, so the far hemisphere's satellites are
// still drawn and were still answering the pointer — which left almost nowhere
// to put the cursor to dismiss a card, since the whole disc of the Earth is
// backed by dots on its far side. Only the hemisphere facing the camera is
// pointable now.
function behindGlobe(record) {
  // Closest approach of the camera-to-satellite segment to the globe's centre,
  // which sits at the origin of this space.
  const toSatellite = hoverSegment.subVectors(record.position, hoverCamera);
  const lengthSq = toSatellite.lengthSq();
  if (lengthSq < 1e-8) return false;
  const along = -hoverCamera.dot(toSatellite) / lengthSq;
  // Nearest point is behind the camera or past the satellite: the Earth is not
  // between the two, whatever else it is doing.
  if (along <= 0 || along >= 1) return false;
  return toSatellite.multiplyScalar(along).add(hoverCamera).lengthSq() < EARTH_RADIUS * EARTH_RADIUS;
}

function hideTooltip() {
  tooltipIndex = -1;
  hoverLostAt = 0;
  hoverSince = 0;
  hoverTarget = -1;
  if (!tooltipShown) return;
  tooltipShown = false;
  // Moving away is not a moment that wants a snap, so the card fades out where
  // it stands rather than blinking off.
  tooltip.classList.remove('is-visible');
  clearTimeout(tooltipHideTimer);
  tooltipHideTimer = setTimeout(() => { tooltip.hidden = true; }, TOOLTIP_FADE_MS);
}

function showTooltip(index) {
  const record = satelliteRecords[index];
  if (!record) return;
  const profile = record.profile;

  tooltipName.textContent = record.name;
  // Two deliberate lines rather than "kind · orbit" left to wrap wherever it
  // lands: what the object is, then where it flies.
  tooltipKind.textContent = ARCHETYPE_LABELS[record.variant] || 'Tracked object';
  tooltipOrbit.textContent = profile.orbitClass;

  // Who flies it and whether it still answers, joined from SATCAT (with the
  // mirror's country as fallback). The flag holds the card's top-right corner;
  // the owner's name is spelled out on the origin line below.
  const metadata = satelliteMetadata(record);
  tooltipFlag.hidden = !metadata.owner;
  tooltipFlag.textContent = metadata.owner ? metadata.owner.flag : '';
  tooltip.classList.toggle('has-flag', Boolean(metadata.owner));

  // Altitude and speed lead because they are the two figures that land without
  // any orbital background: how far up, and how fast.
  tooltipAltitude.textContent = `${Math.round(record.altitude).toLocaleString()} km`;
  tooltipSpeed.textContent = record.speed ? `${record.speed.toFixed(2)} km/s` : '—';

  const rows = [
    // Blank status codes (nearly all debris and rocket bodies) draw no row.
    metadata.status && ['Status', metadata.status.label, metadata.status.tone],
    ['Period', formatPeriod(profile.periodMinutes)],
    ['Inclination', `${profile.inclination.toFixed(1)}°`],
    // A circular orbit's apogee and perigee say nothing; an elliptical one's
    // are the most interesting thing about it.
    // One "km" for the pair, not two — at this type size the row overflows the
    // card otherwise.
    profile.elliptical && ['Apogee / perigee', `${formatKm(profile.apogee)} × ${formatKm(profile.perigee)} km`],
    ['Ground track', formatGroundTrack(record.latitude, record.longitude)],
    // One model stands in for a whole docked complex, so say how much of the
    // catalogue is flying inside the object being pointed at.
    record.companions.length && ['Docked with', formatCompanions(record.companions)],
  ].filter(Boolean);
  tooltipDetail.replaceChildren(...rows.map(([label, value, tone]) => {
    const row = document.createElement('div');
    row.className = 'tip-row';
    const term = document.createElement('span');
    term.textContent = label;
    const figure = document.createElement('span');
    figure.textContent = value;
    if (tone) figure.classList.add(tone);
    row.append(term, figure);
    return row;
  }));

  tooltipOrigin.textContent = [
    metadata.owner?.label,
    profile.launchYear && `Launched ${profile.launchYear}`,
    profile.orbits && `${profile.orbits.toLocaleString()} orbits flown`,
    `NORAD ${record.id}`,
  ].filter(Boolean).join(' · ');

  clearTimeout(tooltipHideTimer);
  tooltip.hidden = false;
  tooltipShown = true;
  // Measured here rather than once a frame: the rows have just been rebuilt, and
  // short of a resize nothing else changes the card's size while it is up.
  tooltipBox = tooltip.getBoundingClientRect();
  // Placed before it fades up, or its first frame lands wherever the last card
  // was sitting.
  updateTooltipPosition();
  requestAnimationFrame(() => { if (tooltipShown) tooltip.classList.add('is-visible'); });
}

// LEO orbits run 88 to 100 minutes, and "1 h 32 min" is a worse way to say 92
// than "92.4 min" is. Only past two hours does the split help.
function formatPeriod(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  if (minutes < 120) return `${minutes.toFixed(1)} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${Math.round(minutes - hours * 60)} min`;
}

function formatKm(value) {
  return Math.round(value).toLocaleString();
}

function formatGroundTrack(latitude, longitude) {
  const lat = `${Math.abs(latitude).toFixed(1)}°${latitude >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(longitude).toFixed(1)}°${longitude >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}

// One companion is worth naming; a station's worth of them would overflow the
// card, so past that it is the count that carries the point.
function formatCompanions(names) {
  return names.length === 1 ? names[0] : `${names.length} tracked objects`;
}

function updateTooltipPosition() {
  if (tooltipIndex < 0 || tooltip.hidden) return;
  const point = tooltipAnchor.copy(satelliteRecords[tooltipIndex].position);
  globeRoot.localToWorld(point);
  point.project(camera);

  // The card is anchored by its left edge and vertical centre (see the transform
  // in the stylesheet), so keep that anchor far enough inside the viewport that
  // the whole card stays on screen — it is tall enough now to clip otherwise.
  // Reading the box back here instead would force a layout every frame, since
  // the lines below write to the same element.
  const box = tooltipBox ?? (tooltipBox = tooltip.getBoundingClientRect());
  const left = (point.x * .5 + .5) * innerWidth;
  const top = (-point.y * .5 + .5) * innerHeight;
  const margin = 12;
  tooltip.style.left = `${Math.min(left, innerWidth - box.width - margin - 14)}px`;
  tooltip.style.top = `${clamp(top, box.height / 2 + margin, innerHeight - box.height / 2 - margin)}px`;
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

canvas.addEventListener('pointermove', (event) => {
  pointer.x = event.clientX / innerWidth * 2 - 1;
  pointer.y = -(event.clientY / innerHeight) * 2 + 1;
  lastMoveAt = performance.now();
});

canvas.addEventListener('pointerdown', () => {
  pointerDown = true;
  hideTooltip();
});

// A drag that ends over a satellite should not hand out a card for free: the
// dwell starts from the moment the globe is let go.
addEventListener('pointerup', () => {
  pointerDown = false;
  lastMoveAt = performance.now();
});

canvas.addEventListener('pointercancel', () => {
  pointerDown = false;
  lastMoveAt = performance.now();
});

canvas.addEventListener('pointerleave', () => {
  pointer.set(9, 9);
  hoveredSatellite = -1;
  hideTooltip();
});

addEventListener('resize', () => {
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.8));
  renderer.setSize(innerWidth, innerHeight, false);
  // The only thing that resizes the card without rewriting it, so the cached
  // measurement has to be dropped here.
  tooltipBox = null;
  positionScene();
});

/* -------------------------------------------------------------------------
   Mission focus — behaviour
   ------------------------------------------------------------------------- */

function easeInOutCubic(t) {
  return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Great-circle angle between a satellite's ground point and a mission region.
function groundAngleTo(record, region) {
  const a = THREE.MathUtils.degToRad(record.latitude);
  const b = THREE.MathUtils.degToRad(region.lat);
  const spread = THREE.MathUtils.degToRad(region.lon - record.longitude);
  const cosine = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(spread);
  return Math.acos(THREE.MathUtils.clamp(cosine, -1, 1));
}

function nearestRecordTo(region) {
  let record = null;
  let index = -1;
  let bestAngle = Infinity;
  for (let i = 0; i < satelliteRecords.length; i++) {
    const candidate = satelliteRecords[i];
    if (candidate.position.lengthSq() === 0) continue; // never propagated
    const angle = groundAngleTo(candidate, region);
    if (angle < bestAngle) { bestAngle = angle; record = candidate; index = i; }
  }
  return { record, index };
}

function focusOnMission(key) {
  const mission = missions[key];
  if (!mission?.region) return;
  if (entryState.active) return;
  if (focusState.active && focusState.key === key && focusState.phase !== 'exit') return;
  if (!satelliteRecords.length) {
    // Nothing propagated yet (first paint, or the catalogue failed) — remember
    // the wish briefly and fulfil it when element sets arrive.
    focusState.pendingKey = key;
    focusState.pendingAt = performance.now();
    return;
  }
  const { record, index } = nearestRecordTo(mission.region);
  if (!record) return;

  const wasActive = focusState.active;
  const sameRecord = wasActive && record === focusState.record;
  // A switch mid-focus starts the new flight from the exact current pose: the
  // gaze keeps pointing wherever it was (usually the old spacecraft) and pans
  // away over the align curve, rather than snapping to the globe's centre for
  // one frame — that snap reads as a jump cut.
  focusState.alignFromTarget.copy(wasActive ? focusState.lookTarget : globeRoot.position);
  focusState.tintFrom = sameRecord ? focusState.tint : 0;
  if (!sameRecord && focusState.releaseRecord === record) {
    // Re-locking a spacecraft that is still fading out: adopt its remaining tint.
    focusState.tintFrom = focusState.releaseTint;
    focusState.releaseRecord = null;
    focusState.releaseIndex = -1;
  }
  if (wasActive && !sameRecord) {
    // The outgoing highlight fades on its own clock instead of snapping white.
    if (focusState.releaseRecord) writeTintFor(focusState.releaseIndex, focusState.releaseRecord, 0);
    focusState.releaseRecord = focusState.record;
    focusState.releaseIndex = focusState.index;
    focusState.releaseTint = focusState.tint;
  }
  if (wasActive) {
    focusRing.visible = false;
    focusRing.material.opacity = 0;
  }
  hoveredSatellite = -1;
  hideTooltip();
  hideFocusCard();

  const offset = camera.position.clone().sub(globeRoot.position);
  // Where "back out" returns to: the viewer's own zoom level from before the
  // first focus, preserved across mission-to-mission switches.
  if (!wasActive) {
    focusState.returnDistance = THREE.MathUtils.clamp(offset.length(), controls.minDistance, controls.maxDistance);
  }
  focusState.active = true;
  focusState.phase = 'align';
  focusState.key = key;
  focusState.record = record;
  focusState.index = index;
  focusState.pendingKey = null;
  focusState.tint = focusState.tintFrom;
  focusState.alignFromDistance = offset.length();
  focusState.alignFromDir.copy(offset).normalize();
  focusState.lookTarget.copy(focusState.alignFromTarget);
  focusState.ringScale = .18 + .14 * record.modelScale;
  // Dress the target in the mission's own hardware, or hand the last one back
  // to the fleet if this mission has none of its own.
  satelliteFleet.setStandIn(record, mission.model || null);

  // Longer slews get more time, so a quarter turn and a half turn read at the
  // same angular pace.
  const angle = focusState.alignFromDir.angleTo(focusUp.copy(record.position).normalize());
  focusState.alignDuration = reducedMotion ? 0 : .55 + angle / Math.PI * 1.5;
  focusState.approachDuration = reducedMotion ? 0 : 1.45;
  focusState.phaseStart = performance.now();

  controls.enabled = false;
  controls.autoRotate = false;
  autoRotateRamp = 0;
  clearTimeout(resumeRotationTimer);

  updateFocusCardContent(mission, record);
}

function exitFocus() {
  if (entryState.active) return; // the dive is committed — no backing out mid-plunge
  if (!focusState.active || focusState.phase === 'exit') return;
  focusState.phase = 'exit';
  focusState.phaseStart = performance.now();
  focusState.exitDuration = reducedMotion ? 0 : 1.05;
  focusState.exitFromTint = focusState.tint;
  focusState.exitFromCamera.copy(camera.position);
  focusState.exitFromTarget.copy(focusState.lookTarget);
  focusState.exitDir.copy(camera.position).sub(globeRoot.position).normalize();
  hideFocusCard();
}

function finishFocusExit() {
  restoreFocusVisuals();
  focusState.active = false;
  focusState.phase = 'idle';
  focusState.record = null;
  focusState.index = -1;
  focusState.key = null;
  controls.target.copy(globeRoot.position);
  // If a focus exit lands while the entry dive owns the camera, the viewer
  // must not get the controls (or the idle spin) back mid-plunge.
  controls.enabled = !entryState.active;
  controls.update();
  if (!reducedMotion && !entryState.active) {
    clearTimeout(resumeRotationTimer);
    resumeRotationTimer = setTimeout(() => { controls.autoRotate = true; }, RESUME_DELAY);
  }
}

function restoreFocusVisuals() {
  focusRing.visible = false;
  focusRing.material.opacity = 0;
  setFocusTint(0);
  // Held until the very end of the fly-out: swapping the model back is a pop,
  // and it costs nothing once the spacecraft is a dot again.
  satelliteFleet.setStandIn(null, null);
}

function setFocusTint(strength) {
  focusState.tint = strength;
  writeTintFor(focusState.index, focusState.record, strength);
}

// The outgoing spacecraft of a mission switch dims over a few tenths of a
// second on the render loop's clock, whatever phase the new focus is in.
function updateReleaseTint(deltaSeconds) {
  if (!focusState.releaseRecord) return;
  focusState.releaseTint = reducedMotion ? 0 : Math.max(0, focusState.releaseTint - deltaSeconds * 2.5);
  writeTintFor(focusState.releaseIndex, focusState.releaseRecord, focusState.releaseTint);
  if (!focusState.releaseTint) {
    focusState.releaseRecord = null;
    focusState.releaseIndex = -1;
  }
}

// Drives both halves of one spacecraft's highlight: the instanced hull and
// panels tint toward mission green while the additive corona dims, so it
// reads as a green machine rather than a green blob. Strength 0 restores the
// resting look. Guarded against stale indices across mesh rebuilds.
function writeTintFor(index, record, strength) {
  if (index < 0 || satelliteRecords[index] !== record) return;
  if (!satellitePoints) return;
  focusColor.copy(INSTANCE_WHITE).lerp(FOCUS_TINT, strength);
  satelliteFleet.setTint(record, focusColor);
  // Dim the corona rather than killing it: a third survives as a green aura,
  // which keeps the highlight reading green even when a wing catches the sun
  // glint (specular light ignores the instance tint).
  focusColor.set(index % 9 === 0 ? 0xa8ffe4 : 0x63f2c4).multiplyScalar(1 - strength * .7);
  satellitePoints.geometry.attributes.color.setXYZ(index, focusColor.r, focusColor.g, focusColor.b);
  satellitePoints.geometry.attributes.color.needsUpdate = true;
}

// The along-track direction, used to lean the locked camera slightly off the
// straight-down axis so the spacecraft shows depth instead of a flat top view.
function focusTangent(record, out) {
  out.copy(record.heading);
  if (out.lengthSq() < 1e-8) out.set(record.position.z, 0, -record.position.x);
  focusRadial.copy(record.position).normalize();
  out.addScaledVector(focusRadial, -out.dot(focusRadial));
  if (out.lengthSq() < 1e-8) out.set(1, 0, 0);
  return out.normalize();
}

function updateFocus(now, deltaSeconds) {
  const record = focusState.record;
  if (!record) { finishFocusExit(); return; }
  const centre = globeRoot.position;
  focusWorld.copy(record.position).add(centre);
  focusUp.copy(record.position).normalize();
  const satelliteRadius = record.position.length();

  if (focusState.phase === 'align') {
    // Swing around the globe at a fixed-ish radius until the target satellite
    // sits between the camera and the Earth's centre.
    const t = focusState.alignDuration ? Math.min(1, (now - focusState.phaseStart) / (focusState.alignDuration * 1000)) : 1;
    const eased = easeInOutCubic(t);
    focusSwing.setFromUnitVectors(focusState.alignFromDir, focusUp);
    focusSwingEased.slerpQuaternions(FOCUS_QUAT_IDENTITY, focusSwing, eased);
    focusDir.copy(focusState.alignFromDir).applyQuaternion(focusSwingEased);
    const distance = THREE.MathUtils.lerp(focusState.alignFromDistance, FOCUS_ALIGN_DISTANCE, eased);
    camera.position.copy(centre).addScaledVector(focusDir, distance);
    // The gaze releases its previous target and settles on the globe's centre
    // over the same curve as the swing.
    focusState.lookTarget.lerpVectors(focusState.alignFromTarget, centre, eased);
    camera.lookAt(focusState.lookTarget);
    if (t >= 1) { focusState.phase = 'approach'; focusState.phaseStart = now; }
    return;
  }

  if (focusState.phase === 'approach') {
    // Dolly down the radial line while the view's pivot glides from the globe's
    // centre to the spacecraft itself; the green tint rides the same curve.
    const t = focusState.approachDuration ? Math.min(1, (now - focusState.phaseStart) / (focusState.approachDuration * 1000)) : 1;
    const eased = easeInOutCubic(t);
    focusTangent(record, focusTangentVec);
    focusDir.copy(focusUp).addScaledVector(focusTangentVec, FOCUS_CAMERA_TILT * eased).normalize();
    const gap = THREE.MathUtils.lerp(FOCUS_ALIGN_DISTANCE - satelliteRadius, FOCUS_LOCK_GAP, eased);
    camera.position.copy(focusWorld).addScaledVector(focusDir, gap);
    focusState.lookTarget.lerpVectors(centre, focusWorld, eased);
    camera.lookAt(focusState.lookTarget);
    setFocusTint(THREE.MathUtils.lerp(focusState.tintFrom, 1, eased));
    focusRing.position.copy(record.position);
    if (t >= 1) {
      focusState.phase = 'locked';
      focusState.lockedAt = now;
      focusState.smoothCamera.copy(camera.position);
      focusState.smoothTarget.copy(focusWorld);
      focusRing.scale.set(focusState.ringScale, focusState.ringScale, 1);
      focusRing.visible = true;
      showFocusCard();
    }
    return;
  }

  if (focusState.phase === 'locked') {
    // The spacecraft never stops moving, so the lock is a soft follow rather
    // than a hard parent: desired framing recomputed live, eased into.
    focusTangent(record, focusTangentVec);
    focusDir.copy(focusUp).addScaledVector(focusTangentVec, FOCUS_CAMERA_TILT).normalize();
    focusCameraTarget.copy(focusWorld).addScaledVector(focusDir, FOCUS_LOCK_GAP);
    const catchUp = 1 - Math.exp(-deltaSeconds * FOCUS_FOLLOW_RATE);
    focusState.smoothCamera.lerp(focusCameraTarget, catchUp);
    focusState.smoothTarget.lerp(focusWorld, catchUp);
    camera.position.copy(focusState.smoothCamera);
    focusState.lookTarget.copy(focusState.smoothTarget);
    camera.lookAt(focusState.lookTarget);

    const since = (now - focusState.lockedAt) / 1000;
    const ramp = reducedMotion ? 1 : Math.min(1, since / .45);
    const pulse = reducedMotion ? 0 : Math.sin(since * 2.4);
    focusRing.material.opacity = ramp * (.74 + pulse * .14);
    focusRing.material.rotation = reducedMotion ? 0 : since * .16;
    const ringScale = focusState.ringScale * (1 + pulse * .035);
    focusRing.scale.set(ringScale, ringScale, 1);
    focusRing.position.copy(record.position);
    return;
  }

  if (focusState.phase === 'exit') {
    const t = focusState.exitDuration ? Math.min(1, (now - focusState.phaseStart) / (focusState.exitDuration * 1000)) : 1;
    const eased = easeInOutCubic(t);
    focusCameraTarget.copy(centre).addScaledVector(focusState.exitDir, focusState.returnDistance);
    camera.position.lerpVectors(focusState.exitFromCamera, focusCameraTarget, eased);
    focusState.lookTarget.lerpVectors(focusState.exitFromTarget, centre, eased);
    camera.lookAt(focusState.lookTarget);
    setFocusTint(focusState.exitFromTint * (1 - eased));
    focusRing.material.opacity = Math.max(0, focusRing.material.opacity - deltaSeconds * 4);
    focusRing.position.copy(record.position);
    if (t >= 1) finishFocusExit();
  }
}

function updateFocusCardContent(mission, record) {
  focusMissionLabel.textContent = mission.title;
  focusName.textContent = record.name;
  focusMeta.textContent = `NORAD ${record.id} · ${record.altitude.toFixed(0)} KM\nOVER ${mission.region.label.toUpperCase()}`;
}

function showFocusCard() {
  const mission = missions[focusState.key];
  if (mission && focusState.record) updateFocusCardContent(mission, focusState.record);
  focusCard.hidden = false;
  requestAnimationFrame(() => focusCard.classList.add('is-visible'));
}

function hideFocusCard() {
  focusCard.classList.remove('is-visible');
  focusCard.hidden = true;
}

// The card hangs below the spacecraft rather than beside it, far enough down to
// leave the model and its reticle in the clear — the lock is the one moment the
// viewer gets to look at the machine itself.
function updateFocusCardPosition() {
  if (focusCard.hidden || !focusState.record) return;
  if (innerWidth <= 560) return; // docked to the bottom by the stylesheet instead
  focusCameraTarget.copy(focusState.record.position);
  globeRoot.localToWorld(focusCameraTarget);
  // One reticle half-width along the camera's right, projected beside the
  // spacecraft: the gap between the two is what the reticle measures in pixels,
  // whatever the lock distance and field of view work out to.
  focusCardEdge.setFromMatrixColumn(camera.matrixWorld, 0)
    .multiplyScalar(focusState.ringScale * .5)
    .add(focusCameraTarget);
  focusCameraTarget.project(camera);
  focusCardEdge.project(camera);
  const x = (focusCameraTarget.x * .5 + .5) * innerWidth;
  const y = (-focusCameraTarget.y * .5 + .5) * innerHeight;
  const halfExtent = Math.abs(focusCardEdge.x - focusCameraTarget.x) * .5 * innerWidth;

  const box = focusCard.getBoundingClientRect();
  const margin = 14;
  // Distance from the spacecraft down to the card's top edge: enough to clear
  // the whole reticle where the viewport allows, never less than the ring
  // itself, which is drawn wide enough to enclose the model.
  const wanted = halfExtent * FOCUS_CARD_RING_CLEAR + FOCUS_CARD_GAP;
  const least = halfExtent * FOCUS_CARD_MODEL_CLEAR + FOCUS_CARD_GAP;
  const below = innerHeight - margin - box.height - y;
  const above = y - margin - box.height;
  let top;
  if (below >= least) top = y + Math.min(wanted, below);
  // Not enough room underneath — a low lock on a short viewport — so it hangs
  // above the spacecraft instead.
  else if (above >= least) top = y - Math.min(wanted, above) - box.height;
  else top = clamp(y + least, margin, innerHeight - box.height - margin);

  focusCard.style.left = `${clamp(x, box.width / 2 + margin, innerWidth - box.width / 2 - margin)}px`;
  focusCard.style.top = `${top}px`;
}

// applySatelliteCount rebuilds the instanced meshes, which wipes instance
// colours and can reshuffle indices. Re-anchor the highlight to the same
// record, re-acquire over the same region if that spacecraft left the render
// set, or fulfil a focus that was requested before any data had landed.
function refreshFocusAfterRebuild() {
  if (focusState.releaseRecord) {
    const releaseIndex = satelliteRecords.indexOf(focusState.releaseRecord);
    if (releaseIndex >= 0) focusState.releaseIndex = releaseIndex;
    else { focusState.releaseRecord = null; focusState.releaseIndex = -1; }
  }
  if (!focusState.active) {
    if (focusState.pendingKey && performance.now() - focusState.pendingAt < 6000) {
      const key = focusState.pendingKey;
      focusState.pendingKey = null;
      focusOnMission(key);
    }
    return;
  }
  const index = satelliteRecords.indexOf(focusState.record);
  if (index >= 0) {
    focusState.index = index;
    setFocusTint(focusState.tint);
  } else {
    const key = focusState.key;
    focusState.key = null; // clear so focusOnMission does not treat this as a same-key no-op
    focusState.index = -1;
    focusOnMission(key);
  }
}

// A targeting reticle rather than a glow: a crisp ring with diagonal ticks and
// a faint halo, drawn once and pulsed by the lock loop.
function makeFocusRingTexture() {
  const size = 256;
  const image = document.createElement('canvas');
  image.width = image.height = size;
  const context = image.getContext('2d');
  const centre = size / 2;

  const halo = context.createRadialGradient(centre, centre, 60, centre, centre, 122);
  halo.addColorStop(0, 'rgba(64, 248, 198, 0)');
  halo.addColorStop(.55, 'rgba(64, 248, 198, .13)');
  halo.addColorStop(.8, 'rgba(64, 248, 198, .045)');
  halo.addColorStop(1, 'rgba(64, 248, 198, 0)');
  context.fillStyle = halo;
  context.fillRect(0, 0, size, size);

  context.strokeStyle = 'rgba(148, 255, 219, .92)';
  context.lineWidth = 2.6;
  context.shadowColor = 'rgba(52, 244, 192, .9)';
  context.shadowBlur = 9;
  context.beginPath();
  context.arc(centre, centre, 88, 0, Math.PI * 2);
  context.stroke();

  context.lineWidth = 3;
  context.shadowBlur = 6;
  context.strokeStyle = 'rgba(190, 255, 231, .95)';
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2 + Math.PI / 4;
    context.beginPath();
    context.moveTo(centre + Math.cos(angle) * 96, centre + Math.sin(angle) * 96);
    context.lineTo(centre + Math.cos(angle) * 112, centre + Math.sin(angle) * 112);
    context.stroke();
  }

  const texture = new THREE.CanvasTexture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* -------------------------------------------------------------------------
   Debug dock — fleet size sweep

   A development-only control for answering "how many satellites do I actually
   want on screen". The slider spans MIN_SATELLITES to the full size of the
   live catalogue — every object the API can serve — and the readout reports
   frame rate and propagation cost so the tradeoff is visible while dragging.
   ------------------------------------------------------------------------- */

let debugOpen = false;
let debugApplyTimer = 0;
let frameSamples = 0;
let frameWindowStart = 0;
let framesPerSecond = 0;

function initDebugPanel() {
  if (!debugDock) return;
  debugSlider.min = String(MIN_SATELLITES);
  debugSlider.value = String(satelliteTarget);

  debugToggle.addEventListener('click', () => {
    debugOpen = !debugOpen;
    debugPanel.hidden = !debugOpen;
    debugDock.classList.toggle('is-open', debugOpen);
    debugToggle.setAttribute('aria-expanded', String(debugOpen));
    if (debugOpen) syncDebugReadout();
  });

  // Applying on every input event would rebuild the instanced meshes faster
  // than a drag produces events, so the rebuild trails the handle slightly
  // while the number under it stays live.
  debugSlider.addEventListener('input', () => {
    debugCount.textContent = formatCount(Number(debugSlider.value));
    clearTimeout(debugApplyTimer);
    debugApplyTimer = setTimeout(() => requestSatelliteCount(Number(debugSlider.value)), 90);
  });

  debugPresets.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-count]');
    if (!target) return;
    const raw = target.dataset.count;
    const count = raw === 'min' ? MIN_SATELLITES : raw === 'max' ? maxSatellites() : Number(raw);
    clearTimeout(debugApplyTimer);
    requestSatelliteCount(count);
    debugSlider.value = String(satelliteTarget);
  });

  debugGlow?.addEventListener('change', () => setGreenGlow(debugGlow.checked));
  debugLinks?.addEventListener('change', () => setNetworkVisible(debugLinks.checked));
  debugLinkCurve?.addEventListener('change', () => setLinkCurve(debugLinkCurve.checked));

  // A failed download pins the slider to the bundled set, so offer the fetch
  // again rather than leaving the ceiling stuck for the session.
  debugRetry.addEventListener('click', () => loadLiveSatellites(true));

  // Meteors are sporadic by design, so the dock can summon one on demand.
  document.querySelector('#debug-meteor').addEventListener('click', () => shootingStars.launch());

  syncDebugReadout();
}

function sampleFrameRate(elapsed) {
  // The first window has to start at the first frame, not at time zero, or the
  // opening sample is averaged over the whole page load.
  if (!frameWindowStart) frameWindowStart = elapsed;
  frameSamples++;
  if (elapsed - frameWindowStart < 500) return;
  framesPerSecond = frameSamples * 1000 / (elapsed - frameWindowStart);
  frameSamples = 0;
  frameWindowStart = elapsed;
  if (debugOpen) syncDebugReadout();
}

function formatCount(value) {
  return Math.round(value).toLocaleString('en-US');
}

function syncDebugReadout() {
  if (!debugDock) return;
  const ceiling = maxSatellites();
  // The ceiling moves as pages arrive (and collapses to the bundled set when the
  // API is down), so the target follows it rather than advertising a count the
  // app cannot actually reach.
  satelliteTarget = Math.min(satelliteTarget, ceiling);
  debugSlider.max = String(ceiling);
  // A step that scales with the range keeps the handle usable at both ends —
  // the full catalogue runs to five figures, so the step has to grow with it.
  debugSlider.step = ceiling > 5000 ? '50' : ceiling > 600 ? '10' : '5';
  if (Number(debugSlider.value) !== satelliteTarget) debugSlider.value = String(satelliteTarget);
  // The handle carries the request; the number under it reports what actually
  // flew. They part company by a percent or two because the pool always holds
  // some element sets no object can be propagated from — the label says
  // "rendered", so it follows the fleet rather than the ask.
  debugCount.textContent = formatCount(satelliteRecords.length || satelliteTarget);
  debugMaxLabel.textContent = formatCount(ceiling);

  for (const button of debugPresets.querySelectorAll('button[data-count]')) {
    const raw = button.dataset.count;
    const count = raw === 'min' ? MIN_SATELLITES : raw === 'max' ? ceiling : Number(raw);
    button.disabled = count > ceiling;
    button.classList.toggle('is-active', count === satelliteTarget);
  }

  debugFields.rendered.textContent = formatCount(satelliteRecords.length);
  debugFields.pool.textContent = formatCount(elementPool.length);
  debugFields.catalog.textContent = catalogTotal ? formatCount(catalogTotal) : '—';
  debugFields.links.textContent = networkVisible
    ? `${formatCount(crosslinkCount)} mesh · ${formatCount(downlinkCount)} down`
    : 'off';
  debugFields.fps.textContent = framesPerSecond ? framesPerSecond.toFixed(0) : '—';
  debugFields.propagate.textContent = lastPropagationMs ? `${lastPropagationMs.toFixed(1)} ms` : '—';
  debugFields.fps.classList.toggle('is-warn', framesPerSecond > 0 && framesPerSecond < 45);
  debugFields.propagate.classList.toggle('is-warn', lastPropagationMs > 60);

  if (fetchState === 'loading') {
    debugNote.textContent = 'Downloading catalogue · one request covers every object';
  } else if (fetchState === 'offline') {
    debugNote.textContent = `All catalogue sources unreachable · limited to ${formatCount(elementPool.length)} local element sets`;
  } else if (catalogTotal) {
    debugNote.textContent = `${sourceLabel} · slider spans all ${formatCount(catalogTotal)} tracked objects`;
  } else {
    debugNote.textContent = 'Catalogue not fetched yet';
  }
  debugRetry.hidden = fetchState !== 'offline';
}

boot();
