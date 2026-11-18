// Demo corridor: US 41 in south Fort Myers, from just south of College Pkwy to just
// south of Jamaica Bay Blvd. Positions are meters south of the corridor's north end.
//
// Where each piece comes from:
//  * Real (OpenStreetMap, via scripts/fetch-osm-corridor.mjs): the road's centerline, which
//    signalized intersections exist and where, their side-street legs, sidewalk coverage,
//    and bike lanes. OSM is community-mapped: spot-check it against aerials.
//  * Illustrative (NOT verified): crosswalk legs, No Turn on Red, leading pedestrian
//    intervals, heavy right turns, construction events, and the places list.
import { OSM_CORRIDOR as OSM } from "./corridor-osm.js";

// Per-intersection safety attributes. Illustrative until checked in the field.
const CROSSING_RULES = {
  sevenlakes: { crosswalks: { N: true, S: true, E: true, W: true }, ntor: [], lpi: false, heavyRight: [] },
  cypresstrace: { crosswalks: { N: true, S: true, W: true }, ntor: [], lpi: false, heavyRight: [] },
  daniels: { crosswalks: { N: true, S: true, E: true, W: true }, ntor: [], lpi: true, heavyRight: ["S"] },
  cypressterrace: { crosswalks: { N: true, S: true, W: true }, ntor: [], lpi: false, heavyRight: [] },
  lakeridge: { crosswalks: { N: true, S: true, E: true, W: true }, ntor: ["E"], lpi: false, heavyRight: [] },
  sixmile: { crosswalks: { N: true, S: false, E: true, W: true }, ntor: [], lpi: false, heavyRight: ["N", "S"] },
  jamaicabay: { crosswalks: { N: true, S: true, E: true }, ntor: [], lpi: false, heavyRight: [] },
};

export const SAMPLE_DATA = {
  sample: true,
  provenance: {
    real: "Road geometry, signal locations, sidewalks and bike lanes from OpenStreetMap (" + OSM.fetchedAt + ").",
    illustrative: "Crosswalk legs, No Turn on Red, leading pedestrian intervals, heavy right turns, construction events and places are illustrative.",
  },
  corridor: {
    name: "US 41 (S. Cleveland Ave / S. Tamiami Trail)", short: "US 41", city: "Fort Myers, FL",
    length: OSM.length, lanes: 6, line: OSM.line,
  },
  intersections: OSM.intersections.map((I) => ({ ...I, signal: true, ...CROSSING_RULES[I.id] })),
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
