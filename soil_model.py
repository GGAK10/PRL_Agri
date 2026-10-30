"""soil_model.py - Method C: soil-test based, nutrient-limited yield (Liebig minimum).

Pipeline (all in Earth Engine so tiles/stats/hover work like the other methods):
  soil points --IDW--> pixel maps of avail N, P, K (+ pH, EC)
  indigenous supply S_n = a + b * soil_test_n               (kg/ha uptake)
  uptake        U_n = S_n + RF_n * fertiliser_n
  yield by nutrient Y_n = U_n * IE_n / 1000                 (t/ha)
  attainable    Y = min(Y_N, Y_P, Y_K) * f(pH) * f(EC)

ALL DEFAULT NUMBERS BELOW ARE PLACEHOLDERS for demonstration. Calibrate supply (a, b) with
NPK omission-plot data and put them in calibration.json -> <crop> -> "SOIL".
"""
import csv
import io
import math

import ee

MAX_POINTS = 100
P2O5_TO_P, K2O_TO_K = 0.436, 0.830

DEFAULTS = {
    "supply": {"N": {"a": 0.0, "b": 0.20}, "P": {"a": 0.0, "b": 0.70}, "K": {"a": 0.0, "b": 0.35}},
    "rf": {"N": 0.40, "P": 0.20, "K": 0.40},        # fertiliser recovery fraction
    "ie": {"N": 55.0, "P": 330.0, "K": 65.0},       # kg grain per kg nutrient taken up
}

REQUIRED = ("lat", "lon", "avail_n", "avail_p", "avail_k")
OPTIONAL = ("oc", "ph", "ec")
ALIASES = {
    "lat": ("lat", "latitude", "y"), "lon": ("lon", "lng", "long", "longitude", "x"),
    "avail_n": ("avail_n", "available_n", "n"), "avail_p": ("avail_p", "available_p", "p"),
    "avail_k": ("avail_k", "available_k", "k"), "oc": ("oc", "organic_carbon"),
    "ph": ("ph",), "ec": ("ec", "ece"),
}
RANGE = {"lat": (-90, 90), "lon": (-180, 180), "avail_n": (0, 1500), "avail_p": (0, 300),
         "avail_k": (0, 2000), "oc": (0, 15), "ph": (3, 11), "ec": (0, 50)}

TEMPLATE_CSV = (
    "lat,lon,avail_n,avail_p,avail_k,oc,ph,ec\n"
    "10.7801,79.1402,240,18,210,0.62,7.1,0.8\n"
    "10.7822,79.1431,205,12,185,0.51,7.6,1.2\n"
)
# units: avail_n, avail_p, avail_k in kg/ha (0-15 cm); oc in %; ph 1:2.5; ec as ECe dS/m


def _median(v):
    s = sorted(v)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def clean_points(raw):
    """Validate/normalise a list of dicts. Invalid rows are dropped; optional gaps get the median."""
    if not isinstance(raw, list) or not raw:
        raise ValueError("Upload soil data first (Method C needs soil-test points).")
    pts = []
    for r in raw:
        if not isinstance(r, dict):
            continue
        rec, ok = {}, True
        for k in REQUIRED + OPTIONAL:
            if r.get(k) in (None, ""):
                if k in REQUIRED:
                    ok = False
                    break
                continue
            try:
                v = float(r[k])
            except (TypeError, ValueError):
                ok = False
                break
            lo, hi = RANGE[k]
            if not (v == v and lo <= v <= hi):
                ok = False
                break
            rec[k] = v
        if ok:
            pts.append(rec)
    if not pts:
        raise ValueError("No valid soil rows found (check units and ranges).")
    if len(pts) > MAX_POINTS:
        raise ValueError(f"Too many soil points ({len(pts)} > {MAX_POINTS}). Average per sampling cell first.")
    for k in OPTIONAL:
        have = [p[k] for p in pts if k in p]
        if have:
            med = _median(have)
            for p in pts:
                p.setdefault(k, med)
    return pts


def parse_csv(text):
    rdr = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    if not rdr.fieldnames:
        raise ValueError("CSV has no header row")
    head = {h.strip().lower(): h for h in rdr.fieldnames if h}
    col = {}
    for key, names in ALIASES.items():
        for n in names:
            if n in head:
                col[key] = head[n]
                break
    missing = [k for k in REQUIRED if k not in col]
    if missing:
        raise ValueError(f"Missing column(s): {', '.join(missing)}. Download the CSV template for the format.")
    rows = [{k: (row.get(h) or "").strip() for k, h in col.items()} for row in rdr]
    pts = clean_points(rows)
    return pts, len(rows) - len(pts)


def clean_fert(d):
    d = d if isinstance(d, dict) else {}

    def f(k):
        try:
            return min(max(float(d.get(k) or 0), 0.0), 400.0)
        except (TypeError, ValueError):
            return 0.0
    return {"N": f("n"), "P": f("p2o5") * P2O5_TO_P, "K": f("k2o") * K2O_TO_K}


def _idw(pts, keys):
    """Inverse-distance-squared interpolation as Earth Engine images (distance in metres)."""
    ll = ee.Image.pixelLonLat()
    lon, lat = ll.select("longitude"), ll.select("latitude")
    num = {k: ee.Image.constant(0) for k in keys}
    den = ee.Image.constant(0)
    for p in pts:
        dx = lon.subtract(p["lon"]).multiply(111320 * math.cos(math.radians(p["lat"])))
        dy = lat.subtract(p["lat"]).multiply(110540)
        w = ee.Image.constant(1).divide(dx.multiply(dx).add(dy.multiply(dy)).add(1))
        den = den.add(w)
        for k in keys:
            num[k] = num[k].add(w.multiply(p[k]))
    return {k: num[k].divide(den) for k in keys}


def soil_yield(aoi, cfg, pts, fert, cal=None):
    """Nutrient-limited attainable yield image (t/ha)."""
    cal = cal or {}
    sup = {**DEFAULTS["supply"], **(cal.get("supply") or {})}
    rf = {**DEFAULTS["rf"], **(cal.get("rf") or {})}
    ie = {**DEFAULTS["ie"], **(cal.get("ie") or {})}
    keys = ["avail_n", "avail_p", "avail_k"] + [k for k in OPTIONAL if k in pts[0]]
    est = _idw(pts, keys)

    def by_nutrient(key, n):
        s = est[key].multiply(sup[n]["b"]).add(sup[n]["a"]).max(0)
        return s.add(fert.get(n, 0.0) * rf[n]).multiply(ie[n] / 1000.0)

    y = by_nutrient("avail_n", "N").min(by_nutrient("avail_p", "P")).min(by_nutrient("avail_k", "K"))
    if "ph" in est:        # placeholder: optimum 5.5-8.0, -15 % per pH unit outside
        off = est["ph"].subtract(5.5).multiply(-1).max(0).add(est["ph"].subtract(8.0).max(0))
        y = y.multiply(ee.Image.constant(1).subtract(off.multiply(0.15)).clamp(0.4, 1))
    if "ec" in est:        # Maas-Hoffman style: threshold 3 dS/m, -12 %/dS/m (assumes ECe)
        y = y.multiply(ee.Image.constant(1).subtract(est["ec"].subtract(3.0).max(0).multiply(0.12)).clamp(0, 1))
    return y.clamp(0, cfg["ymax"])
