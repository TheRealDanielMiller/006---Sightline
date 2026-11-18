// Corridor geometry: converts between map coordinates and the engine's
// "position along the corridor + side" model.
// `line` is the corridor centerline as [[lat, lon], ...] from the north end to the south end.
// Positions are meters from the north end. Side "E" is the left of southbound travel
// (for a north-south road, the east side); "W" is the other side.

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function makeFrame(line) {
  if (!line || line.length < 2) throw new Error("Corridor line needs at least two points");
  const lat0 = line.reduce((t, p) => t + p[0], 0) / line.length;
  const kx = Math.cos(rad(lat0));
  const toXY = ([lat, lon]) => [rad(lon) * R * kx, rad(lat) * R];
  const toLL = ([x, y]) => [deg(y / R), deg(x / (R * kx))];
  const pts = line.map(toXY);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const length = cum[cum.length - 1];

  /** Nearest point on the centerline: { pos, dist, side } */
  function project(lat, lon) {
    const [px, py] = toXY([lat, lon]);
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2));
      const cx = x1 + t * dx, cy = y1 + t * dy;
      const dist = Math.hypot(px - cx, py - cy);
      if (!best || dist < best.dist) {
        const cross = dx * (py - y1) - dy * (px - x1); // > 0: left of travel (southbound -> east)
        best = { pos: cum[i] + t * Math.sqrt(L2), dist, side: cross > 0 ? "E" : "W" };
      }
    }
    return best;
  }

  function segmentAt(pos) {
    const p = Math.max(0, Math.min(length, pos));
    let i = 0;
    while (i < pts.length - 2 && cum[i + 1] < p) i++;
    const seg = cum[i + 1] - cum[i] || 1e-9;
    return { i, t: (p - cum[i]) / seg, seg };
  }

  /** Map coordinates [lat, lon] at `pos`, offset `offsetM` meters toward `side` ("E", "W" or null). */
  function at(pos, side = null, offsetM = 0) {
    const { i, t, seg } = segmentAt(pos);
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const tx = (x2 - x1) / seg, ty = (y2 - y1) / seg; // unit tangent (southward)
    const ex = -ty, ey = tx; // unit normal toward the east side
    const s = side === "E" ? 1 : side === "W" ? -1 : 0;
    return toLL([x1 + t * (x2 - x1) + s * offsetM * ex, y1 + t * (y2 - y1) + s * offsetM * ey]);
  }

  /** Points along the corridor from `a` to `b` (either direction), offset toward `side`. */
  function path(a, b, side = null, offsetM = 0) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const ps = [lo, ...cum.filter((c) => c > lo && c < hi), hi].map((p) => at(p, side, offsetM));
    return a <= b ? ps : ps.reverse();
  }

  return { length, project, at, path };
}

/** [lat, lon] -> [lon, lat] for GeoJSON / MapLibre. */
export const lngLat = ([lat, lon]) => [lon, lat];
