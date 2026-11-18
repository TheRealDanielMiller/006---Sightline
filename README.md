# Sightline: Handoff

Sightline plans walks to work along a busy corridor. It tells the walker which side of the street to use and where to cross, steering around construction, missing sidewalks, and crossings where drivers turning right on red are looking the other way.

- **Live demo (hosted on Claude):** https://claude.ai/artifact/2hRfy4aRJthRczTxsiRPYN. It's private until you share it from that page.
- **Current state:** a working prototype on **sample data** for US 41 near Six Mile Cypress Pkwy, Fort Myers. Intersection layouts, sidewalk gaps, and construction events are illustrative, not real conditions.

---

## 1. Set up in VS Code (about 10 minutes)

**You need:** VS Code, Python 3.8+, and Node.js 18+ (Node is only needed for the routing tests).

1. Unzip `sightline.zip` somewhere convenient (e.g., `Documents/sightline`).
2. In VS Code: **File → Open Folder…** and choose the `sightline` folder.
3. Open a terminal (**Terminal → New Terminal**) and check the tools:
   ```
   python --version
   node --version
   ```
   On Mac/Linux, use `python3` if `python` isn't found.
4. Build and run:
   ```
   python build.py
   python -m http.server 8000
   ```
   Open http://localhost:8000 in your browser. Press **Ctrl+C** in the terminal to stop the server.
5. Run the routing tests:
   ```
   node test.js
   ```
   This prints the chosen route for six sample trips, with a "typical route" comparison for each.

**Shortcut:** the `.vscode/tasks.json` file includes these commands. Press **Ctrl+Shift+P → "Tasks: Run Task"** and pick **Build**, **Serve**, **Test routing**, or **Fetch live data**.

**Recommended extensions:** Python (Microsoft), and optionally Live Server (Ritwick Dey) for auto-refresh when you open `index.html`.

---

## 2. What each file does

| File | Role | Edit it? |
|---|---|---|
| `template.html` | The page: layout, styles, map drawing, step text, the "Ask Claude" box | **Yes**, for UI and wording changes |
| `engine.js` | Routing rules and scoring (the core logic) | **Yes**, to change safety rules or weights |
| `data.js` | Sample corridor data (intersections, sidewalks, events, places) | **Yes**, to fix the sample to match real conditions |
| `build.py` | Combines template + data + engine into `index.html` | Rarely |
| `index.html` | **Generated.** The single file you open or publish | **No**. Run `build.py` instead |
| `test.js` | Prints routes for sample trips in the terminal | Add trips as needed |
| `fetch_live.py` | Pulls live FDOT sidewalk data and FL511 events into `corridor.json` | Yes, edit the CONFIG block |

**Workflow:** edit `template.html`, `engine.js`, or `data.js`, run `python build.py`, then refresh the browser.

---

## 3. How the routing works (engine.js)

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

**Scoring (equivalent meters, in `makeRouter`):**

| Factor | Penalty |
|---|---|
| Walking distance | 1 per m |
| No sidewalk | +5 per m (×1.5 after dark) |
| Active sidewalk closure | +4 per m |
| Active lane closure next to the sidewalk | +1 per m |
| Crossing where right-on-red drivers look away | +250 (halved with a leading pedestrian interval; none with No Turn on Red) |
| No marked crosswalk | +1,500 |
| Heavy right turns on green coming from behind | +80 |
| Corner work zone at a crossing | +400 |

These weights are judgment calls and the main thing to tune. The "typical route" for comparison uses the same engine with all penalties set to zero.

**Time of day.** Construction events carry a schedule (days, start, end, overnight windows OK). Only events active at the departure time count. "Dark" is approximate for November in Fort Myers (before 6:50 am or after 5:40 pm). See `run()` in `template.html`.

---

## 4. Data format

The same format is used by `data.js` and by `corridor.json` from the live script.

```js
{
  sample: true,
  corridor: { name, short, city, length /* m */, lanes /* main road */ },
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
  events: [{
    id, type, desc, side: "E" | "W" | "both", from, to,
    effect: "closed" | "adjacent",
    schedule: { days: "all" | "weekdays" | "weekends", start: "07:00", end: "17:00" }
  }],
  places: [{ id, name, pos, side }]
}
```

**First task:** correct `data.js` for the real US 41 corridor. Check the order of the cross streets, which intersections are T-intersections, missing crosswalks, No Turn on Red signs, and leading pedestrian intervals. You know this corridor, and anyone from FDOT District 1 who sees the demo will too.

---

## 5. Live data (fetch_live.py)

1. Request an FL511 developer key at fl511.com (Developers page).
2. Edit the `CONFIG` block:
   - `line`: the real corridor endpoints (lat, lon), north end first. Add points if the road bends.
   - `intersections` and `places`: copy them from `data.js` once they're corrected.
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

- **Claude artifact (current).** `index.html` is published as a Claude artifact. Pages there can't load outside map tiles or call outside APIs, which is why the map is a hand-drawn diagram and the data is built in. The **Ask Claude** box only works there; it's hidden automatically anywhere else. To update the demo, ask Claude to republish the new `index.html`.
- **Your own hosting (GitHub Pages, Netlify).** Upload `index.html` as-is. Everything works except Ask Claude. To keep that feature elsewhere, call the Claude API from a small backend. Never put an API key in the page.

---

## 7. Suggested next steps

1. **Correct the sample data** in `data.js` to match the real corridor (highest value, low effort).
2. **Run live data once** and screenshot the result for your portfolio.
3. **Real map.** On your own hosting, switch to Leaflet with OpenStreetMap tiles and draw the route on real geometry.
4. **Real origin/destination entry.** Address search (geocoding) instead of the place list.
5. **Signal data.** Add pedestrian signal timing and leading-interval data from the county or FDOT signal inventory.
6. **Crash validation.** Check the rules against Signal Four Analytics pedestrian crash data. A short write-up of that would be strong interview material.
7. **Rider angle for Lime.** The same side-of-street and crossing logic applies to scooter riders using sidewalks and shared-use paths, and to where they park at the end of a trip.

---

## 8. Talking about it in an interview

- **Problem:** commuters on foot face hazards that standard navigation apps ignore.
- **Insight:** comes from traffic engineering. Right-on-red drivers look left, so which side you walk on decides whether you're seen.
- **Product decisions:** compare against a typical route so the benefit is measurable; take the departure time into account; give one plain-language reason at every crossing; send walkers to signals instead of mid-block crossings.
- **AI usage:** built with Claude as a coding partner, plus a Claude-powered briefing and Q&A inside the app.
- **Honest limits:** prototype; sample data; the scoring weights are judgment calls to validate against crash data.
