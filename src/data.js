// Demo corridors: Lee County state-road sections picked from the pedestrian and bicyclist crash
// ranking (data/lee-crash-sections.json). The list, with crash totals, is generated into
// src/corridors/index.js by scripts/fetch-osm-corridor.mjs; each corridor's data loads only
// when it's picked (loadCorridor).
//
// Positions are meters from each corridor's start. Sides and legs use relative codes (see
// scripts/fetch-osm-corridor.mjs); `corridor.compass` says what they mean on the ground.
//
// Where each piece comes from:
//  * Real (FDOT + OpenStreetMap, via scripts/fetch-osm-corridor.mjs): the corridor's extent and
//    mileposts (FDOT), the road's centerline, which signalized intersections exist and where,
//    their side-street legs and lane counts, which legs have a marked crosswalk, free right-turn
//    slip lanes, sidewalk coverage, and bike lanes (OSM). OSM is community-mapped: spot-check it
//    against aerials. FDOT's sidewalk inventory is kept alongside for comparison.
//  * Unverified crosswalks: legs where OSM has no crossing mapped at all (common downtown) are
//    assumed to have one, and listed in `unverifiedCrosswalks` so the advice can say so.
//  * Derived: heavy right turns, from slip lanes (a slip lane exists because the turn is busy).
//  * Unverified defaults: No Turn on Red (none assumed) and leading pedestrian intervals
//    (none assumed). Neither is mapped in OSM here; fill in from a field visit or FDOT.
//  * Illustrative: construction events and the places list.
import { CATALOG, LOADERS } from "./corridors/index.js";

export { CATALOG };
export const DEFAULT_CORRIDOR = "us41";

// Field-verified overrides per corridor and intersection id, e.g.
//   us41: { daniels: { ntor: ["E"], lpi: true, heavyRight: ["N", "S"], crosswalks: { S: false } } }
// ntor: approaches with a "No Turn on Red" sign. lpi: leading pedestrian interval.
// Leave empty until someone has checked; the defaults assume neither exists.
const FIELD_CHECKED = {};

// Drivers approaching from the far end (approach S) turn right into the E-side leg at the SE
// corner; drivers approaching from the start (approach N) turn right into the W-side leg at NW.
const heavyRightFromSlips = (slips = []) =>
  [slips.includes("NW") && "N", slips.includes("SE") && "S"].filter(Boolean);

function intersection(checked) {
  return (I) => {
    const f = checked[I.id] || {};
    const done = Object.keys(f.crosswalks || {});
    return {
      ...I,
      signal: true,
      ntor: f.ntor || [],
      lpi: f.lpi || false,
      heavyRight: f.heavyRight || heavyRightFromSlips(I.slipCorners),
      crosswalks: { ...I.crosswalks, ...f.crosswalks },
      unverifiedCrosswalks: (I.unverifiedCrosswalks || []).filter((l) => !done.includes(l)),
    };
  };
}

// Sample places and work zones are placed relative to an intersection, so they stay put
// when a corridor's ends move: at("hanson", 60) is 60 m past Hanson St, away from the start.
function placer(osm) {
  const pos = Object.fromEntries(osm.intersections.map((I) => [I.id, I.pos]));
  return (id, m = 0) => {
    if (!(id in pos)) throw new Error(`data.js: no intersection "${id}" in corridors/${osm.id}-osm.js`);
    return pos[id] + m;
  };
}

// Hand-written sample trips for the first two corridors.
const SAMPLES = {
  us41: (at) => ({
    events: [
      { id: "SAMPLE-1", type: "Sidewalk closure", desc: "Utility work: west sidewalk closed", side: "W", from: at("cypressterrace", 120), to: at("cypressterrace", 420),
        effect: "closed", schedule: { days: "weekdays", start: "07:00", end: "17:00" } },
      { id: "SAMPLE-2", type: "Lane closure", desc: "Northbound right lane closed for drainage work; crews next to the east sidewalk", side: "E", from: at("sixmile", 187), to: at("sixmile", 437),
        effect: "adjacent", schedule: { days: "all", start: "20:00", end: "05:00" } },
      { id: "SAMPLE-3", type: "Intersection construction", desc: "Intersection improvement: east-side corners at Six Mile Cypress detoured", side: "E", from: at("sixmile", -38), to: at("sixmile", 37),
        effect: "closed", schedule: { days: "all", start: "00:00", end: "24:00" } },
      { id: "SAMPLE-4", type: "Sidewalk closure", desc: "Driveway rebuild: east sidewalk closed south of Hanson St", side: "E", from: at("hanson", 80), to: at("hanson", 230),
        effect: "closed", schedule: { days: "weekdays", start: "08:00", end: "16:00" } },
    ],
    // North to south.
    places: [
      { id: "downtown", name: "Office downtown, south of Victoria Ave", pos: at("victoria", 120), side: "E" },
      { id: "hansonbus", name: "Bus stop near Hanson St", pos: at("hanson", 60), side: "E" },
      { id: "hillapts", name: "Apartments near Hill Ave", pos: at("hill", -90), side: "W" },
      { id: "winklershop", name: "Shopping center near Winkler Ave", pos: at("winkler", 120), side: "E" },
      { id: "home", name: "Home near Seven Lakes Blvd", pos: at("sevenlakes", -139), side: "W" },
      { id: "bus", name: "Bus stop south of Daniels Pkwy", pos: at("daniels", 87), side: "E" },
      { id: "office", name: "Office park near Cypress Terrace", pos: at("cypressterrace", 170), side: "W" },
      { id: "grocery", name: "Grocery store", pos: at("lakeridge", 361), side: "E" },
      { id: "plaza", name: "Retail plaza south of Six Mile Cypress", pos: at("sixmile", 137), side: "E" },
      { id: "work", name: "Office near Jamaica Bay Blvd", pos: at("jamaicabay", 166), side: "W" },
    ],
    defaultTrip: ["home", "work"],
  }),
  // On SR 80 the start is the west end: side "E" is the north side, "W" the south side.
  sr80: (at) => ({
    events: [
      { id: "SAMPLE-5", type: "Sidewalk closure", desc: "Drainage work: south sidewalk closed east of Marsh Ave", side: "W", from: at("marsh", 200), to: at("marsh", 450),
        effect: "closed", schedule: { days: "weekdays", start: "07:00", end: "16:00" } },
    ],
    // West to east.
    places: [
      { id: "home", name: "Home near Veronica S. Shoemaker Blvd", pos: at("shoemaker", 250), side: "E" },
      { id: "bus", name: "Bus stop near Marsh Ave", pos: at("marsh", -80), side: "W" },
      { id: "grocery", name: "Grocery store near New York Dr", pos: at("newyork", 150), side: "E" },
      { id: "work", name: "Job near Ortiz Ave", pos: at("ortiz", 200), side: "W" },
      { id: "shops", name: "Shops near Underwood Dr", pos: at("underwood", -150), side: "E" },
      { id: "hotel", name: "Hotel job by the I-75 interchange", pos: at("orangeriver", -90), side: "W" },
    ],
    defaultTrip: ["home", "work"],
  }),
};

// Other corridors get generic sample places beside intersections spread along the road,
// alternating sides, so every corridor has trips to try. They are labeled as samples.
const KINDS = ["Bus stop", "Apartments", "Shops", "Office", "Grocery store", "Clinic", "School", "Restaurant"];
export function autoSamples(osm) {
  const inside = osm.intersections.filter((I) => I.pos > 60 && I.pos < osm.length - 60);
  // Prefer named streets over "Driveway signal" as landmarks.
  const named = inside.filter((I) => !/^Driveway signal/.test(I.name));
  const Is = named.length >= 3 ? named : inside;
  const want = Math.min(6, Is.length);
  const places = [];
  for (let k = 0; k < want; k++) {
    const I = Is[Math.round((k * (Is.length - 1)) / Math.max(1, want - 1))];
    const offset = k % 2 ? -70 : 70;
    const pos = Math.max(20, Math.min(osm.length - 20, I.pos + offset));
    const near = I.short || I.name;
    places.push({ id: `p${k + 1}`, name: `${KINDS[k % KINDS.length]} near ${near} (sample)`, pos, side: k % 2 ? "W" : "E" });
  }
  const seen = new Set();
  const unique = places.filter((p) => !seen.has(p.pos) && seen.add(p.pos));
  return {
    events: [],
    places: unique,
    defaultTrip: unique.length >= 2 ? [unique[0].id, unique[Math.min(unique.length - 1, 3)].id] : [],
  };
}

function corridorData(osm, meta, sample) {
  return {
    sample: true,
    id: osm.id,
    provenance: {
      real: "Corridor extent and mileposts from FDOT; road geometry, signal locations, crosswalks, slip lanes, sidewalks and bike lanes from OpenStreetMap (" + osm.fetchedAt + ").",
      illustrative: "No Turn on Red signs and leading pedestrian intervals are not yet verified (none assumed). Crosswalks not yet mapped in OpenStreetMap are assumed present. Construction events and places are illustrative.",
    },
    corridor: {
      name: meta.name, short: meta.short, city: meta.city, lanes: meta.lanes,
      roadway: osm.roadway, compass: osm.compass, length: osm.length, line: osm.line, mp: osm.mp,
      crashes: meta.crashes,
    },
    intersections: osm.intersections.map(intersection(FIELD_CHECKED[osm.id] || {})),
    sidewalks: osm.sidewalks,
    // type: "lane" (painted), "protected" (separated on-road), "path" (off-street shared-use path).
    bikeFacilities: osm.bikeFacilities,
    fdotSidewalks: osm.fdotSidewalks,
    sidewalkConflicts: osm.sidewalkConflicts || [],
    events: sample.events,
    places: sample.places,
    defaultTrip: sample.defaultTrip,
  };
}

const cache = new Map();
/** Load one corridor's data by id (see CATALOG). Cached; safe to call repeatedly. */
export function loadCorridor(id) {
  if (!cache.has(id)) {
    const meta = CATALOG.find((c) => c.id === id);
    if (!meta || !LOADERS[id]) return Promise.reject(new Error(`unknown corridor "${id}"`));
    cache.set(id, LOADERS[id]().then(({ OSM_CORRIDOR: osm }) => {
      const sample = SAMPLES[id] ? SAMPLES[id](placer(osm)) : autoSamples(osm);
      return corridorData(osm, meta, sample);
    }));
  }
  return cache.get(id);
}

/** Every corridor, loaded (for tests and scripts). */
export const loadAllCorridors = () => Promise.all(CATALOG.map((c) => loadCorridor(c.id)));
