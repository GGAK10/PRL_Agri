"""yield_models.py - Sentinel-2 / ERA5-Land crop-yield helpers for PRITHVI.

Method A: LUE (empirical/biophysical)   Method B: calibrated NDVI/spectral regressions
Method C: soil-test model (soil_model.py), optionally FUSED = min(A, C).

From the MDPI e-book 'Recent Advances in Remote Sensing for Crop Growth Monitoring' (2016):
  rice base temperature 12 C and fAPAR ceiling 0.95 (Guo et al.); NWDWI flood index
  (Shi & Huang); time-integrated NDVI predictor (Hao et al.); 10-day phenology windows
  (Boschetti et al.).
NOT from the e-book: RUE, HI, NDVI->fAPAR slope, optimum temperatures (generic starting
values - calibrate with local crop-cutting data and put results in calibration.json).
"""
import json
import os

import ee

import soil_model as sm

STEP, PAD = 10, 5
KEEP_SCL = [4, 5, 6, 7]
NWDWI_A = 2.0
FAPAR_SLOPE, FAPAR_INT, FAPAR_MAX = 1.25, 0.17, 0.95
PAR_FRAC = 0.48
ERA = "ECMWF/ERA5_LAND/DAILY_AGGR"
DEFAULT_SSRD_J, DEFAULT_T_C = 18e6, 27.0
SOIL_MODELS = ("SOIL", "FUSED")

CROP_CFG = {"crops": {
    "rice":    dict(tb=12, to=28, tx=38, rue=2.2, hi=0.45, ymax=9.0, paddy=True),
    "wheat":   dict(tb=0,  to=20, tx=32, rue=2.8, hi=0.42, ymax=8.0),
    "maize":   dict(tb=8,  to=28, tx=40, rue=3.2, hi=0.45, ymax=14.0),
    "sorghum": dict(tb=8,  to=30, tx=40, rue=3.0, hi=0.35, ymax=8.0),
    "soybean": dict(tb=8,  to=26, tx=38, rue=1.8, hi=0.40, ymax=5.0),
}}


def _load_cal():
    try:
        with open(os.path.join(os.path.dirname(__file__), "calibration.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


CAL = _load_cal()


def available_models(crop):
    """LUE plus any calibrated model present in calibration.json (soil models are added by the UI)."""
    cal = CAL.get(crop, {})
    return ["LUE"] + [m for m in ("NDVI_REG", "INDVI_REG", "LUE_CAL", "MULTI") if m in cal]


# ------------------------------------------------------------------ Sentinel-2
def _mask_scl(img, keep):
    scl = img.select("SCL")
    m = scl.eq(keep[0])
    for k in keep[1:]:
        m = m.Or(scl.eq(k))
    return img.updateMask(m)


def _prep(img):
    r = img.select(["B2", "B3", "B4", "B8", "B11"]).divide(10000)
    m = {k: r.select(k) for k in ["B2", "B3", "B4", "B8", "B11"]}
    bands = [
        r.normalizedDifference(["B8", "B4"]).rename("NDVI"),
        r.expression("2.5*(B8-B4)/(B8+6*B4-7.5*B2+1)", m).rename("EVI"),
        r.expression("1.5*(B8-B4)/(B8+B4+0.5)", m).rename("SAVI"),
        r.expression("((B11+B4)-(B8+B2))/((B11+B4)+(B8+B2))", m).rename("BSI"),
        r.normalizedDifference(["B8", "B11"]).rename("NDMI"),
        r.normalizedDifference(["B3", "B11"]).rename("NDSI"),
        r.expression(f"(B11-{NWDWI_A}*B3)/(B11+{NWDWI_A}*B3)", m).rename("NWDWI"),
    ]
    return (r.select(["B2", "B3", "B4"]).addBands(bands)
            .copyProperties(img, ["system:time_start"]))


def get_collection(aoi, start, end, keep=None):
    keep = keep or KEEP_SCL
    return (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
            .filterBounds(aoi).filterDate(start, end)
            .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 85))
            .map(lambda i: _prep(_mask_scl(i, keep))))


# ------------------------------------------------------------------ Sentinel-1
def sar_collection(aoi, start, end):
    return (ee.ImageCollection("COPERNICUS/S1_GRD").filterBounds(aoi).filterDate(start, end)
            .filter(ee.Filter.eq("instrumentMode", "IW"))
            .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VH"))
            .map(lambda i: i.select("VH").rename("SAR_VH").copyProperties(i, ["system:time_start"])))


def sar_image(aoi, start, end):
    return sar_collection(aoi, start, end).median().focal_median(20, "circle", "meters").clip(aoi)


# ------------------------------------------------------------------ compositing
def _median_or_empty(col, bands):
    empty = (ee.Image.constant([0] * len(bands)).rename(bands).toFloat()
             .updateMask(ee.Image.constant(0)))
    return ee.Image(ee.Algorithms.If(col.size().gt(0), col.median(), empty))


def composites(col, bands, start, end, step=STEP, pad=PAD):
    """Moving-median composites (window = step + 2*pad days). Empty windows come back fully masked."""
    bands = [bands] if isinstance(bands, str) else list(bands)
    col = col.select(bands)
    s = ee.Date(start)
    n = ee.Date(end).difference(s, "day").divide(step).ceil()

    def win(i):
        a = s.advance(ee.Number(i).multiply(step), "day")
        sub = col.filterDate(a.advance(-pad, "day"), a.advance(step + pad, "day"))
        return _median_or_empty(sub, bands).set({"t0": a.millis(), "date": a.format("YYYY-MM-dd")})

    return ee.ImageCollection.fromImages(ee.List.sequence(0, n.subtract(1)).map(win))


# ------------------------------------------------------------------ weather
def _pos(d, key, fallback):
    raw = d.get(key, -1)
    v = ee.Number(ee.Algorithms.If(raw, raw, -1))
    return ee.Number(ee.Algorithms.If(v.gt(0), v, fallback))


def _weather(aoi, a, b):
    """PAR (MJ/m2) and mean air temperature (C) for [a, b) from ERA5-Land, with fallbacks."""
    days = b.difference(a, "day")
    w = ee.ImageCollection(ERA).filterDate(a, b)

    def sample():
        img = ee.Image.cat([w.select("surface_solar_radiation_downwards_sum").sum(),
                            w.select("temperature_2m").mean()]).rename(["ssrd", "t2m"])
        return img.reduceRegion(ee.Reducer.first(), aoi.centroid(100), 11132)

    d = ee.Dictionary(ee.Algorithms.If(w.size().gt(0), sample(), ee.Dictionary()))
    ssrd = _pos(d, "ssrd", days.multiply(DEFAULT_SSRD_J))
    t2m = _pos(d, "t2m", DEFAULT_T_C + 273.15)
    return ssrd.divide(1e6).multiply(PAR_FRAC), t2m.subtract(273.15)


def _ft(t, cfg):
    tb, to, tx = cfg["tb"], cfg["to"], cfg["tx"]
    up = t.subtract(tb).divide(to - tb)
    dn = ee.Number(tx).subtract(t).divide(tx - to)
    return up.min(dn).max(0).min(1)


# ------------------------------------------------------------------ features & masks
def season_features(aoi, start, end, cfg, step=STEP):
    """Bands: apar (MJ/m2 effective), indvi, ndvi_max, ndmi_mean, bsi_pre.
    Gap windows are compensated by n_windows / n_valid; pixels with <50% valid windows are masked."""
    comp = composites(get_collection(aoi, start, end), ["NDVI", "NDMI"], start, end, step)
    n = comp.size()

    def per_win(img):
        img = ee.Image(img)
        a = ee.Date(img.get("t0"))
        par, tc = _weather(aoi, a, a.advance(step, "day"))
        fapar = img.select("NDVI").multiply(FAPAR_SLOPE).subtract(FAPAR_INT).clamp(0, FAPAR_MAX)
        return img.addBands(fapar.multiply(par.multiply(_ft(tc, cfg))).rename("apar"))

    w = comp.map(per_win)
    nv = w.select("NDVI").count()
    k = ee.Image.constant(n).divide(nv)
    pre = get_collection(aoi, start, ee.Date(start).advance(30, "day")).select("BSI")
    feats = ee.Image.cat([
        w.select("apar").sum().multiply(k).rename("apar"),
        w.select("NDVI").sum().multiply(k).multiply(step).rename("indvi"),
        w.select("NDVI").max().rename("ndvi_max"),
        w.select("NDMI").mean().rename("ndmi_mean"),
        _median_or_empty(pre, ["BSI"]).rename("bsi_pre"),
    ])
    return feats.updateMask(nv.gte(n.multiply(0.5)))


def crop_mask_img(aoi, start, end, cfg):
    if cfg.get("paddy"):   # flooded at some point AND green later (Shi & Huang logic, adapted to S2)
        comp = composites(get_collection(aoi, start, end), ["NDVI", "NWDWI"], start, end)
        return comp.select("NWDWI").min().lte(0).And(comp.select("NDVI").max().gte(0.5))
    return ee.Image("ESA/WorldCover/v200").select("Map").eq(40)


# ------------------------------------------------------------------ yield
def yield_image(aoi, start, end, crop, model, crop_mask, soil=None, fert=None):
    cfg = CROP_CFG["crops"].get(crop)
    if cfg is None:
        raise ValueError(f"Unknown crop '{crop}'")
    model = str(model).upper()
    if model not in available_models(crop) and model not in SOIL_MODELS:
        raise ValueError(f"Model {model} is not calibrated for {crop}. Add coefficients to "
                         f"calibration.json or use LUE.")
    cal_crop = CAL.get(crop, {})

    ys = None
    if model in SOIL_MODELS:
        if not soil:
            raise ValueError("Upload soil data first (Method C needs soil-test points).")
        ys = sm.soil_yield(aoi, cfg, soil, fert or {}, cal_crop.get("SOIL"))
        if model == "SOIL":                       # soil-only: no satellite features needed
            y = ys
            if crop_mask:
                y = y.updateMask(crop_mask_img(aoi, start, end, cfg))
            return y.clamp(0, cfg["ymax"]).rename("YIELD").clip(aoi)

    f = season_features(aoi, start, end, cfg)
    cal = cal_crop.get(model, {})
    if model in ("LUE", "FUSED"):                 # MJ/m2 x g/MJ x HI -> g/m2 ; x0.01 -> t/ha
        y = f.select("apar").multiply(cfg["rue"] * cfg["hi"] * 0.01)
        if model == "FUSED":                      # potential (light) capped by nutrient supply
            y = y.min(ys)
    elif model == "LUE_CAL":
        y = f.select("apar").multiply(cal["k"])
    elif model == "NDVI_REG":
        y = f.select("ndvi_max").multiply(cal["b"]).add(cal["a"])
    elif model == "INDVI_REG":
        y = f.select("indvi").multiply(cal["b"]).add(cal["a"])
    else:                                         # MULTI
        y = ee.Image.constant(cal["intercept"])
        for name, c in cal["coef"].items():
            y = y.add(f.select(name).multiply(c))
    y = y.updateMask(f.select("ndvi_max").gte(0.3))
    if crop_mask:
        y = y.updateMask(crop_mask_img(aoi, start, end, cfg))
    return y.clamp(0, cfg["ymax"]).rename("YIELD").clip(aoi)
