// Demo corridors in Fort Myers, chosen from the Lee County pedestrian and bicyclist crash
// ranking (data/lee-crash-sections.json):
//  * US 41 (Cleveland Ave / S. Tamiami Trail), McGregor / MLK Blvd to Jamaica Bay Blvd, 8.5 mi.
//    Takes in the three one-mile sections of US 41 with the most crashes.
//  * SR 80 (Palm Beach Blvd), Seaboard St to Orange River Blvd past I-75, 4.3 mi. Takes in the
//    section with the most deaths and serious injuries in the county.
//
// Positions are meters from each corridor's start. Sides and legs use relative codes (see
// scripts/fetch-osm-corridor.mjs); `corridor.compass` says what they mean on the ground.
//
// Where each piece comes from:
//  * Real (OpenStreetMap, via scripts/fetch-osm-corridor.mjs): the road's centerline, which
//    signalized intersections exist and where, their side-street legs and lane counts, which
//    legs have a marked crosswalk, free right-turn slip lanes, sidewalk coverage, and bike lanes.
//    OSM is community-mapped: spot-check it against aerials.
//  * Unverified crosswalks: legs where OSM has no crossing mapped at all (common downtown) are
//    assumed to have one, and listed in `unverifiedCrosswalks` so the advice can say so.
//  * Derived: heavy right turns, from slip lanes (a slip lane exists because the turn is busy).
//  * Unverified defaults: No Turn on Red (none assumed) and leading pedestrian intervals
//    (none assumed). Neither is mapped in OSM here; fill in from a field visit or FDOT.
//  * Illustrative: construction events and the places list.
import { OSM_CORRIDOR as US41 } from "./corridors/us41-osm.js";
import { OSM_CORRIDOR as SR80 } from "./corridors/sr80-osm.js";

// Field-verified overrides per corridor and intersection id, e.g.
//   us41: { daniels: { ntor: ["E"], lpi: true, heavyRight: ["N", "S"], crosswalks: { S: false } } }
// ntor: approaches with a "No Turn on Red" sign. lpi: leading pedestrian interval.
// Leave empty until someone has checked; the defaults assume neither exists.
const FIELD_CHECKED = { us41: {}, sr80: {} };

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

function corridorData(osm, { corridor, events, places, defaultTrip }) {
  return {
    sample: true,
    id: osm.id,
    provenance: {
      real: "Road geometry, signal locations, crosswalks, slip lanes, sidewalks and bike lanes from OpenStreetMap (" + osm.fetchedAt + ").",
      illustrative: "No Turn on Red signs and leading pedestrian intervals are not yet verified (none assumed). Crosswalks not yet mapped in OpenStreetMap are assumed present. Construction events and places are illustrative.",
    },
    corridor: { ...corridor, compass: osm.compass, length: osm.length, line: osm.line },
    intersections: osm.intersections.map(intersection(FIELD_CHECKED[osm.id] || {})),
    sidewalks: osm.sidewalks,
    // type: "lane" (painted), "protected" (separated on-road), "path" (off-street shared-use path).
    bikeFacilities: osm.bikeFacilities,
    events,
    places,
    defaultTrip,
  };
}

const a41 = placer(US41);
export const US41_DATA = corridorData(US41, {
  corridor: { name: "US 41 (Cleveland Ave / S. Tamiami Trail)", short: "US 41", city: "Fort Myers, FL", lanes: 6 },
  events: [
    { id: "SAMPLE-1", type: "Sidewalk closure", desc: "Utility work: west sidewalk closed", side: "W", from: a41("cypressterrace", 120), to: a41("cypressterrace", 420),
      effect: "closed", schedule: { days: "weekdays", start: "07:00", end: "17:00" } },
    { id: "SAMPLE-2", type: "Lane closure", desc: "Northbound right lane closed for drainage work; crews next to the east sidewalk", side: "E", from: a41("sixmile", 187), to: a41("sixmile", 437),
      effect: "adjacent", schedule: { days: "all", start: "20:00", end: "05:00" } },
    { id: "SAMPLE-3", type: "Intersection construction", desc: "Intersection improvement: east-side corners at Six Mile Cypress detoured", side: "E", from: a41("sixmile", -38), to: a41("sixmile", 37),
      effect: "closed", schedule: { days: "all", start: "00:00", end: "24:00" } },
    { id: "SAMPLE-4", type: "Sidewalk closure", desc: "Driveway rebuild: east sidewalk closed south of Hanson St", side: "E", from: a41("hanson", 80), to: a41("hanson", 230),
      effect: "closed", schedule: { days: "weekdays", start: "08:00", end: "16:00" } },
  ],
  // North to south.
  places: [
    { id: "downtown", name: "Office downtown, south of Victoria Ave", pos: a41("victoria", 120), side: "E" },
    { id: "hansonbus", name: "Bus stop near Hanson St", pos: a41("hanson", 60), side: "E" },
    { id: "hillapts", name: "Apartments near Hill Ave", pos: a41("hill", -90), side: "W" },
    { id: "winklershop", name: "Shopping center near Winkler Ave", pos: a41("winkler", 120), side: "E" },
    { id: "home", name: "Home near Seven Lakes Blvd", pos: a41("sevenlakes", -139), side: "W" },
    { id: "bus", name: "Bus stop south of Daniels Pkwy", pos: a41("daniels", 87), side: "E" },
    { id: "office", name: "Office park near Cypress Terrace", pos: a41("cypressterrace", 170), side: "W" },
    { id: "grocery", name: "Grocery store", pos: a41("lakeridge", 361), side: "E" },
    { id: "plaza", name: "Retail plaza south of Six Mile Cypress", pos: a41("sixmile", 137), side: "E" },
    { id: "work", name: "Office near Jamaica Bay Blvd", pos: a41("jamaicabay", 166), side: "W" },
  ],
  defaultTrip: ["home", "work"],
});

// On SR 80 the start is the west end: side "E" is the north side, "W" the south side.
const a80 = placer(SR80);
export const SR80_DATA = corridorData(SR80, {
  corridor: { name: "SR 80 (Palm Beach Blvd)", short: "Palm Beach Blvd", city: "Fort Myers, FL", lanes: 4 },
  events: [
    { id: "SAMPLE-5", type: "Sidewalk closure", desc: "Drainage work: south sidewalk closed east of Marsh Ave", side: "W", from: a80("marsh", 200), to: a80("marsh", 450),
      effect: "closed", schedule: { days: "weekdays", start: "07:00", end: "16:00" } },
  ],
  // West to east.
  places: [
    { id: "home", name: "Home near Veronica S. Shoemaker Blvd", pos: a80("shoemaker", 250), side: "E" },
    { id: "bus", name: "Bus stop near Marsh Ave", pos: a80("marsh", -80), side: "W" },
    { id: "grocery", name: "Grocery store near New York Dr", pos: a80("newyork", 150), side: "E" },
    { id: "work", name: "Job near Ortiz Ave", pos: a80("ortiz", 200), side: "W" },
    { id: "shops", name: "Shops near Underwood Dr", pos: a80("underwood", -150), side: "E" },
    { id: "hotel", name: "Hotel job by the I-75 interchange", pos: a80("orangeriver", -90), side: "W" },
  ],
  defaultTrip: ["home", "work"],
});

export const CORRIDORS = [US41_DATA, SR80_DATA];
// The default corridor; tests and scripts that predate multiple corridors use this name.
export const SAMPLE_DATA = US41_DATA;
