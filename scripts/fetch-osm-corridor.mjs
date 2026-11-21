#!/usr/bin/env node
// Builds src/corridors/<id>-osm.js from OpenStreetMap: the corridor centerline, where each
// signalized intersection sits along it, which of its legs have a marked crosswalk, which
// corners have a free right-turn slip lane, and sidewalk / bike-lane coverage on each side.
//
// Usage: npm run fetch:osm -- us41     (or sr80; no argument fetches every corridor)
//
// A corridor is an FDOT roadway id and a milepost range. FDOT's line gives the extent,
// direction and mileposts; OSM gives the precise centerline and everything on the street.
// FDOT's sidewalk inventory is saved alongside OSM's sidewalks for comparison.
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
    roadway: "12010000", // FDOT roadway id
    from: 23.643, // start: just north of McGregor Blvd / Dr. Martin Luther King Jr. Blvd (SR 82)
    to: 15.19, // end: just south of Jamaica Bay Blvd
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
    roadway: "12020000",
    from: 1.528, // start: just west of Seaboard St
    to: 5.855, // end: just past Orange River Blvd, east of I-75
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

// ---------- FDOT (Florida Dept. of Transportation open data, Transportation Data & Analytics) ----------
// Roads are identified by an 8-digit ROADWAY id and located by milepost (MP) along it.
const FDOT = "https://services1.arcgis.com/O1JpcwDW8sjYuddV/ArcGIS/rest/services";
const STATION_M = 25; // spacing of centerline points
const M_PER_MI = 1609.344;

async function fdotQuery(service, where, extra = "") {
  const url = `${FDOT}/${service}/FeatureServer/0/query?where=${encodeURIComponent(where)}&outFields=*&f=json${extra}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${service}: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${service}: ${j.error.message}`);
  return j.features;
}

// Local flat coordinates in meters (x east, y north) around a latitude; fine for a few miles.
function localXY(lat0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110574;
  return {
    toXY: (p) => [(p.lon ?? p[1]) * kx, (p.lat ?? p[0]) * ky],
    toLL: ([x, y]) => [y / ky, x / kx],
  };
}

// FDOT's centerline for `roadway` from milepost `from` to `to` (either order: the corridor
// starts at `from`), as stations every STATION_M meters carrying their milepost.
async function fdotStations(roadway, from, to) {
  const [f] = await fdotQuery("LRS_Routes_with_Measures_TDA", `ROADWAY='${roadway}'`, "&returnM=true&outSR=4326");
  if (!f) throw new Error(`FDOT has no roadway ${roadway}`);
  // Paths are [lon, lat, milepost]; join multi-part lines in milepost order.
  const pts = f.geometry.paths.flat().map(([lon, lat, m]) => ({ lat, lon, m })).sort((a, b) => a.m - b.m);
  const lo = Math.min(from, to), hi = Math.max(from, to);
  if (lo < pts[0].m - 0.01 || hi > pts.at(-1).m + 0.01) throw new Error(`MP ${from}-${to} is outside roadway ${roadway} (MP ${pts[0].m.toFixed(2)}-${pts.at(-1).m.toFixed(2)})`);
  const at = (m) => {
    let i = 0;
    while (i < pts.length - 2 && pts[i + 1].m < m) i++;
    const a = pts[i], b = pts[i + 1], t = b.m === a.m ? 0 : (m - a.m) / (b.m - a.m);
    return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon), m };
  };
  const n = Math.max(1, Math.round(((hi - lo) * M_PER_MI) / STATION_M));
  const out = [];
  for (let k = 0; k <= n; k++) out.push(at(from + ((to - from) * k) / n));
  return out;
}

// FDOT sidewalk inventory for the corridor, as position ranges per side. RDWYSIDE is relative
// to FDOT's inventory direction (increasing milepost): R = right, L = left, C = both, G = none.
async function fdotSidewalks(roadway, posOfMp, increasing) {
  const feats = await fdotQuery("Sidewalks_and_Gaps_TDA", `ROADWAY='${roadway}'`, "&returnGeometry=false");
  // Our "E" side is the left of travel from the corridor start.
  const sideOf = { L: increasing ? ["E"] : ["W"], R: increasing ? ["W"] : ["E"], C: ["E", "W"], G: [] };
  const out = { E: [], W: [], inventoried: [] };
  for (const { attributes: a } of feats) {
    const p0 = posOfMp(a.BEGIN_POST), p1 = posOfMp(a.END_POST);
    if (p0 == null || p1 == null) continue;
    const r = [Math.min(p0, p1), Math.max(p0, p1)];
    out.inventoried.push(r);
    for (const s of sideOf[a.RDWYSIDE] || []) out[s].push(r);
  }
  return out;
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
  // FDOT's line for this roadway between the two mileposts: the corridor's extent, direction,
  // and milepost reference. Stations every ~25 m, start end first.
  const stations = await fdotStations(CONFIG.roadway, CONFIG.from, CONFIG.to);
  const lats = stations.map((p) => p.lat), lons = stations.map((p) => p.lon);
  const PAD = 0.004; // ~400 m around the road
  const [s, w, n, e] = [Math.min(...lats) - PAD, Math.min(...lons) - PAD, Math.max(...lats) + PAD, Math.max(...lons) + PAD];
  const bb = `(${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)})`;
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

  // Centerline: FDOT's line follows one side of a divided road, a few meters off the middle,
  // and our side-of-road rules work in meters from the middle. So at each FDOT station, look
  // across the road (perpendicular to FDOT's line) for the OSM carriageways in each direction
  // and take the midpoint. A two-way (undivided) piece counts for both directions. Works on
  // curving roads; FDOT's line is only the guide.
  const { toXY, toLL } = localXY(stations[0].lat);
  const segs = { N: [], S: [] }; // N: carriageways heading back toward the start; S: toward the end
  const tangentAt = (i) => {
    const a = toXY(stations[Math.max(0, i - 2)]), b = toXY(stations[Math.min(stations.length - 1, i + 2)]);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  };
  const guide = makeFrame(stations.map((p) => [p.lat, p.lon]));
  for (const way of carriage) {
    const g = way.geometry.map(toXY);
    const twoWay = way.tags.oneway !== "yes" && way.tags.oneway !== "-1";
    const sign = way.tags.oneway === "-1" ? -1 : 1;
    for (let i = 0; i < g.length - 1; i++) {
      // Direction of this piece compared with the corridor's direction at the same spot.
      const mid = toLL([(g[i][0] + g[i + 1][0]) / 2, (g[i][1] + g[i + 1][1]) / 2]);
      const near = guide.project(mid[0], mid[1]);
      if (near.dist > 60) continue;
      const k = Math.min(stations.length - 1, Math.round(near.pos / STATION_M));
      const t = tangentAt(k);
      const toEnd = sign * ((g[i + 1][0] - g[i][0]) * t[0] + (g[i + 1][1] - g[i][1]) * t[1]) > 0;
      if (twoWay || toEnd) segs.S.push([g[i], g[i + 1]]);
      if (twoWay || !toEnd) segs.N.push([g[i], g[i + 1]]);
    }
  }
  // Signed distance along the normal from station p to the nearest carriageway piece crossing it.
  const crossAt = (dir, p, nrm) => {
    let best = null;
    for (const [a, b] of segs[dir]) {
      const d = [b[0] - a[0], b[1] - a[1]];
      const den = nrm[0] * d[1] - nrm[1] * d[0];
      if (Math.abs(den) < 1e-9) continue;
      const ap = [a[0] - p[0], a[1] - p[1]];
      const u = (ap[0] * d[1] - ap[1] * d[0]) / den; // along the normal
      const v = (ap[0] * nrm[1] - ap[1] * nrm[0]) / den; // along the piece, 0..1
      if (v < 0 || v > 1 || Math.abs(u) > 40) continue;
      if (best === null || Math.abs(u) < Math.abs(best)) best = u;
    }
    return best;
  };
  let line = [], mp = [], lastGap = null, lastU = 0, fdotOnly = 0;
  stations.forEach((st, i) => {
    const p = toXY(st), t = tangentAt(i), nrm = [-t[1], t[0]];
    const un = crossAt("N", p, nrm), us = crossAt("S", p, nrm);
    let u;
    if (un != null && us != null) { u = (un + us) / 2; lastGap = un - us; }
    else if (un != null && lastGap != null) u = un - lastGap / 2;
    else if (us != null && lastGap != null) u = us + lastGap / 2;
    else { u = lastU; fdotOnly++; }
    lastU = u;
    const [lat, lon] = toLL([p[0] + u * nrm[0], p[1] + u * nrm[1]]);
    line.push([+lat.toFixed(6), +lon.toFixed(6)]);
    mp.push(+st.m.toFixed(3));
  });
  const frame = makeFrame(line);
  console.log(`Centerline: ${line.length} points, ${round(frame.length)} m, MP ${CONFIG.from} -> ${CONFIG.to}` +
    (fdotOnly ? ` (${fdotOnly} stations with no OSM carriageway found; used FDOT's line)` : ""));

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

  // FDOT sidewalk inventory, in corridor positions, and where it disagrees with OSM.
  const mpPos = mp.map((m, i) => [m, frame.project(line[i][0], line[i][1]).pos]);
  const increasing = CONFIG.to > CONFIG.from;
  const posOfMp = (m) => {
    const lo = Math.min(CONFIG.from, CONFIG.to), hi = Math.max(CONFIG.from, CONFIG.to);
    const c = Math.max(lo, Math.min(hi, m));
    if (m < lo - 1e-6 && c === lo && Math.abs(m - lo) > 0.001 && m < lo) { /* clipped */ }
    let i = 0;
    while (i < mpPos.length - 2 && (increasing ? mpPos[i + 1][0] < c : mpPos[i + 1][0] > c)) i++;
    const [m0, p0] = mpPos[i], [m1, p1] = mpPos[i + 1];
    return m1 === m0 ? p0 : p0 + ((c - m0) / (m1 - m0)) * (p1 - p0);
  };
  const fdot = await fdotSidewalks(CONFIG.roadway, posOfMp, increasing);
  const fdotSidewalksOut = { E: toRanges(fdot.E), W: toRanges(fdot.W), inventoried: toRanges(fdot.inventoried) };
  const disagreements = [];
  for (const side of ["E", "W"]) {
    const has = (rs, p) => rs.some((r) => p >= r.from && p <= r.to);
    let cur = null;
    for (let p = 0; p <= frame.length; p += 10) {
      const inv = has(fdotSidewalksOut.inventoried, p);
      const o = has(sidewalks[side], p), fd = has(fdotSidewalksOut[side], p);
      const kind = !inv ? null : o && !fd ? "osm-only" : fd && !o ? "fdot-only" : null;
      if (kind && cur && cur.kind === kind && p - cur.to <= 10) cur.to = p;
      else if (kind) { cur = { side, kind, from: p, to: p }; disagreements.push(cur); }
    }
  }
  const sidewalkConflicts = disagreements.filter((d) => d.to - d.from >= 50)
    .map((d) => ({ ...d, mpFrom: +mpNear(d.from).toFixed(2), mpTo: +mpNear(d.to).toFixed(2) }));
  function mpNear(p) { let best = mpPos[0]; for (const x of mpPos) if (Math.abs(x[1] - p) < Math.abs(best[1] - p)) best = x; return best[0]; }
  const cov = (rs) => round(rs.reduce((t, r) => t + r.to - r.from, 0) / frame.length * 100);
  console.log(`FDOT sidewalk inventory: E ${cov(fdotSidewalksOut.E)}%, W ${cov(fdotSidewalksOut.W)}% (inventoried ${cov(fdotSidewalksOut.inventoried)}% of the corridor)`);
  for (const d of sidewalkConflicts) console.log(`  sidewalk conflict, ${d.side} side ${d.from}-${d.to} m (MP ${d.mpFrom}-${d.mpTo}): ${d.kind === "osm-only" ? "OSM has one, FDOT says none" : "FDOT has one, OSM has none"}`);

  const out = {
    id: corridorId,
    roadway: CONFIG.roadway,
    compass,
    source: "OpenStreetMap (© OpenStreetMap contributors, ODbL)",
    fetchedAt: new Date().toISOString().slice(0, 10),
    length: round(frame.length),
    line,
    mp, // FDOT milepost at each line point
    intersections,
    sidewalks,
    bikeFacilities,
    fdotSidewalks: fdotSidewalksOut,
    sidewalkConflicts,
  };
  writeFileSync(new URL(`../src/corridors/${corridorId}-osm.js`, import.meta.url),
    `// GENERATED by scripts/fetch-osm-corridor.mjs. Do not edit; re-run the script instead.\n` +
    `// Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).\n` +
    `export const OSM_CORRIDOR = ${JSON.stringify(out, null, 1)};\n`);
  console.log(`Wrote src/corridors/${corridorId}-osm.js (start = ${compass.N} end; sides E/W = ${compass.E}/${compass.W})`);
}

main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
