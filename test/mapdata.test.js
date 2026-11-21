import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMapData, hasGeometry, OFFSET } from "../src/mapdata.js";
import { makeFrame } from "../src/geo.js";
import { plan } from "../src/engine.js";
import { loadCorridor } from "../src/data.js";

const D = await loadCorridor("us41");

const CTX = { minutes: 7 * 60 + 30, weekend: false, dark: false };
const P = Object.fromEntries(D.places.map((p) => [p.id, p]));
const frame = makeFrame(D.corridor.line);

test("sample data carries real geometry", () => {
  assert.ok(hasGeometry(D));
  assert.equal(hasGeometry({ corridor: {} }), false);
});

test("every crossing gets a pin, and the route starts and ends at the places", () => {
  for (const mode of ["walk", "bike"]) {
    const r = plan(D, P.home, P.work, CTX, { mode }).safe;
    const m = buildMapData(D, r);
    const crossings = r.acts.filter((a) => a.type === "crossCross" || a.type === "crossCorridor");
    assert.equal(m.pins.length, crossings.length, mode);
    const coords = m.route.features[0].geometry.coordinates;
    const start = frame.project(coords[0][1], coords[0][0]);
    const end = frame.project(coords.at(-1)[1], coords.at(-1)[0]);
    assert.ok(Math.abs(start.pos - P.home.pos) < 2 && start.side === P.home.side, `${mode} start`);
    assert.ok(Math.abs(end.pos - P.work.pos) < 2 && end.side === P.work.side, `${mode} end`);
  }
});

test("the drawn route stays on the side the engine chose", () => {
  const r = plan(D, P.work, P.home, { ...CTX, minutes: 18 * 60 }, { mode: "walk" }).safe;
  const m = buildMapData(D, r);
  const coords = m.route.features[0].geometry.coordinates;
  for (const a of r.acts.filter((a) => a.type === "walk" && a.len > 50)) {
    const mid = (a.from + a.to) / 2;
    // the route point nearest this stretch's midpoint should be on its side, ~sidewalk distance out
    let best = null;
    for (const [lon, lat] of coords) {
      const p = frame.project(lat, lon);
      if (!best || Math.abs(p.pos - mid) < Math.abs(best.pos - mid)) best = p;
    }
    assert.equal(best.side, a.side);
    assert.ok(Math.abs(best.dist - OFFSET.sidewalk) < 2, `dist ${best.dist}`);
  }
});

test("each step has somewhere to zoom to", () => {
  const r = plan(D, P.bus, P.office, CTX).safe;
  const m = buildMapData(D, r);
  for (const a of r.acts) if (a.type !== "walk" || a.len >= 1) assert.ok(m.focus.get(a), a.type);
});

test("without a route, the map still shows the corridor", () => {
  const m = buildMapData(D, null);
  assert.ok(m.sidewalks.features.length > 0);
  assert.equal(m.route.features.length, 0);
  assert.ok(m.bounds[0][0] < m.bounds[1][0] && m.bounds[0][1] < m.bounds[1][1]);
});
