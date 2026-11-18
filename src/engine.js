// Sightline routing engine: side-of-street + crossing choice along one corridor.
// Rule set (U.S., right-hand traffic):
//  * A right-on-red driver looks LEFT for oncoming traffic. A pedestrian or cyclist is in
//    that driver's view only when approaching from the driver's left.
//  * Along a N-S corridor that means: northbound -> east side, southbound -> west side
//    (the right-hand side, moving with the adjacent traffic).
//  * Crossing the corridor itself: east->west on the north leg, west->east on the south leg.
//  * Avoid sidewalk gaps, active construction, missing crosswalks.
// Bike mode adds:
//  * Riding against traffic (wrong-way sidewalk or lane riding) is penalized per meter.
//  * Road stress by facility: none > painted lane > shared-use path > protected lane.
//  * Sidewalk gaps only matter where there is no bike facility.
//  * Right hooks (right turns on green crossing from behind) weigh far more than for walkers.

export const MODES = ["walk", "bike"];
export const SPEED_M_PER_MIN = { walk: 80, bike: 250 };

const ZERO = {
  gapPerM: 0, closedPerM: 0, adjacentPerM: 0, againstPerM: 0, noFacilityPerM: 0, lanePerM: 0, pathPerM: 0,
  blind: 0, noXwalk: 0, behind: 0, toward: 0, corner: 0, darkGap: 1,
};

// Penalties in equivalent meters. These are judgment calls: validate against crash data.
export const WEIGHTS = {
  walk: { ...ZERO, gapPerM: 5, closedPerM: 4, adjacentPerM: 1, blind: 250, noXwalk: 1500, behind: 80, toward: 20, corner: 400, darkGap: 1.5 },
  bike: {
    ...ZERO,
    gapPerM: 3,          // no sidewalk AND no bike facility: in mixed traffic or on the shoulder
    closedPerM: 2,       // sidewalk closure: riders can often use the road, so less than walking
    adjacentPerM: 3,     // lane closure next to the curb usually eats the bike lane
    againstPerM: 4,      // wrong-way riding: drivers at driveways and side streets don't look for you
    noFacilityPerM: 2,   // no bike lane or path (scaled down on roads under 4 lanes)
    lanePerM: 0.5,       // painted lane next to fast traffic (same scaling)
    pathPerM: 0.2,       // shared-use path: pedestrian and driveway conflicts
    blind: 250, noXwalk: 600, behind: 400, toward: 40, corner: 400, darkGap: 1.5,
  },
};

const VEC = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] };
const OPP = { N: "S", S: "N", E: "W", W: "E" };
const SIDE_WORD = { E: "east", W: "west", N: "north", S: "south" };
const ON_ROAD = new Set(["lane", "protected"]);
const neg = (v) => [-v[0], -v[1]];
const cw = (v) => [v[1], -v[0]];
const eq = (a, b) => a[0] === b[0] && a[1] === b[1];

export { VEC, OPP, SIDE_WORD };

/** The side that moves with adjacent traffic for a direction of travel along the corridor. */
export const withTrafficSide = (travel) => (travel === "N" ? "E" : "W");

function toMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function eventActive(ev, ctx) {
  const s = ev.schedule || {};
  if (s.days === "weekdays" && ctx.weekend) return false;
  if (s.days === "weekends" && !ctx.weekend) return false;
  const a = toMin(s.start || "00:00");
  const b = toMin(s.end || "24:00");
  const t = ctx.minutes;
  return a <= b ? t >= a && t < b : t >= a || t < b; // overnight windows
}

export function gapsFor(data, side) {
  const L = data.corridor.length;
  const segs = (data.sidewalks[side] || []).slice().sort((a, b) => a.from - b.from);
  const gaps = [];
  let cur = 0;
  for (const s of segs) {
    if (s.from > cur) gaps.push({ from: cur, to: s.from });
    cur = Math.max(cur, s.to);
  }
  if (cur < L) gaps.push({ from: cur, to: L });
  return gaps;
}

const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(Math.max(a1, a2), b2) - Math.max(Math.min(a1, a2), b1));

// Interval helpers: [from, to] pairs, clipped to [lo, hi] and merged.
function clip(list, lo, hi) {
  const out = [];
  const ivs = list.map((i) => [Math.max(lo, i.from), Math.min(hi, i.to)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  for (const iv of ivs) {
    const prev = out[out.length - 1];
    if (prev && iv[0] <= prev[1]) prev[1] = Math.max(prev[1], iv[1]);
    else out.push(iv);
  }
  return out;
}
const total = (ivs) => ivs.reduce((t, [a, b]) => t + b - a, 0);
function intersectTotal(A, B) {
  let t = 0;
  for (const [a1, b1] of A) for (const [a2, b2] of B) t += Math.max(0, Math.min(b1, b2) - Math.max(a1, a2));
  return t;
}

/** Bike facility on `side` covering position `pos`, or null. */
export function facilityAt(data, side, pos) {
  return ((data.bikeFacilities || {})[side] || []).find((f) => pos >= f.from && pos <= f.to) || null;
}

export function makeRouter(data, opts) {
  const mode = opts.mode || "walk";
  if (!WEIGHTS[mode]) throw new Error(`Unknown mode "${mode}". Expected one of: ${MODES.join(", ")}`);
  const bike = mode === "bike";
  const P = opts.safety ? WEIGHTS[mode] : ZERO;
  const ctx = opts.ctx;
  const gaps = { E: gapsFor(data, "E"), W: gapsFor(data, "W") };
  const facilities = { E: (data.bikeFacilities || {}).E || [], W: (data.bikeFacilities || {}).W || [] };
  const active = data.events.filter((e) => eventActive(e, ctx));
  const usLanes = data.corridor.lanes;
  const roadStress = usLanes >= 4 ? 1 : 0.5;

  function segment(side, a, b) {
    const len = Math.abs(b - a);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    let gapM = 0, closedM = 0, adjM = 0;
    let againstM = 0, noFacilityM = 0, laneM = 0, protectedM = 0, pathM = 0;
    const notes = [];
    const anyFac = bike ? clip(facilities[side], lo, hi) : [];
    for (const g of gaps[side]) {
      let o = overlap(a, b, g.from, g.to);
      // A bike lane or path makes a missing sidewalk irrelevant for a rider.
      if (bike && o > 0) o -= intersectTotal([[Math.max(lo, g.from), Math.min(hi, g.to)]], anyFac);
      if (o > 0) { gapM += o; notes.push({ kind: "gap", from: Math.max(lo, g.from), to: Math.min(hi, g.to), m: o }); }
    }
    const onRoad = bike ? clip(facilities[side].filter((f) => ON_ROAD.has(f.type)), lo, hi) : [];
    for (const e of active) {
      if (e.side !== side && e.side !== "both") continue;
      let o = overlap(a, b, e.from, e.to);
      // A sidewalk closure doesn't touch a rider who is in an on-road bike lane.
      if (bike && e.effect === "closed" && o > 0) o -= intersectTotal([[Math.max(lo, e.from), Math.min(hi, e.to)]], onRoad);
      if (o <= 0) continue;
      if (e.effect === "closed") closedM += o; else adjM += o;
      notes.push({ kind: "event", event: e, m: o });
    }
    if (bike && len > 0) {
      const dir = b > a ? "S" : "N";
      if (side !== withTrafficSide(dir)) { againstM = len; notes.push({ kind: "against", m: len }); }
      laneM = total(clip(facilities[side].filter((f) => f.type === "lane"), lo, hi));
      protectedM = total(clip(facilities[side].filter((f) => f.type === "protected"), lo, hi));
      pathM = total(clip(facilities[side].filter((f) => f.type === "path"), lo, hi));
      noFacilityM = len - total(anyFac);
      if (noFacilityM > 0) notes.push({ kind: "noFacility", m: noFacilityM });
    }
    const cost = len
      + gapM * P.gapPerM * (ctx.dark ? P.darkGap : 1)
      + closedM * P.closedPerM + adjM * P.adjacentPerM
      + againstM * P.againstPerM
      + (noFacilityM * P.noFacilityPerM + laneM * P.lanePerM) * roadStress
      + pathM * P.pathPerM;
    return { type: "walk", side, from: a, to: b, len, gapM, closedM, adjM, againstM, noFacilityM, laneM, protectedM, pathM, notes, cost };
  }

  function cornerEvents(I, sides) {
    return active.filter((e) => e.effect === "closed" && sides.includes(e.side) && I.pos >= e.from && I.pos <= e.to);
  }

  // Cross the cross street, on the leg on `side`, moving in direction pedDir.
  function crossCross(I, side, pedDir) {
    if (!I.legs.includes(side)) return { type: "pass", I, side, cost: 0 };
    const act = { type: "crossCross", I, side, leg: side, pedDir };
    let cost = 15 + 6 * I.crossLanes;
    // A rider in an on-road lane goes through with traffic and doesn't need the crosswalk.
    const fac = bike ? facilityAt(data, side, I.pos) : null;
    act.inRoad = !!(fac && ON_ROAD.has(fac.type));
    act.noCrosswalk = !I.crosswalks[side] && !act.inRoad;
    if (act.noCrosswalk) cost += P.noXwalk;
    const approach = side; // cross-street traffic approaching from this leg turns right across this crossing
    act.ntor = (I.ntor || []).includes(approach);
    act.visible = eq(VEC[pedDir], cw(neg(VEC[approach])));
    act.blind = !act.ntor && !act.visible;
    if (act.blind) cost += P.blind * (I.lpi ? 0.5 : 1);
    // right turns on green from the corridor into this leg
    const parallelApproach = side === "E" ? "S" : "N";
    if ((I.heavyRight || []).includes(parallelApproach)) {
      act.rightHook = eq(VEC[pedDir], neg(VEC[parallelApproach])) ? "behind" : "toward";
      cost += act.rightHook === "behind" ? P.behind : P.toward;
    }
    act.corner = cornerEvents(I, [side]);
    if (act.corner.length) cost += P.corner;
    act.cost = cost;
    return act;
  }

  // Cross the corridor at intersection I on leg (N or S), from side `from` to the other side.
  function crossCorridor(I, leg, from) {
    if (!I.crosswalks[leg]) return null;
    const to = OPP[from];
    const pedDir = to; // moving toward the destination side
    const act = { type: "crossCorridor", I, leg, from, to, pedDir };
    let cost = 30 + 10 * usLanes;
    act.ntor = (I.ntor || []).includes(leg);
    act.visible = eq(VEC[pedDir], cw(neg(VEC[leg])));
    act.blind = !act.ntor && !act.visible;
    if (act.blind) cost += P.blind * (I.lpi ? 0.5 : 1);
    act.corner = cornerEvents(I, ["E", "W"]);
    if (act.corner.length) cost += P.corner;
    act.cost = cost;
    return act;
  }

  function route(orig, dest) {
    const travel = dest.pos > orig.pos ? "S" : "N"; // positions increase southward
    const near = OPP[travel]; // leg you reach first
    const far = travel;
    const between = data.intersections
      .filter((I) => (travel === "S" ? I.pos > orig.pos && I.pos < dest.pos : I.pos < orig.pos && I.pos > dest.pos))
      .sort((a, b) => (travel === "S" ? a.pos - b.pos : b.pos - a.pos));

    let best = { E: null, W: null };
    best[orig.side] = { cost: 0, acts: [] };
    let cur = orig.pos;
    for (const I of between) {
      const nb = { E: null, W: null };
      const offer = (s, cost, acts) => { if (!nb[s] || cost < nb[s].cost) nb[s] = { cost, acts }; };
      for (const s of ["E", "W"]) {
        if (!best[s]) continue;
        const w = segment(s, cur, I.pos);
        const base = best[s].cost + w.cost;
        const o = OPP[s];
        const stay = crossCross(I, s, travel);
        offer(s, base + stay.cost, [...best[s].acts, w, stay]);
        const cu1 = crossCorridor(I, near, s);
        if (cu1) { const cc = crossCross(I, o, travel); offer(o, base + cu1.cost + cc.cost, [...best[s].acts, w, cu1, cc]); }
        const cu2 = crossCorridor(I, far, s);
        if (cu2) { const cc = crossCross(I, s, travel); offer(o, base + cc.cost + cu2.cost, [...best[s].acts, w, cc, cu2]); }
      }
      best = nb;
      cur = I.pos;
    }
    if (best[dest.side]) {
      const w = segment(dest.side, cur, dest.pos);
      const acts = [...best[dest.side].acts, w];
      return finish({ orig, dest, travel, acts, cost: best[dest.side].cost + w.cost, detour: false });
    }
    // Same block, opposite sides: go to the nearest crossing and back.
    let bestD = null;
    for (const I of data.intersections) {
      const dir = I.pos > orig.pos ? "S" : "N";
      const leg = OPP[dir]; // the leg facing you
      const legs = [leg, dir];
      for (const lg of legs) {
        const cu = crossCorridor(I, lg, orig.side);
        if (!cu) continue;
        const acts = [segment(orig.side, orig.pos, I.pos)];
        if (lg === dir) acts.push(crossCross(I, orig.side, dir));
        acts.push(cu);
        if (lg === dir) acts.push(crossCross(I, dest.side, OPP[dir]));
        acts.push(segment(dest.side, I.pos, dest.pos));
        const cost = acts.reduce((t, a) => t + a.cost, 0);
        if (!bestD || cost < bestD.cost) bestD = { orig, dest, travel, acts, cost, detour: true };
      }
    }
    return bestD ? finish(bestD) : null;
  }

  function finish(r) {
    const ex = {
      blind: 0, gapM: 0, closedM: 0, adjM: 0, noCrosswalk: 0, corner: 0, crossings: 0, distance: 0, behind: 0,
      againstM: 0, noFacilityM: 0, laneM: 0, protectedM: 0, pathM: 0,
    };
    for (const a of r.acts) {
      if (a.type === "walk") {
        for (const k of ["gapM", "closedM", "adjM", "againstM", "noFacilityM", "laneM", "protectedM", "pathM"]) ex[k] += a[k];
        ex.distance += a.len;
      }
      if (a.type === "crossCross" || a.type === "crossCorridor") {
        ex.crossings++;
        if (a.blind) ex.blind++;
        if (a.noCrosswalk) ex.noCrosswalk++;
        if (a.corner && a.corner.length) ex.corner++;
        if (a.rightHook === "behind") ex.behind++;
      }
    }
    r.mode = mode;
    r.exposure = ex;
    r.preferredSide = withTrafficSide(r.travel);
    r.activeEvents = active;
    return r;
  }

  return { route };
}

/**
 * Plan a trip. Returns the safety-weighted route and the "typical" (shortest) route
 * computed with every penalty set to zero.
 * @param {object} opts - { mode: "walk" | "bike" } (defaults to walk)
 */
export function plan(data, orig, dest, ctx, opts = {}) {
  const mode = opts.mode || "walk";
  const safe = makeRouter(data, { safety: true, ctx, mode }).route(orig, dest);
  const typical = makeRouter(data, { safety: false, ctx, mode }).route(orig, dest);
  return { mode, safe, typical };
}
