import { plan, gapsFor, facilityAt, SPEED_M_PER_MIN } from "./engine.js";
import { SAMPLE_DATA } from "./data.js";
import { fmtDist, fmtFeet, fmtMiles } from "./units.js";

let DATA = SAMPLE_DATA;
const $ = (id) => document.getElementById(id);
const WORD = { E: "east", W: "west", N: "north", S: "south" };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (I) => I.short || I.name;
const US = () => DATA.corridor.short || "the main road";
let last = null;
const selectedMode = () => (document.querySelector('input[name="mode"]:checked') || {}).value || "walk";
const FAC_WORD = { lane: "bike lane", protected: "protected bike lane", path: "shared-use path" };
const minutesFor = (meters, mode) => Math.max(1, Math.round(meters / SPEED_M_PER_MIN[mode]));

function fillPlaces() {
  const opts = DATA.places.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${WORD[p.side]} side)</option>`).join("");
  $("orig").innerHTML = opts; $("dest").innerHTML = opts;
  $("orig").value = DATA.places[0].id;
  $("dest").value = DATA.places[DATA.places.length - 1].id;
  $("corridorSub").textContent = (DATA.sample ? "Demo corridor: " : "Corridor: ") + DATA.corridor.name + ", " + DATA.corridor.city + ".";
  $("dataPill").textContent = (DATA.sample ? "Sample data · " : "Loaded data · ") + DATA.corridor.short + ", " + DATA.corridor.city.split(",")[0];
}

function scheduleText(ev) {
  const s = ev.schedule || {};
  const fmt = (t) => { const [h, m] = t.split(":").map(Number); if (h === 24) return "midnight"; const ap = h >= 12 ? "pm" : "am"; const hh = ((h + 11) % 12) + 1; return hh + (m ? ":" + String(m).padStart(2, "0") : "") + " " + ap; };
  const days = s.days === "weekdays" ? "Weekdays" : s.days === "weekends" ? "Weekends" : "Daily";
  if ((s.start || "00:00") === "00:00" && (s.end || "24:00") === "24:00") return days + ", around the clock";
  return days + ", " + fmt(s.start) + " to " + fmt(s.end);
}

// ---------- steps ----------
function describe(r) {
  const steps = [];
  let n = 0;
  const bike = r.mode === "bike";
  const dark = last && last.ctx.dark;
  steps.push({ badge: "A", cls: "end", title: `Start at ${r.orig.name}`, why: `You're on the ${WORD[r.orig.side]} side of ${US()}.` });
  for (const a of r.acts) {
    if (a.type === "walk") {
      if (a.len < 1) continue;
      const d = a.to > a.from ? "south" : "north";
      const flags = [];
      const gapTotal = a.notes.filter((n) => n.kind === "gap").reduce((t, n) => t + n.m, 0);
      for (const note of a.notes) {
        if (note.kind === "gap") {
          flags.push(bike
            ? { cls: "stop", text: `No sidewalk or bike lane for about ${fmtDist(note.m)}, so you'll be in the travel lane. Ride predictably and hold your line${dark ? ", with front and rear lights on" : ""}.` }
            : { cls: "stop", text: `No sidewalk for about ${fmtDist(note.m)}. Stay as far from the travel lanes as you can${dark ? ", and it will be dark, so carry a light" : ""}.` });
        } else if (note.kind === "against") {
          flags.push({ cls: "stop", text: `This side runs against traffic for your direction. Walk your bike on the sidewalk here: drivers pulling out of driveways and side streets look left, away from you.` });
        } else if (note.kind === "noFacility") {
          const m = note.m - gapTotal; // the gap flag already covers stretches with no sidewalk either
          if (a.againstM || m < 20) continue;
          flags.push({ cls: "warn", text: `No bike lane for about ${fmtDist(m)}. If you use the sidewalk, ride at walking speed and give pedestrians the right of way.` });
        } else if (note.event.effect === "closed") {
          flags.push({ cls: "warn", text: `${note.event.type}: ${note.event.desc}. Follow the posted ${bike ? "" : "pedestrian "}detour (${fmtDist(note.m)} affected).` });
        } else {
          flags.push({ cls: "warn", text: bike
            ? `${note.event.type}: ${note.event.desc}. The closure may take over the bike lane, so merge early and make yourself visible.`
            : `${note.event.type}: ${note.event.desc}. Equipment is right beside the sidewalk.` });
        }
      }
      let title = `Walk ${fmtDist(a.len)} ${d} on the ${WORD[a.side]} sidewalk`;
      if (bike && a.againstM) title = `Walk your bike ${fmtDist(a.len)} ${d} on the ${WORD[a.side]} sidewalk`;
      else if (bike) {
        const fac = facilityAt(DATA, a.side, (a.from + a.to) / 2);
        title = `Ride ${fmtDist(a.len)} ${d} on the ${WORD[a.side]} side${fac ? ` in the ${FAC_WORD[fac.type] || "bike lane"}` : ""}`;
      }
      // Walking a bike goes at walking speed.
      steps.push({ badge: "", cls: "walk", title, why: `About ${minutesFor(a.len, bike && !a.againstM ? "bike" : "walk")} min.`, flags, act: a });
    } else if (a.type === "pass") {
      steps.push({ badge: "", cls: "walk", title: `Continue past ${a.I.name}`, why: `There's no street to cross on the ${WORD[a.side]} side. ${short(a.I)} only meets ${US()} from the other side.`, act: a });
    } else if (a.type === "crossCross") {
      n++; a.n = n;
      const flags = [];
      let cls = "go";
      if (a.noCrosswalk) { cls = "stop"; flags.push({ cls: "stop", text: "There is no marked crosswalk on this side. Cross only with the signal and extra care." }); }
      if (a.ntor) flags.push({ cls: "go", text: `"No Turn on Red" is posted for drivers on ${short(a.I)} here, so no right-on-red conflict.` });
      else if (a.visible) flags.push({ cls: "go", text: `Drivers turning right on red from ${short(a.I)} look left for traffic, which is toward you.` });
      else { cls = cls === "stop" ? cls : "warn"; flags.push({ cls: "warn", text: `Drivers turning right on red here look away from you. Wait until they have fully stopped and you've made eye contact.${a.I.lpi ? " A leading pedestrian interval gives you a head start." : ""}` }); }
      if (a.rightHook === "behind") {
        if (bike) { cls = cls === "stop" ? cls : "warn"; flags.push({ cls: "warn", text: `Right-hook risk: heavy right turns from ${US()} on green cut across your path from behind. Watch for turn signals and never pass a turning car on its right.` }); }
        else flags.push({ cls: "warn", text: `Heavy right turns from ${US()} on green will come from behind you. Check over your shoulder before stepping off.` });
      }
      if (a.rightHook === "toward") flags.push({ cls: "go", text: `Right-turning drivers from ${US()} will be coming toward you, so you can see each other.` });
      if (a.corner && a.corner.length) flags.push({ cls: "warn", text: `Corner work zone: ${a.corner[0].desc}. Follow the posted detour.` });
      if (a.slip && a.slip.length) { cls = cls === "stop" ? cls : "warn"; flags.push(slipFlag(a)); }
      const title = a.inRoad ? `Ride through ${a.I.name} in the bike lane on the ${WORD[a.side]} side` : `Cross ${a.I.name} on the ${WORD[a.side]} side of ${US()}`;
      steps.push({ badge: String(n), cls, title, why: crossingWhy(a, r), flags, act: a });
    } else if (a.type === "crossCorridor") {
      n++; a.n = n;
      const flags = [];
      const cls = a.blind || (a.slip && a.slip.length) ? "warn" : "go";
      const approachDir = a.leg === "N" ? "southbound" : "northbound";
      const otherLeg = a.leg === "N" ? "S" : "N";
      if (a.ntor) flags.push({ cls: "go", text: `"No Turn on Red" is posted for ${approachDir} ${US()} drivers here.` });
      else if (a.visible) flags.push({ cls: "go", text: `${cap(approachDir)} drivers turning right on red look left for traffic, which is toward you on this crosswalk.` });
      else flags.push({ cls: "warn", text: `${cap(approachDir)} drivers turning right on red look away from you on this crosswalk.${a.I.crosswalks[otherLeg] ? "" : ` The ${WORD[otherLeg]} crosswalk, where they'd see you, is missing here.`} Wait for a full stop and eye contact.` });
      if (a.corner && a.corner.length) flags.push({ cls: "warn", text: `Corner work zone: ${a.corner[0].desc}. Follow the posted detour.` });
      if (a.slip && a.slip.length) flags.push(slipFlag(a));
      if (bike) flags.push({ cls: "go", text: `Walk your bike across in the crosswalk, or use a two-stage turn box if one is marked.` });
      steps.push({ badge: String(n), cls, title: `Cross ${US()} to the ${WORD[a.to]} side on the ${WORD[a.leg]} crosswalk at ${a.I.name}`, why: corridorWhy(a, r), flags, act: a });
    }
  }
  steps.push({ badge: "B", cls: "end", title: `Arrive at ${r.dest.name}`, why: `On the ${WORD[r.dest.side]} side.` });
  return steps;
}

const CORNER_WORD = { NE: "northeast", NW: "northwest", SE: "southeast", SW: "southwest" };
function slipFlag(a) {
  const where = a.slip.map((c) => CORNER_WORD[c]).join(" and ");
  const many = a.slip.length > 1;
  return { cls: "warn", text: `Free right-turn lane${many ? "s" : ""} at the ${where} corner${many ? "s" : ""}: the short crossing${many ? "s" : ""} over ${many ? "them have" : "it has"} no signal, and drivers there are looking left for a gap, not at you. Wait until they stop.` };
}

function crossingWhy(a, r) {
  return `You're ${r.mode === "bike" ? "riding" : "walking"} ${WORD[r.travel]}bound, crossing ${short(a.I)} (${a.I.crossLanes} lanes).`;
}
function corridorWhy(a, r) {
  if (r.detour) return `Your destination is across ${US()} on the same block, so we send you to the nearest signal instead of having you cross mid-block.`;
  // what lies ahead on the side we're leaving, until the next switch or the destination
  const i = r.acts.indexOf(a);
  let end = r.dest.pos;
  for (let k = i + 1; k < r.acts.length; k++) if (r.acts[k].type === "crossCorridor") { end = r.acts[k].I.pos; break; }
  const lo = Math.min(a.I.pos, end), hi = Math.max(a.I.pos, end);
  const why = [];
  if (r.mode === "bike") {
    if (a.to === r.preferredSide) why.push(`riding against traffic on the ${WORD[a.from]} side`);
  } else {
    for (const g of gapsFor(DATA, a.from)) {
      const o = Math.max(0, Math.min(hi, g.to) - Math.max(lo, g.from));
      if (o > 20) why.push(`a ${fmtDist(o)} sidewalk gap on the ${WORD[a.from]} side`);
    }
  }
  for (const e of r.activeEvents) {
    if ((e.side === a.from || e.side === "both") && e.effect === "closed" && Math.min(hi, e.to) > Math.max(lo, e.from)) why.push(`the ${e.type.toLowerCase()} on the ${WORD[a.from]} side`);
  }
  if (a.from !== r.preferredSide) {
    const n = DATA.intersections.filter((I) => I.pos > lo && I.pos < hi && I.legs.includes(a.from) && !(I.ntor || []).includes(a.from)).length;
    if (n) why.push(`${n} side-street crossing${n > 1 ? "s" : ""} where right-on-red drivers would be looking away from you`);
  }
  if (!why.length) return r.dest.side === a.to ? `${r.dest.name} is on the ${WORD[a.to]} side, and this is the safest place to cross over.` : `This keeps you on the safer side for what's ahead.`;
  return `Switching here avoids ${why.join(" and ")}.`;
}

// ---------- map ----------
function drawMap(r) {
  const L = DATA.corridor.length, W = 380, top = 34, H = 780, sc = (H - top - 30) / L;
  const y = (p) => top + p * sc;
  const X = { W: 146, E: 234 }, PX = { W: 122, E: 258 };
  const band = (I) => 10 + I.crossLanes * 2.4;
  const legY = (I, leg) => y(I.pos) + (leg === "N" ? -1 : 1) * (band(I) / 2 + 8);
  let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Schematic map of the route along ${esc(DATA.corridor.name)}">`;
  s += `<rect width="${W}" height="${H}" rx="12" fill="#f4f1ea"/>`;
  s += `<rect x="160" y="${top - 14}" width="60" height="${H - top}" fill="#5b6672"/>`;
  s += `<line x1="190" y1="${top - 14}" x2="190" y2="${H}" stroke="#ffd96a" stroke-width="1.5" stroke-dasharray="9 8"/>`;
  // cross streets
  for (const I of DATA.intersections) {
    const b = band(I), yc = y(I.pos);
    if (I.legs.includes("W")) s += `<rect x="0" y="${yc - b / 2}" width="160" height="${b}" fill="#6b7682"/>`;
    if (I.legs.includes("E")) s += `<rect x="220" y="${yc - b / 2}" width="160" height="${b}" fill="#6b7682"/>`;
    s += `<rect x="160" y="${yc - b / 2}" width="60" height="${b}" fill="#5b6672"/>`;
    const lx = I.legs.includes("E") ? 374 : 6, anchor = I.legs.includes("E") ? "end" : "start";
    s += `<text x="${lx}" y="${yc - b / 2 - 5}" font-size="11.5" font-weight="700" fill="#13263a" text-anchor="${anchor}">${esc(short(I))}</text>`;
    // crosswalks
    for (const leg of ["N", "S"]) {
      if (!I.crosswalks[leg]) { s += `<text x="190" y="${legY(I, leg) + 4}" font-size="11" fill="#ffb4ad" text-anchor="middle" font-weight="800">✕ no crosswalk</text>`; continue; }
      for (let k = 0; k < 7; k++) s += `<rect x="${163 + k * 8.2}" y="${legY(I, leg) - 4}" width="4.5" height="8" fill="#fff" opacity=".9"/>`;
    }
    for (const side of ["E", "W"]) {
      if (!I.legs.includes(side) || !I.crosswalks[side]) continue;
      const n = Math.floor(b / 6);
      for (let k = 0; k < n; k++) s += `<rect x="${X[side] - 7}" y="${yc - b / 2 + 2 + k * 6}" width="14" height="3.2" fill="#fff" opacity=".9"/>`;
    }
  }
  // sidewalks + gaps
  for (const side of ["E", "W"]) {
    for (const sw of DATA.sidewalks[side] || []) s += `<line x1="${X[side]}" y1="${y(sw.from)}" x2="${X[side]}" y2="${y(sw.to)}" stroke="#b9c2cc" stroke-width="4"/>`;
    for (const g of gapsFor(DATA, side)) s += `<line x1="${X[side]}" y1="${y(g.from)}" x2="${X[side]}" y2="${y(g.to)}" stroke="#c8362f" stroke-width="3" stroke-dasharray="5 4"/>`;
    if (r.mode === "bike") {
      // on-road lanes at the curb; paths beside the sidewalk
      for (const f of (DATA.bikeFacilities || {})[side] || []) {
        const fx = f.type === "path" ? X[side] + (side === "E" ? 8 : -8) : side === "E" ? 216 : 164;
        s += `<line x1="${fx}" y1="${y(f.from)}" x2="${fx}" y2="${y(f.to)}" stroke="#1f8a5b" stroke-width="3"${f.type === "lane" ? ' stroke-dasharray="10 3"' : ""}/>`;
      }
    }
  }
  // events
  const activeIds = new Set(r.activeEvents.map((e) => e.id));
  for (const e of DATA.events) {
    const on = activeIds.has(e.id);
    const sides = e.side === "both" ? ["E", "W"] : [e.side];
    for (const side of sides) {
      const x = side === "E" ? X.E - 4 : X.W - 12;
      s += `<rect x="${x}" y="${y(e.from)}" width="16" height="${Math.max(6, y(e.to) - y(e.from))}" rx="3" fill="${on ? "#f2a900" : "#9aa6b2"}" opacity="${on ? 0.6 : 0.22}"/>`;
      if (on) s += `<text x="${side === "E" ? X.E + 18 : X.W - 18}" y="${(y(e.from) + y(e.to)) / 2 + 5}" font-size="14" text-anchor="middle">🚧</text>`;
    }
  }
  // route
  let pts = [[X[r.orig.side], y(r.orig.pos)]];
  const markers = [];
  let curSide = r.orig.side;
  for (const a of r.acts) {
    if (a.type === "walk") { pts.push([X[a.side], y(a.to)]); curSide = a.side; }
    else if (a.type === "crossCorridor") {
      const ly = legY(a.I, a.leg);
      pts.push([X[a.from], ly]); pts.push([X[a.to], ly]);
      markers.push({ x: 190, y: ly, a });
      curSide = a.to;
    } else if (a.type === "crossCross") {
      markers.push({ x: X[a.side], y: y(a.I.pos), a });
    }
  }
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  s += `<path d="${d}" fill="none" stroke="#fff" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"/>`;
  s += `<path d="${d}" fill="none" stroke="#2361d8" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`;
  for (const m of markers) {
    const col = m.a.noCrosswalk ? "#c8362f" : m.a.blind ? "#c27c00" : "#1f8a5b";
    s += `<circle cx="${m.x}" cy="${m.y}" r="10" fill="${col}" stroke="#fff" stroke-width="2"/><text x="${m.x}" y="${m.y + 4}" font-size="11" font-weight="800" fill="#fff" text-anchor="middle">${m.a.n}</text>`;
  }
  for (const [p, lbl] of [[r.orig, "A"], [r.dest, "B"]]) {
    const px = PX[p.side], py = y(p.pos);
    s += `<line x1="${X[p.side]}" y1="${py}" x2="${px}" y2="${py}" stroke="#13263a" stroke-width="2"/>`;
    s += `<circle cx="${px}" cy="${py}" r="11" fill="#13263a"/><text x="${px}" y="${py + 4}" font-size="12" font-weight="800" fill="#fff" text-anchor="middle">${lbl}</text>`;
  }
  s += `<text x="190" y="${top - 18}" font-size="12" font-weight="800" fill="#13263a" text-anchor="middle">${esc(DATA.corridor.short)} · N ↑</text>`;
  s += `<text x="${X.W}" y="${H - 8}" font-size="10.5" fill="#44566a" text-anchor="middle">west side</text><text x="${X.E}" y="${H - 8}" font-size="10.5" fill="#44566a" text-anchor="middle">east side</text>`;
  s += `</svg>`;
  $("map").innerHTML = s;
}

// ---------- summary ----------
function renderSummary(r, t, ctx) {
  const ex = r.exposure, tx = t ? t.exposure : null;
  const pref = WORD[r.preferredSide];
  const bike = r.mode === "bike";
  const verb = bike ? "Ride" : "Walk";
  // Stretches walked against traffic go at walking speed.
  const minutes = Math.round((bike ? (ex.distance - ex.againstM) / SPEED_M_PER_MIN.bike + ex.againstM / SPEED_M_PER_MIN.walk : ex.distance / SPEED_M_PER_MIN.walk) + ex.crossings);
  const [h, m] = $("leave").value.split(":").map(Number);
  const arr = new Date(2000, 0, 1, h, m + minutes);
  const arrTxt = arr.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const switches = r.acts.filter((a) => a.type === "crossCorridor").length;
  let headline = `${verb} ${WORD[r.travel]}bound, mostly on the ${pref} side.`;
  let body = bike
    ? `Going ${WORD[r.travel]}bound, the ${pref} side keeps you riding with traffic, where drivers turning right on red are already looking your way.`
    : `Going ${WORD[r.travel]}bound, the ${pref} side keeps drivers turning right on red facing you as you cross side streets.`;
  const usedSides = new Set(r.acts.filter((a) => a.type === "walk" && a.len > 0).map((a) => a.side));
  const metersOn = (sd) => r.acts.filter((a) => a.type === "walk" && a.side === sd).reduce((t, a) => t + a.len, 0);
  const mainSide = metersOn("E") >= metersOn("W") ? "E" : "W";
  if (usedSides.size > 1) headline = `${verb} ${WORD[r.travel]}bound, mostly on the ${WORD[mainSide]} side.`;
  if (usedSides.size > 1 && mainSide !== r.preferredSide) body = `Going ${WORD[r.travel]}bound, the ${pref} side is usually safer because drivers turning right on red face you. On this trip it has problems you're better off avoiding, so you'll spend most of the ${bike ? "ride" : "walk"} on the ${WORD[mainSide]} side. Each crossing below explains why.`;
  if (usedSides.size === 1 && !usedSides.has(r.preferredSide)) {
    headline = `Stay on the ${WORD[[...usedSides][0]]} side for this trip.`;
    body += ` Here, crossing ${US()} would add more risk than it removes, so watch the caution crossings below.`;
  } else if (switches > 0 && !r.detour && mainSide === r.preferredSide) {
    body += ` Your route changes sides ${switches === 1 ? "once" : switches + " times"} to get around problem spots${r.activeEvents.length ? " that are active when you leave" : ""}.`;
  }
  if (r.detour) headline = `Cross ${US()} at the signal, not mid-block.`;
  if (r.detour) body =`${r.dest.name} is across ${US()} on the same block. We send you to the nearest signalized crosswalk rather than having you cross mid-block.`;
  // a and b are raw numbers (meters for distances) so the comparison is exact; fmt formats them.
  const row = (label, a, b, fmt = String) => {
    const cls = b == null ? "" : Math.round(a) < Math.round(b) ? "better" : Math.round(a) > Math.round(b) ? "worse" : "";
    return `<tr><td>${label}</td><td class="num ${cls}">${fmt(a)}</td><td class="num">${b == null ? "–" : fmt(b)}</td></tr>`;
  };
  $("summary").innerHTML = `
    <div class="headline">${esc(headline)}</div>
    <div class="why" style="font-size:15px">${esc(body)}</div>
    <div class="meta">
      <span class="chip">${fmtDist(ex.distance)} · ~${minutes} min</span>
      <span class="chip">Arrive ~${arrTxt}</span>
      <span class="chip">${ex.crossings} crossing${ex.crossings === 1 ? "" : "s"}</span>
      ${ctx.dark ? `<span class="chip dark">🌙 Dark at this hour: ${bike ? "front and rear lights on" : "wear something bright"}</span>` : ""}
    </div>
    <table class="cmp">
      <tr><th>Exposure</th><th>Sightline route</th><th>Typical route*</th></tr>
      ${bike ? row("Riding against traffic", ex.againstM, tx && tx.againstM, fmtFeet) : ""}
      ${row("Crossings where right-on-red drivers look away", ex.blind, tx && tx.blind)}
      ${bike ? row("Right hooks from behind", ex.behind, tx && tx.behind) : ""}
      ${row("Through active work zones", ex.closedM + ex.adjM, tx && tx.closedM + tx.adjM, fmtFeet)}
      ${row("Corner work zones at crossings", ex.corner, tx && tx.corner)}
      ${bike ? row("Riding with no bike lane or path", ex.noFacilityM, tx && tx.noFacilityM, fmtFeet) : ""}
      ${row(bike ? "In traffic with no sidewalk or bike lane" : "Walking with no sidewalk", ex.gapM, tx && tx.gapM, fmtFeet)}
      ${row("Total distance", ex.distance, tx && tx.distance, fmtMiles)}
    </table>
    <div class="why" style="font-size:12.5px;margin-top:8px">*Typical route = the shortest ${bike ? "ride" : "walk"} that stays on your starting side and crosses only when it has to.</div>`;
}

function renderSteps(steps) {
  $("steps").innerHTML = steps.map((st, i) => `
    <li data-i="${i}"${st.act ? ' class="locatable" tabindex="0" title="Show on map"' : ""}><div class="badge ${st.cls}">${st.badge || (st.cls === "walk" ? "↓" : "")}</div>
      <div><div class="step-title">${esc(st.title)}</div>${st.why ? `<div class="why">${esc(st.why)}</div>` : ""}
      ${(st.flags || []).map((f) => `<div class="flag ${f.cls}">${esc(f.text)}</div>`).join("")}</div></li>`).join("");
}

// ---------- real map ----------
// Loaded on demand. Not part of the Claude-artifact build (no outside tiles there):
// Vite drops this whole branch when MODE is "artifact".
const hasLine = (d) => !!(d.corridor && Array.isArray(d.corridor.line) && d.corridor.line.length >= 2);
let routeMap = null, mapLoad = null, mapFailed = false;
function setView(view) {
  const real = view === "real" && routeMap && !mapFailed;
  $("realMap").hidden = !real;
  $("map").hidden = real;
  for (const b of document.querySelectorAll("#viewTabs [data-view]")) b.setAttribute("aria-selected", String(b.dataset.view === (real ? "real" : "diagram")));
  if (real) routeMap.resize();
}
function mapUnavailable(why) {
  mapFailed = true; routeMap = null;
  $("viewTabs").hidden = true;
  setView("diagram");
  if (why) console.warn("Real map unavailable, showing the diagram instead:", why);
}
function ensureMap() {
  if (import.meta.env.MODE === "artifact") return Promise.resolve(null);
  if (mapFailed || !hasLine(DATA)) { $("viewTabs").hidden = true; setView("diagram"); return Promise.resolve(null); }
  if (!mapLoad) {
    $("viewTabs").hidden = false;
    $("realMap").hidden = false; $("map").hidden = true; // the map needs a visible, sized container
    mapLoad = import("./map.js")
      .then(({ createRouteMap }) => {
        routeMap = createRouteMap($("realMap"), { data: DATA, onFail: mapUnavailable, onPinClick: highlightStep });
        if (!mapFailed) setView("real");
        return routeMap;
      })
      .catch((e) => { mapUnavailable(e.message); return null; });
  }
  return mapLoad;
}
function highlightStep(act) {
  if (!last) return;
  const i = last.steps.findIndex((s) => s.act === act);
  const li = document.querySelector(`#steps li[data-i="${i}"]`);
  if (!li) return;
  for (const x of document.querySelectorAll("#steps li.hl")) x.classList.remove("hl");
  li.classList.add("hl");
  li.scrollIntoView({ behavior: "smooth", block: "center" });
}
function locateStep(li) {
  if (!last || !routeMap || mapFailed) return;
  const st = last.steps[+li.dataset.i];
  if (!st || !st.act) return;
  setView("real");
  routeMap.focus(st.act);
  for (const x of document.querySelectorAll("#steps li.hl")) x.classList.remove("hl");
  li.classList.add("hl");
  if (window.innerWidth <= 920) document.querySelector(".mapcard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderAlerts(r) {
  const active = new Set(r.activeEvents.map((e) => e.id));
  const items = DATA.events.slice().sort((a, b) => active.has(b.id) - active.has(a.id));
  $("alerts").innerHTML = items.length ? items.map((e) => `
    <li><span class="tag ${active.has(e.id) ? "on" : "off"}">${active.has(e.id) ? "Active when you leave" : "Not active then"}</span><b>${esc(e.type)}</b> · ${WORD[e.side] || "both"} side<br>${esc(e.desc)}<div class="when">${esc(scheduleText(e))} · ${esc(e.id)}</div></li>`).join("")
    : "<li>No construction events reported on this corridor.</li>";
}

function run() {
  $("formErr").textContent = "";
  const P = Object.fromEntries(DATA.places.map((p) => [p.id, p]));
  const o = P[$("orig").value], d = P[$("dest").value];
  if (!o || !d || o.id === d.id) { $("formErr").textContent = "Pick two different places."; return; }
  const [h, m] = ($("leave").value || "07:30").split(":").map(Number);
  const minutes = h * 60 + m;
  const ctx = { minutes, weekend: $("day").value === "we", dark: minutes < 6 * 60 + 50 || minutes > 17 * 60 + 40 };
  const mode = selectedMode();
  document.body.classList.toggle("bike", mode === "bike");
  const res = plan(DATA, o, d, ctx, { mode });
  if (!res.safe) { $("formErr").textContent = "No route found with the crossings available."; return; }
  last = { ctx, res, o, d, mode };
  const steps = describe(res.safe);
  last.steps = steps;
  drawMap(res.safe);
  renderSummary(res.safe, res.typical, ctx);
  renderSteps(steps);
  renderAlerts(res.safe);
  $("results").classList.add("show");
  $("aiOut").style.display = "none"; $("aiOut").textContent = "";
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  ensureMap().then((m) => m && m.show(DATA, res.safe));
}

// ---------- events ----------
$("startBtn").addEventListener("click", () => { $("plan").scrollIntoView({ behavior: "smooth" }); setTimeout(() => $("orig").focus(), 400); });
$("swapBtn").addEventListener("click", () => { const a = $("orig").value; $("orig").value = $("dest").value; $("dest").value = a; });
$("odForm").addEventListener("submit", (e) => { e.preventDefault(); run(); });
$("steps").addEventListener("click", (e) => { const li = e.target.closest("li.locatable"); if (li) locateStep(li); });
$("steps").addEventListener("keydown", (e) => { const li = e.target.closest("li.locatable"); if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); locateStep(li); } });
for (const b of document.querySelectorAll("#viewTabs [data-view]")) b.addEventListener("click", () => setView(b.dataset.view));
for (const el of document.querySelectorAll('input[name="mode"]')) {
  el.addEventListener("change", () => {
    document.body.classList.toggle("bike", selectedMode() === "bike");
    if ($("results").classList.contains("show")) run();
  });
}
$("fileIn").addEventListener("change", async (e) => {
  $("fileErr").textContent = "";
  try {
    const f = e.target.files[0]; if (!f) return;
    const j = JSON.parse(await f.text());
    for (const k of ["corridor", "intersections", "sidewalks", "events", "places"]) if (!j[k]) throw new Error("missing '" + k + "'");
    DATA = j; fillPlaces(); $("results").classList.remove("show");
    $("dataNote").innerHTML = "Using the corridor file you loaded (" + esc(f.name) + ")." + (hasLine(j) ? "" : " It has no road geometry (<code>corridor.line</code>), so only the diagram is shown.");
  } catch (err) { $("fileErr").textContent = "Couldn't read that file: " + err.message; }
});

// ---------- Claude ----------
let sample = null, ctrl = null;
function routeContext() {
  const r = last.res.safe;
  return JSON.stringify({
    corridor: DATA.corridor.name + ", " + DATA.corridor.city, sampleData: !!DATA.sample, mode: last.mode,
    leaveAt: $("leave").value, day: $("day").value === "we" ? "weekend" : "weekday", dark: last.ctx.dark,
    from: r.orig.name, to: r.dest.name, direction: WORD[r.travel] + "bound",
    steps: last.steps.map((s) => ({ step: s.title, notes: (s.flags || []).map((f) => f.text) })),
    exposure: { sightline: r.exposure, typicalRoute: last.res.typical && last.res.typical.exposure },
    constructionEvents: DATA.events.map((e) => ({ id: e.id, type: e.type, desc: e.desc, side: e.side, schedule: scheduleText(e), activeAtDeparture: r.activeEvents.some((a) => a.id === e.id) })),
    intersections: DATA.intersections.map((I) => ({ name: I.name, crossLanes: I.crossLanes, crosswalks: I.crosswalks, noTurnOnRedApproaches: I.ntor, leadingPedInterval: I.lpi })),
  });
}
async function ask(question) {
  if (!sample || !last) return;
  if (ctrl) ctrl.abort();
  ctrl = new AbortController();
  const out = $("aiOut"); out.style.display = "block"; out.textContent = "Thinking…";
  const sys = "You are Sightline, a safety assistant for people walking or biking to work along busy roads. The route data says which mode this trip uses. Use ONLY the route data provided; do not invent conditions, streets or times. Key rule: drivers turning right on red look left, so people are safest approaching from the driver's left. In U.S. traffic that means using the right-hand side for your direction of travel; for cyclists it also means never riding against traffic. Distances in the route data are in meters, but always state them to the user in feet or miles (U.S. units), never meters. Be warm, concrete and brief. Plain text, no markdown headers. If the data is marked as sample data, mention that once at the end in a short clause.";
  const prompt = question
    ? `${sys}\n\nRoute data (JSON):\n${routeContext()}\n\nThe walker asks: ${question}\n\nAnswer in 2-5 sentences.`
    : `${sys}\n\nRoute data (JSON):\n${routeContext()}\n\nWrite a briefing of 4-6 sentences for this trip: which side to use and why, the crossings to be careful at, and any work zones or missing sidewalk at this departure time.`;
  try {
    await sample(prompt, { signal: ctrl.signal, modelTier: "quick", onText: ({ text }) => { out.textContent = text; } });
  } catch (err) {
    if (err && err.name === "AbortError") return;
    if (err && err.code === "not_granted") { $("ai").classList.remove("show"); return; }
    out.textContent = err && err.code === "rate_limited" ? "Claude is busy right now. Try again in a minute." : "Couldn't reach Claude just now.";
  }
}
$("briefBtn").addEventListener("click", () => ask(null));
$("askBtn").addEventListener("click", () => { const q = $("aiQ").value.trim(); if (q) ask(q); });
$("aiQ").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const q = $("aiQ").value.trim(); if (q) ask(q); } });
(async () => {
  try {
    for (let i = 0; i < 20 && !(window.claude && typeof window.claude.use === "function"); i++) await new Promise((r) => setTimeout(r, 250));
    if (window.claude && typeof window.claude.use === "function") {
      sample = await window.claude.use("sample");
      if (sample) $("ai").classList.add("show");
    }
  } catch (e) { sample = null; }
})();

fillPlaces();
