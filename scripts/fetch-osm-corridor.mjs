#!/usr/bin/env node
// Builds src/corridors/<id>-osm.js from OpenStreetMap: the corridor centerline, where each
// signalized intersection sits along it, which of its legs have a marked crosswalk, which
// corners have a free right-turn slip lane, and sidewalk / bike-lane coverage on each side.
//
// Usage: npm run fetch:osm -- us41     (or sr80; no argument fetches every corridor)
//
// A corridor is one road between two points. "Start" is position 0; positions grow toward
// the far end. Sides "E"/"W" are left/right of travel from the start (east/west for a road
// run north to south) and legs "N"/"S" point back toward the start / on toward the end.
// The engine only ever uses those relative codes; `compass` in the output says what they
// mean on the ground so the app can say "north side" on an east-west road.
//
// Signalized intersections are found automatically: traffic-signal nodes on the corridor's
// carriageways, grouped, with their side streets (which side they leave on, name, lane
// count) taken from the roads that join there. OVERRIDES below pin stable ids and short
// labels for intersections we refer to elsewhere. No Turn on Red signs and leading
// pedestrian intervals are NOT in OSM here; those stay in src/data.js until field-verified.
//
// OSM data © OpenStreetMap contributors, ODbL 1.0.
import { writeFileSync } from "node:fs";
import { makeFrame } from "../src/geo.js";

const DEFAULTS = {
  maxOffsetM: 45, // how far from the centerline a sidewalk or path can be and still count
  mergeGapM: 35, // join sidewalk pieces split by driveways or side-street crossings
  signalGroupM: 60, // signal nodes closer than this along the road are one intersection
  sideRoadMinM: 22, // a side street must reach this far from the centerline to count as a leg
};

// Overrides give detected intersections stable ids and labels, matched by name (or, where OSM
// gives no usable name, by being within 60 m of `near` [lat, lon]).
const CORRIDORS = {
  us41: {
    ref: "US 41",
    axis: "lat", // sample the centerline along latitude (a north-south road)
    start: 26.6416, // just north of McGregor Blvd / Dr. Martin Luther King Jr. Blvd (SR 82)
    end: 26.5195, // just south of Jamaica Bay Blvd
    bbox: [26.515, -81.885, 26.646, -81.860], // south, west, north, east
    overrides: [
  { match: /Martin Luther King/, id: "mlk", name: "McGregor Blvd / Dr. Martin Luther King Jr. Blvd (SR 82)", short: "McGregor / MLK" },
  { near: [26.5969, -81.8718], id: "colonial", name: "Colonial Blvd (interchange ramps)", short: "Colonial Blvd" },
  { match: /Seven Lakes/, id: "sevenlakes", name: "Seven Lakes Blvd / Big Pine Way", short: "Seven Lakes" },
  { match: /^Cypress Trace/, id: "cypresstrace" },
  { match: /Daniels/, id: "daniels", name: "Daniels Pkwy / Cypress Lake Dr", short: "Daniels / Cypress Lake" },
  { match: /^Cypress Terrace/, id: "cypressterrace" },
  { match: /Lakeridge/, id: "lakeridge", name: "Lakeridge Ct / Andrea Ln", short: "Lakeridge" },
  { match: /Six Mile/, id: "sixmile", name: "Six Mile Cypress Pkwy / Gladiolus Dr", short: "Six Mile Cypress" },
  { match: /Jamaica Bay/, id: "jamaicabay" },
    ],
  },
  sr80: {
    ref: "SR 80",
    name: /Palm Beach/, // SR 80 also runs on Seaboard St and the downtown one-way pair
    axis: "lon", // sample along longitude (a west-east road)
    start: -81.8540, // just west of Seaboard St
    end: -81.7945, // just east of Ortiz Ave
    bbox: [26.645, -81.858, 26.692, -81.790],
    overrides: [
      { match: /Riverside/, id: "riverside" },
      { match: /Shoemaker/, id: "shoemaker", name: "Veronica S. Shoemaker Blvd", short: "Shoemaker Blvd" },
      { match: /^Marsh/, id: "marsh" },
      { match: /New York/, id: "newyork", name: "Tice St / New York Dr", short: "New York Dr" },
      { match: /^Ortiz/, id: "ortiz" },
      { match: /^Underwood/, id: "underwood" },
      { near: [26.68347, -81.79992], id: "i75west", name: "I-75 ramps (west side of the interchange)", short: "I-75 west ramps" },
      { near: [26.68469, -81.79779], id: "i75east", name: "I-75 ramps (east side of the interchange)", short: "I-75 east ramps" },
      { match: /Orange River/, id: "orangeriver", name: "Orange River Blvd / Louise St", short: "Orange River Blvd" },
    ],
  },
};
const CORRIDOR_ID = process.argv[2];
let CONFIG, OVERRIDES;
// Roads that can be a side-street leg. Ramps count where people on foot cross them at a
// signal: single-point interchanges (Colonial Blvd over US 41) and freeway ramp terminals
// (I-75 at Palm Beach Blvd). Ordinary turn-lane links don't.
const isSideRoad = (t) => /^(primary|secondary|tertiary|unclassified|residential|service|living_street)$/.test(t.highway || "")
  || (/_link$/.test(t.highway || "") && t.junction === "spui")
  || t.highway === "motorway_link";
const RANK = { primary: 6, secondary: 5, tertiary: 4, unclassified: 3, residential: 2, living_street: 1, service: 0 };
// Shorter labels: "North Airport Road" -> "N Airport Rd". A direction word is abbreviated only
// when a name follows it, so "South Street" stays "South St".
const ABBR = { Street: "St", Avenue: "Ave", Boulevard: "Blvd", Drive: "Dr", Road: "Rd", Parkway: "Pkwy", Court: "Ct", Lane: "Ln", Terrace: "Ter" };
const abbreviate = (s) => s
  .replace(/\b(North|South|East|West) (?=\S+ \S)/g, (w) => w[0] + " ")
  .replace(/\b[A-Z][a-z]+\b/g, (w) => ABBR[w] || w);

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
//  * A leg with an explicitly unmarked (or no) crossing has no crosswalk. A leg with nothing
//    mapped is "unverified": many signals, downtown especially, have no crossings drawn in
//    OSM yet, and a missing tag is not a missing crosswalk.
function crossingsAt(frame, els, pos, legs) {
  const found = new Set(), slip = new Set(), unmarked = new Set();
  for (const e of els) {
    const t = e.tags || {};
    const isX = (e.type === "node" && t.highway === "crossing") || (e.type === "way" && t.footway === "crossing");
    if (!isX) continue;
    const marked = !(t.crossing === "unmarked" || t.crossing === "no" || t["crossing:markings"] === "no");
    const into = marked ? found : unmarked;
    const pts = (e.type === "node" ? [e] : e.geometry).map((g) => frame.project(g.lat, g.lon));
    const dpos = pts.reduce((a, p) => a + p.pos, 0) / pts.length - pos;
    const xs = pts.map((p) => (p.side === "E" ? p.dist : -p.dist));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), xm = (x0 + x1) / 2;
    if (Math.abs(dpos) > 50 || Math.min(Math.abs(x0), Math.abs(x1)) > 45) continue;
    const ns = dpos < 0 ? "N" : "S", ew = xm > 0 ? "E" : "W";
    if (marked && t["crossing:signals"] === "no" && Math.abs(dpos) > 15 && Math.abs(xm) > 15) slip.add(ns + ew);
    else if (Math.abs(dpos) >= 5 && (x0 < -5 && x1 > 5 || Math.abs(xm) < 15)) into.add(ns);
    else if (Math.abs(dpos) <= 20 && Math.abs(xm) >= 15) into.add(ew);
  }
  return {
    crosswalks: Object.fromEntries(legs.map((l) => [l, found.has(l) || !unmarked.has(l)])),
    unverifiedCrosswalks: legs.filter((l) => !found.has(l) && !unmarked.has(l)),
    slipCorners: [...slip].sort(),
  };
}
// Signalized intersections: group the traffic-signal nodes on the carriageways, then look at
// the roads that join the carriageways nearby. A joining road whose far end is well east or
// west of the centerline is a side-street leg on that side.
function findIntersections(frame, els, carriage) {
  const mainIds = new Set(carriage.map((w) => w.id));
  const mainNodes = new Set(carriage.flatMap((w) => w.nodes));
  const signals = els
    .filter((e) => e.type === "node" && e.tags?.highway === "traffic_signals" && mainNodes.has(e.id))
    .map((e) => frame.project(e.lat, e.lon))
    .filter((p) => p.dist < 40 && p.pos > 0 && p.pos < frame.length)
    .sort((a, b) => a.pos - b.pos);
  const groups = [];
  for (const s of signals) {
    const g = groups.at(-1);
    if (g && s.pos - g.at(-1).pos < CONFIG.signalGroupM) g.push(s);
    else groups.push([s]);
  }

  // Where each side road touches the carriageways, and how far out it reaches.
  const sideWays = els.filter((w) => w.type === "way" && !mainIds.has(w.id) && isSideRoad(w.tags) && w.nodes);
  const joins = [];
  for (const w of sideWays) {
    const pts = w.geometry.map((g) => frame.project(g.lat, g.lon));
    w.nodes.forEach((id, i) => {
      if (!mainNodes.has(id)) return;
      const far = pts.reduce((a, b) => (b.dist > a.dist ? b : a));
      // Short pieces (busy junctions are split into many) can still name a leg, but only
      // a road reaching sideRoadMinM out makes one.
      if (far.dist >= 8) joins.push({ way: w, pos: pts[i].pos, side: far.side, reaches: far.dist >= CONFIG.sideRoadMinM });
    });
  }

  const out = [];
  for (const g of groups) {
    const center = g.reduce((t, s) => t + s.pos, 0) / g.length;
    const lo = g[0].pos - 45, hi = g.at(-1).pos + 45;
    const near = joins.filter((j) => j.pos >= lo && j.pos <= hi);
    const legSides = new Set(near.filter((j) => j.reaches).map((j) => j.side));
    const here = near.filter((j) => legSides.has(j.side));
    if (!here.length) { console.log(`  ${round(center)} m: signal with no side street (mid-block crossing?), skipped`); continue; }
    const legs = ["N", "S"], names = {}, lanes = {};
    for (const side of ["E", "W"]) {
      const ws = [...new Map(here.filter((j) => j.side === side).map((j) => [j.way.id, j.way])).values()];
      if (!ws.length) continue;
      legs.push(side);
      // The leg's name: the most important named road there (route number, then class), then the most common.
      const score = (w) => (w.tags.ref ? 100 : 0) + (RANK[w.tags.highway.replace("_link", "")] || 0) * 10 + ws.filter((v) => v.tags.name === w.tags.name).length;
      const best = ws.filter((w) => w.tags.name).sort((a, b) => score(b) - score(a))[0];
      names[side] = best ? best.tags.name
        : ws.some((w) => /_link$/.test(w.tags.highway)) ? "ramps"
        : ws.some((w) => w.tags.highway === "service") ? "driveway" : "unnamed road";
      // Lanes to cross on this leg: the widest road there (a one-way pair counts both halves).
      const long = [...new Map(here.filter((j) => j.side === side && j.reaches).map((j) => [j.way.id, j.way])).values()];
      const pairs = long.filter((w) => w.tags.oneway === "yes" && w.tags.name === names[side]);
      lanes[side] = Math.max(...long.map(wayLanes),pairs.length >= 2 ? pairs.slice(0, 2).reduce((t, w) => t + wayLanes(w), 0) : 0);
    }
    if (legs.length === 2) continue;
    const pos = round(here.reduce((t, j) => t + j.pos, 0) / here.length);
    const realName = (n) => n && !["driveway", "unnamed road", "ramps"].includes(n);
    // One street often carries two spellings ("Veronica S. Shoemaker" / "Veronica S Shoemaker").
    const key = (n) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
    const nameList = [...new Map([names.W, names.E].filter(realName).map((n) => [key(n), n])).values()];
    const name = nameList.join(" / ") || "Driveway signal";
    const ll = frame.at(pos);
    const o = OVERRIDES.find((x) => (x.match ? x.match.test(name) : Math.hypot((x.near[0] - ll[0]) * 111000, (x.near[1] - ll[1]) * 99500) < 60)) || {};
    const id = o.id || name.toLowerCase().replace(/\b(street|avenue|road|boulevard|drive|way|lane|court|parkway|terrace)\b/g, "").replace(/[^a-z0-9]+/g, "");
    const short = o.short || abbreviate(nameList.length > 1 ? nameList[0] : name);
    // legNames: what you actually cross on each side, e.g. a driveway opposite a named street.
    const legNames = Object.fromEntries(Object.entries(names).map(([s, n]) => [s, realName(n) ? abbreviate(n) : n]));
    out.push({ id, name: o.name || abbreviate(name), ...(short !== (o.name || abbreviate(name)) ? { short } : {}), pos, legs, legNames, crossLanes: Math.max(2, ...Object.values(lanes)) });
  }
  // Ids must be unique; suffix repeats.
  const seen = {};
  for (const I of out) { seen[I.id] = (seen[I.id] || 0) + 1; if (seen[I.id] > 1) I.id += seen[I.id]; }
  return out;
}

// Lanes a side road adds to a crossing: its lanes tag, else a guess from its class.
function wayLanes(w) {
  const t = w.tags, oneway = t.oneway === "yes" || t.oneway === "-1";
  const n = parseInt(t.lanes, 10);
  if (n > 0) return n;
  const big = /^(primary|secondary)$/.test(t.highway);
  return oneway ? (big ? 2 : 1) : (big ? 4 : 2);
}

const toRanges = (r) => merge(r, CONFIG.mergeGapM).map(([from, to]) => ({ from: round(from), to: round(to) })).filter((s) => s.to - s.from >= 10);

async function main() {
  const ids = CORRIDOR_ID ? [CORRIDOR_ID] : Object.keys(CORRIDORS);
  for (const id of ids) {
    if (!CORRIDORS[id]) throw new Error(`unknown corridor "${id}"; known: ${Object.keys(CORRIDORS).join(", ")}`);
    CONFIG = { ...DEFAULTS, ...CORRIDORS[id] }; OVERRIDES = CONFIG.overrides;
    console.log(`\n== ${id} (${CONFIG.ref}) ==`);
    await fetchCorridor(id);
  }
}

async function fetchCorridor(corridorId) {
  const [s, w, n, e] = CONFIG.bbox;
  const bb = `(${s},${w},${n},${e})`;
  const els = await overpass(`[out:json][timeout:120];
    way["highway"~"^(primary|trunk)$"]["ref"~"${CONFIG.ref}"]${bb}->.main;
    node(w.main)->.mainNodes;
    (
      .main;
      way(bn.mainNodes)["highway"];
      way["highway"="footway"]${bb};
      way["highway"~"^(cycleway|path)$"]${bb};
      node["highway"="crossing"]${bb};
      node.mainNodes["highway"="traffic_signals"];
    );out body geom;`);
  const isMain = (x) => x.type === "way" && /^(primary|trunk)$/.test(x.tags.highway) && (x.tags.ref || "").split(";").map((r) => r.trim()).includes(CONFIG.ref)
    && (!CONFIG.name || CONFIG.name.test(x.tags.name || ""));
  const carriage = els.filter(isMain);
  console.log(`OSM ways: ${els.length} (${carriage.length} ${CONFIG.ref} carriageway pieces)`);

  // Centerline: step along the axis (~25 m apart) from start to end; at each step find where
  // each carriageway crosses it and average the two directions. A two-way (undivided) piece
  // counts for both. Assumes the road keeps moving along the axis (no doubling back).
  const A = CONFIG.axis, B = A === "lat" ? "lon" : "lat";
  const dirSign = Math.sign(CONFIG.end - CONFIG.start); // +1 if the axis value grows toward the end
  const segs = { N: [], S: [] }; // N: carriageways heading back toward the start; S: toward the end
  for (const way of carriage) {
    const g = way.geometry;
    const twoWay = way.tags.oneway !== "yes" && way.tags.oneway !== "-1";
    const toEnd = Math.sign(g[g.length - 1][A] - g[0][A]) === dirSign;
    for (let i = 0; i < g.length - 1; i++) {
      if (twoWay || toEnd) segs.S.push([g[i], g[i + 1]]);
      if (twoWay || !toEnd) segs.N.push([g[i], g[i + 1]]);
    }
  }
  const crossAt = (dir, v) => {
    const xs = [];
    for (const [a, b] of segs[dir]) {
      if ((a[A] - v) * (b[A] - v) > 0 || a[A] === b[A]) continue;
      xs.push(a[B] + ((v - a[A]) / (b[A] - a[A])) * (b[B] - a[B]));
    }
    xs.sort((x, y) => x - y);
    return xs.length ? xs[Math.floor(xs.length / 2)] : null;
  };
  const STEP = A === "lat" ? 0.000225 : 0.00025;
  let line = [], lastGap = null;
  const steps = Math.floor(Math.abs(CONFIG.end - CONFIG.start) / STEP + 1e-6);
  for (let k = 0; k <= steps; k++) {
    const v = CONFIG.start + dirSign * k * STEP;
    const nb = crossAt("N", v), sb = crossAt("S", v);
    let w;
    if (nb != null && sb != null) { w = (nb + sb) / 2; lastGap = nb - sb; }
    else if (nb != null && lastGap != null) w = nb - lastGap / 2;
    else if (sb != null && lastGap != null) w = sb + lastGap / 2;
    else continue;
    const pt = A === "lat" ? [v, w] : [w, v];
    line.push([+pt[0].toFixed(6), +pt[1].toFixed(6)]);
  }
  const frame = makeFrame(line);
  console.log(`Centerline: ${line.length} points, ${round(frame.length)} m`);

  const intersections = findIntersections(frame, els, carriage).map((I) => ({ ...I, ...crossingsAt(frame, els, I.pos, I.legs) }));

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

  // A short break in the sidewalk right at a side-street leg is the crossing of that street,
  // not a gap (wide ones, like the interchange ramps at Colonial, exceed mergeGapM).
  const bridgeLegs = (ranges, side) => {
    const out = [];
    for (const r of ranges) {
      const prev = out.at(-1), mid = prev && (prev.to + r.from) / 2;
      if (prev && r.from - prev.to < 80 && intersections.some((I) => I.legs.includes(side) && Math.abs(I.pos - mid) < 40)) prev.to = r.to;
      else out.push({ ...r });
    }
    return out;
  };
  const sidewalks = { E: bridgeLegs(toRanges(sidewalk.E), "E"), W: bridgeLegs(toRanges(sidewalk.W), "W") };
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
    const unk = I.unverifiedCrosswalks;
    console.log(`  ${String(I.pos).padStart(5)} m  ${I.id.padEnd(16)} ${I.name} [${I.legs.join("")}, ${I.crossLanes} lanes]  crosswalks: ${missing.length ? "NONE on " + missing.join(",") : "all legs"}${unk.length ? " (unmapped: " + unk.join(",") + ")" : ""}${I.slipCorners.length ? "  slip lanes: " + I.slipCorners.join(",") : ""}`);
  }

  // What the relative codes mean on the ground, from the overall direction start -> end.
  const [la0, lo0] = line[0], [la1, lo1] = line.at(-1);
  const dx = (lo1 - lo0) * Math.cos((la0 * Math.PI) / 180), dy = la1 - la0;
  const travel = Math.abs(dy) >= Math.abs(dx) ? (dy < 0 ? "south" : "north") : (dx > 0 ? "east" : "west");
  const OPPOSITE = { north: "south", south: "north", east: "west", west: "east" };
  const LEFT_OF = { south: "east", north: "west", east: "north", west: "south" };
  const compass = { S: travel, N: OPPOSITE[travel], E: LEFT_OF[travel], W: OPPOSITE[LEFT_OF[travel]] };

  const out = {
    id: corridorId,
    compass,
    source: "OpenStreetMap (© OpenStreetMap contributors, ODbL)",
    fetchedAt: new Date().toISOString().slice(0, 10),
    length: round(frame.length),
    line,
    intersections,
    sidewalks,
    bikeFacilities,
  };
  writeFileSync(new URL(`../src/corridors/${corridorId}-osm.js`, import.meta.url),
    `// GENERATED by scripts/fetch-osm-corridor.mjs. Do not edit; re-run the script instead.\n` +
    `// Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).\n` +
    `export const OSM_CORRIDOR = ${JSON.stringify(out, null, 1)};\n`);
  console.log(`Wrote src/corridors/${corridorId}-osm.js (start = ${compass.N} end; sides E/W = ${compass.E}/${compass.W})`);
}

main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
