// SAMPLE DATA — illustrative demo of US 41 near Six Mile Cypress Pkwy.
// Positions are meters measured southward from the north end of the study corridor.
// Replace with the output of fetch_live.py for real FDOT sidewalk + FL511 data.
const SAMPLE_DATA = {
  sample: true,
  corridor: { name: "US 41 (S. Tamiami Trail)", short: "US 41", city: "Fort Myers, FL", length: 2900, lanes: 6 },
  intersections: [
    { id: "daniels", name: "Daniels Pkwy", pos: 350, signal: true, legs: ["N", "S", "E"], crossLanes: 6,
      crosswalks: { N: true, S: true, E: true }, ntor: [], lpi: false, heavyRight: ["S"] },
    { id: "cypress", name: "Cypress Lake Dr", pos: 1100, signal: true, legs: ["N", "S", "E", "W"], crossLanes: 4,
      crosswalks: { N: true, S: true, E: true, W: true }, ntor: ["E"], lpi: true, heavyRight: [] },
    { id: "sixmile", name: "Six Mile Cypress Pkwy / Gladiolus Dr", short: "Six Mile Cypress", pos: 1900, signal: true, legs: ["N", "S", "E", "W"], crossLanes: 6,
      crosswalks: { N: true, S: false, E: true, W: true }, ntor: [], lpi: false, heavyRight: ["N", "S"] },
    { id: "island", name: "Island Park Rd", pos: 2600, signal: true, legs: ["N", "S", "E", "W"], crossLanes: 2,
      crosswalks: { N: true, S: true, E: true, W: true }, ntor: [], lpi: false, heavyRight: [] },
  ],
  sidewalks: {
    E: [ { from: 0, to: 1350, width: 5 }, { from: 1650, to: 2900, width: 6 } ],
    W: [ { from: 0, to: 2050, width: 5 }, { from: 2250, to: 2900, width: 5 } ],
  },
  events: [
    { id: "FL511-S1", type: "Sidewalk closure", desc: "Utility work: west sidewalk closed", side: "W", from: 600, to: 900,
      effect: "closed", schedule: { days: "weekdays", start: "07:00", end: "17:00" } },
    { id: "FL511-S2", type: "Lane closure", desc: "Northbound right lane closed for drainage work; crews next to the east sidewalk", side: "E", from: 2250, to: 2500,
      effect: "adjacent", schedule: { days: "all", start: "20:00", end: "05:00" } },
    { id: "FL511-S3", type: "Intersection construction", desc: "Intersection improvement: east-side corners at Six Mile Cypress detoured", side: "E", from: 1860, to: 1940,
      effect: "closed", schedule: { days: "all", start: "00:00", end: "24:00" } },
  ],
  places: [
    { id: "home", name: "Home (Villas neighborhood)", pos: 120, side: "W" },
    { id: "bus", name: "LeeTran bus stop near Daniels Pkwy", pos: 450, side: "E" },
    { id: "office", name: "Office park near Cypress Lake Dr", pos: 1250, side: "W" },
    { id: "grocery", name: "Grocery store", pos: 1720, side: "E" },
    { id: "plaza", name: "Retail plaza near Six Mile Cypress", pos: 2050, side: "E" },
    { id: "work", name: "Island Park business center", pos: 2780, side: "W" },
  ],
};
if (typeof module !== "undefined") module.exports = { SAMPLE_DATA };
