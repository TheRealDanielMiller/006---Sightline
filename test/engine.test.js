import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, WEIGHTS } from "../src/engine.js";
import { SAMPLE_DATA, CORRIDORS, US41_DATA, SR80_DATA } from "../src/data.js";

const CTX = { minutes: 8 * 60, weekend: false, dark: false };

// A 1 km, 4-lane test corridor with full sidewalks and no bike facilities unless overridden.
function corridor({ intersections, sidewalks, bikeFacilities, events } = {}) {
  return {
    corridor: { name: "Test Rd", short: "Test", city: "Testville, FL", length: 1000, lanes: 4 },
    intersections: intersections || [],
    sidewalks: sidewalks || { E: [{ from: 0, to: 1000 }], W: [{ from: 0, to: 1000 }] },
    bikeFacilities: bikeFacilities || { E: [], W: [] },
    events: events || [],
    places: [],
  };
}
const X = (id, pos, extra = {}) => ({
  id, name: id, pos, signal: true, legs: ["N", "S", "E", "W"], crossLanes: 4,
  crosswalks: { N: true, S: true, E: true, W: true }, ntor: [], lpi: false, heavyRight: [], ...extra,
});
const place = (pos, side) => ({ id: `p${pos}${side}`, name: `P${pos}`, pos, side });
const walks = (r) => r.acts.filter((a) => a.type === "walk" && a.len > 0);
const crossings = (r) => r.acts.filter((a) => a.type === "crossCross");

test("defaults to walk mode", () => {
  const D = corridor({ intersections: [X("mid", 500)] });
  const r = plan(D, place(900, "E"), place(100, "E"), CTX);
  assert.equal(r.mode, "walk");
  assert.equal(r.safe.mode, "walk");
});

test("rejects an unknown mode", () => {
  const D = corridor();
  assert.throws(() => plan(D, place(900, "E"), place(100, "E"), CTX, { mode: "scooter" }), /Unknown mode/);
});

test("right-on-red rule: northbound on the east side is visible, west side is not", () => {
  const D = corridor({ intersections: [X("mid", 500)] });
  const east = crossings(plan(D, place(900, "E"), place(100, "E"), CTX).safe)[0];
  assert.equal(east.visible, true);
  // Force the west side by making the corridor uncrossable.
  const D2 = corridor({ intersections: [X("mid", 500, { crosswalks: { N: false, S: false, E: true, W: true } })] });
  const west = crossings(plan(D2, place(900, "W"), place(100, "W"), CTX).safe)[0];
  assert.equal(west.visible, false);
  assert.equal(west.blind, true);
});

test("sidewalk gap: walker switches sides, rider stays in the bike lane on the with-traffic side", () => {
  const D = corridor({
    intersections: [X("south", 900), X("north", 100)],
    sidewalks: { E: [{ from: 0, to: 200 }, { from: 800, to: 1000 }], W: [{ from: 0, to: 1000 }] },
    bikeFacilities: { E: [{ from: 0, to: 1000, type: "lane" }], W: [] },
  });
  const o = place(950, "E"), d = place(50, "E"); // northbound: east side is with traffic
  const walk = plan(D, o, d, CTX, { mode: "walk" }).safe;
  const bike = plan(D, o, d, CTX, { mode: "bike" }).safe;
  assert.ok(walks(walk).some((a) => a.side === "W"), "walker should avoid the 600 m sidewalk gap");
  assert.ok(walks(bike).every((a) => a.side === "E"), "rider should stay in the east bike lane");
  assert.equal(bike.exposure.gapM, 0, "a bike lane covers the missing sidewalk");
  assert.equal(bike.exposure.againstM, 0);
});

test("bike: crosses over to ride with traffic instead of against it", () => {
  // No side streets (legs N/S only), so right-on-red can't be the reason to switch sides.
  const onlyMain = { legs: ["N", "S"] };
  const D = corridor({
    intersections: [X("south", 900, onlyMain), X("north", 100, onlyMain)],
    bikeFacilities: { E: [{ from: 0, to: 1000, type: "lane" }], W: [{ from: 0, to: 1000, type: "lane" }] },
  });
  const o = place(950, "W"), d = place(50, "W");
  const r = plan(D, o, d, CTX, { mode: "bike" });
  const middle = walks(r.safe).find((a) => a.from === 900 && a.to === 100);
  assert.equal(middle.side, "E", "northbound rider should be on the east side between signals");
  assert.equal(r.safe.exposure.againstM, 100, "only the short ends are against traffic");
  assert.equal(r.typical.exposure.againstM, 900, "the shortest route rides the whole way against traffic");
  // A walker has no reason to switch here.
  assert.ok(walks(plan(D, o, d, CTX, { mode: "walk" }).safe).every((a) => a.side === "W"));
});

test("bike: right hook from behind costs more than for a walker", () => {
  const D = corridor({ intersections: [X("mid", 500, { heavyRight: ["S"] })] });
  const base = corridor({ intersections: [X("mid", 500)] });
  for (const mode of ["walk", "bike"]) {
    const withHook = plan(D, place(900, "E"), place(100, "E"), CTX, { mode }).safe;
    const without = plan(base, place(900, "E"), place(100, "E"), CTX, { mode }).safe;
    assert.equal(crossings(withHook)[0].rightHook, "behind");
    assert.equal(withHook.exposure.behind, 1);
    assert.equal(withHook.cost - without.cost, WEIGHTS[mode].behind, mode);
  }
  assert.ok(WEIGHTS.bike.behind > WEIGHTS.walk.behind);
});

test("bike: a missing crosswalk doesn't matter to a rider in an on-road lane", () => {
  const D = corridor({
    intersections: [X("mid", 500, { crosswalks: { N: false, S: false, E: false, W: true } })],
    bikeFacilities: { E: [{ from: 0, to: 1000, type: "lane" }], W: [] },
  });
  const walk = crossings(plan(D, place(900, "E"), place(100, "E"), CTX, { mode: "walk" }).safe)[0];
  const bike = crossings(plan(D, place(900, "E"), place(100, "E"), CTX, { mode: "bike" }).safe)[0];
  assert.equal(walk.noCrosswalk, true);
  assert.equal(bike.noCrosswalk, false);
  assert.equal(bike.inRoad, true);
});

test("bike: sidewalk closures skip on-road lanes, lane closures don't", () => {
  const ev = (effect) => ({ id: effect, type: "Work", desc: "", side: "E", from: 300, to: 700, effect, schedule: { days: "all" } });
  const fac = { E: [{ from: 0, to: 1000, type: "lane" }], W: [] };
  const closed = plan(corridor({ bikeFacilities: fac, events: [ev("closed")] }), place(900, "E"), place(100, "E"), CTX, { mode: "bike" }).safe;
  const adjacent = plan(corridor({ bikeFacilities: fac, events: [ev("adjacent")] }), place(900, "E"), place(100, "E"), CTX, { mode: "bike" }).safe;
  assert.equal(closed.exposure.closedM, 0);
  assert.equal(adjacent.exposure.adjM, 400);
  // A walker still feels the sidewalk closure.
  const walk = plan(corridor({ bikeFacilities: fac, events: [ev("closed")] }), place(900, "E"), place(100, "E"), CTX, { mode: "walk" }).safe;
  assert.equal(walk.exposure.closedM, 400);
});

test("walk mode ignores bike-only factors", () => {
  const r = plan(corridor(), place(900, "W"), place(100, "W"), CTX, { mode: "walk" }).safe;
  assert.equal(r.exposure.againstM, 0);
  assert.equal(r.exposure.noFacilityM, 0);
});

test("sample data: every sample trip on every corridor routes in both modes", () => {
  for (const D of CORRIDORS) {
    const P = D.places;
    for (const mode of ["walk", "bike"]) {
      for (const o of P) for (const d of P) {
        if (o.id === d.id) continue;
        const r = plan(D, o, d, CTX, { mode });
        assert.ok(r.safe && r.typical, `${D.id} ${mode} ${o.id}->${d.id}`);
        assert.equal(r.safe.mode, mode);
        assert.ok(r.typical.exposure.distance <= r.safe.exposure.distance + 1e-9, `${D.id} ${mode} ${o.id}->${d.id}: typical should be the shortest`);
      }
    }
  }
});

test("corridors say what their relative codes mean on the ground", () => {
  assert.deepEqual(US41_DATA.corridor.compass, { S: "south", N: "north", E: "east", W: "west" });
  // Palm Beach Blvd runs west to east: the start is the west end, and the left of travel is north.
  assert.deepEqual(SR80_DATA.corridor.compass, { S: "east", N: "west", E: "north", W: "south" });
  const [w, e] = [SR80_DATA.corridor.line[0], SR80_DATA.corridor.line.at(-1)];
  assert.ok(e[1] > w[1] && e[0] > w[0], "SR 80 heads east-northeast from the start");
});

test("Palm Beach Blvd: I-75 ramp signals are crossings, places sit in order", () => {
  const ids = SR80_DATA.intersections.map((I) => I.id);
  for (const id of ["shoemaker", "marsh", "newyork", "ortiz", "i75west", "i75east"]) assert.ok(ids.includes(id), id);
  const ramps = SR80_DATA.intersections.find((I) => I.id === "i75west");
  assert.deepEqual(ramps.legNames, { E: "ramps", W: "ramps" });
  const pos = SR80_DATA.places.map((p) => p.pos);
  assert.deepEqual(pos, [...pos].sort((a, b) => a - b), "places listed west to east");
  assert.ok(pos.every((p) => p > 0 && p < SR80_DATA.corridor.length));
});

test("slip-lane corners add a penalty to crosswalks that start or end there", () => {
  const from = place(900, "E"), to = place(100, "E");
  const plain = plan(corridor({ intersections: [X("mid", 500)] }), from, to, CTX);
  const slipped = plan(corridor({ intersections: [X("mid", 500, { slipCorners: ["NE", "SE", "SW"] })] }), from, to, CTX);
  const a = crossings(plain.safe)[0], b = crossings(slipped.safe)[0];
  assert.equal(a.side, "E");
  assert.deepEqual(b.slip, ["NE", "SE"]);
  assert.equal(b.cost - a.cost, 2 * WEIGHTS.walk.slip);
  // The typical route ignores safety penalties.
  assert.equal(crossings(slipped.typical)[0].cost, crossings(plain.typical)[0].cost);
});

test("corridor data: crosswalks from OSM, unmapped legs flagged, Daniels slip lanes imply heavy northbound rights", () => {
  const byId = Object.fromEntries(SAMPLE_DATA.intersections.map((I) => [I.id, I]));
  for (const I of SAMPLE_DATA.intersections) {
    for (const l of I.legs) assert.equal(typeof I.crosswalks[l], "boolean", `${I.id} ${l}`);
    for (const l of I.unverifiedCrosswalks) assert.ok(I.legs.includes(l) && I.crosswalks[l], `${I.id} ${l}: unverified legs are assumed present`);
  }
  // The original south-end intersections are fully mapped; downtown has gaps in OSM.
  for (const id of ["sevenlakes", "cypresstrace", "daniels", "cypressterrace", "lakeridge", "sixmile", "jamaicabay"]) {
    assert.deepEqual(byId[id].unverifiedCrosswalks, [], id);
  }
  assert.ok(SAMPLE_DATA.intersections.some((I) => I.unverifiedCrosswalks.length), "some downtown legs unmapped");
  // North to south, ending at the old corridor's intersections.
  const pos = SAMPLE_DATA.intersections.map((I) => I.pos);
  assert.deepEqual(pos, [...pos].sort((a, b) => a - b));
  assert.equal(SAMPLE_DATA.intersections[0].id, "mlk");
  const d = byId.daniels;
  assert.deepEqual(d.slipCorners, ["NE", "SE", "SW"]);
  assert.deepEqual(d.heavyRight, ["S"]);
  assert.ok(SAMPLE_DATA.intersections.every((I) => I.ntor.length === 0 && I.lpi === false), "unverified: none assumed");
});
