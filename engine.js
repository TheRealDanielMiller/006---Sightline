// Sightline routing engine — side-of-street + crossing choice along one corridor.
// Rule set (U.S., right-hand traffic):
//  * A right-on-red driver looks LEFT for oncoming traffic. A pedestrian is in that
//    driver's view only when approaching from the driver's left.
//  * Walking along a N-S corridor that means: northbound -> east side, southbound -> west side
//    (walk on the right-hand side, with the adjacent traffic).
//  * Crossing the corridor itself: east->west on the north leg, west->east on the south leg.
//  * Avoid sidewalk gaps, active construction, missing crosswalks.

const VEC = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0] };
const OPP = { N: "S", S: "N", E: "W", W: "E" };
const SIDE_WORD = { E: "east", W: "west", N: "north", S: "south" };
const neg = (v) => [-v[0], -v[1]];
const cw = (v) => [v[1], -v[0]];
const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
const dirOf = (v) => Object.keys(VEC).find((k) => eq(VEC[k], v));

function toMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function eventActive(ev, ctx) {
  const s = ev.schedule || {};
  if (s.days === "weekdays" && ctx.weekend) return false;
  if (s.days === "weekends" && !ctx.weekend) return false;
  const a = toMin(s.start || "00:00");
  const b = toMin(s.end || "24:00");
  const t = ctx.minutes;
  return a <= b ? t >= a && t < b : t >= a || t < b; // overnight windows
}

function gapsFor(data, side) {
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

function makeRouter(data, opts) {
  const P = opts.safety
    ? { gapPerM: 5, closedPerM: 4, adjacentPerM: 1, blind: 250, noXwalk: 1500, behind: 80, toward: 20, corner: 400, darkGap: 1.5 }
    : { gapPerM: 0, closedPerM: 0, adjacentPerM: 0, blind: 0, noXwalk: 0, behind: 0, toward: 0, corner: 0, darkGap: 1 };
  const ctx = opts.ctx;
  const gaps = { E: gapsFor(data, "E"), W: gapsFor(data, "W") };
  const active = data.events.filter((e) => eventActive(e, ctx));
  const usLanes = data.corridor.lanes;

  function segment(side, a, b) {
    const len = Math.abs(b - a);
    let gapM = 0, closedM = 0, adjM = 0;
    const notes = [];
    for (const g of gaps[side]) {
      const o = overlap(a, b, g.from, g.to);
      if (o > 0) { gapM += o; notes.push({ kind: "gap", from: Math.max(Math.min(a, b), g.from), to: Math.min(Math.max(a, b), g.to), m: o }); }
    }
    for (const e of active) {
      if (e.side !== side && e.side !== "both") continue;
      const o = overlap(a, b, e.from, e.to);
      if (o <= 0) continue;
      if (e.effect === "closed") closedM += o; else adjM += o;
      notes.push({ kind: "event", event: e, m: o });
    }
    const cost = len + gapM * P.gapPerM * (ctx.dark ? P.darkGap : 1) + closedM * P.closedPerM + adjM * P.adjacentPerM;
    return { type: "walk", side, from: a, to: b, len, gapM, closedM, adjM, notes, cost };
  }

  function cornerEvents(I, sides) {
    return active.filter((e) => e.effect === "closed" && sides.includes(e.side) && I.pos >= e.from && I.pos <= e.to);
  }

  // Cross the cross street, on the leg on `side`, walking in direction pedDir.
  function crossCross(I, side, pedDir) {
    if (!I.legs.includes(side)) return { type: "pass", I, side, cost: 0 };
    const act = { type: "crossCross", I, side, leg: side, pedDir };
    let cost = 15 + 6 * I.crossLanes;
    act.noCrosswalk = !I.crosswalks[side];
    if (act.noCrosswalk) cost += P.noXwalk;
    const approach = side; // cross-street traffic approaching from this leg turns right across this crosswalk
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
    const pedDir = to; // walking toward the destination side
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
    // Same block, opposite sides: walk to the nearest crossing and back.
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
    const ex = { blind: 0, gapM: 0, closedM: 0, adjM: 0, noCrosswalk: 0, corner: 0, crossings: 0, distance: 0, behind: 0 };
    for (const a of r.acts) {
      if (a.type === "walk") { ex.gapM += a.gapM; ex.closedM += a.closedM; ex.adjM += a.adjM; ex.distance += a.len; }
      if (a.type === "crossCross" || a.type === "crossCorridor") {
        ex.crossings++;
        if (a.blind) ex.blind++;
        if (a.noCrosswalk) ex.noCrosswalk++;
        if (a.corner && a.corner.length) ex.corner++;
        if (a.rightHook === "behind") ex.behind++;
      }
    }
    r.exposure = ex;
    r.preferredSide = r.travel === "N" ? "E" : "W";
    r.activeEvents = active;
    return r;
  }

  return { route };
}

function plan(data, orig, dest, ctx) {
  const safe = makeRouter(data, { safety: true, ctx }).route(orig, dest);
  const typical = makeRouter(data, { safety: false, ctx }).route(orig, dest);
  if (safe && typical) {
    // re-score typical route's exposure with safety-aware actions (same path, real flags)
    typical.exposure = typical.exposure;
  }
  return { safe, typical };
}

if (typeof module !== "undefined") module.exports = { plan, eventActive, gapsFor, VEC, OPP, SIDE_WORD };
