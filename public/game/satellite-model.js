import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Every dimension below is in world units against an Earth of radius 2.48, and
// describes a model at full size — roughly .2 tip to tip for a typical bus.
// MODEL_SCALE is the one lever that resizes the whole fleet: parts are authored
// at their natural proportions and each variant's merged geometry is baked down
// at the end, so the instance matrices never carry a size term.
const MODEL_SCALE = .5;

// Whites for the different surfaces on a bus. Baked into vertex colours so a
// whole spacecraft merges into one draw call and still shows a range of tones.
const SHELL = 0xffffff;    // main thermal blanket
const BRIGHT = 0xf6faf8;   // sunlit fittings
const DISH = 0xf4f8fa;     // antenna reflectors
const TRIM = 0xd8e3df;     // collars, radiators, equipment decks
const STRUT = 0xb8c6c5;    // booms, masts, truss
const OPTIC = 0xd9e8f5;    // glass apertures and star trackers

// Metallic fittings, rendered by their own high-metalness material so they
// spark under the probe's sun instead of matching the painted hull.
const GOLD = 0xd8a955;     // kapton foil wraps, feed horns, engine bells
const SILVER = 0xeef3f1;   // collars, hinges, docking hardware

// The catalogue this reads is roughly 80% LEO, 11% near-GEO, 4% MEO and a tail
// of ellipticals, so the archetypes below are chosen to cover what actually
// shows up rather than to be a taxonomy: the big GEO birds, the flat-pack
// broadband constellations that dominate LEO by count, the MEO navigation
// shells, polar imagers, crewed stations, and spent hardware.
// `recon` is not reached by classification: nothing in a public catalogue
// reliably says "this one is a spy satellite". It exists for the mission focus,
// which dresses a use case's target in the hardware that use case is about.
const ARCHETYPES = {
  comsat: buildComsat,
  flatpack: buildFlatpack,
  navsat: buildNavsat,
  observer: buildObserver,
  recon: buildRecon,
  station: buildStation,
  debris: buildDebris,
  smallsat: buildSmallsat,
};

// What each archetype is called when a viewer is looking at one.
export const ARCHETYPE_LABELS = {
  comsat: 'Communications relay',
  flatpack: 'Broadband constellation',
  navsat: 'Navigation',
  observer: 'Earth observation',
  recon: 'Defence reconnaissance',
  station: 'Crewed station',
  debris: 'Rocket body / debris',
  smallsat: 'Small satellite',
};

const NAME_RULES = [
  // Spent hardware first — "CZ-2D R/B" would otherwise match nothing and land
  // on the generic bus, and debris outnumbers most real categories.
  [/\b(DEB|R\/B|ROCKET|FREGAT|BREEZE|BRIZ|CENTAUR|AKM|PKM|PLATFORM|SL-\d|COOLANT|WESTFORD)\b/, 'debris'],
  [/\b(ISS|CSS|MIR|SALYUT|SKYLAB|TIANGONG|TIANHE|WENTIAN|MENGTIAN|ZARYA|NAUKA|POISK|RASSVET|ZVEZDA|PIRS|PROGRESS|SOYUZ|SHENZHOU|DRAGON|CYGNUS|STARLINER)\b/, 'station'],
  [/\b(STARLINK|ONEWEB|KUIPER|QIANFAN|GUOWANG|LIGHTSPEED)\b/, 'flatpack'],
  [/\b(NAVSTAR|GPS|GLONASS|GALILEO|BEIDOU|COMPASS|IRNSS|NVS|QZS|MICHIBIKI)\b/, 'navsat'],
  [/\b(INTELSAT|IS-\d|TELSTAR|ASTRA|EUTELSAT|EKRAN|BSAT|BADR|SES|ECHOSTAR|DIRECTV|ANIK|NIMIQ|THAICOM|MEASAT|OPTUS|INMARSAT|TDRS|RADUGA|GORIZONT|EXPRESS|YAMAL|APSTAR|CHINASAT|GSAT|VIASAT|SKYNET|MILSTAR|AEHF|WGS)\b/, 'comsat'],
  [/\b(GOES|NOAA|METEOR|METOP|SENTINEL|LANDSAT|TERRA|AQUA|AURA|SUOMI|NPP|JPSS|YAOGAN|GAOFEN|WORLDVIEW|GEOEYE|PLEIADES|SPOT|RADARSAT|ICEYE|SKYSAT|CARTOSAT|RESOURCESAT|HIMAWARI|ELEKTRO|FENGYUN|HUANJING|ZIYUAN|KOMPSAT|TERRASAR|COSMO-SKYMED|ENVISAT|ERS|SEASAT|HUBBLE|CHANDRA|SWIFT|FERMI|TESS|IRIS)\b/, 'observer'],
];

const EARTH_RADIUS_KM = 6378.137;
const GRAVITY_PARAMETER = 398600.4418; // km^3/s^2

// Name first, because it is the only thing that separates a comsat from a
// rocket body sitting in the same graveyard orbit. Where the name says nothing
// — plain "COSMOS 2224" and the like — the orbit itself is the tell.
export function classifySatellite(name = '', satrec) {
  const label = String(name).toUpperCase();
  for (const [pattern, archetype] of NAME_RULES) {
    if (pattern.test(label)) return archetype;
  }

  const altitude = semiMajorAltitude(satrec);
  const eccentricity = satrec?.ecco ?? 0;
  const inclination = (satrec?.inclo ?? 0) * 180 / Math.PI;

  if (altitude === null) return 'smallsat';
  // Anything on a strongly elliptical path is a Molniya-type relay or an early
  // warning bird — both big dish-carrying buses.
  if (eccentricity > .25) return 'comsat';
  if (altitude > 30000) return 'comsat';
  if (altitude > 15000) return 'navsat';
  // Sun-synchronous and near-polar LEO is where the imagers live.
  if (altitude < 2000 && inclination >= 80 && inclination <= 102) return 'observer';
  return 'smallsat';
}

function semiMajorAltitude(satrec) {
  const meanMotion = satrec?.no; // radians per minute
  if (!Number.isFinite(meanMotion) || meanMotion <= 0) return null;
  const radiansPerSecond = meanMotion / 60;
  const semiMajor = Math.cbrt(GRAVITY_PARAMETER / (radiansPerSecond * radiansPerSecond));
  return semiMajor - EARTH_RADIUS_KM;
}

// The fleet owns one InstancedMesh per (archetype, material) pair and hands out
// a slot per record, so adding archetypes costs draw calls rather than
// per-object overhead. Geometry and materials are built once and survive every
// rebuild; only the instanced meshes are torn down when the count changes.
export function createSatelliteFleet(renderer) {
  const envMap = buildEnvironment(renderer);
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const hullTexture = makeHullTexture();
  hullTexture.anisotropy = anisotropy;
  const panelTexture = makePanelTexture();
  panelTexture.anisotropy = anisotropy;

  // Deliberately low metalness: the buses are painted and wrapped in white
  // thermal blanket, so their definition comes from soft bevels and a broad
  // reflection rather than chrome-like contrast.
  const hullMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: hullTexture,
    vertexColors: true,
    roughness: .34,
    metalness: .1,
    envMap,
    envMapIntensity: 1.25,
    emissive: 0xdde5e7,
    emissiveIntensity: .055,
  });

  // Real photovoltaic blue under a very smooth glass cover. The base stays
  // dark enough that a reflected sun has room to bloom across it; clearcoat and
  // a small iridescent response provide the shifting blue-violet glare seen on
  // real multi-junction arrays without turning the panels aqua.
  const panelMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: panelTexture,
    vertexColors: true,
    roughness: .15,
    metalness: .42,
    envMap,
    envMapIntensity: 1.75,
    clearcoat: 1,
    clearcoatRoughness: .035,
    iridescence: .22,
    iridescenceIOR: 1.35,
    iridescenceThicknessRange: [120, 260],
    emissive: 0x0a1b38,
    emissiveIntensity: .06,
  });

  // Antenna bowls are a distinct polished surface rather than hull-coloured
  // cones. Double-sided rendering keeps the open parabolic dishes convincing
  // from either side as the spacecraft turns.
  const reflectorMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xf5f8fb,
    vertexColors: true,
    roughness: .12,
    metalness: .72,
    envMap,
    envMapIntensity: 2.5,
    clearcoat: .72,
    clearcoatRoughness: .045,
    side: THREE.DoubleSide,
  });

  const opticMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x173754,
    vertexColors: true,
    roughness: .08,
    metalness: .2,
    envMap,
    envMapIntensity: 2.2,
    clearcoat: 1,
    clearcoatRoughness: .025,
    transmission: .08,
    thickness: .018,
  });

  // Foil wraps, engine bells and docking rings. Roughness sits well above the
  // reflectors' so the gold reads as crinkled foil rather than chrome, and the
  // faint warm emissive keeps it from dropping to black on the shadowed side.
  const metalMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: .3,
    metalness: .88,
    envMap,
    envMapIntensity: 1.6,
    emissive: 0x2c2413,
    emissiveIntensity: .3,
  });

  const layerMaterials = {
    hull: hullMaterial,
    panels: panelMaterial,
    reflectors: reflectorMaterial,
    optics: opticMaterial,
    metals: metalMaterial,
  };
  const models = new Map();
  for (const [key, build] of Object.entries(ARCHETYPES)) {
    const parts = build();
    const layers = {};
    for (const layer of Object.keys(layerMaterials)) {
      layers[layer] = parts[layer]?.length ? bake(parts[layer]) : null;
    }
    models.set(key, layers);
  }

  const object3d = new THREE.Group();
  const active = new Map();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  const white = new THREE.Color(0xffffff);

  // One spare spacecraft outside the instanced fleet. Mission focus dresses its
  // target in this so a use case can show the hardware it is actually about —
  // a reconnaissance bird for Defence — without re-laying out every instance
  // behind it. The record's own instance collapses to nothing while it is up,
  // so exactly one copy of that satellite is ever on screen.
  const standIn = { record: null, key: null, group: new THREE.Group(), materials: null };
  standIn.group.visible = false;
  standIn.group.matrixAutoUpdate = false;
  object3d.add(standIn.group);

  // Cloned so the mission tint can drive this one spacecraft's colour the way
  // instanceColor drives the fleet's — multiplied against each layer's own
  // finish rather than replacing it, which is what instance colours do too.
  function standInMaterials() {
    if (!standIn.materials) {
      standIn.materials = {};
      for (const [layer, material] of Object.entries(layerMaterials)) {
        const clone = material.clone();
        clone.userData.baseColor = clone.color.clone();
        standIn.materials[layer] = clone;
      }
    }
    return standIn.materials;
  }

  function setStandIn(record, key) {
    const model = key ? models.get(key) : null;
    if (!record || !model) {
      standIn.record = null;
      standIn.group.visible = false;
      return;
    }
    if (standIn.key !== key) {
      standIn.group.clear();
      for (const [layer, material] of Object.entries(standInMaterials())) {
        if (!model[layer]) continue;
        const mesh = new THREE.Mesh(model[layer], material);
        mesh.frustumCulled = false;
        mesh.renderOrder = 4;
        standIn.group.add(mesh);
      }
      standIn.key = key;
    }
    standIn.record = record;
    // Stays hidden until the first matrix lands, so it never shows up for a
    // frame at the centre of the globe.
    standIn.group.visible = false;
  }

  function releaseMeshes() {
    for (const meshes of active.values()) {
      for (const mesh of meshes) {
        mesh.dispose();
        object3d.remove(mesh);
      }
    }
    active.clear();
  }

  return {
    object3d,

    // Assigns every record an archetype and a slot within that archetype's
    // instanced mesh. `variant` is cached on the record because app.js memoises
    // records across count changes and reclassifying is pure waste.
    build(records) {
      releaseMeshes();
      // A count change can drop the spacecraft a mission was dressing up.
      if (standIn.record && !records.includes(standIn.record)) setStandIn(null, null);
      const counts = new Map();
      for (const record of records) {
        if (!record.variant) record.variant = classifySatellite(record.name, record.satrec);
        const used = counts.get(record.variant) || 0;
        record.slot = used;
        counts.set(record.variant, used + 1);
      }

      for (const [key, count] of counts) {
        const model = models.get(key) || models.get('smallsat');
        const meshes = [];
        for (const [layer, material] of Object.entries(layerMaterials)) {
          if (model[layer]) meshes.push(new THREE.InstancedMesh(model[layer], material, count));
        }
        for (const mesh of meshes) {
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          // Objects that never propagate stay collapsed to nothing rather than
          // piling up at the centre of the globe. Instance colours start white
          // so the mission-focus highlight can tint one spacecraft without
          // darkening the rest.
          for (let i = 0; i < count; i++) {
            mesh.setMatrixAt(i, hidden);
            mesh.setColorAt(i, white);
          }
          mesh.frustumCulled = false;
          mesh.renderOrder = 4;
          object3d.add(mesh);
        }
        active.set(key, meshes);
      }
    },

    // Swaps the archetype a single record is drawn as. A `key` of null puts it
    // back in its own archetype's instanced mesh.
    setStandIn,

    setMatrix(record, matrix) {
      const dressed = standIn.record === record;
      if (dressed) {
        standIn.group.matrix.copy(matrix);
        standIn.group.matrixWorldNeedsUpdate = true;
        standIn.group.visible = true;
      }
      const meshes = active.get(record.variant);
      if (!meshes) return;
      for (const mesh of meshes) mesh.setMatrixAt(record.slot, dressed ? hidden : matrix);
    },

    // Mission-focus highlight: tints one spacecraft's hull and wings across
    // however many meshes its archetype carries.
    setTint(record, color) {
      if (standIn.record === record && standIn.materials) {
        for (const material of Object.values(standIn.materials)) {
          material.color.copy(material.userData.baseColor).multiply(color);
        }
      }
      const meshes = active.get(record.variant);
      if (!meshes) return;
      for (const mesh of meshes) {
        mesh.setColorAt(record.slot, color);
        mesh.instanceColor.needsUpdate = true;
      }
    },

    commit() {
      for (const meshes of active.values()) {
        for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
      }
    },

    dispose() {
      releaseMeshes();
    },
  };
}

function bake(parts) {
  const geometry = mergeGeometries(parts).scale(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
  geometry.computeBoundingSphere();
  return geometry;
}

// Local axes match the attitude the propagator hands out: +Y is zenith, +Z is
// along-track, so nadir fittings hang toward Earth and wings sweep out
// cross-track along X.

// The GEO workhorse: a faceted equipment bus, a large Earth-facing antenna,
// twin polished side reflectors and long framed photovoltaic wings.
function buildComsat() {
  const hull = [
    box(.044, .052, .058, SHELL),
    box(.049, .008, .062, TRIM, 0, -.020, 0),
    box(.037, .006, .064, BRIGHT, 0, .023, 0),
    box(.004, .032, .046, TRIM, -.024, .002, 0),
    tube(.010, .013, .012, 18, BRIGHT, 0, -.032, 0),
    tube(.0021, .0021, .030, 8, STRUT, 0, .041, 0),
    box(.011, .006, .011, BRIGHT, 0, .057, 0),
  ];
  const panels = [];
  const reflectors = [];
  const optics = [sphere(.0042, 16, OPTIC, -.014, .030, -.022)];

  const metals = [box(.0455, .011, .0595, GOLD, 0, -.010, 0)];
  for (const side of [-1, 1]) {
    framePanel(hull, panels, .076, .050, side * .083, 0, 0);
    hull.push(tube(.0034, .0034, .024, 10, STRUT, side * .034, 0, 0, 'x'));
    hull.push(sphere(.005, 12, BRIGHT, side * .044, 0, 0));
    addDish(reflectors, .0145, .007, 0, .004, side * .034, 'z', side);
    hull.push(tube(.0011, .0011, .015, 6, STRUT, 0, .004, side * .046, 'z'));
    metals.push(sphere(.0024, 12, SILVER, 0, .004, side * .052));
  }

  addDish(reflectors, .021, .010, 0, -.031, 0, 'y', -1);
  hull.push(tube(.0012, .0012, .016, 6, STRUT, 0, -.043, 0));
  metals.push(tube(.0034, .0006, .006, 10, GOLD, 0, -.051, 0));
  return { hull, panels, reflectors, optics, metals };
}

// Starlink and its imitators: a flat slab with a single wing folded out to one
// side. The asymmetry is the whole silhouette, and it is by far the most common
// thing in the catalogue.
function buildFlatpack() {
  const hull = [
    box(.057, .012, .050, SHELL),
    box(.050, .004, .043, TRIM, 0, -.008, 0),
    box(.021, .009, .017, BRIGHT, .009, .010, 0),
    box(.014, .005, .022, TRIM, -.017, .008, 0),
    tube(.0032, .0032, .019, 10, STRUT, .037, 0, 0, 'x'),
  ];
  const panels = [];
  framePanel(hull, panels, .132, .043, .106, 0, 0);
  const optics = [
    sphere(.004, 16, OPTIC, .014, .016, -.012),
    tube(.0035, .0035, .003, 16, OPTIC, -.015, -.011, .014),
  ];
  const metals = [
    flatBox(.052, .0016, .045, SILVER, 0, .0068, 0),
    tube(.0035, .0058, .009, 10, GOLD, -.010, 0, -.0285, 'z'),
  ];
  return { hull, panels, optics, metals };
}

// MEO navigation: a squat bus under a deck of helical antennas, all of them
// aimed at Earth.
function buildNavsat() {
  const hull = [
    box(.046, .042, .046, SHELL),
    box(.052, .007, .052, TRIM, 0, -.020, 0),
    box(.036, .005, .036, BRIGHT, 0, -.027, 0),
    box(.035, .005, .035, TRIM, 0, .023, 0),
  ];
  const reflectors = [];
  const metals = [box(.0475, .012, .0475, GOLD, 0, .002, 0)];
  for (const x of [-.010, .010]) {
    for (const z of [-.010, .010]) {
      hull.push(tube(.0011, .0011, .011, 6, STRUT, x, -.035, z));
      metals.push(sphere(.0038, 12, GOLD, x, -.041, z));
    }
  }
  const panels = [];
  for (const side of [-1, 1]) {
    framePanel(hull, panels, .059, .052, side * .075, 0, 0);
    hull.push(tube(.0035, .0035, .020, 10, STRUT, side * .032, 0, 0, 'x'));
  }
  const optics = [sphere(.004, 16, OPTIC, .014, .031, -.014)];
  return { hull, panels, reflectors, optics, metals };
}

// Polar imager: long body along track, a telescope barrel out the nadir face, a
// radiator down one flank and a single wing off the other.
function buildObserver() {
  const hull = [
    box(.032, .037, .075, SHELL),
    box(.004, .031, .061, TRIM, -.019, 0, 0),
    box(.024, .005, .055, BRIGHT, 0, .020, .003),
    tube(.013, .015, .030, 18, BRIGHT, 0, -.033, 0),
    box(.008, .008, .008, BRIGHT, .012, .020, -.028),
    tube(.0018, .0018, .026, 8, STRUT, 0, .032, .018),
    tube(.0035, .0035, .019, 10, STRUT, .025, 0, 0, 'x'),
  ];
  const panels = [];
  framePanel(hull, panels, .073, .050, .067, 0, 0);
  const reflectors = [];
  addDish(reflectors, .0155, .0065, 0, -.048, 0, 'y', -1);
  const optics = [
    tube(.010, .010, .0025, 24, OPTIC, 0, -.052, 0),
    sphere(.0042, 16, OPTIC, .012, .026, -.028),
  ];
  const metals = [tube(.0146, .0146, .007, 18, GOLD, 0, -.023, 0)];
  return { hull, panels, reflectors, optics, metals };
}

// Optical reconnaissance — the shape every large defence imager has converged
// on, from the KH-11 family to their foreign equivalents: a telescope flown
// with its aperture pointed at the ground. The barrel is the spacecraft, a
// flared light shade rings the aperture at the nadir end, the service section
// and relay dish sit aft, and two long wings hang off the sides. Deliberately
// the largest bus outside the crewed stations, because the real ones are.
function buildRecon() {
  const hull = [
    tube(.021, .021, .070, 22, SHELL, 0, .006, 0),
    // Wider at the aperture: the shade keeps sunlight off the primary the same
    // way a lens hood does, and it is the detail that reads as a telescope.
    tube(.0215, .026, .028, 22, TRIM, 0, -.043, 0),
    box(.038, .022, .040, TRIM, 0, .050, 0),
    box(.004, .018, .034, BRIGHT, -.020, .050, 0),
    box(.010, .009, .010, BRIGHT, .019, .046, -.019),
    tube(.0022, .0022, .028, 8, STRUT, 0, .070, .014),
  ];
  const panels = [];
  const reflectors = [];
  const optics = [
    // The primary, sunk far enough up the barrel to sit in the shade's shadow.
    tube(.018, .018, .0025, 26, OPTIC, 0, -.055, 0),
    sphere(.0042, 16, OPTIC, .019, .052, -.019),
  ];
  const metals = [
    tube(.0216, .0216, .009, 22, GOLD, 0, .030, 0),
    tube(.0216, .0216, .006, 22, SILVER, 0, -.028, 0),
    tube(.008, .0045, .010, 12, GOLD, 0, .066, -.012),
  ];
  for (const side of [-1, 1]) {
    framePanel(hull, panels, .086, .046, side * .080, .006, 0);
    hull.push(tube(.0036, .0036, .018, 10, STRUT, side * .029, .006, 0, 'x'));
  }
  // Imagery leaves through a relay satellite overhead, so this dish looks away
  // from Earth rather than down it.
  addDish(reflectors, .013, .006, 0, .076, .014, 'y', 1);
  return { hull, panels, reflectors, optics, metals };
}

// Crewed station: pressurised modules under a long lattice truss, silver
// collars at the module joints, a gold docking cone at the end of the lab
// branch, and four arrays hung fore-and-aft off the truss the way the real
// ones are. The only archetype that is meaningfully larger than the rest.
function buildStation() {
  const hull = [
    tube(.0135, .0135, .096, 20, SHELL, 0, -.008, 0, 'z'),
    tube(.010, .010, .052, 18, SHELL, .032, -.008, 0, 'x'),
    tube(.0105, .0105, .034, 18, BRIGHT, -.026, -.008, .012, 'x'),
    box(.024, .022, .023, TRIM, 0, -.008, 0),
    tube(.004, .004, .020, 10, STRUT, 0, .004, 0),
    flatBox(.150, .004, .008, STRUT, 0, .014, 0),
  ];
  const panels = [];
  const reflectors = [];
  addDish(reflectors, .009, .0036, .012, .008, -.020, 'y', 1);
  const metals = [
    tube(.014, .014, .0045, 18, SILVER, 0, -.008, .024, 'z'),
    tube(.014, .014, .0045, 18, SILVER, 0, -.008, -.024, 'z'),
    tube(.011, .011, .005, 16, SILVER, 0, -.008, .046, 'z'),
    tube(.0095, .0065, .007, 12, GOLD, .0605, -.008, 0, 'x'),
  ];
  for (const x of [-.065, -.022, .022, .065]) {
    metals.push(tube(.0013, .0013, .011, 6, SILVER, x, .014, 0));
  }
  for (const side of [-1, 1]) {
    hull.push(flatBox(.0025, .016, .028, BRIGHT, side * .014, .002, -.024));
    for (const arm of [-1, 1]) {
      framePanel(hull, panels, .036, .062, side * .058, .014, arm * .041);
    }
  }
  const optics = [sphere(.004, 16, OPTIC, .042, -.0015, .008)];
  return { hull, panels, reflectors, optics, metals };
}

// Spent upper stage: a bare tube with a nozzle skirt, tumbling. No wings, which
// is exactly what makes it read as junk rather than a spacecraft.
function buildDebris() {
  return {
    hull: [
      tube(.014, .014, .078, 18, TRIM, 0, 0, 0, 'z'),
      tube(.010, .0145, .014, 18, BRIGHT, 0, 0, -.044, 'z'),
      box(.020, .003, .034, STRUT, 0, 0, .009),
    ],
    reflectors: [],
    optics: [
      tube(.0045, .0045, .002, 18, OPTIC, 0, 0, .041, 'z'),
      tube(.0085, .0085, .0012, 16, OPTIC, 0, 0, -.0625, 'z'),
    ],
    metals: [
      tube(.0148, .0148, .005, 18, SILVER, 0, 0, .024, 'z'),
      tube(.0148, .0148, .005, 18, SILVER, 0, 0, -.015, 'z'),
      tube(.0055, .0105, .016, 16, GOLD, 0, 0, -.054, 'z'),
    ],
    panels: null,
  };
}

// The generic small bus everything unrecognised falls back to, and deliberately
// the smallest of the fleet.
function buildSmallsat() {
  const hull = [
    box(.032, .032, .036, SHELL),
    box(.036, .006, .040, TRIM, 0, -.012, 0),
    box(.024, .004, .027, BRIGHT, 0, .017, 0),
    tube(.0015, .0015, .022, 8, STRUT, 0, .027, 0),
  ];
  const panels = [];
  for (const side of [-1, 1]) {
    framePanel(hull, panels, .045, .032, side * .046, 0, 0);
    hull.push(tube(.0028, .0028, .012, 8, STRUT, side * .021, 0, 0, 'x'));
  }
  const reflectors = [];
  addDish(reflectors, .008, .0034, 0, -.020, -.005, 'y', -1);
  const optics = [sphere(.0038, 14, OPTIC, .010, .022, -.010)];
  const metals = [
    box(.0325, .007, .0365, GOLD, 0, .009, 0),
    sphere(.0021, 10, GOLD, 0, .039, 0),
  ];
  return { hull, panels, reflectors, optics, metals };
}

function box(width, height, depth, hex, x = 0, y = 0, z = 0) {
  const radius = Math.min(width, height, depth) * .22;
  return tint(place(new RoundedBoxGeometry(width, height, depth, 1, radius), x, y, z), hex);
}

function flatBox(width, height, depth, hex, x = 0, y = 0, z = 0) {
  return tint(place(new THREE.BoxGeometry(width, height, depth), x, y, z), hex);
}

function tube(radiusTop, radiusBottom, length, radialSegments, hex, x = 0, y = 0, z = 0, axis = 'y') {
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, radialSegments);
  if (axis === 'x') geometry.rotateZ(Math.PI * .5);
  if (axis === 'z') geometry.rotateX(Math.PI * .5);
  return tint(place(geometry, x, y, z), hex);
}

function sphere(radius, segments, hex, x = 0, y = 0, z = 0) {
  return tint(place(new THREE.SphereGeometry(radius, segments, Math.max(8, segments >> 1)), x, y, z), hex);
}

// A solar blanket and its raised aluminium perimeter are authored separately:
// the cells receive glass optics while the rails retain the bus's pale finish.
function framePanel(hull, panels, width, depth, x, y, z) {
  const thickness = .0044;
  const rail = .0022;
  panels.push(flatBox(width, thickness, depth, 0xffffff, x, y, z));
  hull.push(flatBox(width + rail, thickness + .0012, rail, STRUT, x, y + .0004, z - depth * .5));
  hull.push(flatBox(width + rail, thickness + .0012, rail, STRUT, x, y + .0004, z + depth * .5));
  hull.push(flatBox(rail, thickness + .0012, depth, STRUT, x - width * .5, y + .0004, z));
  hull.push(flatBox(rail, thickness + .0012, depth, STRUT, x + width * .5, y + .0004, z));
  // A narrow central busbar remains visible even when the texture's fine cell
  // grid has minified to only a few pixels.
  hull.push(flatBox(.0014, thickness + .0014, depth - rail * 2, BRIGHT, x, y + .0005, z));
}

// Open parabolic reflector plus a rolled rim. A lathed surface reads as a true
// antenna bowl under a moving highlight, unlike a capped cone.
function addDish(parts, radius, depth, x, y, z, axis = 'y', sign = 1) {
  const points = [];
  const rings = 8;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    points.push(new THREE.Vector2(radius * t, depth * t * t));
  }
  const bowl = new THREE.LatheGeometry(points, 28);
  orient(bowl, 'y', axis, sign);
  parts.push(tint(place(bowl, x, y, z), DISH));

  const rim = new THREE.TorusGeometry(radius, Math.max(.00055, radius * .055), 8, 28);
  orient(rim, 'z', axis, sign);
  const offset = axisVector(axis, sign).multiplyScalar(depth);
  parts.push(tint(place(rim, x + offset.x, y + offset.y, z + offset.z), BRIGHT));
}

function orient(geometry, fromAxis, toAxis, sign = 1) {
  const from = axisVector(fromAxis, 1);
  const to = axisVector(toAxis, sign);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(from, to));
  return geometry;
}

function axisVector(axis, sign = 1) {
  if (axis === 'x') return new THREE.Vector3(sign, 0, 0);
  if (axis === 'z') return new THREE.Vector3(0, 0, sign);
  return new THREE.Vector3(0, sign, 0);
}

function place(geometry, x, y, z) {
  geometry.translate(x, y, z);
  return geometry;
}

function tint(source, hex) {
  // RoundedBoxGeometry is non-indexed while cylinders and spheres are indexed;
  // normalising here lets every kind of part merge into a single instanced
  // geometry per surface without BufferGeometryUtils rejecting the mix.
  const geometry = source.index ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color(hex);
  for (let i = 0; i < count; i++) color.toArray(colors, i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

// Thermal blanket: near-white throughout, with creases and seams that only
// resolve once the camera is close. Kept high-key so it never darkens the model
// at the size it is usually seen.
function makeHullTexture() {
  const image = document.createElement('canvas');
  image.width = image.height = 128;
  const context = image.getContext('2d');
  context.fillStyle = '#fcfefd';
  context.fillRect(0, 0, 128, 128);

  context.strokeStyle = 'rgba(168,186,180,.34)';
  context.lineWidth = 1;
  for (let y = 10; y < 128; y += 21) {
    context.beginPath();
    context.moveTo(0, y);
    for (let x = 0; x <= 128; x += 8) context.lineTo(x, y + Math.sin((x + y) * .12) * 1.6);
    context.stroke();
  }

  context.fillStyle = 'rgba(206,219,214,.42)';
  for (let i = 0; i < 60; i++) {
    const x = (i * 47) % 128;
    const y = (i * 83) % 128;
    context.fillRect(x, y, 2 + (i % 3), 1);
  }

  const texture = new THREE.CanvasTexture(image);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Solar array: deep indigo photovoltaic cells with fine silver contacts. The
// diffuse artwork provides the recognisable cell structure; the physical
// material above supplies the moving, sun-like reflection independently.
function makePanelTexture() {
  const image = document.createElement('canvas');
  image.width = 192;
  image.height = 128;
  const context = image.getContext('2d');
  context.fillStyle = '#07172f';
  context.fillRect(0, 0, image.width, image.height);

  const sheen = context.createLinearGradient(0, 0, image.width, image.height);
  sheen.addColorStop(0, 'rgba(64,115,186,.32)');
  sheen.addColorStop(.28, 'rgba(9,35,76,.08)');
  sheen.addColorStop(.58, 'rgba(87,140,211,.25)');
  sheen.addColorStop(1, 'rgba(13,42,88,.16)');
  context.fillStyle = sheen;
  context.fillRect(0, 0, image.width, image.height);

  // Cell boundaries and collector lines remain cool-neutral, keeping the blue
  // optical rather than green even when the scene's teal rim light reaches it.
  context.strokeStyle = 'rgba(150,186,224,.72)';
  context.lineWidth = 2;
  for (let x = 0; x <= image.width; x += 32) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, image.height);
    context.stroke();
  }
  for (let y = 0; y <= image.height; y += 32) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(image.width, y);
    context.stroke();
  }

  context.strokeStyle = 'rgba(190,215,239,.4)';
  context.lineWidth = 1;
  for (let x = 8; x < image.width; x += 16) {
    context.beginPath();
    context.moveTo(x, 2);
    context.lineTo(x, image.height - 2);
    context.stroke();
  }

  // Tiny alternating blue values stop a large wing reading as a flat printed
  // rectangle when the camera locks onto it.
  for (let y = 0; y < image.height; y += 32) {
    for (let x = 0; x < image.width; x += 32) {
      context.fillStyle = ((x + y) / 32) % 2
        ? 'rgba(39,91,161,.1)'
        : 'rgba(4,16,42,.12)';
      context.fillRect(x + 3, y + 3, 26, 26);
    }
  }

  const texture = new THREE.CanvasTexture(image);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const ENV_WIDTH = 256;
const ENV_HEIGHT = 128;

// Zenith to nadir: starlight above, the Earth's green limb glow around the
// horizon, near-black below. Linear radiance, not sRGB — this feeds a probe, not
// a screen.
// The zenith holds a touch of blue so the wings' glass reflects blue-white
// rather than green when it mirrors open sky.
const ENV_SKY = [
  { at: 0, rgb: [.148, .178, .200] },
  { at: .40, rgb: [.028, .043, .048] },
  { at: .56, rgb: [.005, .050, .034] },
  { at: .72, rgb: [.002, .016, .012] },
  { at: 1, rgb: [.001, .0015, .001] },
];

// A hard key and a cooler fill on the far side, so a wing turning through the
// sky crosses more than one source per revolution. `peak` is deliberately far
// above 1: a clearcoat returns only a few percent of what it reflects when you
// are looking straight at it, so a source clamped to display white produces no
// glint at all — the wings just sit there evenly lit.
//
// `core` is wide enough (around 10 degrees) that a flat wing sweeps through the
// source often rather than flashing once a revolution, which is the difference
// between a shimmer and a strobe.
const ENV_LIGHTS = [
  { theta: 1.02, phi: 1.45, core: .18, halo: .62, peak: 62, glow: 1.8, rgb: [1, 1, .99] },
  { theta: 1.72, phi: 4.35, core: .2, halo: .5, peak: 13, glow: .6, rgb: [.86, .97, .94] },
  { theta: .55, phi: 3.1, core: .16, halo: .42, peak: 7, glow: .4, rgb: [.88, .95, 1] },
];

// A hand-painted orbital sky, pre-filtered into a reflection probe. Applied only
// to the satellite materials, so the globe's own look is untouched.
function buildEnvironment(renderer) {
  const texels = new Uint16Array(ENV_WIDTH * ENV_HEIGHT * 4);
  const lights = ENV_LIGHTS.map((light) => ({ ...light, dir: direction(light.theta, light.phi) }));
  const rgb = [0, 0, 0];

  for (let y = 0; y < ENV_HEIGHT; y++) {
    const theta = (y + .5) / ENV_HEIGHT * Math.PI;
    for (let x = 0; x < ENV_WIDTH; x++) {
      const phi = (x + .5) / ENV_WIDTH * Math.PI * 2;
      const dir = direction(theta, phi);
      sampleSky(theta / Math.PI, rgb);

      for (const light of lights) {
        const cosine = dir[0] * light.dir[0] + dir[1] * light.dir[1] + dir[2] * light.dir[2];
        const angle = Math.acos(Math.min(1, Math.max(-1, cosine)));
        const core = 1 - smoothstep(light.core * .4, light.core, angle);
        const glow = Math.pow(1 - smoothstep(0, light.halo, angle), 2.2);
        const energy = light.peak * core + light.glow * glow;
        for (let c = 0; c < 3; c++) rgb[c] += light.rgb[c] * energy;
      }

      const offset = (y * ENV_WIDTH + x) * 4;
      for (let c = 0; c < 3; c++) texels[offset + c] = THREE.DataUtils.toHalfFloat(rgb[c]);
      texels[offset + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }

  const source = new THREE.DataTexture(texels, ENV_WIDTH, ENV_HEIGHT, THREE.RGBAFormat, THREE.HalfFloatType);
  source.mapping = THREE.EquirectangularReflectionMapping;
  source.minFilter = source.magFilter = THREE.LinearFilter;
  source.generateMipmaps = false;
  source.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromEquirectangular(source).texture;
  pmrem.dispose();
  source.dispose();
  return envMap;
}

function direction(theta, phi) {
  const ring = Math.sin(theta);
  return [ring * Math.cos(phi), Math.cos(theta), ring * Math.sin(phi)];
}

function sampleSky(t, out) {
  let lower = ENV_SKY[0];
  let upper = ENV_SKY[ENV_SKY.length - 1];
  for (let i = 1; i < ENV_SKY.length; i++) {
    if (ENV_SKY[i].at < t) continue;
    lower = ENV_SKY[i - 1];
    upper = ENV_SKY[i];
    break;
  }
  const span = upper.at - lower.at;
  const mix = span > 0 ? (t - lower.at) / span : 0;
  for (let c = 0; c < 3; c++) out[c] = lower.rgb[c] + (upper.rgb[c] - lower.rgb[c]) * mix;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
