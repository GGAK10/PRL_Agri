import os
import json
import csv
from io import StringIO
from collections import defaultdict
from datetime import date, datetime, timedelta

import ee
import requests
from dotenv import load_dotenv
from flask import Flask, render_template, request, jsonify, Response

load_dotenv()


def init_earth_engine():
    project = os.environ.get("GEE_PROJECT_ID")
    use_sa = os.environ.get("GEE_USE_SERVICE_ACCOUNT", "").lower() in ("1", "true", "yes")
    sa = os.environ.get("GEE_SERVICE_ACCOUNT")
    key_file = os.environ.get("GEE_KEY_FILE", "service_account_key.json")
    if use_sa and sa and os.path.exists(key_file):
        print(f"[EE] Using SERVICE ACCOUNT {sa} on project {project}")
        creds = ee.ServiceAccountCredentials(sa, key_file)
        ee.Initialize(credentials=creds, project=project)
    else:
        print(f"[EE] Using LOCAL LOGIN on project {project}")
        ee.Initialize(project=project)


def init_earth_engine():
    project = os.environ.get("GEE_PROJECT_ID")
    use_sa = os.environ.get("GEE_USE_SERVICE_ACCOUNT", "").lower() in ("1", "true", "yes")
    sa = os.environ.get("GEE_SERVICE_ACCOUNT")
    key_file = os.environ.get("GEE_KEY_FILE", "service_account_key.json")
    if use_sa and sa and os.path.exists(key_file):
        print(f"[EE] Using SERVICE ACCOUNT {sa} on project {project}")
        creds = ee.ServiceAccountCredentials(sa, key_file)
        ee.Initialize(credentials=creds, project=project)
    else:
        print(f"[EE] Using LOCAL LOGIN on project {project}")
        ee.Initialize(project=project)


init_earth_engine()
app = Flask(__name__)

# ---------------- Config ----------------
AGRI_THRESHOLD = 0.25
S2_COLLECTION = "COPERNICUS/S2_SR_HARMONIZED"
YIELD_PERCENTILE = int(os.environ.get("YIELD_PERCENTILE", 90))
YIELD_CAL = float(os.environ.get("YIELD_CAL_FACTOR", 1.0))

# District statistics (from your original script)
HYV, LOCAL = 64524, 0
IRRIGATED, RAINFED = 64524, 0
F_VARIETY = (HYV + 0.7 * LOCAL) / (HYV + LOCAL) if (HYV + LOCAL) > 0 else 1.0
F_IRRIGATION = 1.2 if IRRIGATED > RAINFED else 0.9

DEFAULT_START, DEFAULT_END = "2026-04-01", "2026-11-21"


class NoImagery(Exception):
    pass


# ---------------- Sentinel-2 collection with auto-extend ----------------
def prep(img):
    scl = img.select("SCL")
    bad = scl.eq(3).Or(scl.eq(8)).Or(scl.eq(9)).Or(scl.eq(10))  # shadow, cloud, cirrus
    return (img.updateMask(bad.Not())
               .select(["B2", "B3", "B4", "B8", "B11"])
               .divide(10000)
               .copyProperties(img, ["system:time_start"]))


def build_collection(aoi, start, end):
    s = datetime.strptime(start, "%Y-%m-%d").date()
    e = datetime.strptime(end, "%Y-%m-%d").date()
    today = date.today()
    # (days added each side, max scene cloud %)
    attempts = [(0, 20), (0, 50), (15, 50), (30, 70), (60, 80)]
    for i, (pad, cloud) in enumerate(attempts):
        s2 = s - timedelta(days=pad)
        e2 = min(e + timedelta(days=pad), today)
        col = (ee.ImageCollection(S2_COLLECTION)
               .filterBounds(aoi)
               .filterDate(s2.isoformat(), (e2 + timedelta(days=1)).isoformat())
               .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", cloud)))
        n = col.size().getInfo()
        if n > 0:
            meta = {"start": s2.isoformat(), "end": e2.isoformat(),
                    "max_cloud": cloud, "scenes": n, "extended": i > 0, "notice": None}
            if i > 0:
                meta["notice"] = (
                    f"Few clear Sentinel-2 scenes for the chosen dates. Used "
                    f"{meta['start']} to {meta['end']} (cloud < {cloud}%, {n} scenes).")
            return col.map(prep), meta
    raise NoImagery("No Sentinel-2 images found even after extending the range. "
                    "Pick a wider date range or a different area.")


def ndvi_of(img):
    return (img.normalizedDifference(["B8", "B4"]).rename("NDVI")
               .copyProperties(img, ["system:time_start"]))


def get_index_image(aoi, index, start, end):
    col, meta = build_collection(aoi, start, end)

    if index == "SATELLITE":
        return col.median().select(["B4", "B3", "B2"]).clip(aoi), meta

    if index == "NDVI":
        ndvi = col.map(ndvi_of).median()
        return ndvi.updateMask(ndvi.gte(AGRI_THRESHOLD)).clip(aoi), meta

    if index == "YIELD":
        # Peak-season NDVI per pixel, not the season median
        peak = (col.map(ndvi_of)
                   .reduce(ee.Reducer.percentile([YIELD_PERCENTILE]))
                   .rename("NDVI"))
        y = (peak.multiply(6).subtract(1)
                 .multiply(F_VARIETY * F_IRRIGATION * YIELD_CAL)
                 .max(0)
                 .rename("YIELD"))
        return y.updateMask(peak.gte(AGRI_THRESHOLD)).clip(aoi), meta

    img = col.median().clip(aoi)
    if index == "BSI":
        return img.expression(
            "((SWIR1 + RED) - (NIR + BLUE)) / ((SWIR1 + RED) + (NIR + BLUE))",
            {"SWIR1": img.select("B11"), "RED": img.select("B4"),
             "NIR": img.select("B8"), "BLUE": img.select("B2")}).rename("BSI"), meta
    if index == "SAVI":
        return img.expression(
            "((NIR - RED) / (NIR + RED + 0.5)) * 1.5",
            {"NIR": img.select("B8"), "RED": img.select("B4")}).rename("SAVI"), meta
    if index == "NDSI":
        return img.normalizedDifference(["B11", "B8"]).rename("NDSI"), meta
    raise ValueError(f"Unknown index: {index}")


def common(data):
    return (ee.Geometry(data["aoi"]), data.get("index", "NDVI"),
            data.get("startDate", DEFAULT_START), data.get("endDate", DEFAULT_END))


# ---------------- Routes ----------------
@app.route("/get_tiles", methods=["POST"])
def get_tiles():
    data = request.json
    try:
        aoi, index, start, end = common(data)
        img, meta = get_index_image(aoi, index, start, end)
        vis = {"min": data.get("min", -0.3), "max": data.get("max", 1.0)}
        if index != "SATELLITE":
            vis["palette"] = data.get("colorRamp") or ["440154", "3B528B", "21908C", "5DC863", "FDE725"]
        map_data = img.getMapId(vis)
        return jsonify({"tile_url": map_data["tile_fetcher"].url_format,
                        "notice": meta["notice"], "used": meta})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/value_at", methods=["POST"])
def value_at():
    data = request.json
    try:
        index = data["index"]
        if index == "SATELLITE":
            return jsonify({"value": None})
        pt = ee.Geometry.Point([data["lng"], data["lat"]])
        img, _ = get_index_image(pt.buffer(1000), index,
                                 data.get("startDate", DEFAULT_START),
                                 data.get("endDate", DEFAULT_END))
        val = img.reduceRegion(ee.Reducer.first(), pt, 10).get(index).getInfo()
        return jsonify({"value": val})
    except Exception:
        return jsonify({"value": None}), 200


@app.route("/download", methods=["POST"])
def download():
    data = request.json
    try:
        aoi, index, start, end = common(data)
        img, _ = get_index_image(aoi, index, start, end)
        bands = img.bandNames().size().getInfo()
        pixels = aoi.area().getInfo() / 100.0          # 10 m pixels
        size_mb = pixels * 4 * bands / 1e6
        if size_mb > 32:
            return jsonify({"error": f"AOI too large (~{size_mb:.0f} MB, limit 32 MB)"})
        url = img.getDownloadURL({"scale": 10, "region": aoi,
                                  "format": "GEO_TIFF", "crs": "EPSG:4326"})
        return jsonify({"url": url})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


def region_stats(img, aoi):
    return img.reduceRegion(
        reducer=ee.Reducer.mean().combine(ee.Reducer.minMax(), sharedInputs=True),
        geometry=aoi, scale=10, maxPixels=1e9).getInfo()


@app.route("/stats", methods=["POST"])
def stats():
    data = request.json
    try:
        aoi, index, start, end = common(data)
        img, meta = get_index_image(aoi, index, start, end)
        area_ha = aoi.area().divide(10000).getInfo()
        out = {"stats": region_stats(img, aoi), "area_ha": round(area_ha, 3),
               "index": index, "notice": meta["notice"]}
        if index == "YIELD":
            px_ha = ee.Image.pixelArea().divide(10000)
            prod = (img.multiply(px_ha)
                       .reduceRegion(ee.Reducer.sum(), aoi, 10, maxPixels=1e9)
                       .get("YIELD").getInfo())
            cropped = (px_ha.updateMask(img.mask())
                       .reduceRegion(ee.Reducer.sum(), aoi, 10, maxPixels=1e9)
                       .get("area").getInfo())
            out["production_t"] = round(prod or 0, 3)
            out["cropped_ha"] = round(cropped or 0, 3)
        return jsonify(out)
    except Exception as ex:
        return jsonify({"error": str(ex)}), 400


@app.route("/stats_csv")
def stats_csv():
    try:
        aoi = ee.Geometry(json.loads(request.args.get("aoi")))
        index = request.args.get("index", "NDVI")
        img, _ = get_index_image(aoi, index,
                                 request.args.get("start", DEFAULT_START),
                                 request.args.get("end", DEFAULT_END))
        st = region_stats(img, aoi)
        out = StringIO()
        w = csv.writer(out)
        w.writerow(["Metric", "Value"])
        for k, v in st.items():
            w.writerow([k, v])
        return Response(out.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": "attachment;filename=stats.csv"})
    except Exception as ex:
        return jsonify({"error": str(ex)}), 400


def per_image_value(img, index):
    if index in ("NDVI", "YIELD", "SATELLITE"):      # YIELD trend = NDVI trend
        v = img.normalizedDifference(["B8", "B4"])
    elif index == "BSI":
        v = img.expression(
            "((SWIR1 + RED) - (NIR + BLUE)) / ((SWIR1 + RED) + (NIR + BLUE))",
            {"SWIR1": img.select("B11"), "RED": img.select("B4"),
             "NIR": img.select("B8"), "BLUE": img.select("B2")})
    elif index == "SAVI":
        v = img.expression("((NIR - RED) / (NIR + RED + 0.5)) * 1.5",
                           {"NIR": img.select("B8"), "RED": img.select("B4")})
    else:  # NDSI as currently defined
        v = img.normalizedDifference(["B11", "B8"])
    return v.rename("v")


@app.route("/timeseries", methods=["POST"])
def timeseries():
    data = request.json
    try:
        aoi, index, start, end = common(data)
        col, meta = build_collection(aoi, start, end)

        def to_feature(img):
            val = per_image_value(img, index).reduceRegion(
                ee.Reducer.mean(), aoi, 10, maxPixels=1e9).get("v")
            return ee.Feature(None, {"date": img.date().format("YYYY-MM-dd"), "value": val})

        feats = col.map(to_feature).filter(ee.Filter.notNull(["value"])).getInfo()["features"]
        by_date = defaultdict(list)
        for f in feats:
            p = f["properties"]
            if p.get("value") is not None:
                by_date[p["date"]].append(p["value"])
        series = [{"date": d, "value": sum(v) / len(v)} for d, v in sorted(by_date.items())]
        return jsonify({"series": series, "index": index, "notice": meta["notice"]})
    except Exception as ex:
        return jsonify({"error": str(ex), "series": []})


@app.route("/search")
def search_place():
    q = request.args.get("q", "")
    resp = requests.get("https://nominatim.openstreetmap.org/search",
                        params={"format": "json", "q": q, "limit": 1},
                        headers={"User-Agent": "prithvi-dashboard/1.0"}, timeout=10)
    if resp.ok and resp.json():
        p = resp.json()[0]
        return jsonify({"lat": p.get("lat"), "lon": p.get("lon"), "display_name": p.get("display_name")})
    return jsonify({"error": "Location not found"}), 404


@app.route("/ask_gemini", methods=["POST"])
def ask_gemini():
    data = request.get_json()
    prompt = data.get("prompt", "")
    stats_context = data.get("stats_context", "")
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return jsonify({"error": "GEMINI_API_KEY not set"}), 500

    system_instruction = (
        "You are PRITHVI, a Precision Agriculture Specialist. Give data-driven diagnostics "
        "from remote sensing indices (NDVI, BSI, NDSI, Yield).\n\n"
        "RULES:\n"
        "1. Low NDVI/Yield + high BSI = bare soil, harvest, or salt stress.\n"
        "2. NDSI > 0.4 = snow or surface moisture/flooding.\n"
        "3. High spread between min and max (> 0.3) suggests localized stress pockets.\n"
        "4. If values are extreme (NDVI < 0.1), consider clouds/shadows first.\n"
        "5. Interpret indices together. If stats are missing, ask for them.\n"
        "FORMAT: bold headers, concise."
    )
    full_prompt = f"{system_instruction}\n\nStatistics context:\n{stats_context}\n\nContext:\n{prompt}"
    endpoint = ("https://generativelanguage.googleapis.com/v1beta/models/"
                f"gemini-2.5-flash-lite:generateContent?key={key}")
    resp = requests.post(endpoint, json={"contents": [{"parts": [{"text": full_prompt}]}]}, timeout=30)
    return jsonify(resp.json())


@app.route("/healthz")
def healthz():
    return jsonify({"status": "ok"}), 200


@app.route("/")
def index():
    return render_template("index.html")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5001)), debug=True, use_reloader=False)
