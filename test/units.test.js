import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtDist, fmtFeet, fmtMiles } from "../src/units.js";

test("short distances read in feet, rounded sensibly", () => {
  assert.equal(fmtDist(1), "10 ft");      // never "0 ft"
  assert.equal(fmtDist(20), "70 ft");     // 65.6 ft
  assert.equal(fmtDist(150), "500 ft");   // 492 ft, nearest 50
});

test("longer distances switch to miles", () => {
  assert.equal(fmtDist(400), "0.2 mi");   // 1,312 ft
  assert.equal(fmtDist(3954), "2.5 mi");
});

test("table and total formats", () => {
  assert.equal(fmtFeet(0), "0 ft");
  assert.equal(fmtFeet(500), "1,640 ft");
  assert.equal(fmtMiles(1609.344), "1.00 mi");
});
