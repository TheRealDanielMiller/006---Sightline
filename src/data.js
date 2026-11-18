// Demo corridor: US 41 in south Fort Myers, from just south of College Pkwy to just
// south of Jamaica Bay Blvd. Positions are meters south of the corridor's north end.
//
// Where each piece comes from:
//  * Real (OpenStreetMap, via scripts/fetch-osm-corridor.mjs): the road's centerline, which
//    signalized intersections exist and where, their side-street legs, which legs have a
//    marked crosswalk, free right-turn slip lanes, sidewalk coverage, and bike lanes.
//    OSM is community-mapped: spot-check it against aerials.
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
  return {
    ...I,
    signal: true,
    ntor: f.ntor || [],
    lpi: f.lpi || false,
    heavyRight: f.heavyRight || heavyRightFromSlips(I.slipCorners),
    crosswalks: { ...I.crosswalks, ...f.crosswalks },
  };
}

export const SAMPLE_DATA = {
  sample: true,
  provenance: {
    real: "Road geometry, signal locations, crosswalks, slip lanes, sidewalks and bike lanes from OpenStreetMap (" + OSM.fetchedAt + ").",
    illustrative: "No Turn on Red signs and leading pedestrian intervals are not yet verified (none assumed). Construction events and places are illustrative.",
  },
  corridor: {
    name: "US 41 (S. Cleveland Ave / S. Tamiami Trail)", short: "US 41", city: "Fort Myers, FL",
    length: OSM.length, lanes: 6, line: OSM.line,
  },
  intersections: OSM.intersections.map(intersection),
  sidewalks: OSM.sidewalks,
  // type: "lane" (painted), "protected" (separated on-road), "path" (off-street shared-use path).
  bikeFacilities: OSM.bikeFacilities,
  events: [
    { id: "SAMPLE-1", type: "Sidewalk closure", desc: "Utility work: west sidewalk closed", side: "W", from: 1500, to: 1800,
      effect: "closed", schedule: { days: "weekdays", start: "07:00", end: "17:00" } },
    { id: "SAMPLE-2", type: "Lane closure", desc: "Northbound right lane closed for drainage work; crews next to the east sidewalk", side: "E", from: 3150, to: 3400,
      effect: "adjacent", schedule: { days: "all", start: "20:00", end: "05:00" } },
    { id: "SAMPLE-3", type: "Intersection construction", desc: "Intersection improvement: east-side corners at Six Mile Cypress detoured", side: "E", from: 2925, to: 3000,
      effect: "closed", schedule: { days: "all", start: "00:00", end: "24:00" } },
  ],
  places: [
    { id: "home", name: "Home (west side, near Seven Lakes Blvd)", pos: 150, side: "W" },
    { id: "bus", name: "Bus stop south of Daniels Pkwy", pos: 1000, side: "E" },
    { id: "office", name: "Office park near Cypress Terrace", pos: 1550, side: "W" },
    { id: "grocery", name: "Grocery store", pos: 2600, side: "E" },
    { id: "plaza", name: "Retail plaza south of Six Mile Cypress", pos: 3100, side: "E" },
    { id: "work", name: "Office near Jamaica Bay Blvd", pos: 3800, side: "W" },
  ],
};
