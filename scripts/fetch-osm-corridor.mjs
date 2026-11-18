#!/usr/bin/env node
// Builds src/corridor-osm.js from OpenStreetMap: the corridor centerline, where each
// signalized intersection sits along it, which of its legs have a marked crosswalk, which
// corners have a free right-turn slip lane, and sidewalk / bike-lane coverage on each side.
//
// Usage: npm run fetch:osm
//
// Intersections are listed by hand below (from OSM traffic-signal nodes). No Turn on Red
// signs and leading pedestrian intervals are NOT in OSM here; those stay in src/data.js
// until field-verified.
//
// OSM data © OpenStreetMap contributors, ODbL 1.0.
import { writeFileSync } from "node:fs";
import { makeFrame } from "../src/geo.js";

const CONFIG = {
  ref: "US 41",
  north: 26.5545, // corridor north end (latitude): just south of College Pkwy
  south: 26.5195, // corridor south end: just south of Jamaica Bay Blvd
  bbox: [26.515, -81.880, 26.559, -81.862], // south, west, north, east
  maxOffsetM: 45, // how far from the centerline a sidewalk or path can be and still count
  mergeGapM: 35, // join sidewalk pieces split by driveways or side-street crossings
  intersections: [
    { id: "sevenlakes", name: "Seven Lakes Blvd / Big Pine Way", short: "Seven Lakes", lat: 26.5519, lon: -81.87167, legs: ["N", "S", "E", "W"], crossLanes: 2 },
    { id: "cypresstrace", name: "Cypress Trace Dr", lat: 26.55011, lon: -81.87159, legs: ["N", "S", "W"], crossLanes: 2 },
    { id: "daniels", name: "Daniels Pkwy / Cypress Lake Dr", short: "Daniels / Cypress Lake", lat: 26.54629, lon: -81.87154, legs: ["N", "S", "E", "W"], crossLanes: 6 },
    { id: "cypressterrace", name: "Cypress Terrace", lat: 26.54209, lon: -81.87146, legs: ["N", "S", "W"], crossLanes: 2 },
    { id: "lakeridge", name: "Lakeridge Ct / Andrea Ln", short: "Lakeridge", lat: 26.53437, lon: -81.87134, legs: ["N", "S", "E", "W"], crossLanes: 2 },
    { id: "sixmile", name: "Six Mile Cypress Pkwy / Gladiolus Dr", short: "Six Mile Cypress", lat: 26.52786, lon: -81.87127, legs: ["N", "S", "E", "W"], crossLanes: 6 },
    { id: "jamaicabay", name: "Jamaica Bay Blvd", lat: 26.5221, lon: -81.86972, legs: ["N", "S", "E"], crossLanes: 2 },
  ],
};

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "sightline-prototype" },
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return (await res.json()).elements;
    } catch (e) { lastErr = e; console.warn("Overpass failed, trying next:", e.message); }
  }
  throw lastErr;
}

function merge(ranges, gap) {
  const out = [];
  for (const [a, b] of ranges.slice().sort((x, y) => x[0] - y[0])) {
    const prev = out[out.length - 1];
    if (prev && a <= prev[1] + gap) prev[1] = Math.max(prev[1], b);
    else out.push([a, b]);
  }
  return out;
}

const round = (x) => Math.round(x);

// Crosswalks and slip lanes at one intersection, from OSM crossing nodes and
// footway=crossing ways near it. Positions are relative to the intersection center:
// dpos > 0 is south, x > 0 is east of the centerline.
//  * N/S leg crosswalk: a crossing on the US 41 carriageways 5-50 m north/south of center.
//  * E/W leg crosswalk: a crossing on the side street 15-45 m east/west, within 20 m along.
//  * Slip-lane corner: an explicitly unsignalized crossing (crossing:signals=no) out on a
//    corner diagonal; at a signalized intersection that's a free right-turn lane.
function crossingsAt(frame, els, pos, legs) {
  const found = new Set(), slip = new Set();
  for (const e of els) {
    const t = e.tags || {};
    const isX = (e.type === "node" && t.highway === "crossing") || (e.type === "way" && t.footway === "crossing");
    if (!isX || t.crossing === "unmarked" || t.crossing === "no" || t["crossing:markings"] === "no") continue;
    const pts = (e.type === "node" ? [e] : e.geometry).map((g) => frame.project(g.lat, g.lon));
    const dpos = pts.reduce((a, p) => a + p.pos, 0) / pts.length - pos;
    const xs = pts.map((p) => (p.side === "E" ? p.dist : -p.dist));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), xm = (x0 + x1) / 2;
    if (Math.abs(dpos) > 50 || Math.min(Math.abs(x0), Math.abs(x1)) > 45) continue;
    const ns = dpos < 0 ? "N" : "S", ew = xm > 0 ? "E" : "W";
    if (t["crossing:signals"] === "no" && Math.abs(dpos) > 15 && Math.abs(xm) > 15) slip.add(ns + ew);
    else if (Math.abs(dpos) >= 5 && (x0 < -5 && x1 > 5 || Math.abs(xm) < 15)) found.add(ns);
    else if (Math.abs(dpos) <= 20 && Math.abs(xm) >= 15) found.add(ew);
  }
  return {
    crosswalks: Object.fromEntries(legs.map((l) => [l, found.has(l)])),
    slipCorners: [...slip].sort(),
  };
}
const toRanges = (r) => merge(r, CONFIG.mergeGapM).map(([from, to]) => ({ from: round(from), to: round(to) })).filter((s) => s.to - s.from >= 10);

async function main() {
  const [s, w, n, e] = CONFIG.bbox;
  const bb = `(${s},${w},${n},${e})`;
  const els = await overpass(`[out:json][timeout:90];(
    way["highway"~"^(primary|trunk)$"]["ref"~"${CONFIG.ref}"]${bb};
    way["highway"="footway"]${bb};
    way["highway"~"^(cycleway|path)$"]${bb};
    node["highway"="crossing"]${bb};
  );out tags geom;`);
  const carriage = els.filter((x) => /^(primary|trunk)$/.test(x.tags.highway));
  console.log(`OSM ways: ${els.length} (${carriage.length} ${CONFIG.ref} carriageway pieces)`);

  // Centerline: at fixed latitudes (~25 m apart), find where each one-way carriageway
  // crosses that latitude and average the two. (Assumes the road runs roughly north-south.)
  const segs = { N: [], S: [] };
  for (const way of carriage) {
    const g = way.geometry;
    const dir = g[g.length - 1].lat > g[0].lat ? "N" : "S";
    for (let i = 0; i < g.length - 1; i++) segs[dir].push([g[i], g[i + 1]]);
  }
  const lonAt = (dir, lat) => {
    const xs = [];
    for (const [a, b] of segs[dir]) {
      if ((a.lat - lat) * (b.lat - lat) > 0 || a.lat === b.lat) continue;
      xs.push(a.lon + ((lat - a.lat) / (b.lat - a.lat)) * (b.lon - a.lon));
    }
    xs.sort((x, y) => x - y);
    return xs.length ? xs[Math.floor(xs.length / 2)] : null;
  };
  const STEP = 0.000225;
  let line = [], lastGap = null;
  for (let lat = CONFIG.north; lat >= CONFIG.south - 1e-9; lat -= STEP) {
    const nb = lonAt("N", lat), sb = lonAt("S", lat);
    let lon;
    if (nb != null && sb != null) { lon = (nb + sb) / 2; lastGap = nb - sb; }
    else if (nb != null && lastGap != null) lon = nb - lastGap / 2;
    else if (sb != null && lastGap != null) lon = sb + lastGap / 2;
    else continue;
    line.push([+lat.toFixed(6), +lon.toFixed(6)]);
  }
  const frame = makeFrame(line);
  console.log(`Centerline: ${line.length} points, ${round(frame.length)} m`);

  const intersections = CONFIG.intersections.map(({ lat, lon, ...I }) => {
    const p = frame.project(lat, lon);
    if (p.dist > 40) console.warn(`  ${I.name} is ${round(p.dist)} m off the centerline; check its coordinates`);
    return { ...I, pos: round(p.pos), ...crossingsAt(frame, els, p.pos, I.legs) };
  });

  // Sidewalks and paths: pieces of footways/paths running alongside the corridor.
  const sidewalk = { E: [], W: [] }, path = { E: [], W: [] }, lane = { E: [], W: [] }, track = { E: [], W: [] };
  const alongside = (way, into) => {
    const g = way.geometry;
    for (let i = 0; i < g.length - 1; i++) {
      const a = frame.project(g[i].lat, g[i].lon), b = frame.project(g[i + 1].lat, g[i + 1].lon);
      if (a.dist > CONFIG.maxOffsetM || b.dist > CONFIG.maxOffsetM || a.dist < 4 || a.side !== b.side) continue;
      const along = Math.abs(b.pos - a.pos), across = Math.abs(b.dist - a.dist);
      if (along < 2 || across > along * 0.5) continue; // not parallel to the road
      into[a.side].push([Math.min(a.pos, b.pos), Math.max(a.pos, b.pos)]);
    }
  };
  for (const way of els) {
    const t = way.tags;
    if (t.highway === "footway" && /^(sidewalk|crossing)$/.test(t.footway || "")) alongside(way, sidewalk);
    else if (t.highway === "cycleway" || (t.highway === "path" && (t.bicycle === "designated" || t.foot === "designated"))) { alongside(way, path); alongside(way, sidewalk); }
  }
  // Tags on the carriageways themselves: sidewalks drawn as attributes, and bike lanes.
  for (const way of carriage) {
    const g = way.geometry, t = way.tags;
    const a = frame.project(g[0].lat, g[0].lon), b = frame.project(g[g.length - 1].lat, g[g.length - 1].lon);
    if (a.dist > CONFIG.maxOffsetM && b.dist > CONFIG.maxOffsetM) continue;
    const lo = Math.max(0, Math.min(a.pos, b.pos)), hi = Math.min(frame.length, Math.max(a.pos, b.pos));
    if (hi - lo < 1) continue;
    const northbound = b.pos < a.pos;
    const right = northbound ? "E" : "W", left = northbound ? "W" : "E";
    const sw = t.sidewalk || t["sidewalk:both"];
    if (sw === "right" || sw === "both" || sw === "yes" || t["sidewalk:right"] === "yes") sidewalk[right].push([lo, hi]);
    if (sw === "left" || sw === "both" || t["sidewalk:left"] === "yes") sidewalk[left].push([lo, hi]);
    const cyc = t["cycleway:right"] || t["cycleway:both"] || t.cycleway;
    if (cyc === "lane") lane[right].push([lo, hi]);
    if (cyc === "track" || cyc === "separate") track[right].push([lo, hi]);
  }

  const sidewalks = { E: toRanges(sidewalk.E), W: toRanges(sidewalk.W) };
  const bikeFacilities = {};
  for (const side of ["E", "W"]) {
    bikeFacilities[side] = [
      ...toRanges(lane[side]).map((r) => ({ ...r, type: "lane" })),
      ...toRanges(track[side]).map((r) => ({ ...r, type: "protected" })),
      ...toRanges(path[side]).map((r) => ({ ...r, type: "path" })),
    ].sort((a, b) => a.from - b.from);
  }
  for (const side of ["E", "W"]) {
    const cov = (rs) => round(rs.reduce((t, r) => t + r.to - r.from, 0) / frame.length * 100);
    console.log(`Side ${side}: sidewalk ${cov(sidewalks[side])}% (${sidewalks[side].length} pieces), bike facility ${cov(bikeFacilities[side])}%`);
  }
  for (const I of intersections) {
    const missing = I.legs.filter((l) => !I.crosswalks[l]);
    console.log(`  ${String(I.pos).padStart(5)} m  ${I.name}  crosswalks: ${missing.length ? "missing " + missing.join(",") : "all legs"}${I.slipCorners.length ? "  slip lanes: " + I.slipCorners.join(",") : ""}`);
  }

  const out = {
    source: "OpenStreetMap (© OpenStreetMap contributors, ODbL)",
    fetchedAt: new Date().toISOString().slice(0, 10),
    length: round(frame.length),
    line,
    intersections,
    sidewalks,
    bikeFacilities,
  };
  writeFileSync(new URL("../src/corridor-osm.js", import.meta.url),
    `// GENERATED by scripts/fetch-osm-corridor.mjs. Do not edit; re-run the script instead.\n` +
    `// Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).\n` +
    `export const OSM_CORRIDOR = ${JSON.stringify(out, null, 1)};\n`);
  console.log("Wrote src/corridor-osm.js");
}

main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
