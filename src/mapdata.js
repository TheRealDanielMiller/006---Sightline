// Turns corridor data + an engine route into GeoJSON for the real map.
// Kept free of MapLibre so it can be unit-tested in Node.
import { makeFrame, lngLat } from "./geo.js";
import { gapsFor, facilityAt } from "./engine.js";

// Typical distances from the centerline of a 6-lane divided road, in meters.
export const OFFSET = { sidewalk: 21, bikeLane: 15, path: 25 };

const line = (coords, props = {}) => ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords.map(lngLat) } });
const fc = (features) => ({ type: "FeatureCollection", features });

/** Distance from the intersection center to the crosswalk on its north or south leg. */
const legOffset = (I) => I.crossLanes * 1.8 + 6;

export function hasGeometry(data) {
  return !!(data && data.corridor && Array.isArray(data.corridor.line) && data.corridor.line.length >= 2);
}

export function buildMapData(data, route) {
  const f = makeFrame(data.corridor.line);
  const bike = route && route.mode === "bike";
  // Where the traveler is, across the road: in the bike lane when riding one, else on the sidewalk.
  const offFor = (side, pos, againstTraffic) => {
    if (!bike || againstTraffic) return OFFSET.sidewalk;
    const fac = facilityAt(data, side, pos);
    if (!fac) return OFFSET.sidewalk;
    return fac.type === "path" ? OFFSET.path : OFFSET.bikeLane;
  };

  const sidewalks = [], gaps = [], bikeFac = [], events = [];
  for (const side of ["E", "W"]) {
    for (const s of data.sidewalks[side] || []) sidewalks.push(line(f.path(s.from, s.to, side, OFFSET.sidewalk), { side }));
    for (const g of gapsFor(data, side)) if (g.to - g.from >= 5) gaps.push(line(f.path(g.from, g.to, side, OFFSET.sidewalk), { side, m: Math.round(g.to - g.from) }));
    for (const b of (data.bikeFacilities || {})[side] || []) {
      bikeFac.push(line(f.path(b.from, b.to, side, b.type === "path" ? OFFSET.path : OFFSET.bikeLane), { side, type: b.type }));
    }
  }
  const activeIds = new Set(route ? route.activeEvents.map((e) => e.id) : []);
  for (const e of data.events) {
    for (const side of e.side === "both" ? ["E", "W"] : [e.side]) {
      events.push(line(f.path(e.from, e.to, side, OFFSET.sidewalk), { id: e.id, type: e.type, active: activeIds.has(e.id) }));
    }
  }

  const out = { sidewalks: fc(sidewalks), gaps: fc(gaps), bike: fc(bikeFac), events: fc(events), route: fc([]), pins: [], ends: [], bounds: null, focus: new Map() };
  if (!route) {
    out.bounds = boundsOf(data.corridor.line);
    return out;
  }

  // Route: one continuous line through every action, plus a pin per crossing.
  const coords = [];
  const push = (ll) => { const last = coords[coords.length - 1]; if (!last || last[0] !== ll[0] || last[1] !== ll[1]) coords.push(ll); };
  push(f.at(route.orig.pos, route.orig.side, offFor(route.orig.side, route.orig.pos)));
  for (const a of route.acts) {
    if (a.type === "walk") {
      if (a.len < 1) continue;
      const off = offFor(a.side, (a.from + a.to) / 2, a.againstM > 0);
      const pts = f.path(a.from, a.to, a.side, off);
      pts.forEach(push);
      out.focus.set(a, { center: pts[Math.floor(pts.length / 2)], zoom: 16.5 });
    } else if (a.type === "crossCorridor") {
      const p = a.I.pos + (a.leg === "N" ? -1 : 1) * legOffset(a.I);
      const from = f.at(p, a.from, OFFSET.sidewalk), to = f.at(p, a.to, OFFSET.sidewalk);
      push(from); push(to);
      const mid = f.at(p);
      out.pins.push({ at: mid, act: a });
      out.focus.set(a, { center: mid, zoom: 18.5 });
    } else if (a.type === "crossCross") {
      const at = f.at(a.I.pos, a.side, a.inRoad ? OFFSET.bikeLane : OFFSET.sidewalk);
      out.pins.push({ at, act: a });
      out.focus.set(a, { center: at, zoom: 18.5 });
    } else if (a.type === "pass") {
      out.focus.set(a, { center: f.at(a.I.pos, a.side, OFFSET.sidewalk), zoom: 17.5 });
    }
  }
  push(f.at(route.dest.pos, route.dest.side, offFor(route.dest.side, route.dest.pos)));
  out.route = fc([line(coords, { mode: route.mode })]);
  // [lat, lon], like `pins`
  out.ends = [
    { label: "A", at: coords[0], place: route.orig },
    { label: "B", at: coords[coords.length - 1], place: route.dest },
  ];
  out.bounds = boundsOf(coords);
  return out;
}

/** [[west, south], [east, north]] in lon/lat for a list of [lat, lon] points. */
function boundsOf(pts) {
  const lats = pts.map((p) => p[0]), lons = pts.map((p) => p[1]);
  return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
}
