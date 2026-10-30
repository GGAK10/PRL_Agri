"""Fit Method B coefficients from crop-cutting experiments (CCE).

Input CSV columns: plot_id, lon, lat, start, end, yield_t_ha   (dates YYYY-MM-DD, yield at 14 % moisture)
Usage:  python tools/fit_calibration.py cce.csv --crop rice
Auth :  either `earthengine authenticate` + GEE_PROJECT_ID, or GEE_SERVICE_ACCOUNT + GEE_KEY_FILE + GEE_PROJECT_ID.
Output: calibration_candidate.json (merge into calibration.json) and cross-validated metrics.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ee
import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression
from sklearn.metrics import r2_score, mean_squared_error
from sklearn.model_selection import KFold, cross_val_predict

import yield_models as ym


def init():
    proj, sa, key = os.environ["GEE_PROJECT_ID"], os.environ.get("GEE_SERVICE_ACCOUNT"), os.environ.get("GEE_KEY_FILE")
    if sa and key:
        ee.Initialize(ee.ServiceAccountCredentials(sa, key), project=proj)
    else:
        ee.Initialize(project=proj)


def features(df, cfg, buf):
    rows = []
    for _, r in df.iterrows():
        g = ee.Geometry.Point([float(r.lon), float(r.lat)]).buffer(buf)
        try:
            v = ym.season_features(g, str(r.start), str(r.end), cfg).reduceRegion(
                ee.Reducer.mean(), g, 10, maxPixels=1e8).getInfo()
        except ee.EEException as e:
            print("skip", r.plot_id, str(e)[:80]); continue
        if all(v.get(k) is not None for k in ("apar", "indvi", "ndvi_max", "ndmi_mean")):
            rows.append({**v, "y": float(r.yield_t_ha), "plot_id": r.plot_id})
    return pd.DataFrame(rows)


def cv(model, X, y):
    pred = cross_val_predict(model, X, y, cv=KFold(min(10, len(y)), shuffle=True, random_state=1))
    return round(r2_score(y, pred), 3), round(float(mean_squared_error(y, pred) ** 0.5), 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv"); ap.add_argument("--crop", default="rice"); ap.add_argument("--buffer", type=float, default=15)
    a = ap.parse_args()
    init()
    df = features(pd.read_csv(a.csv), ym.CROP_CFG["crops"][a.crop], a.buffer)
    n = len(df)
    print(f"{n} usable plots")
    if n < 20:
        sys.exit("Need at least ~20 plots (30-60+ recommended) for a meaningful fit.")
    y, out, rep = df["y"].values, {}, {}

    for name, col in (("NDVI_REG", "ndvi_max"), ("INDVI_REG", "indvi")):
        X = df[[col]].values
        m = LinearRegression().fit(X, y)
        out[name] = {"a": float(m.intercept_), "b": float(m.coef_[0])}
        rep[name] = cv(LinearRegression(), X, y)

    X = df[["apar"]].values
    m = LinearRegression(fit_intercept=False).fit(X, y)
    out["LUE_CAL"] = {"k": float(m.coef_[0])}
    rep["LUE_CAL"] = cv(LinearRegression(fit_intercept=False), X, y)

    cols = [c for c in ("ndvi_max", "indvi", "ndmi_mean", "bsi_pre") if c in df and df[c].notna().all()]
    if n >= 10 * len(cols) and cols:        # rule of thumb: >= 10 plots per predictor
        X = df[cols].values
        m = LinearRegression().fit(X, y)
        out["MULTI"] = {"intercept": float(m.intercept_), "coef": {c: float(v) for c, v in zip(cols, m.coef_)}}
        rep["MULTI"] = cv(LinearRegression(), X, y)

    print("Cross-validated (R2, RMSE t/ha):", json.dumps(rep, indent=2))
    with open("calibration_candidate.json", "w") as f:
        json.dump({a.crop: out}, f, indent=2)
    print("Wrote calibration_candidate.json - review the metrics before merging into calibration.json")


if __name__ == "__main__":
    main()
