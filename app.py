from flask import Flask, render_template, request, jsonify, Response
import ee
import json
import csv
from io import StringIO
import requests
SERVICE_ACCOUNT = os.environ["GEE_SERVICE_ACCOUNT"]
KEY_FILE = "/etc/secrets/service_account_key.json"

credentials = ee.ServiceAccountCredentials(
    SERVICE_ACCOUNT,
    KEY_FILE
)

ee.Initialize(
    credentials=credentials,
    project=os.environ["GEE_PROJECT_ID"]
)


app = Flask(__name__)
# Constants for Agricultural Calibration
AGRI_THRESHOLD = 0.25  # NDVI values < 0.25 are treated as non-agriculture/bare soil
def get_index_image(aoi, index, start_date, end_date):
    collection = (
        ee.ImageCollection("COPERNICUS/S2_SR")
        .filterBounds(aoi)
        .filterDate(start_date, end_date)
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 10))
        .map(lambda img: img.divide(10000))
    )
    
    if collection.size().getInfo() == 0:
        raise Exception("No valid Sentinel-2 images found. Try a wider date range.")
    
    img = collection.median().clip(aoi)
    # True Color Satellite Imagery
    if index == "SATELLITE":
        # Select RGB bands and return without masking
        return img.select(["B4", "B3", "B2"])
    # Calculate Base NDVI
    ndvi = img.normalizedDifference(['B8', 'B4']).rename("NDVI")
    
    # Create the Agricultural Mask (Keep only NDVI >= 0.25)
    agri_mask = ndvi.gte(AGRI_THRESHOLD)

    if index == "NDVI":
        # Apply mask: Values below 0.25 become NaN
        return ndvi.updateMask(agri_mask)
    
    if index == "YIELD":
        # Calibrated Yield Formula: (NDVI * 6)
        # We omit the '-1' to keep values positive and align with masked vegetation
        yield_map = ndvi.multiply(6).rename("YIELD")
        # Apply mask so yield is only calculated for actual crops
        return yield_map.updateMask(agri_mask)

    if index == "BSI":
        bsi = img.expression(
            "((SWIR1 + RED) - (NIR + BLUE)) / ((SWIR1 + RED) + (NIR + BLUE))",
            {
                "SWIR1": img.select("B11"),
                "RED":   img.select("B4"),
                "NIR":   img.select("B8"),
                "BLUE":  img.select("B2"),
            }
        ).rename("BSI")
        return bsi
    
    if index == "SAVI":
        return img.expression(
            "((NIR - RED) / (NIR + RED + 0.5)) * 1.5",
            {
                "NIR": img.select("B8"),
                "RED": img.select("B4")
            }
        ).rename("SAVI")
    if index == "NDSI":
        return img.normalizedDifference(["B11", "B8"]).rename("NDSI")
    
    if index == "YIELD":
        # Constants from your provided script
        hyv, local = 64524, 0
        irrig, unirrig = 64524, 0
        
        variety_factor = (hyv + 0.7 * local) / (hyv + local) if (hyv + local) > 0 else 1.0
        irrigation_factor = 1.2 if irrig > unirrig else 0.9
        
        yield_map = ndvi.multiply(6).subtract(1).multiply(variety_factor).multiply(irrigation_factor)
        return yield_map.rename("YIELD")

    return None

@app.route("/get_tiles", methods=["POST"])
def get_tiles():
    data = request.json
    try:
        aoi_geojson = data.get("aoi")
        index = data.get("index", "NDVI")
        ramp = data.get("colorRamp", ["440154","3B528B","21908C","5DC863","FDE725"])
        start = data.get("startDate", "2024-01-01")
        end = data.get("endDate", "2024-01-30")
        aoi = ee.Geometry(aoi_geojson)
        img = get_index_image(aoi, index, start, end)
        v_min = data.get("min", -0.3)
        v_max = data.get("max", 1.0)
        map_data = img.getMapId({
            "min": v_min,
            "max": v_max,
            "palette": ramp
        })
        return jsonify({"tile_url": map_data["tile_fetcher"].url_format })
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/value_at", methods=["POST"])
def value_at():
    data = request.json
    try:
        lat = data["lat"]
        lng = data["lng"]
        index = data["index"]
        start = data.get("startDate", "2024-01-01")
        end = data.get("endDate", "2024-01-30")
        pt = ee.Geometry.Point([lng, lat])
        dummy_aoi = pt.buffer(1000)
        img = get_index_image(dummy_aoi, index, start, end)
        sample = img.sample(pt, 10).first()
        if not sample:
            return jsonify({'value': None})
        result = sample.getInfo()
        val = result["properties"][index] if result and "properties" in result and index in result["properties"] else None
        return jsonify({'value': val})
    except Exception as ex:
        return jsonify({'value': None}), 200

@app.route("/download", methods=["POST"])
def download():
    data = request.json
    try:
        aoi_geojson = data.get("aoi")
        index = data.get("index", "NDVI")
        start = data.get("startDate", "2024-01-01")
        end = data.get("endDate", "2024-01-30")
        aoi = ee.Geometry(aoi_geojson)
        img = get_index_image(aoi, index, start, end)
        info = img.getInfo()
        size_est = info["bands"][0]["dimensions"][0] * info["bands"][0]["dimensions"][1] * 4 / 1e6
        if size_est > 50:
            return jsonify({"error": "AOI too large (limit = 50MB)"})
        url = img.getDownloadURL({
            "scale": 10,
            "region": aoi,
            "format": "GEO_TIFF"
        })
        return jsonify({"url": url})
    except Exception as e:
        return jsonify({"error": str(e)}), 400

@app.route("/stats", methods=["POST"])
def stats():
    data = request.json
    try:
        aoi_geojson = data.get("aoi")
        index = data.get("index", "NDVI")
        start = data.get("startDate", "2024-01-01")
        end = data.get("endDate", "2024-01-30")
        aoi = ee.Geometry(aoi_geojson)
        img = get_index_image(aoi, index, start, end)
        area_ha = aoi.area().divide(10000).getInfo() 
    
        stats_result = img.reduceRegion(
        reducer=ee.Reducer.mean().combine(ee.Reducer.minMax(), sharedInputs=True),
        geometry=aoi,
        scale=10,
        maxPixels=1e9
        ).getInfo()
        return jsonify({
        "stats": stats_result, 
        "area_ha": round(area_ha, 2), 
        "index": index
        })
        stats = img.reduceRegion(
            reducer=ee.Reducer.mean().combine(ee.Reducer.minMax(), sharedInputs=True),
            geometry=aoi,
            scale=10,
            maxPixels=1e9
        ).getInfo()
        hist = img.reduceRegion(
            reducer=ee.Reducer.fixedHistogram(-0.5, 1, 30),
            geometry=aoi,
            scale=10,
            maxPixels=1e9
        ).getInfo()
        return jsonify({"stats": stats, "histogram": hist, "index": index})
    except Exception as ex:
        return jsonify({"error": str(ex)}), 400

@app.route("/stats_csv")
def stats_csv():
    try:
        aoi_geojson = request.args.get('aoi')
        index = request.args.get('index', 'NDVI')
        start = request.args.get('start', "2024-01-01")
        end = request.args.get('end', "2024-01-30")
        aoi = ee.Geometry(json.loads(aoi_geojson))
        img = get_index_image(aoi, index, start, end)
        stats = img.reduceRegion(
            reducer=ee.Reducer.mean().combine(ee.Reducer.minMax(), sharedInputs=True),
            geometry=aoi,
            scale=10,
            maxPixels=1e9
        ).getInfo()
        output = StringIO()
        writer = csv.writer(output)
        writer.writerow(['Metric', 'Value'])
        for k, v in stats.items():
            writer.writerow([k, v])
        csv_data = output.getvalue()
        return Response(
            csv_data,
            mimetype='text/csv',
            headers={"Content-Disposition":"attachment;filename=stats.csv"}
        )
    except Exception as ex:
        return jsonify({"error": str(ex)}), 400

@app.route("/search", methods=["GET"])
def search_place():
    query = request.args.get("q", "").strip()

    if not query:
        return jsonify({"error": "Search query is required"}), 400

    url = "https://nominatim.openstreetmap.org/search"

    params = {
        "format": "json",
        "q": query,
        "limit": 1
    }

    headers = {
        "User-Agent": "PRL_Agri/1.0"
    }

    try:
        resp = requests.get(
            url,
            params=params,
            headers=headers,
            timeout=10
        )

        if resp.ok:
            results = resp.json()

            if results:
                place = results[0]

                return jsonify({
                    "lat": place.get("lat"),
                    "lon": place.get("lon"),
                    "display_name": place.get("display_name")
                })

        return jsonify({"error": "Location not found"}), 404

    except requests.RequestException as ex:
        return jsonify({
            "error": f"Location search failed: {str(ex)}"
        }), 502

@app.route("/timeseries", methods=["POST"])
def timeseries():
    data = request.json
    try:
        aoi_geojson = data.get("aoi")
        index = data.get("index", "NDVI")
        start = data.get("startDate", "2024-01-01")
        end = data.get("endDate", "2024-01-30")
        aoi = ee.Geometry(aoi_geojson)
        collection = (
            ee.ImageCollection("COPERNICUS/S2_SR")
            .filterBounds(aoi)
            .filterDate(start, end)
            .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 10))
            .map(lambda img: img.divide(10000))
        )
        if collection.size().getInfo() == 0:
            return jsonify({"error": "No valid Sentinel-2 images for your AOI and date range.", "series": []})
        def index_img(img):
            if index == "NDVI": return img.normalizedDifference(['B8','B4']).set('system:time_start', img.get('system:time_start'))
            if index == "BSI":
                img2 = img.resample("bilinear").reproject(crs="EPSG:4326", scale=10)
                return img2.expression(
                    "((SWIR1 + RED) - (NIR + BLUE)) / ((SWIR1 + RED) + (NIR + BLUE))",
                    {
                        "SWIR1": img2.select("B11"),
                        "RED":   img2.select("B4"),
                        "NIR":   img2.select("B8"),
                        "BLUE":  img2.select("B2"),
                    }).set('system:time_start', img.get('system:time_start'))
            if index == "SAVI":
                return img.expression(
                    "((NIR - RED) / (NIR + RED + 0.5)) * 1.5",
                    {
                        "NIR": img.select("B8"),
                        "RED": img.select("B4")
                    }).set('system:time_start', img.get('system:time_start'))
            if index == "NDSI":
                return img.normalizedDifference(["B11", "B8"]).set('system:time_start', img.get('system:time_start'))
            return img
        indexed_col = collection.map(index_img)
        stats = indexed_col.map(lambda i: i.reduceRegion(
            reducer=ee.Reducer.mean(),
            geometry=aoi,
            scale=10,
            maxPixels=1e9
        ).set('date', ee.Date(i.get('system:time_start')).format('YYYY-MM-dd'))
        )
        stats_list = stats.filter(ee.Filter.notNull([index])).getInfo()
        ts = [{"date": x.get("date", ""), "value": x.get(index, None)} for x in stats_list]
        return jsonify({"series": ts, "index": index})
    except Exception as ex:
        return jsonify({"error": str(ex), "series": []})

@app.route("/ask_gemini", methods=["POST"])
def ask_gemini():
    data = request.get_json()
    prompt = data.get("prompt", "")
    # Inside ask_gemini route
    stats_context = data.get("stats_context", "")
    system_instruction = (
    "You are PRITHVI, a Precision Agriculture Specialist. Your goal is to provide data-driven "
    "diagnostics based on remote sensing indices (NDVI, BSI, NDSI, Yield).\n\n"
    
    "CORE DIAGNOSTIC RULES:\n"
    "1. VEGETATION LOSS: Low NDVI/Yield + High BSI indicates bare soil, harvesting, or salt stress.\n"
    "2. MOISTURE/CRYOSPHERE: High NDSI (>0.4) signals snow cover or significant surface moisture/flooding.\n"
    "3. SPATIAL REASONING: When discussing 'North' or 'South' field sectors, you MUST base your "
    "direction on the delta between Min, Max, and Average stats. High variability (spread > 0.3) "
    "suggests localized stress pockets.\n\n"

    "ANALYSIS PROTOCOLS:\n"
    "- If values are extreme (e.g., NDVI < 0.1), prioritize 'Sensor Obstruction' (clouds/shadows) as a possibility.\n"
    "- Always interpret indices in the context of one another (e.g., 'NDVI is low, which correlates with the high BSI seen in the South').\n"
    "- If stats_context is missing, ask for specific values before diagnosing."
    "RESPONSE FORMAT:\n"
        "- Use bold headers.\n"
        "- Keep explanations concise and data-driven."
)
    full_prompt = (
    f"{system_instruction}\n\n"
    f"Statistics context:\n{stats_context}\n\n"
    f"Context:\n{prompt}"
)


    GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]

    endpoint = (
    "https://generativelanguage.googleapis.com/"
    "v1beta/models/gemini-2.5-flash-lite:generateContent"
    f"?key={GEMINI_API_KEY}"
)

    body = {
        "contents": [
            {"parts": [ {"text": full_prompt} ]}
        ]
    }
    resp = requests.post(endpoint, json=body)
    return jsonify(resp.json())

@app.route("/healthz")
def healthz():
    return jsonify({"status": "ok"}), 200

@app.route("/")
def index():
    return render_template("index.html")

iif __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 5001))
    )

