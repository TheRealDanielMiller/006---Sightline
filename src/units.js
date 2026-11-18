// Display units. The engine and data stay in meters (OSM and FDOT data are metric);
// everything shown to people goes through these helpers, in U.S. customary units.

export const FT_PER_M = 3.28084;
export const M_PER_MI = 1609.344;

const withCommas = (n) => n.toLocaleString("en-US");

/** A distance for a sentence: "60 ft", "450 ft", "0.3 mi", "1.2 mi". */
export function fmtDist(m) {
  const ft = m * FT_PER_M;
  if (ft < 300) return `${Math.max(10, Math.round(ft / 10) * 10)} ft`;
  if (ft < 1000) return `${Math.round(ft / 50) * 50} ft`;
  return `${(m / M_PER_MI).toFixed(1)} mi`;
}

/** Feet for a table column, so rows compare like for like: "0 ft", "1,240 ft". */
export function fmtFeet(m) {
  return `${withCommas(Math.round((m * FT_PER_M) / 10) * 10)} ft`;
}

/** Miles with two decimals, for trip totals: "1.85 mi". */
export function fmtMiles(m) {
  return `${(m / M_PER_MI).toFixed(2)} mi`;
}
