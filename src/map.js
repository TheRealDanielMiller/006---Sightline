// Real map (MapLibre GL + OpenFreeMap tiles, built on OpenStreetMap data).
// Loaded on demand from main.js; never included in the Claude-artifact build,
// which can't fetch outside map tiles.
import { Map as MLMap, Marker, NavigationControl, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildMapData } from "./mapdata.js";

setWorkerUrl(workerUrl);

const STYLE = "https://tiles.openfreemap.org/styles/positron";
const COLORS = { route: "#2361d8", sidewalk: "#64748b", gap: "#c8362f", bike: "#1f8a5b", work: "#d97706", idle: "#94a3b8" };
const PIN = { go: "#1f8a5b", warn: "#c27c00", stop: "#c8362f" };
const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * @param {HTMLElement} container
 * @param {{ data: object, onFail: (reason: string) => void, onPinClick?: (act: object) => void }} opts
 */
export function createRouteMap(container, { data, onFail, onPinClick }) {
  let ready = false, failed = false, pending = null, markers = [], current = null;
  const fail = (why) => { if (failed || ready) return; failed = true; clearTimeout(timer); try { map.remove(); } catch {} onFail(why); };
  const initial = buildMapData(data, null);

  let map;
  try {
    map = new MLMap({
      container, style: STYLE, bounds: initial.bounds, fitBoundsOptions: { padding: 30 },
      attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, maxZoom: 19.5,
    });
  } catch (e) {
    queueMicrotask(() => onFail("WebGL unavailable: " + e.message));
    return { show() {}, focus() {}, setData() {} };
  }
  map.touchZoomRotate.disableRotation();
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  // If the style or tiles can't load (offline, blocked), fall back to the diagram.
  const timer = setTimeout(() => fail("map style timed out"), 10000);
  map.on("error", (e) => { if (!ready) fail((e && e.error && e.error.message) || "map error"); });

  map.on("load", () => {
    ready = true;
    clearTimeout(timer);
    // Darker street labels for outdoor legibility.
    for (const layer of map.getStyle().layers) {
      if (layer.type === "symbol" && /road|street|highway/.test(layer.id)) {
        try { map.setPaintProperty(layer.id, "text-color", "#1e293b"); map.setPaintProperty(layer.id, "text-halo-color", "#ffffff"); } catch {}
      }
    }
    const src = (id) => map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    ["sidewalks", "gaps", "bike", "events", "route"].forEach(src);
    const lineLayer = (id, source, paint, extra = {}) => map.addLayer({ id, type: "line", source, layout: { "line-cap": "round", "line-join": "round" }, paint, ...extra });
    lineLayer("sidewalks", "sidewalks", { "line-color": COLORS.sidewalk, "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 18, 4], "line-opacity": 0.7 });
    lineLayer("gaps", "gaps", { "line-color": COLORS.gap, "line-width": ["interpolate", ["linear"], ["zoom"], 14, 2.5, 18, 5], "line-dasharray": [1.2, 1] });
    lineLayer("bike", "bike", { "line-color": COLORS.bike, "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 18, 4], "line-dasharray": [2, 1] });
    lineLayer("events", "events", {
      "line-color": ["case", ["get", "active"], COLORS.work, COLORS.idle],
      "line-width": ["interpolate", ["linear"], ["zoom"], 14, 6, 18, 16],
      "line-opacity": ["case", ["get", "active"], 0.55, 0.25],
    });
    lineLayer("route-casing", "route", { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 14, 6, 18, 12] });
    lineLayer("route", "route", { "line-color": COLORS.route, "line-width": ["interpolate", ["linear"], ["zoom"], 14, 3.5, 18, 7] });
    if (pending) { const p = pending; pending = null; show(p.data, p.route); }
  });

  function pinEl(text, color, title, size = 26) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "map-pin";
    el.textContent = text;
    el.title = title;
    el.setAttribute("aria-label", title);
    el.style.cssText = `width:${size}px;height:${size}px;background:${color}`;
    return el;
  }

  function show(d, route) {
    if (failed) return;
    if (!ready) { pending = { data: d, route }; return; }
    current = buildMapData(d, route);
    for (const k of ["sidewalks", "gaps", "bike", "events", "route"]) map.getSource(k).setData(current[k]);
    markers.forEach((m) => m.remove());
    markers = [];
    for (const { at, act } of current.pins) {
      const cls = act.noCrosswalk ? "stop" : act.blind ? "warn" : "go";
      const title = `Crossing ${act.n}${act.I ? " at " + act.I.name : ""}`;
      const el = pinEl(String(act.n ?? ""), PIN[cls], title);
      el.addEventListener("click", () => { focus(act); onPinClick && onPinClick(act); });
      markers.push(new Marker({ element: el }).setLngLat([at[1], at[0]]).addTo(map));
    }
    for (const e of current.ends) {
      const el = pinEl(e.label, "#13263a", `${e.label === "A" ? "Start" : "Destination"}: ${e.place.name}`, 30);
      markers.push(new Marker({ element: el }).setLngLat([e.at[1], e.at[0]]).addTo(map));
    }
    map.fitBounds(current.bounds, { padding: 50, maxZoom: 17, duration: reduceMotion() ? 0 : 400 });
  }

  function focus(act) {
    if (!ready || !current) return;
    const f = current.focus.get(act);
    if (!f) return;
    const center = [f.center[1], f.center[0]];
    if (reduceMotion()) map.jumpTo({ center, zoom: f.zoom });
    else map.easeTo({ center, zoom: f.zoom, duration: 450 });
  }

  /** Corridor-only view (no route yet), e.g. after loading a different corridor file. */
  function setData(d) {
    if (!ready) { pending = { data: d, route: null }; return; }
    show(d, null);
  }

  return { show, focus, setData, resize: () => ready && map.resize() };
}
