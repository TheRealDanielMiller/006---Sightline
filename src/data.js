// Demo corridor: US 41 (Cleveland Ave / S. Tamiami Trail) in Fort Myers, from McGregor Blvd /
// MLK Blvd downtown to just south of Jamaica Bay Blvd, about 8.5 miles. It takes in the
// three Lee County one-mile sections with the most pedestrian and bicyclist crashes on US 41
// (see data/lee-crash-sections.json). Positions are meters south of the corridor's north end.
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
import { OSM_CORRIDOR as OSM } from "./corridor-osm.js";

// Field-verified overrides per intersection id, e.g.
//   daniels: { ntor: ["E"], lpi: true, heavyRight: ["N", "S"], crosswalks: { S: false } }
// ntor: approaches with a "No Turn on Red" sign. lpi: leading pedestrian interval.
// Leave empty until someone has checked; the defaults assume neither exists.
const FIELD_CHECKED = {};

// Northbound drivers (approach S) turn right into the east leg at the SE corner; southbound
// drivers (approach N) turn right into the west leg at the NW corner.
const heavyRightFromSlips = (slips = []) =>
  [slips.includes("NW") && "N", slips.includes("SE") && "S"].filter(Boolean);

function intersection(I) {
  const f = FIELD_CHECKED[I.id] || {};
  const checked = Object.keys(f.crosswalks || {});
  return {
    ...I,
    signal: true,
    ntor: f.ntor || [],
    lpi: f.lpi || false,
    heavyRight: f.heavyRight || heavyRightFromSlips(I.slipCorners),
    crosswalks: { ...I.crosswalks, ...f.crosswalks },
    unverifiedCrosswalks: (I.unverifiedCrosswalks || []).filter((l) => !checked.includes(l)),
  };
}

// Sample places and work zones are placed relative to an intersection, so they stay put
// when the corridor's ends move: at("hanson", 60) is 60 m south of Hanson St.
const POS = Object.fromEntries(OSM.intersections.map((I) => [I.id, I.pos]));
const at = (id, m = 0) => {
  if (!(id in POS)) throw new Error(`data.js: no intersection "${id}" in corridor-osm.js`);
  return POS[id] + m;
};

export const SAMPLE_DATA = {
  sample: true,
  provenance: {
    real: "Road geometry, signal locations, crosswalks, slip lanes, sidewalks and bike lanes from OpenStreetMap (" + OSM.fetchedAt + ").",
    illustrative: "No Turn on Red signs and leading pedestrian intervals are not yet verified (none assumed). Crosswalks not yet mapped in OpenStreetMap are assumed present. Construction events and places are illustrative.",
  },
  corridor: {
    name: "US 41 (Cleveland Ave / S. Tamiami Trail)", short: "US 41", city: "Fort Myers, FL",
    length: OSM.length, lanes: 6, line: OSM.line,
  },
  intersections: OSM.intersections.map(intersection),
  sidewalks: OSM.sidewalks,
  // type: "lane" (painted), "protected" (separated on-road), "path" (off-street shared-use path).
  bikeFacilities: OSM.bikeFacilities,
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
  // North to south. The default trip is home -> work.
  places: [
    { id: "downtown", name: "Office downtown, south of Victoria Ave", pos: at("victoria", 120), side: "E" },
    { id: "hansonbus", name: "Bus stop near Hanson St", pos: at("hanson", 60), side: "E" },
    { id: "hillapts", name: "Apartments near Hill Ave", pos: at("hill", -90), side: "W" },
    { id: "winklershop", name: "Shopping center near Winkler Ave", pos: at("winkler", 120), side: "E" },
    { id: "home", name: "Home (west side, near Seven Lakes Blvd)", pos: at("sevenlakes", -139), side: "W" },
    { id: "bus", name: "Bus stop south of Daniels Pkwy", pos: at("daniels", 87), side: "E" },
    { id: "office", name: "Office park near Cypress Terrace", pos: at("cypressterrace", 170), side: "W" },
    { id: "grocery", name: "Grocery store", pos: at("lakeridge", 361), side: "E" },
    { id: "plaza", name: "Retail plaza south of Six Mile Cypress", pos: at("sixmile", 137), side: "E" },
    { id: "work", name: "Office near Jamaica Bay Blvd", pos: at("jamaicabay", 166), side: "W" },
  ],
  defaultTrip: ["home", "work"],
};
