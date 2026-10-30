# PRITHVI – Paddy Intelligence

Flask + Google Earth Engine + Leaflet. Three yield methods:
A) LUE empirical · B) calibrated NDVI/spectral regression · C) soil-test nutrient model (+ Fused = min(A, C)).
Hover over the analysed field to read per-pixel values.

## Local run
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export GEE_SERVICE_ACCOUNT=name@project.iam.gserviceaccount.com
export GEE_PROJECT_ID=your-gcp-project
export GEE_KEY_FILE=/path/to/service_account_key.json
export ALLOW_ANONYMOUS=1            # local only
python app.py                       # http://localhost:5001
```

## Deploy to Render
1. Push this repo to GitHub (never commit the key file).
2. Render → New → Blueprint → select the repo (it reads `render.yaml`).
3. Environment: set GEE_SERVICE_ACCOUNT, GEE_PROJECT_ID, APP_USER, APP_PASS (required),
   GEMINI_API_KEY and NOMINATIM_EMAIL (optional).
4. Environment → Secret Files → add `service_account_key.json` (paste the JSON key).
   It mounts at /etc/secrets/service_account_key.json.
5. Deploy. Health check: /healthz.

## Earth Engine setup
- Create a GCP project, enable the Earth Engine API, register the project for Earth Engine.
- Create a service account, grant it an Earth Engine role (e.g. Earth Engine Resource Viewer),
  and create a JSON key.

## Calibrating Method B
`pip install -r tools/requirements-dev.txt`, then
`python tools/fit_calibration.py cce.csv --crop rice`, review the cross-validated metrics,
and merge `calibration_candidate.json` into `calibration.json`.

## Soil data (Method C) CSV
Columns: lat, lon, avail_n, avail_p, avail_k (kg/ha, 0-15 cm); optional oc (%), ph, ec (dS/m).
Max 100 points. Default coefficients in soil_model.py are placeholders.
