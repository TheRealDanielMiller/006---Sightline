# Sightline: Handoff

Sightline plans walks and bike rides to work along a busy corridor. It tells the commuter which side of the street to use and where to cross, steering around construction, missing sidewalks, wrong-way riding, and crossings where drivers turning right on red are looking the other way.

- **Live site (GitHub Pages, real map):** https://therealdanielmiller.github.io/006---Sightline/
- **Claude-hosted demo (diagram only, with Ask Claude):** https://claude.ai/artifact/2hRfy4aRJthRczTxsiRPYN. It's private until you share it from that page.
- **Current state:** a working prototype for US 41 in south Fort Myers, from College Pkwy to Jamaica Bay Blvd. The road geometry, signal locations, crosswalks, free right-turn slip lanes, sidewalks, and bike lanes come from OpenStreetMap. No Turn on Red signs and leading pedestrian intervals aren't verified yet, so none are assumed. Construction events and places are illustrative, not real conditions.

---

## 1. Set up in VS Code (about 10 minutes)

**You need:** VS Code, Node.js 18+, and Python 3.8+ (Python is only needed for `fetch_live.py`).

1. Clone the repo and open the folder in VS Code (**File → Open Folder…**).
2. Open a terminal (**Terminal → New Terminal**) and install the build tools:
   ```
   npm install
   ```
3. Run the dev server (auto-reloads on save):
   ```
   npm run dev
   ```
   Open the URL it prints (usually http://localhost:5173). Press **Ctrl+C** to stop.
4. Run the routing tests:
   ```
   npm test
   ```
   To print the chosen route for six sample trips, with a "typical route" comparison for each: `npm run demo` (walk) or `npm run demo -- bike`.
5. Build:
   ```
   npm run build            # the GitHub Pages site, with the real map, in dist/
   npm run build:artifact   # one self-contained file for the Claude demo, in dist-artifact/index.html
   ```
   You don't need to build for GitHub Pages yourself: pushing to `main` builds and publishes it (see section 6).
6. Refresh the road geometry from OpenStreetMap (only when you change the corridor or want newer OSM data):
   ```
   npm run fetch:osm
   ```

**Shortcut:** `.vscode/tasks.json` has these commands. Press **Ctrl+Shift+P → "Tasks: Run Task"** and pick **Dev server**, **Build**, **Test routing**, **Print sample routes**, or **Fetch live data**.

**Recommended extensions:** Python (Microsoft) for `fetch_live.py`.

---

## 2. What each file does

| File | Role | Edit it? |
|---|---|---|
| `index.html` | The page: layout, styles, the Walk/Bike toggle, the "Ask Claude" box | **Yes**, for layout and styling |
| `src/main.js` | Page logic: crossing diagram, step text, summary table, map/diagram tabs, Claude briefing | **Yes**, for UI and wording changes |
| `src/map.js` | The real map (MapLibre GL + OpenFreeMap tiles); loaded only when needed | **Yes**, for map styling |
| `src/mapdata.js` | Turns a route into map lines and pins (no map library, so it's testable) | Rarely |
| `src/geo.js` | Converts between map coordinates and "meters along the corridor + side" | Rarely |
| `src/engine.js` | Routing rules and scoring for walk and bike modes (the core logic) | **Yes**, to change safety rules or weights |
| `src/data.js` | Corridor data: OSM data from `corridor-osm.js`, field-checked overrides (`FIELD_CHECKED`), and the illustrative events and places | **Yes**, to add field-checked rules, events, and places |
| `src/corridor-osm.js` | **Generated** by `npm run fetch:osm`: centerline, intersections, sidewalks, bike lanes | **No**. Edit the CONFIG in the script and re-run it |
| `scripts/fetch-osm-corridor.mjs` | Builds `corridor-osm.js` from OpenStreetMap | Yes, the CONFIG block |
| `test/*.test.js` | Automated tests for routing, geometry, and map data (`npm test`) | Add cases when you change rules |
| `scripts/demo-routes.js` | Prints routes for sample trips (`npm run demo`) | Add trips as needed |
| `vite.config.js` | Build settings for the Pages site and the single-file artifact | Rarely |
| `.github/workflows/pages.yml` | Tests, builds, and publishes the site to GitHub Pages on every push to `main` | Rarely |
| `dist/`, `dist-artifact/` | **Generated** build output (not committed) | **No** |
| `fetch_live.py` | Pulls live FDOT sidewalk data and FL511 events into `corridor.json` | Yes, edit the CONFIG block |

**Workflow:** run `npm run dev`, edit any file, and the browser reloads. Run `npm test` after changing `src/engine.js`.

---

## 3. How the routing works (src/engine.js)

The corridor is treated as one north–south line. Every feature has a **position** (meters south of the north end) and a **side** (`E` or `W`).

**The core rule.** A driver turning right on red looks **left** for oncoming traffic. A walker is in that driver's view only when approaching from the driver's left. In U.S. traffic that works out to:
- Walking **northbound**: use the **east** side.
- Walking **southbound**: use the **west** side.
- Crossing the main road **east→west**: use the **north** crosswalk. **West→east**: use the **south** crosswalk.

The code computes this geometrically (`visible = pedDir == rotateClockwise(-approachDirection)`), so it works for any leg. It doesn't depend on a lookup table.

**Route choice.** The engine is a small dynamic program over intersections between start and destination. At each intersection it considers three options:
1. Stay on the current side and cross the side street.
2. Cross the main road on the near crosswalk, then cross the side street.
3. Cross the side street, then cross the main road on the far crosswalk.

Switching sides only happens at signals. If the destination is across the road on the same block, the app sends the walker to the nearest signal instead of having them cross mid-block.

**Modes.** `plan(data, orig, dest, ctx, { mode })` takes `"walk"` (the default) or `"bike"`. Each mode has its own set of weights in `WEIGHTS` in `src/engine.js`. The visibility rule is the same for both.

**Scoring (equivalent meters, `WEIGHTS`):**

| Factor | Walk | Bike |
|---|---|---|
| Distance | 1 per m | 1 per m |
| No sidewalk | +5 per m | +3 per m, only where there's also no bike lane or path |
| (×1.5 after dark) | yes | yes |
| Active sidewalk closure | +4 per m | +2 per m, none where the rider is in an on-road lane |
| Active lane closure next to the curb | +1 per m | +3 per m (it usually takes the bike lane) |
| Riding against traffic | – | +4 per m |
| No bike lane or path | – | +2 per m (halved on roads under 4 lanes) |
| Painted bike lane / shared-use path | – | +0.5 / +0.2 per m (protected lane: 0) |
| Crossing where right-on-red drivers look away | +250 | +250 |
| (halved with a leading pedestrian interval; none with No Turn on Red) | | |
| No marked crosswalk | +1,500 | +600, none if the rider is in an on-road lane |
| Heavy right turns on green from behind (right hook) | +80 | +400 |
| Corner work zone at a crossing | +400 | +400 |

These weights are judgment calls and the main thing to tune. The "typical route" for comparison uses the same engine with all penalties set to zero.

**Bike-mode rules in plain terms.** Ride with traffic: the with-traffic side is the same side the right-on-red rule prefers, so the two rules agree. Where a route must use the against-traffic side (for example, the first block from a door on the wrong side), the step text tells the rider to walk the bike on the sidewalk. Bike lanes make sidewalk gaps irrelevant, and a rider in an on-road lane goes through intersections with traffic instead of using the crosswalk. To change sides of the main road, riders walk the bike across in the crosswalk.

**Time of day.** Construction events carry a schedule (days, start, end, overnight windows OK). Only events active at the departure time count. "Dark" is approximate for November in Fort Myers (before 6:50 am or after 5:40 pm). See `run()` in `src/main.js`.

---

## 4. Data format

The same format is used by `src/data.js` and by `corridor.json` from the live script.

```js
{
  sample: true,
  corridor: {
    name, short, city, length /* m */, lanes /* main road */,
    line: [[lat, lon], ...]   // optional centerline, north end first; enables the real map
  },
  intersections: [{
    id, name, short?, pos, signal: true,
    legs: ["N","S","E","W"],            // omit "W" for a T-intersection on the east side
    crossLanes: 4,                       // side-street width
    crosswalks: { N: true, S: false, E: true, W: true },
    ntor: ["E"],                         // approaches with No Turn on Red
    lpi: true,                           // leading pedestrian interval
    heavyRight: ["S"]                    // main-road approaches with heavy right turns (S = northbound)
  }],
  sidewalks: { E: [{ from, to, width? }], W: [...] },   // gaps = anything not covered
  bikeFacilities: {                                     // optional; anything not covered = no facility
    E: [{ from, to, type: "lane" | "protected" | "path" }], W: [...]
  },
  events: [{
    id, type, desc, side: "E" | "W" | "both", from, to,
    effect: "closed" | "adjacent",
    schedule: { days: "all" | "weekdays" | "weekends", start: "07:00", end: "17:00" }
  }],
  places: [{ id, name, pos, side }]
}
```

**Where the data comes from.** `npm run fetch:osm` pulls the US 41 centerline, the seven signalized intersections (with their side-street legs, crosswalks, and slip lanes), sidewalk coverage, and bike lanes from OpenStreetMap into `src/corridor-osm.js`. OSM is community-mapped, so spot-check it against aerials. The intersection list itself is in the script's CONFIG.

**Crossings.** The fetch script also reads OSM crossings: a leg has a crosswalk when OSM maps a marked crossing on it, and a corner has a slip lane when OSM maps an unsignalized crossing out on that corner (currently NE, SE, and SW at Daniels / Cypress Lake). Heavy right turns are inferred from slip lanes. Every leg on this stretch has a mapped crosswalk.

**First task:** in `src/data.js`, fill in `FIELD_CHECKED` from a field visit or FDOT: No Turn on Red signs, leading pedestrian intervals, heavy right turns without slip lanes, and any crosswalk OSM gets wrong. Then replace the sample events and places. You know this corridor, and anyone from FDOT District 1 who sees the demo will too. `fetch_live.py` doesn't fill in `bikeFacilities` yet, so a corridor file it writes treats the whole road as having no bike facility.

---

## 5. Live data (fetch_live.py)

1. Request an FL511 developer key at fl511.com (Developers page).
2. Edit the `CONFIG` block:
   - `line`: the real corridor endpoints (lat, lon), north end first. Add points if the road bends.
   - `intersections` and `places`: copy them from `src/data.js` once they're corrected.
   - `fl511_events`: confirm the events URL on the FL511 developer docs. The current URL follows the pattern other states' 511 sites use and hasn't been tested.
3. Run it:
   ```
   # Windows (PowerShell)
   $env:FL511_KEY="your_key"; python fetch_live.py
   # Mac/Linux
   FL511_KEY=your_key python3 fetch_live.py
   ```
4. Open the page and use **Load a corridor file** at the bottom to select `corridor.json`.

**Untested against the live servers. Check these the first time you run it:**
- The script prints the FDOT layer's field names. If the side field isn't `ROAD_SIDE`, update `fetch_sidewalks()`.
- FDOT RCI sidewalk records are tied to the centerline with a left/right attribute. The script infers which side is which from the direction the geometry runs (increasing milepost). Check a few segments against aerial imagery.
- The FL511 field names (`Latitude`, `DirectionOfTravel`, `PlannedEndDate`, etc.) match other 511 sites built on the same platform. FL511 should be the same, but confirm.
- Work hours are pulled from event descriptions with a simple pattern ("9 pm to 5 am"). Anything else defaults to all day.
- 511 mostly covers state highways and major roads. Local sidewalk closures usually won't appear.

---

## 6. Hosting

- **GitHub Pages (main site).** Every push to `main` runs `.github/workflows/pages.yml`, which runs the tests, builds, and publishes https://therealdanielmiller.github.io/006---Sightline/. One-time setup: on GitHub, **Settings → Pages → Build and deployment → Source: GitHub Actions**. The real map uses MapLibre GL with free OpenFreeMap tiles (no API key). If the tiles can't load, the page falls back to the crossing diagram. Everything works except Ask Claude; to offer that here, call the Claude API from a small backend. Never put an API key in the page.
- **Claude artifact (demo).** Pages there can't load outside map tiles or call outside APIs, so `npm run build:artifact` leaves the map code out and the page shows the crossing diagram only. The **Ask Claude** box only works there; it's hidden automatically anywhere else. To update the demo, run `npm run build:artifact` and ask Claude to republish `dist-artifact/index.html`.

---

## 7. Suggested next steps

1. **Field-check No Turn on Red and leading pedestrian intervals** and add them to `FIELD_CHECKED` in `src/data.js` (highest value, low effort).
2. **Run live data once** and screenshot the result for your portfolio.
3. **Live-data server.** A small Node server with Neon (Postgres) that merges FDOT construction, FL511, and community reports into the `events` format.
4. **Real origin/destination entry.** Address search with an open-source geocoder (Photon or Pelias) instead of the place list.
5. **Signal data.** Add pedestrian signal timing and leading-interval data from the county or FDOT signal inventory.
6. **Crash validation.** Check the rules against Signal Four Analytics pedestrian crash data. A short write-up of that would be strong interview material.
7. **Rider angle for Lime.** Bike mode is in place; scooters could reuse it with their own weights in `WEIGHTS` (and add where they park at the end of a trip).

---

## 8. Talking about it in an interview

- **Problem:** commuters on foot face hazards that standard navigation apps ignore.
- **Insight:** comes from traffic engineering. Right-on-red drivers look left, so which side you walk on decides whether you're seen.
- **Product decisions:** compare against a typical route so the benefit is measurable; take the departure time into account; give one plain-language reason at every crossing; send walkers to signals instead of mid-block crossings.
- **AI usage:** built with Claude as a coding partner, plus a Claude-powered briefing and Q&A inside the app.
- **Honest limits:** prototype; real geometry and crosswalks from OpenStreetMap, but No Turn on Red and leading intervals unverified and events illustrative; the scoring weights are judgment calls to validate against crash data.
