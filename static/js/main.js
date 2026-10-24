/* PRITHVI front-end */
(() => {
"use strict";

const $ = (id) => document.getElementById(id);
const val = (id) => $(id).value;
const num = (id) => { const x = parseFloat(val(id)); return Number.isFinite(x) ? x : undefined; };
const S = { aoi: null, map: null, drawn: null, layers: null, layer: null, opacity: 0.7, chart: null, last: null,
            busy: false, viewer: null, tileUrl: null, cesiumLayer: null, is3d: false, lang: "en", valueCtrl: null };

/* ---------- i18n (have a native speaker review before release) ---------- */
const I18N = {
  en: { layer: "Layer", season: "Season", run: "Run", analytics: "Analytics", download: "Download",
        drawFirst: "Draw a field on the map first" },
  ta: { layer: "அடுக்கு", season: "பருவம்", run: "பகுப்பாய்வு", analytics: "புள்ளிவிவரம்", download: "பதிவிறக்கம்",
        drawFirst: "முதலில் வரைபடத்தில் வயலை வரையவும்" },
  te: { layer: "పొర", season: "సీజన్", run: "విశ్లేషణ", analytics: "గణాంకాలు", download: "డౌన్‌లోడ్",
        drawFirst: "ముందుగా మ్యాప్‌లో పొలాన్ని గీయండి" },
  kn: { layer: "ಪದರ", season: "ಹಂಗಾಮು", run: "ವಿಶ್ಲೇಷಣೆ", analytics: "ಅಂಕಿಅಂಶ", download: "ಡೌನ್‌ಲೋಡ್",
        drawFirst: "ಮೊದಲು ನಕ್ಷೆಯಲ್ಲಿ ಹೊಲವನ್ನು ಬರೆಯಿರಿ" },
  ml: { layer: "ലെയർ", season: "സീസൺ", run: "വിശകലനം", analytics: "സ്ഥിതിവിവരം", download: "ഡൗൺലോഡ്",
        drawFirst: "ആദ്യം മാപ്പിൽ പാടം വരയ്ക്കുക" },
};
const tr = (k) => (I18N[S.lang] && I18N[S.lang][k]) || I18N.en[k] || k;
const applyLang = () => document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = tr(el.dataset.i18n); });

/* ---------- ui helpers ---------- */
let toastTimer;
function toast(msg, ms = 3000) {
  const el = $("toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}
function spin(on, msg) { $("spinner").style.display = on ? "flex" : "none"; if (msg) $("spinnerMsg").textContent = msg; }

async function api(url, body, { timeout = 100000, signal, method = "POST" } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  if (signal) signal.addEventListener("abort", () => ctrl.abort());
  try {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body), signal: ctrl.signal });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
    if (!r.ok || !data) {
      throw new Error((data && data.error) ||
        (r.status === 429 ? "Too many requests – wait a minute and retry." :
         r.status >= 500 ? "Server timed out – try a smaller field or a shorter season." : `Server error (${r.status})`));
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError" && !(signal && signal.aborted)) throw new Error("Request timed out – try a smaller field or shorter season.");
    throw e;
  } finally { clearTimeout(timer); }
}

function payload(extra = {}) {
  return { aoi: S.aoi, index: val("indexSelect"), startDate: val("startDate"), endDate: val("endDate"),
    crop: val("cropSelect"), model: val("modelSelect") || "LUE", cropMask: $("cropMask").checked,
    minNdvi: $("hideBare").checked ? 0.25 : null, ...extra };
}

/* ---------- data: ramps, guidance, seasons ---------- */
const RAMPS = { paddy: ["7b4a1e", "c9a227", "f2e394", "9ccc65", "2e7d32", "0b5d1e"],
  viridis: ["440154", "3B528B", "21908C", "5DC863", "FDE725"], redgreen: ["f80000", "ffe500", "18c016"],
  bluered: ["0044ff", "ffebeb", "ff0000"], earth: ["543005", "a6611a", "dfc27d", "f6e8c3"] };
const ramp = () => RAMPS[val("rampSelect")] || RAMPS.paddy;

const GUIDE = {
  SATELLITE: { min: 0, max: 0.3, t: "True colour – no colour ramp applied." },
  NDVI: { min: 0.2, max: 0.9, t: "NDVI saturates in dense paddy; prefer EVI after tillering." },
  EVI: { min: 0.1, max: 0.8, t: "EVI keeps responding in dense canopy – better for tillering to heading." },
  YIELD: { min: 2, max: 7, t: "Yield estimate (t/ha) from light-use efficiency. Defaults are uncalibrated – treat as relative variability unless a calibrated model is listed." },
  NDMI: { min: -0.2, max: 0.6, t: "Canopy moisture / field wetness." },
  SAVI: { min: 0.1, max: 0.8, t: "Soil-adjusted – useful early in the season." },
  BSI: { min: -0.2, max: 0.3, t: "High values = exposed soil / fallow." },
  NWDWI: { min: -0.6, max: 0.6, t: "≤ 0 suggests standing water (nursery / transplanting). Thresholds come from MODIS work – verify on your fields." },
  SAR_VH: { min: -25, max: -8, t: "Sentinel-1 VH backscatter (dB) – works through monsoon cloud." },
};
const SEASONS = {
  tn_samba:   { label: "Samba (TN) · Aug–Jan",        s: [8, 15],  e: [1, 15] },
  tn_kuruvai: { label: "Kuruvai (TN) · Jun–Sep",      s: [6, 1],   e: [9, 30] },
  tn_thaladi: { label: "Thaladi (TN) · Oct–Feb",      s: [10, 1],  e: [2, 15] },
  tn_navarai: { label: "Navarai (TN) · Dec–Apr",      s: [12, 15], e: [4, 30] },
  kl_virippu: { label: "Virippu (Kerala) · Apr–Sep",  s: [4, 15],  e: [9, 15] },
  kl_mundakan:{ label: "Mundakan (Kerala) · Sep–Jan", s: [9, 15],  e: [1, 15] },
  kl_puncha:  { label: "Puncha (Kerala) · Dec–Apr",   s: [12, 1],  e: [4, 15] },
  kharif:     { label: "Kharif (AP/TS/KA) · Jun–Nov", s: [6, 15],  e: [11, 30] },
  rabi:       { label: "Rabi (AP/TS/KA) · Dec–Apr",   s: [12, 1],  e: [4, 30] },
};
const MODEL_LABEL = { LUE: "LUE (default)", NDVI_REG: "NDVI regression (calibrated)", INDVI_REG: "Integrated NDVI (calibrated)",
  LUE_CAL: "LUE (calibrated)", MULTI: "Multi-variable (calibrated)" };

function applySeason(key) {
  const z = SEASONS[key]; if (!z) return;
  const now = new Date(), wraps = z.e[0] < z.s[0];
  const endOf = (yr) => new Date(wraps ? yr + 1 : yr, z.e[0] - 1, z.e[1]);
  let y = now.getFullYear();
  while (endOf(y) > now) y -= 1;
  const f = (yr, [m, d]) => `${yr}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  $("startDate").value = f(y, z.s); $("endDate").value = f(wraps ? y + 1 : y, z.e);
}

function onIndexChange() {
  const g = GUIDE[val("indexSelect")]; if (!g) return;
  $("visMin").value = g.min; $("visMax").value = g.max; $("guide").textContent = g.t;
  if (val("indexSelect") === "YIELD") applyCropDefaults();
}
function applyCropDefaults() { if (val("cropSelect") === "rice") { $("visMin").value = 2; $("visMax").value = 7; } }

async function loadModels() {
  try {
    const d = await api(`/models?crop=${encodeURIComponent(val("cropSelect"))}`, null, { method: "GET" });
    const sel = $("modelSelect"), cur = sel.value;
    sel.innerHTML = d.models.map((m) => `<option value="${m}">${MODEL_LABEL[m] || m}</option>`).join("");
    if (d.models.includes(cur)) sel.value = cur;
  } catch (_) { /* keep default */ }
}

/* ---------- map ---------- */
function initMap() {
  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const base = {
    "Satellite": L.tileLayer(esri, { maxNativeZoom: 17, maxZoom: 22, attribution: "Esri" }),
    "OpenStreetMap": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }),
    "Terrain": L.tileLayer("https://tile.opentopomap.org/{z}/{x}/{y}.png", { maxNativeZoom: 17, maxZoom: 22, attribution: "© OpenTopoMap" }),
    "Dark": L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { subdomains: "abcd", maxZoom: 20, attribution: "© OSM © CARTO" }),
  };
  S.map = L.map("map", { zoomControl: false, layers: [base.Satellite] }).setView([10.78, 79.14], 12);  // Cauvery delta
  L.control.zoom({ position: "bottomright" }).addTo(S.map);
  S.layers = L.control.layers(base, {}).addTo(S.map);

  S.drawn = new L.FeatureGroup().addTo(S.map);
  const shape = { color: "#e6b84a", weight: 2 };
  S.map.addControl(new L.Control.Draw({
    draw: { polygon: { allowIntersection: false, showArea: true, shapeOptions: shape }, rectangle: { shapeOptions: shape },
            polyline: false, circle: false, marker: false, circlemarker: false },
    edit: { featureGroup: S.drawn } }));

  S.map.on(L.Draw.Event.CREATED, (e) => { S.drawn.clearLayers(); S.drawn.addLayer(e.layer); setAoi(e.layer); });
  S.map.on(L.Draw.Event.EDITED, () => S.drawn.eachLayer(setAoi));
  S.map.on(L.Draw.Event.DELETED, () => { if (!S.drawn.getLayers().length) { S.aoi = null; $("aoiInfo").textContent = "Draw a field with the polygon or rectangle tool."; } });
  S.map.on("click", inspectPoint);
  $("stage").addEventListener("transitionend", () => S.map.invalidateSize());
}

function setAoi(layer) {
  S.aoi = layer.toGeoJSON().geometry;
  const ha = turf.area({ type: "Feature", geometry: S.aoi, properties: {} }) / 1e4;
  $("aoiInfo").innerHTML = `<b>${ha.toFixed(2)} ha</b> · ${(ha * 2.471).toFixed(2)} acres`;
}

function addAnalysisLayer(url) {
  if (S.layer) { S.map.removeLayer(S.layer); S.layers.removeLayer(S.layer); }
  S.layer = L.tileLayer(url, { opacity: S.opacity, maxNativeZoom: 18, maxZoom: 22 });
  S.layers.addOverlay(S.layer, "Analysis");
  if ($("toggleLayer").checked) S.layer.addTo(S.map);
}

function updateLegend() {
  const idx = val("indexSelect"), el = $("legend");
  if (idx === "SATELLITE") { el.style.display = "none"; return; }
  const unit = idx === "YIELD" ? " t/ha" : idx === "SAR_VH" ? " dB" : "";
  $("legendTitle").textContent = $("indexSelect").selectedOptions[0].text;
  $("legendBar").style.background = `linear-gradient(90deg, ${ramp().map((c) => "#" + c).join(",")})`;
  $("legendMin").textContent = val("visMin") + unit; $("legendMax").textContent = val("visMax") + unit;
  el.style.display = "block";
}

/* ---------- actions ---------- */
async function run() {
  if (!S.aoi) return toast(tr("drawFirst"));
  if (S.busy) return;
  S.busy = true; $("runBtn").disabled = true; spin(true, "Fetching imagery…");
  try {
    const idx = val("indexSelect");
    const d = await api("/get_tiles", payload({ min: num("visMin"), max: num("visMax"), colorRamp: idx === "SATELLITE" ? null : ramp() }));
    S.tileUrl = d.tile_url; addAnalysisLayer(d.tile_url); apply3DLayer(); updateLegend();
    toast("Layer ready – click inside the field to read a value");
  } catch (e) { toast(e.message, 5000); }
  finally { S.busy = false; $("runBtn").disabled = false; spin(false); }
}

async function inspectPoint(e) {
  if (!S.aoi || !S.layer || !S.map.hasLayer(S.layer)) return;
  if (!turf.booleanPointInPolygon(turf.point([e.latlng.lng, e.latlng.lat]), turf.feature(S.aoi))) return;
  if (S.valueCtrl) S.valueCtrl.abort();
  S.valueCtrl = new AbortController();
  const popup = L.popup().setLatLng(e.latlng).setContent("Reading value…").openOn(S.map);
  try {
    const d = await api("/value_at", payload({ lat: e.latlng.lat, lng: e.latlng.lng }), { signal: S.valueCtrl.signal });
    const unit = val("indexSelect") === "YIELD" ? " t/ha" : "";
    popup.setContent(d.value == null ? "No valid data here (cloud, masked or outside crop)" : `<b>${Number(d.value).toFixed(3)}</b>${unit}`);
  } catch (err) { if (err.name !== "AbortError") popup.setContent(err.message); }
}

async function download() {
  if (!S.aoi) return toast(tr("drawFirst"));
  spin(true, "Preparing GeoTIFF…");
  try {
    const d = await api("/download", payload());
    const a = document.createElement("a"); a.href = d.url; a.target = "_blank"; a.rel = "noopener";
    a.download = `${val("indexSelect")}_${new Date().toISOString().slice(0, 10)}.tif`;
    document.body.appendChild(a); a.click(); a.remove(); toast("Download started");
  } catch (e) { toast(e.message, 5000); } finally { spin(false); }
}

/* ---------- analytics panel ---------- */
const f2 = (v, n = 2) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(n));

function renderKpis(d) {
  const k = d.index, s = d.stats || {}, mean = s[k + "_mean"], isY = k === "YIELD";
  const cards = [
    [`${k} mean`, f2(mean) + (isY ? " t/ha" : "")],
    ["P10 – P90", `${f2(s[k + "_p10"])} – ${f2(s[k + "_p90"])}`],
    [tr("area") || "Field area", `${f2(d.area_ha)} ha · ${f2(d.area_ha * 2.471, 1)} ac`],
    ["Clear-sky coverage", d.valid_fraction != null ? Math.round(d.valid_fraction * 100) + "%" : "–"],
  ];
  if (isY && mean != null) cards.push(["Yield", `${f2(mean * 404.7, 0)} kg/acre`]);
  if (d.production_t != null) cards.push(["Est. production", f2(d.production_t, 1) + " t"]);
  if (isY) cards.push(["Model", MODEL_LABEL[d.model] || d.model]);
  $("kpis").innerHTML = cards.map(([t, v]) => `<div class="kpi"><small>${t}</small><b>${v}</b></div>`).join("");
}

function renderSeries(d) {
  const box = $("seriesBox");
  if (!d.series || !d.series.length) { box.hidden = true; $("peakInfo").textContent = "No clear-sky observations in this period."; return; }
  box.hidden = false;
  if (S.chart) S.chart.destroy();
  S.chart = new Chart($("tsChart").getContext("2d"), { type: "line",
    data: { labels: d.series.map((x) => x.date), datasets: [{ label: d.index, data: d.series.map((x) => x.value),
      borderColor: "#e6b84a", backgroundColor: "rgba(230,184,74,.15)", fill: true, tension: 0.3, pointRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: "#a9c3b0", maxTicksLimit: 6, font: { size: 10 } }, grid: { display: false } },
                y: { ticks: { color: "#a9c3b0", font: { size: 10 } }, grid: { color: "rgba(255,255,255,.06)" } } } } });
  if (d.peak) {
    const days = Math.round((new Date(d.peak.date) - new Date(val("startDate"))) / 864e5);
    $("peakInfo").textContent = `Peak ${d.index}: ${f2(d.peak.value)} on ${d.peak.date} (day ${days} from season start)`;
  }
}

async function openAnalytics() {
  if (!S.aoi) return toast(tr("drawFirst"));
  $("panel").hidden = false;
  if (val("indexSelect") === "SATELLITE") { $("kpis").innerHTML = '<p class="hint">Pick an index layer to see statistics.</p>'; return; }
  $("kpis").innerHTML = '<p class="hint">Calculating…</p>'; $("compareBox").innerHTML = "";
  const [st, ts] = await Promise.allSettled([api("/stats", payload()), api("/timeseries", payload())]);
  if (st.status === "fulfilled") { S.last = st.value; renderKpis(st.value); }
  else { $("kpis").innerHTML = ""; const p = document.createElement("p"); p.className = "err"; p.textContent = st.reason.message; $("kpis").appendChild(p); }
  if (ts.status === "fulfilled") renderSeries(ts.value); else { $("seriesBox").hidden = true; $("peakInfo").textContent = ts.reason.message; }
}

async function compareModels() {
  if (!S.aoi) return toast(tr("drawFirst"));
  $("compareBox").textContent = "Comparing…";
  try {
    const d = await api("/yield_compare", payload({ index: "YIELD" }), { timeout: 115000 });
    const rows = Object.entries(d.models).map(([m, r]) => r.error
      ? `<tr><td>${MODEL_LABEL[m] || m}</td><td colspan="2" class="err">${r.error}</td></tr>`
      : `<tr><td>${MODEL_LABEL[m] || m}</td><td>${f2(r.stats.YIELD_mean)} t/ha</td><td>${f2(r.production_t, 1)} t</td></tr>`).join("");
    $("compareBox").innerHTML = `<table><tr><th>Model</th><th>Mean</th><th>Total</th></tr>${rows}</table>`;
  } catch (e) { $("compareBox").textContent = e.message; }
}

function exportCsv() {
  if (!S.last) return toast("Open analytics first");
  const L0 = S.last, rows = [["metric", "value"], ["index", L0.index], ["crop", L0.crop], ["model", L0.model],
    ["area_ha", L0.area_ha], ["valid_area_ha", L0.valid_area_ha], ["valid_fraction", L0.valid_fraction]];
  Object.entries(L0.stats || {}).forEach(([k, v]) => rows.push([k, v]));
  if (L0.production_t != null) rows.push(["production_t", L0.production_t]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" }));
  a.download = `prithvi_${L0.index}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
function exportPng() {
  if (!S.chart) return;
  const a = document.createElement("a"); a.href = S.chart.toBase64Image(); a.download = `trend_${val("indexSelect")}.png`; a.click();
}

/* ---------- search ---------- */
async function search() {
  const q = val("searchBox").trim(); if (!q) return;
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) { S.map.setView([+m[1], +m[2]], 15); return; }
  try {
    const d = await api(`/search?q=${encodeURIComponent(q)}`, null, { method: "GET" });
    S.map.setView([+d.lat, +d.lon], 14); toast(d.display_name, 3500);
  } catch (e) { toast(e.message); }
}

/* ---------- AI chat ---------- */
function chatLine(cls, text) {
  const d = document.createElement("div"); d.className = cls; d.textContent = text;
  $("chatLog").appendChild(d); $("chatLog").scrollTop = 1e9; return d;
}
async function sendChat() {
  const q = val("chatInput").trim(); if (!q) return;
  $("chatInput").value = ""; chatLine("u", "You: " + q);
  const wait = chatLine("t", "Thinking…");
  const ctx = [`Index: ${val("indexSelect")}`, `Crop: ${val("cropSelect")}`, `Model: ${val("modelSelect")}`,
    `Season: ${val("startDate")} to ${val("endDate")}`, S.last ? `Stats: ${JSON.stringify(S.last)}` : "No stats computed yet"].join("\n");
  try {
    const d = await api("/ask_gemini", { prompt: q, stats_context: ctx }, { timeout: 40000 });
    const txt = d.candidates && d.candidates[0] && d.candidates[0].content.parts[0].text;
    wait.className = "a"; wait.textContent = "AI: " + (txt || "No answer returned.");
  } catch (e) { wait.className = "a"; wait.textContent = "AI: " + e.message; }
}

/* ---------- 3D (Cesium is loaded only on demand) ---------- */
const CESIUM = "https://cesium.com/downloads/cesiumjs/releases/1.114/Build/Cesium/";
function loadCesium() {
  if (window.Cesium) return Promise.resolve();
  return new Promise((res, rej) => {
    const css = document.createElement("link"); css.rel = "stylesheet"; css.href = CESIUM + "Widgets/widgets.css"; document.head.appendChild(css);
    const s = document.createElement("script"); s.src = CESIUM + "Cesium.js"; s.onload = res;
    s.onerror = () => rej(new Error("Could not load the 3D engine")); document.head.appendChild(s);
  });
}
function init3D() {
  if (S.viewer) return;
  Cesium.Ion.defaultAccessToken = "";
  S.viewer = new Cesium.Viewer("cesiumContainer", {
    baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", maximumLevel: 17 })),
    baseLayerPicker: false, geocoder: false, animation: false, timeline: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false });
  apply3DLayer();
}
function apply3DLayer() {
  if (!S.viewer || !S.tileUrl) return;
  if (S.cesiumLayer) S.viewer.imageryLayers.remove(S.cesiumLayer, true);
  S.cesiumLayer = S.viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({ url: S.tileUrl, maximumLevel: 18 }));
  S.cesiumLayer.alpha = S.opacity;
}
function show3DAoi() {
  S.viewer.entities.removeAll();
  if (S.aoi) {
    const flat = S.aoi.coordinates[0].flat();
    S.viewer.entities.add({ polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
      material: Cesium.Color.fromCssColorString("#e6b84a").withAlpha(0.15), outline: true,
      outlineColor: Cesium.Color.fromCssColorString("#e6b84a"), height: 0 } });
    S.viewer.zoomTo(S.viewer.entities);
  } else {
    const c = S.map.getCenter();
    S.viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(c.lng, c.lat, 6000) });
  }
}
async function toggle3D() {
  if (!S.is3d) {
    try { spin(true, "Loading 3D…"); await loadCesium(); init3D(); }
    catch (e) { toast(e.message); return; } finally { spin(false); }
    S.is3d = true; $("map").style.visibility = "hidden"; $("cesiumContainer").style.display = "block";
    $("viewBtn").textContent = "2D"; show3DAoi();
  } else {
    S.is3d = false; $("cesiumContainer").style.display = "none"; $("map").style.visibility = "visible";
    $("viewBtn").textContent = "3D"; S.map.invalidateSize();
  }
}

/* ---------- misc ---------- */
function draggable(el, handle) {
  let sx, sy, ox, oy, on = false;
  handle.addEventListener("pointerdown", (e) => { on = true; sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect(), p = el.offsetParent.getBoundingClientRect(); ox = r.left - p.left; oy = r.top - p.top;
    handle.setPointerCapture(e.pointerId); });
  handle.addEventListener("pointermove", (e) => { if (!on) return;
    el.style.left = ox + e.clientX - sx + "px"; el.style.top = oy + e.clientY - sy + "px"; el.style.right = "auto"; });
  handle.addEventListener("pointerup", () => { on = false; });
}

document.addEventListener("DOMContentLoaded", () => {
  if (window.innerWidth < 900) document.body.classList.remove("sb-open");
  initMap();

  $("seasonSelect").innerHTML = '<option value="">Custom dates</option>' +
    Object.entries(SEASONS).map(([k, z]) => `<option value="${k}">${z.label}</option>`).join("");
  $("seasonSelect").value = "tn_samba"; applySeason("tn_samba");
  if ([...$("cropSelect").options].some((o) => o.value === "rice")) $("cropSelect").value = "rice";
  onIndexChange(); loadModels(); applyLang();

  $("sidebarToggle").onclick = () => document.body.classList.toggle("sb-open");
  $("langSelect").onchange = (e) => { S.lang = e.target.value; applyLang(); };
  $("seasonSelect").onchange = (e) => applySeason(e.target.value);
  $("indexSelect").onchange = onIndexChange;
  $("cropSelect").onchange = () => { loadModels(); if (val("indexSelect") === "YIELD") applyCropDefaults(); };
  $("opacity").oninput = (e) => { S.opacity = e.target.value / 100; $("opacityVal").textContent = S.opacity.toFixed(2);
    if (S.layer) S.layer.setOpacity(S.opacity); if (S.cesiumLayer) S.cesiumLayer.alpha = S.opacity; };
  $("toggleLayer").onchange = (e) => { if (!S.layer) return; e.target.checked ? S.layer.addTo(S.map) : S.map.removeLayer(S.layer); };
  S.map.on("overlayadd", (e) => { if (e.layer === S.layer) $("toggleLayer").checked = true; });
  S.map.on("overlayremove", (e) => { if (e.layer === S.layer) $("toggleLayer").checked = false; });

  $("runBtn").onclick = run; $("analyticsBtn").onclick = openAnalytics; $("downloadBtn").onclick = download;
  $("viewBtn").onclick = toggle3D;
  $("panelClose").onclick = () => { $("panel").hidden = true; };
  $("csvBtn").onclick = exportCsv; $("imgBtn").onclick = exportPng; $("compareBtn").onclick = compareModels;
  draggable($("panel"), $("panelHead"));

  $("searchBtn").onclick = search; $("searchBox").onkeydown = (e) => { if (e.key === "Enter") search(); };
  $("chatBtn").onclick = () => { $("chatPanel").hidden = false; $("chatBtn").style.display = "none"; $("chatInput").focus(); };
  $("chatClose").onclick = () => { $("chatPanel").hidden = true; $("chatBtn").style.display = ""; };
  $("chatSend").onclick = sendChat; $("chatInput").onkeydown = (e) => { if (e.key === "Enter") sendChat(); };
  chatLine("a", "Hi! Draw a field, run an analysis, then ask me what the numbers mean.");

  $("aboutBtn").onclick = () => { $("aboutModal").hidden = false; };
  $("aboutClose").onclick = () => { $("aboutModal").hidden = true; };
});
})();
