// Rank one-mile sections of Lee County roads by pedestrian and bicyclist crashes,
// and mark which ones FDOT's sidewalk inventory covers.
//
// Input:  data/raw/crashes-p*.geojson. These are FDOT State Safety Office crashes
//         (ssogis layer 2000) for Lee County (DOT_CNTY_CD 12), 2011-2022, filtered to
//         pedestrian or bicyclist crashes. They are saved by hand from a browser
//         because gis.fdot.gov refuses scripted requests. They are not committed.
// Output: data/lee-crash-sections.json. This holds per-section counts only, with
//         no crash records.
//
//   node scripts/rank-crash-sections.mjs
//
// A section is a 1-mile window on one FDOT roadway ID (ROADWAYID plus LOCMP
// milepost), chosen greedily so windows on the same road don't overlap.
// The public layer thins out sharply after 2018 (about 400 a year before, 40-120
// after), so 2011-2018 is the base and 2019-2022 is reported only as a check.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const RAW = "data/raw";
const OUT = "data/lee-crash-sections.json";
const MIN_CRASHES = 10;   // smallest section worth listing
const PER_ROAD = 4;       // most sections to take from one road
const TDA = "https://services1.arcgis.com/O1JpcwDW8sjYuddV/ArcGIS/rest/services/Sidewalks_and_Gaps_TDA/FeatureServer/0/query";

const files = readdirSync(RAW).filter((f) => /^crashes-p\d+\.geojson$/.test(f)).sort();
const crashes = new Map();
for (const f of files) {
  const fc = JSON.parse(readFileSync(`${RAW}/${f}`, "utf8"));
  for (const { properties: c } of fc.features) crashes.set(c.XID, c);
}
const all = [...crashes.values()];
const placed = all.filter((c) => c.ROADWAYID && c.LOCMP != null);
console.log(`${files.length} files, ${all.length} unique crashes, ${placed.length} with a road milepost`);

// FDOT sidewalk inventory: C = both sides, L/R = one side, G = gap (no sidewalk).
const tdaUrl = `${TDA}?where=COUNTY%3D%27LEE%27&outFields=ROADWAY,RDWYSIDE,BEGIN_POST,END_POST&returnGeometry=false&f=json`;
const tda = (await (await fetch(tdaUrl)).json()).features.map((f) => f.attributes);

function sidewalks(road, from, to) {
  const segs = tda.filter((s) => s.ROADWAY === road && s.END_POST > from && s.BEGIN_POST < to);
  if (!segs.length) return null; // not in FDOT's inventory: "Not covered"
  const miles = { both: 0, one: 0, none: 0 };
  for (const s of segs) {
    const len = Math.min(s.END_POST, to) - Math.max(s.BEGIN_POST, from);
    miles[s.RDWYSIDE === "C" ? "both" : s.RDWYSIDE === "G" ? "none" : "one"] += len;
  }
  for (const k in miles) miles[k] = +miles[k].toFixed(2);
  return miles;
}

const count = (rs, pred) => rs.filter(pred).length;
const top = (rs, key, n) =>
  Object.entries(rs.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {}))
    .filter(([k]) => k && k !== "null")
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

const byRoad = Map.groupBy(placed, (c) => c.ROADWAYID);
const sections = [];
for (const [road, rs] of byRoad) {
  rs.sort((a, b) => a.LOCMP - b.LOCMP);
  const used = new Set();
  for (let k = 0; k < PER_ROAD; k++) {
    let best = [];
    for (let i = 0; i < rs.length; i++) {
      const w = [];
      for (let j = i; j < rs.length && rs[j].LOCMP <= rs[i].LOCMP + 1 && !used.has(j); j++) w.push(j);
      if (w.length > best.length) best = w;
    }
    if (best.length < MIN_CRASHES) break;
    best.forEach((j) => used.add(j));
    const w = best.map((j) => rs[j]);
    const from = w[0].LOCMP, to = w.at(-1).LOCMP;
    const [lon, lat] = [mean(w.map((c) => c.SAFETYLON)), mean(w.map((c) => c.SAFETYLAT))];
    sections.push({
      roadwayId: road,
      names: top(w, "ON_ROADWAY_NAME", 3),
      fromMp: from, toMp: to,
      crossStreets: top(w, "INT_ROADWAY_NAME", 5),
      center: [+lon.toFixed(5), +lat.toFixed(5)],
      crashes: w.length,
      base2011to2018: count(w, (c) => c.CALENDAR_YEAR <= 2018),
      check2019to2022: count(w, (c) => c.CALENDAR_YEAR >= 2019),
      pedestrian: count(w, (c) => c.NUMBER_OF_PEDESTRIANS > 0),
      bicyclist: count(w, (c) => c.NUMBER_OF_BICYCLISTS > 0),
      fatal: count(w, (c) => c.NUMBER_OF_KILLED > 0),
      fatalOrSerious: count(w, (c) => c.NUMBER_OF_KILLED > 0 || c.NUMBER_OF_SERIOUS_INJURIES > 0),
      dark: count(w, (c) => ["03", "04", "05"].includes(c.LGHT_COND_CD)),
      atIntersection: count(w, (c) => c.INTERSECTION_IND === "Y"),
      sidewalkMiles: sidewalks(road, from, to),
    });
  }
}
function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }

sections.sort((a, b) => b.crashes - a.crashes || b.fatalOrSerious - a.fatalOrSerious);
sections.forEach((s, i) => (s.rank = i + 1));

const years = Object.fromEntries(
  [...Map.groupBy(all, (c) => c.CALENDAR_YEAR)].sort((a, b) => a[0] - b[0]).map(([y, rs]) => [y, rs.length]));
writeFileSync(OUT, JSON.stringify({
  source: "FDOT State Safety Office (ssogis FeatureServer layer 2000), Lee County, pedestrian or bicyclist crashes; sidewalks from FDOT Sidewalks_and_Gaps_TDA",
  generated: new Date().toISOString().slice(0, 10),
  crashesByYear: years,
  note: "Public layer thins after 2018; 2019-2022 counts are a check, not a trend. Sections with sidewalkMiles null are outside FDOT's sidewalk inventory (Not covered).",
  sections,
}, null, 1) + "\n");

console.table(sections.slice(0, 15).map((s) => ({
  rank: s.rank, road: s.names[0], mp: `${s.fromMp.toFixed(2)}-${s.toMp.toFixed(2)}`, near: s.crossStreets.slice(0, 2).join(" / "),
  n: s.crashes, "19-22": s.check2019to2022, KSI: s.fatalOrSerious, dead: s.fatal,
  sidewalks: s.sidewalkMiles ? `${s.sidewalkMiles.both}b ${s.sidewalkMiles.one}o ${s.sidewalkMiles.none}g` : "Not covered",
})));
console.log(`wrote ${OUT} (${sections.length} sections)`);
