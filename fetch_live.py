#!/usr/bin/env python3
"""
Sightline: build a corridor file from live FDOT sidewalk data and FL511 events.

Usage:
    export FL511_KEY=your_developer_key      # request one at fl511.com (Developers page)
    python3 fetch_live.py                    # writes corridor.json
Then open the Sightline page and use "Load a corridor file" at the bottom.

Standard library only (Python 3.8+). Edit the CONFIG block for your corridor.
Intersections and places are entered by hand (positions in meters from the
corridor's north end). Everything else is pulled live.

Things to verify the first time you run it (the script prints them):
  * FDOT field names: the script prints the fields it finds, and ROAD_SIDE may be spelled differently.
  * FL511 endpoint: confirm the events path on the FL511 developer docs page.
"""
import json, math, os, re, sys, urllib.parse, urllib.request
from datetime import datetime, timezone

CONFIG = {
    "corridor": {"name": "US 41 (S. Tamiami Trail)", "short": "US 41", "city": "Fort Myers, FL", "lanes": 6},
    # Corridor centerline, north end -> south end (lat, lon). Add points if the road bends.
    "line": [(26.5600, -81.8700), (26.5340, -81.8700)],  # <-- REPLACE with real endpoints
    "buffer_m": 45,  # how far from the centerline a sidewalk or event can be and still count
    "fdot_sidewalk_layer": "https://services1.arcgis.com/O1JpcwDW8sjYuddV/ArcGIS/rest/services/Sidewalk_Width_Sep_TDA/FeatureServer/0/query",
    "fl511_events": "https://fl511.com/api/v2/get/event",  # verify on fl511.com developer docs
    # Hand-entered: pos = meters south of the line's north end. legs/crosswalks/ntor/lpi from field review.
    "intersections": [
        {"id": "daniels", "name": "Daniels Pkwy", "pos": 350, "legs": ["N", "S", "E"], "crossLanes": 6,
         "crosswalks": {"N": True, "S": True, "E": True}, "ntor": [], "lpi": False, "heavyRight": ["S"]},
        # ...add the rest
    ],
    "places": [
        {"id": "home", "name": "Home", "pos": 120, "side": "W"},
        {"id": "work", "name": "Work", "pos": 2780, "side": "W"},
    ],
}

R = 6371000.0


def to_xy(lat, lon, lat0):
    return (math.radians(lon) * R * math.cos(math.radians(lat0)), math.radians(lat) * R)


class Corridor:
    def __init__(self, line):
        self.lat0 = sum(p[0] for p in line) / len(line)
        self.pts = [to_xy(a, b, self.lat0) for a, b in line]
        self.cum = [0.0]
        for (x1, y1), (x2, y2) in zip(self.pts, self.pts[1:]):
            self.cum.append(self.cum[-1] + math.hypot(x2 - x1, y2 - y1))
        self.length = self.cum[-1]

    def project(self, lat, lon):
        """-> (pos along corridor in m, signed offset in m: + = east/right of a southbound line... see side())"""
        px, py = to_xy(lat, lon, self.lat0)
        best = None
        for i, ((x1, y1), (x2, y2)) in enumerate(zip(self.pts, self.pts[1:])):
            dx, dy = x2 - x1, y2 - y1
            L2 = dx * dx + dy * dy or 1e-9
            t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
            cx, cy = x1 + t * dx, y1 + t * dy
            d = math.hypot(px - cx, py - cy)
            cross = dx * (py - y1) - dy * (px - x1)  # >0: left of travel direction (north->south line: left = east)
            if best is None or d < best[1]:
                best = (self.cum[i] + t * math.sqrt(L2), d, "E" if cross > 0 else "W")
        return best  # pos, distance, side


def get_json(url, params):
    full = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers={"User-Agent": "Sightline prototype"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def bbox(line, pad_deg=0.003):
    lats = [p[0] for p in line]; lons = [p[1] for p in line]
    return f"{min(lons)-pad_deg},{min(lats)-pad_deg},{max(lons)+pad_deg},{max(lats)+pad_deg}"


def merge(ranges):
    out = []
    for a, b in sorted(ranges):
        if out and a <= out[-1][1] + 5:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def fetch_sidewalks(cor):
    data = get_json(CONFIG["fdot_sidewalk_layer"], {
        "where": "1=1", "geometry": bbox(CONFIG["line"]), "geometryType": "esriGeometryEnvelope",
        "inSR": 4326, "outSR": 4326, "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*", "returnGeometry": "true", "f": "geojson"})
    feats = data.get("features", [])
    if feats:
        print("FDOT sidewalk fields:", sorted(feats[0]["properties"].keys()))
    ranges = {"E": [], "W": []}
    for f in feats:
        props = f["properties"]
        side_code = str(props.get("ROAD_SIDE") or props.get("RD_SIDE") or props.get("SIDE") or "").upper()
        geom = f.get("geometry") or {}
        lines = geom.get("coordinates", [])
        if geom.get("type") == "LineString":
            lines = [lines]
        for coords in lines:
            proj = [cor.project(lat, lon) for lon, lat in coords]
            if not proj or max(p[1] for p in proj) > CONFIG["buffer_m"]:
                continue  # not along our corridor (e.g., a cross street)
            first, last = proj[0][0], proj[-1][0]
            southward = last > first  # RCI geometry runs in increasing-milepost direction
            if side_code.startswith("R"):
                sides = ["W"] if southward else ["E"]
            elif side_code.startswith("L"):
                sides = ["E"] if southward else ["W"]
            else:
                sides = ["E", "W"]  # both sides / unknown
            for s in sides:
                ranges[s].append((min(first, last), max(first, last)))
    out = {s: [{"from": round(a), "to": round(b)} for a, b in merge(r)] for s, r in ranges.items()}
    print(f"Sidewalk segments kept: east={len(out['E'])} west={len(out['W'])}")
    return out


TIME_RE = re.compile(r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*(?:to|-|until)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?", re.I)


def hhmm(h, m, ap):
    h = int(h) % 12 + (12 if ap.lower() == "p" else 0)
    return f"{h:02d}:{int(m or 0):02d}"


def fetch_events(cor):
    key = os.environ.get("FL511_KEY")
    if not key:
        print("FL511_KEY not set: skipping construction events.")
        return []
    raw = get_json(CONFIG["fl511_events"], {"key": key, "format": "json"})
    print(f"FL511 events statewide: {len(raw)}")
    now = datetime.now(timezone.utc).timestamp()
    out = []
    for e in raw:
        etype = str(e.get("EventType", "")) + " " + str(e.get("EventSubType", ""))
        if not re.search(r"construct|roadwork|work|closure|maint", etype, re.I):
            continue
        lat, lon = e.get("Latitude"), e.get("Longitude")
        if lat is None or lon is None:
            continue
        pos, dist, geo_side = cor.project(float(lat), float(lon))
        if dist > CONFIG["buffer_m"] * 3 or pos <= 0 or pos >= cor.length:
            continue
        end = e.get("PlannedEndDate")
        if end and float(end) < now:
            continue
        pos2 = pos
        if e.get("LatitudeSecondary") and e.get("LongitudeSecondary"):
            pos2 = cor.project(float(e["LatitudeSecondary"]), float(e["LongitudeSecondary"]))[0]
        dir_ = str(e.get("DirectionOfTravel", ""))
        side = "E" if dir_.startswith("North") else "W" if dir_.startswith("South") else "both"
        desc = str(e.get("Description", "")).strip()
        effect = "closed" if re.search(r"sidewalk|pedestrian|crosswalk", desc, re.I) else "adjacent"
        sched = {"days": "all", "start": "00:00", "end": "24:00"}
        m = TIME_RE.search(desc)
        if m:
            sched["start"], sched["end"] = hhmm(m[1], m[2], m[3]), hhmm(m[4], m[5], m[6])
        if re.search(r"weekday|mon(day)?\s*(-|through|to)\s*fri", desc, re.I):
            sched["days"] = "weekdays"
        out.append({"id": f"FL511-{e.get('ID')}", "type": etype.strip().title() or "Construction",
                    "desc": desc[:220], "side": side,
                    "from": round(min(pos, pos2) - 15), "to": round(max(pos, pos2) + 15),
                    "effect": effect, "schedule": sched})
    print(f"FL511 events kept on corridor: {len(out)}")
    return out


def main():
    cor = Corridor(CONFIG["line"])
    print(f"Corridor length: {cor.length:.0f} m")
    result = {
        "sample": False,
        "generatedAt": datetime.now().isoformat(timespec="minutes"),
        "corridor": dict(CONFIG["corridor"], length=round(cor.length)),
        "intersections": CONFIG["intersections"],
        "sidewalks": fetch_sidewalks(cor),
        "events": fetch_events(cor),
        "places": CONFIG["places"],
    }
    for I in result["intersections"]:
        I.setdefault("signal", True); I.setdefault("ntor", []); I.setdefault("heavyRight", []); I.setdefault("lpi", False)
    with open("corridor.json", "w") as fh:
        json.dump(result, fh, indent=1)
    print("Wrote corridor.json. Load it into Sightline with 'Load a corridor file'.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("Failed:", exc, file=sys.stderr)
        sys.exit(1)
