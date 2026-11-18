import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFrame } from "../src/geo.js";

// A straight 1.11 km north-south line (0.01 degrees of latitude).
const line = [[26.55, -81.87], [26.54, -81.87]];

test("length and positions along a straight line", () => {
  const f = makeFrame(line);
  assert.ok(Math.abs(f.length - 1112) < 3, `length ${f.length}`);
  const p = f.project(26.545, -81.87);
  assert.ok(Math.abs(p.pos - f.length / 2) < 1);
  assert.ok(p.dist < 0.01);
});

test("east of a southbound line is side E, west is W", () => {
  const f = makeFrame(line);
  assert.equal(f.project(26.545, -81.8698).side, "E");
  assert.equal(f.project(26.545, -81.8702).side, "W");
});

test("at() is the inverse of project(), including the side offset", () => {
  const f = makeFrame([[26.55, -81.87], [26.545, -81.8705], [26.54, -81.869]]);
  for (const side of ["E", "W"]) {
    for (const pos of [10, 400, 900]) {
      const [lat, lon] = f.at(pos, side, 20);
      const back = f.project(lat, lon);
      assert.equal(back.side, side);
      assert.ok(Math.abs(back.pos - pos) < 1, `pos ${pos} -> ${back.pos}`);
      assert.ok(Math.abs(back.dist - 20) < 1, `dist ${back.dist}`);
    }
  }
});

test("path() follows the direction asked for", () => {
  const f = makeFrame(line);
  const down = f.path(100, 500, "E", 20);
  const up = f.path(500, 100, "E", 20);
  assert.ok(down[0][0] > down[down.length - 1][0], "southward path ends further south");
  assert.deepEqual(up, down.slice().reverse());
});
