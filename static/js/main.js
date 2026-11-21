/* PRITHVI Dashboard – main.js */
(function () {
    'use strict';

    // ------------------------------------------------------------------
    // State & helpers
    // ------------------------------------------------------------------
    const state = {
        aoi: null,
        tileLayer: null,
        tileUrl: null,
        opacity: 0.7,
        miniChart: null,
        hoverTimer: null,
        hoverSeq: 0,
        cesiumViewer: null,
        cesiumLayer: null,
        is3D: false
    };
    window.state = state; // handy for debugging in the console

    const $ = (id) => document.getElementById(id);

    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    let toastTimer = null;
    function showToast(message, ms = 2300) {
        const t = $('toast');
        t.textContent = message;
        t.classList.remove('toast-hide');
        t.classList.add('toast-show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            t.classList.remove('toast-show');
            t.classList.add('toast-hide');
        }, ms);
    }
    function showSpinner(msg = 'Loading...') {
        $('spinner-msg').textContent = msg;
        $('spinner').style.display = 'flex';
    }
    function hideSpinner() { $('spinner').style.display = 'none'; }
    function openModal(id) { $(id).style.display = 'block'; }
    function closeModal(id) { $(id).style.display = 'none'; }

    async function postJSON(url, body) {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        let data;
        try { data = await r.json(); }
        catch (e) { throw new Error('Server returned an invalid response (HTTP ' + r.status + ')'); }
        return data;
    }

    function getColorRamp() {
        const v = $('colorRamp').value;
        if (v === 'redgreen') return ['f80000', 'ffe500', '18c016'];
        if (v === 'bluered') return ['0044ff', 'ffebeb', 'ff0000'];
        if (v === 'earth') return ['543005', 'a6611a', 'dfc27d', 'f6e8c3'];
        return ['440154', '3B528B', '21908C', '5DC863', 'FDE725'];
    }

    function basePayload() {
        return {
            aoi: state.aoi,
            index: $('indexSelect').value,
            startDate: $('startDate').value,
            endDate: $('endDate').value
        };
    }

    function validDates() {
        const s = $('startDate').value, e = $('endDate').value;
        if (!s || !e) { showToast('Select both dates.'); return false; }
        if (s > e) { showToast('Start date must be before end date.'); return false; }
        return true;
    }

    function showDataNotice(data) {
        const box = $('dataNotice');
        if (data && data.used) {
            const u = data.used;
            box.innerHTML = `<b>Data used:</b> ${esc(u.start)} → ${esc(u.end)}<br>` +
                `${u.scenes} scene(s), cloud &lt; ${u.max_cloud}%` +
                (u.extended ? `<br><b>Range was auto-extended.</b>` : '');
            box.style.display = 'block';
        } else if (data && data.notice) {
            box.textContent = data.notice;
            box.style.display = 'block';
        }
    }

    // ------------------------------------------------------------------
    // Index guidance (also sets suggested min/max)
    // ------------------------------------------------------------------
    const guidanceData = {
        SATELLITE: { text: '<strong>True Color:</strong> Sentinel-2 RGB composite of clear pixels. No color ramp is applied.', min: 0.0, max: 0.3 },
        NDVI: { text: '<strong>NDVI:</strong> Typical crop range is 0.2–0.9. Pixels below 0.25 are masked as non-crop.', min: 0.2, max: 0.9 },
        YIELD: { text: '<strong>Yield (t/ha):</strong> Y = (6 × NDVI<sub>peak</sub> − 1) × F<sub>variety</sub> × F<sub>irrigation</sub> × calibration. Set the dates to the crop season (transplanting → harvest) for the best result.', min: 1.0, max: 5.0 },
        BSI: { text: '<strong>BSI:</strong> Bare Soil Index. Values above 0.1 indicate exposed soil. Use −0.1 to 0.3 to find fallow patches.', min: -0.1, max: 0.3 },
        SAVI: { text: '<strong>SAVI:</strong> Soil-adjusted vegetation index, better than NDVI where canopy is sparse.', min: 0.2, max: 0.8 },
        NDSI: { text: '<strong>NDSI*:</strong> Computed as (SWIR − NIR)/(SWIR + NIR), a moisture-type index, not true snow NDSI.', min: 0.0, max: 1.0 }
    };

    function applyGuidance() {
        const sel = $('indexSelect').value;
        const g = guidanceData[sel];
        if (!g) return;
        $('indexGuidance').innerHTML = g.text;
        $('visMin').value = g.min;
        $('visMax').value = g.max;
    }

    // ------------------------------------------------------------------
    // Leaflet analysis layer
    // ------------------------------------------------------------------
    function addLeafletAnalysis(tileUrl) {
        const map = window.map;
        if (state.tileLayer) {
            // remove from the control first so the overlayremove event doesn't uncheck the toggle
            window.layersControl.removeLayer(state.tileLayer);
            if (map.hasLayer(state.tileLayer)) map.removeLayer(state.tileLayer);
        }
        state.tileLayer = L.tileLayer(tileUrl, { opacity: state.opacity, maxZoom: 22 });
        window.layersControl.addOverlay(state.tileLayer, 'Analysis');
        $('toggleAnalysisLayer').checked = true;
        state.tileLayer.addTo(map);
    }

    // ------------------------------------------------------------------
    // Cesium (created lazily on first use of 3D)
    // ------------------------------------------------------------------
    function ensureCesium() {
        if (state.cesiumViewer) return state.cesiumViewer;
        const token = window.CESIUM_ION_TOKEN;
        if (token) Cesium.Ion.defaultAccessToken = token;
        const opts = {
            baseLayerPicker: false,
            geocoder: false,
            baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
                url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                maximumLevel: 19
            })),
            shouldAnimate: false
        };
        if (token && Cesium.Terrain && Cesium.Terrain.fromWorldTerrain) {
            try { opts.terrain = Cesium.Terrain.fromWorldTerrain(); } catch (e) { /* ignore */ }
        }
        state.cesiumViewer = new Cesium.Viewer('cesiumContainer', opts);
        return state.cesiumViewer;
    }

    function syncCesiumLayer() {
        if (!state.cesiumViewer || !state.tileUrl) return;
        const v = state.cesiumViewer;
        if (state.cesiumLayer) v.imageryLayers.remove(state.cesiumLayer, true);
        state.cesiumLayer = v.imageryLayers.addImageryProvider(
            new Cesium.UrlTemplateImageryProvider({ url: state.tileUrl, maximumLevel: 20 })
        );
        state.cesiumLayer.alpha = state.opacity;
    }

    function showCesiumAOI(geojson) {
        const v = state.cesiumViewer;
        if (!v) return;
        v.entities.removeAll();
        if (geojson && geojson.type === 'Polygon') {
            const flat = [];
            geojson.coordinates[0].forEach(c => flat.push(c[0], c[1]));
            v.entities.add({
                polygon: {
                    hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
                    material: Cesium.Color.GREEN.withAlpha(0.25),
                    outline: true,
                    outlineColor: Cesium.Color.DARKGREEN,
                    clampToGround: true
                }
            });
        }
    }

    // ------------------------------------------------------------------
    // Field analytics (stats + trend chart)
    // ------------------------------------------------------------------
    async function fetchStatsData() {
        const area = $('statsArea');
        const idx = $('indexSelect').value;
        if (idx === 'SATELLITE') {
            area.textContent = 'Select an index layer (NDVI, YIELD, ...) to see statistics.';
            return;
        }
        area.textContent = 'Calculating stats...';
        try {
            const data = await postJSON('/stats', basePayload());
            if (data.error) { area.innerHTML = `<span style="color:#ff6b6b">${esc(data.error)}</span>`; return; }
            const s = data.stats || {};
            const f = (k) => (s[data.index + '_' + k] != null) ? Number(s[data.index + '_' + k]).toFixed(3) : '–';
            const unit = data.index === 'YIELD' ? ' t/ha' : '';
            let html = `<div style="border-bottom:1px solid #43d37533;padding-bottom:5px;margin-bottom:5px;">
                          <b>${esc(data.index)}</b> mean: <b>${f('mean')}</b>${unit}</div>
                        <div style="font-size:12px;">Min ${f('min')} · Max ${f('max')}</div>
                        <div style="font-size:12px;opacity:.8;">AOI area: ${data.area_ha} ha</div>`;
            if (data.index === 'YIELD' && data.production_t != null) {
                html += `<div style="margin-top:5px;">Cropped area: <b>${data.cropped_ha} ha</b><br>
                         Est. production: <b>${data.production_t} t</b></div>`;
            }
            if (data.notice) html += `<div style="color:#e7e585;font-size:11px;margin-top:5px;">${esc(data.notice)}</div>`;
            area.innerHTML = html;
        } catch (err) {
            area.textContent = 'Error loading stats: ' + err.message;
        }
    }

    async function updateMiniChart() {
        const idx = $('indexSelect').value;
        const canvas = $('miniTsChart');
        try {
            const d = await postJSON('/timeseries', basePayload());
            if (!d.series || d.series.length === 0) {
                if (state.miniChart) { state.miniChart.destroy(); state.miniChart = null; }
                showToast(d.error || 'No time-series data for this AOI/date range.', 3200);
                return;
            }
            const label = (idx === 'YIELD' || idx === 'SATELLITE') ? 'NDVI' : idx;
            if (state.miniChart) state.miniChart.destroy();
            state.miniChart = new Chart(canvas.getContext('2d'), {
                type: 'line',
                data: {
                    labels: d.series.map(x => x.date),
                    datasets: [{
                        label: label + ' (AOI mean)',
                        data: d.series.map(x => x.value),
                        borderColor: '#43d375',
                        backgroundColor: 'rgba(67,211,117,0.1)',
                        borderWidth: 2, pointRadius: 3, tension: 0.3, fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false }, title: { display: true, text: label + ' trend', color: '#ccc', font: { size: 11 } } },
                    scales: {
                        y: { ticks: { color: '#ccc', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
                        x: { ticks: { color: '#ccc', font: { size: 10 }, maxRotation: 60 }, grid: { display: false } }
                    }
                }
            });
        } catch (err) {
            showToast('Trend chart failed: ' + err.message, 3000);
        }
    }

    function openAnalyticsPanel() {
        if (!state.aoi) { showToast('Draw AOI first!'); return false; }
        if (!validDates()) return false;
        $('onMapChartContainer').style.display = 'block';
        $('toggleLiveChart').checked = true;
        fetchStatsData();
        updateMiniChart();
        return true;
    }

    function makeDraggable(el) {
        const header = $(el.id + 'Header');
        if (!header) return;
        let x = 0, y = 0;
        header.onmousedown = function (e) {
            if (e.target.id === 'closeOverlay') return;
            e.preventDefault();
            x = e.clientX; y = e.clientY;
            document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
            document.onmousemove = function (ev) {
                ev.preventDefault();
                el.style.left = (el.offsetLeft - (x - ev.clientX)) + 'px';
                el.style.top = (el.offsetTop - (y - ev.clientY)) + 'px';
                x = ev.clientX; y = ev.clientY;
            };
        };
    }

    // ------------------------------------------------------------------
    // Run analysis / download
    // ------------------------------------------------------------------
    async function runAnalysis() {
        if (!state.aoi) { showToast('Draw AOI first!'); return; }
        if (!validDates()) return;

        const idx = $('indexSelect').value;
        const params = Object.assign(basePayload(), {
            min: parseFloat($('visMin').value),
            max: parseFloat($('visMax').value),
            colorRamp: getColorRamp()
        });
        if (idx === 'SATELLITE') {
            params.min = 0.0;
            params.max = 0.3;
            params.colorRamp = null;
        }

        showSpinner('Fetching imagery...');
        try {
            const data = await postJSON('/get_tiles', params);
            hideSpinner();
            if (data.tile_url) {
                state.tileUrl = data.tile_url;
                addLeafletAnalysis(data.tile_url);
                syncCesiumLayer();
                showDataNotice(data);
                showToast(data.notice ? data.notice : 'Analysis complete! Hover AOI for values.',
                          data.notice ? 7000 : 2500);
                if ($('onMapChartContainer').style.display === 'block') {
                    fetchStatsData();
                    updateMiniChart();
                }
            } else {
                showToast(data.error || 'Could not fetch map tiles', 5000);
            }
        } catch (err) {
            hideSpinner();
            showToast('Analysis failed: ' + err.message, 3500);
        }
    }

    async function downloadAOI() {
        if (!state.aoi) { showToast('Draw AOI first!'); return; }
        if (!validDates()) return;
        showSpinner('Preparing download...');
        try {
            const data = await postJSON('/download', basePayload());
            hideSpinner();
            if (!data.url) { showToast(data.error ? 'Error: ' + data.error : 'Download failed!', 4000); return; }
            showToast('Download ready.');
            const now = new Date();
            const p = (n) => String(n).padStart(2, '0');
            const filename = `${$('indexSelect').value}_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.tif`;
            // Earth Engine download URLs are normally CORS-open; fall back to a direct open if not
            try {
                const blob = await (await fetch(data.url)).blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } catch (e) {
                window.open(data.url, '_blank');
            }
        } catch (err) {
            hideSpinner();
            showToast('Download error: ' + err.message, 3500);
        }
    }

    // ------------------------------------------------------------------
    // AI assistant
    // ------------------------------------------------------------------
    function appendChat(role, msg) {
        const box = $('ai-chat-messages');
        const d = document.createElement('div');
        d.className = role === 'user' ? 'ai-msg-user' : (role === 'thinking' ? 'ai-msg-thinking' : 'ai-msg-ai');
        if (role === 'user') d.textContent = 'You: ' + msg;
        else if (role === 'thinking') d.textContent = msg;
        else d.innerHTML = 'AI: ' + esc(msg).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
        box.appendChild(d);
        box.scrollTop = box.scrollHeight;
        return d;
    }

    async function sendGeminiAI() {
        const input = $('ai-chat-input'), send = $('ai-chat-send');
        const q = input.value.trim();
        if (!q) return;

        const idx = $('indexSelect').value;
        const unit = idx === 'YIELD' ? 't/ha' : '';
        const statsText = $('statsArea').innerText || 'No stats calculated yet';
        const prompt =
            `Current dashboard context:\n- Active index: ${idx} ${unit}\n` +
            `- Date range: ${$('startDate').value} to ${$('endDate').value}\n` +
            `- Color stretch: ${$('visMin').value} to ${$('visMax').value}\n\n` +
            `User question: ${q}`;

        appendChat('user', q);
        input.value = '';
        input.disabled = true; send.disabled = true;
        const pending = appendChat('thinking', 'Analyzing dashboard data...');

        try {
            const data = await postJSON('/ask_gemini', { prompt, stats_context: statsText });
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            const errMsg = data.error?.message || data.error;
            pending.remove();
            if (text) appendChat('ai', text);
            else appendChat('ai', errMsg ? 'Service error: ' + errMsg : 'No response received. Please try again.');
        } catch (err) {
            pending.remove();
            appendChat('ai', "I'm having trouble reaching the analytics engine right now.");
        }
        input.disabled = false; send.disabled = false;
        input.focus();
    }

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', function () {

        // ---- Sidebar ----
        const sidebar = $('sidebar'), chevron = $('chevron');
        $('sidebarToggle').onclick = function () {
            sidebar.classList.toggle('sidebar-collapsed');
            chevron.classList.toggle('chevron-right');
            chevron.classList.toggle('chevron-left');
            setTimeout(() => window.map && window.map.invalidateSize(), 380);
        };

        $('indexSelect').addEventListener('change', applyGuidance);
        applyGuidance();

        $('aboutBtn').onclick = () => openModal('aboutModal');
        $('closeAboutModal').onclick = () => closeModal('aboutModal');
        window.addEventListener('click', (e) => { if (e.target.id === 'aboutModal') closeModal('aboutModal'); });

        // ---- Leaflet map ----
        const map = L.map('map').setView([9.505, 77.755], 12);
        window.map = map;

        window.baseLayers = {
    // Imagery: maxNativeZoom stops the "Map data not yet available" tiles
    'Satellite (Esri)': L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { minZoom: 1, maxZoom: 21, maxNativeZoom: 18, attribution: 'Tiles &copy; Esri' }),

    'Satellite (Google)': L.tileLayer(
        'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
        { minZoom: 1, maxZoom: 21, maxNativeZoom: 20, attribution: '&copy; Google' }),

    'Hybrid (Google)': L.tileLayer(
        'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
        { minZoom: 1, maxZoom: 21, maxNativeZoom: 20, attribution: '&copy; Google' }),

    'OpenStreetMap': L.tileLayer(
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        { minZoom: 1, maxZoom: 21, maxNativeZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),

    'Topographic (OpenTopoMap)': L.tileLayer(
        'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        { minZoom: 1, maxZoom: 21, maxNativeZoom: 17, subdomains: 'abc',
          attribution: '&copy; OpenTopoMap, OSM contributors' }),

    'Light (Esri Gray)': L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        { minZoom: 1, maxZoom: 21, maxNativeZoom: 16, attribution: 'Tiles &copy; Esri' }),

    'Dark (Esri)': L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        { minZoom: 1, maxZoom: 21, maxNativeZoom: 16, attribution: 'Tiles &copy; Esri' })
};
window.baseLayers['Satellite (Esri)'].addTo(map);
        window.layersControl = L.control.layers(window.baseLayers, {}).addTo(map);

        // keep the sidebar checkbox in sync with the layer control
        map.on('overlayadd', (e) => { if (e.name === 'Analysis') $('toggleAnalysisLayer').checked = true; });
        map.on('overlayremove', (e) => { if (e.name === 'Analysis') $('toggleAnalysisLayer').checked = false; });
        $('toggleAnalysisLayer').addEventListener('change', function () {
            if (!state.tileLayer) return;
            if (this.checked) { if (!map.hasLayer(state.tileLayer)) state.tileLayer.addTo(map); }
            else if (map.hasLayer(state.tileLayer)) map.removeLayer(state.tileLayer);
        });

        // ---- Drawing ----
        const drawnItems = new L.FeatureGroup();
        map.addLayer(drawnItems);
        map.addControl(new L.Control.Draw({
            edit: { featureGroup: drawnItems },
            draw: { polyline: false, marker: false, circlemarker: false }
        }));

        function layerToAoi(layer) {
            if (layer instanceof L.Circle) {
                const c = layer.getLatLng();
                return turf.circle([c.lng, c.lat], layer.getRadius() / 1000, { steps: 64, units: 'kilometers' }).geometry;
            }
            return layer.toGeoJSON().geometry;
        }
        function describeAoi(layer) {
            const ha = turf.area({ type: 'Feature', geometry: state.aoi, properties: {} }) / 10000;
            layer.bindPopup(`AOI selected<br>Area: <b>${ha.toFixed(3)} ha</b> (${(ha * 2.47105).toFixed(2)} acres)`).openPopup();
        }

        map.on(L.Draw.Event.CREATED, function (e) {
            drawnItems.clearLayers();
            drawnItems.addLayer(e.layer);
            state.aoi = layerToAoi(e.layer);
            describeAoi(e.layer);
            if (state.cesiumViewer) showCesiumAOI(state.aoi);
        });
        map.on(L.Draw.Event.EDITED, function (e) {
            e.layers.eachLayer(function (layer) {
                state.aoi = layerToAoi(layer);
                describeAoi(layer);
            });
            if (state.cesiumViewer) showCesiumAOI(state.aoi);
        });
        map.on(L.Draw.Event.DELETED, function () {
            if (drawnItems.getLayers().length === 0) {
                state.aoi = null;
                if (state.cesiumViewer) state.cesiumViewer.entities.removeAll();
            }
        });

        // ---- Opacity ----
        const slider = $('opacitySlider');
        slider.addEventListener('input', function () {
            state.opacity = this.value / 100;
            $('opacityValue').textContent = state.opacity.toFixed(2);
            if (state.tileLayer) state.tileLayer.setOpacity(state.opacity);
            if (state.cesiumLayer) state.cesiumLayer.alpha = state.opacity;
        });

        // ---- FAB buttons ----
        $('runBtn').onclick = runAnalysis;
        $('downloadBtn').onclick = downloadAOI;
        $('switchViewBtn').onclick = function () {
            const mapDiv = $('map'), cesiumDiv = $('cesiumContainer');
            if (!state.is3D) {
                try { ensureCesium(); }
                catch (err) { showToast('3D view failed: ' + err.message, 4000); return; }
                mapDiv.style.display = 'none';
                cesiumDiv.style.display = 'block';
                state.is3D = true;
                this.textContent = '2D';
                syncCesiumLayer();
                showCesiumAOI(state.aoi);
                const c = map.getCenter();
                state.cesiumViewer.camera.flyTo({
                    destination: Cesium.Cartesian3.fromDegrees(c.lng, c.lat, 5000)
                });
                state.cesiumViewer.resize();
            } else {
                cesiumDiv.style.display = 'none';
                mapDiv.style.display = 'block';
                state.is3D = false;
                this.textContent = '3D';
                map.invalidateSize();
            }
        };

        // ---- Search with Photon autocomplete ----
        const searchBox = $('searchBox');
        const suggestionList = document.createElement('ul');
        suggestionList.className = 'suggestions';
        $('search-panel').appendChild(suggestionList);
        let searchTimer = null;

        searchBox.addEventListener('input', function () {
            const q = searchBox.value.trim();
            clearTimeout(searchTimer);
            if (/^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(q) || q.length < 3) {
                suggestionList.style.display = 'none';
                return;
            }
            searchTimer = setTimeout(() => {
                fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=5')
                    .then(r => r.json())
                    .then(data => {
                        suggestionList.innerHTML = '';
                        if (!data.features || !data.features.length) { suggestionList.style.display = 'none'; return; }
                        data.features.forEach(feature => {
                            const p = feature.properties;
                            const li = document.createElement('li');
                            li.textContent = [p.name, p.city, p.state, p.country].filter(Boolean).join(', ');
                            li.onclick = function () {
                                map.setView([feature.geometry.coordinates[1], feature.geometry.coordinates[0]], 14);
                                searchBox.value = li.textContent;
                                suggestionList.style.display = 'none';
                                showToast('Moved to: ' + li.textContent);
                            };
                            suggestionList.appendChild(li);
                        });
                        suggestionList.style.display = 'block';
                    })
                    .catch(() => { suggestionList.style.display = 'none'; });
            }, 300);
        });
        searchBox.addEventListener('blur', () => setTimeout(() => { suggestionList.style.display = 'none'; }, 250));

        function doSearch() {
            const q = searchBox.value.trim();
            const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
            if (m) {
                map.setView([parseFloat(m[1]), parseFloat(m[2])], 15);
                showToast('Moved to specified coordinates.');
            } else if (q) {
                fetch('/search?q=' + encodeURIComponent(q))
                    .then(r => r.json())
                    .then(d => {
                        if (d.lat) { map.setView([parseFloat(d.lat), parseFloat(d.lon)], 14); showToast('Moved to: ' + d.display_name); }
                        else showToast('Location not found');
                    })
                    .catch(() => showToast('Search failed'));
            }
        }
        $('searchBtn').onclick = doSearch;
        searchBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

        // ---- Hover value (throttled: query only after cursor rests) ----
        const hoverBox = $('hoverValue');
        map.on('mousemove', function (e) {
            clearTimeout(state.hoverTimer);
            hoverBox.style.display = 'none';
            if (!state.tileLayer || !state.aoi || $('indexSelect').value === 'SATELLITE') return;
            const pt = turf.point([e.latlng.lng, e.latlng.lat]);
            if (!turf.booleanPointInPolygon(pt, turf.feature(state.aoi))) return;

            const x = e.originalEvent.clientX, y = e.originalEvent.clientY;
            const seq = ++state.hoverSeq;
            state.hoverTimer = setTimeout(async () => {
                const index = $('indexSelect').value;
                const unit = index === 'YIELD' ? ' t/ha' : '';
                try {
                    const d = await postJSON('/value_at', {
                        lat: e.latlng.lat, lng: e.latlng.lng, index,
                        startDate: $('startDate').value, endDate: $('endDate').value
                    });
                    if (seq !== state.hoverSeq) return; // cursor moved on
                    if (d.value != null) {
                        hoverBox.textContent = `Value: ${parseFloat(d.value).toFixed(3)}${unit}`;
                        hoverBox.style.border = '1px solid #43d375';
                    } else {
                        hoverBox.textContent = 'Non-Agri / Masked';
                        hoverBox.style.border = '1px solid #ff4444';
                    }
                    hoverBox.style.left = (x + 18) + 'px';
                    hoverBox.style.top = (y + 18) + 'px';
                    hoverBox.style.display = 'block';
                } catch (err) { /* ignore hover errors */ }
            }, 500);
        });
        map.on('mouseout', function () { clearTimeout(state.hoverTimer); state.hoverSeq++; hoverBox.style.display = 'none'; });

        // ---- Analytics panel ----
        makeDraggable($('onMapChartContainer'));
        $('statsBtn').onclick = openAnalyticsPanel;
        $('toggleLiveChart').onchange = function () {
            if (this.checked) {
                if (!openAnalyticsPanel()) this.checked = false;
            } else {
                $('onMapChartContainer').style.display = 'none';
            }
        };
        $('closeOverlay').onclick = function () {
            $('onMapChartContainer').style.display = 'none';
            $('toggleLiveChart').checked = false;
        };
        $('statsDownloadBtn').onclick = function () {
            if (!state.aoi) { showToast('Draw AOI first!'); return; }
            const q = new URLSearchParams({
                aoi: JSON.stringify(state.aoi),
                index: $('indexSelect').value,
                start: $('startDate').value,
                end: $('endDate').value
            });
            window.open('/stats_csv?' + q.toString(), '_blank');
        };
        $('chartDownloadBtn').onclick = function () {
            if (!state.miniChart) { showToast('No chart to export yet.'); return; }
            const a = document.createElement('a');
            a.href = state.miniChart.toBase64Image();
            a.download = `Trend_${$('indexSelect').value}.png`;
            a.click();
        };

        // ---- AI chat ----
        const aiBtn = $('ai-chat-launch'), aiPanel = $('ai-chat-panel');
        aiBtn.onclick = () => { aiPanel.style.display = 'flex'; aiBtn.style.display = 'none'; $('ai-chat-input').focus(); };
        $('ai-chat-close').onclick = () => { aiPanel.style.display = 'none'; aiBtn.style.display = 'flex'; };
        $('ai-chat-send').onclick = sendGeminiAI;
        $('ai-chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendGeminiAI(); });
        appendChat('ai', "Hi! I'm your PRITHVI AI assistant. Run an analysis, open Stats, then ask me about yield, NDVI, bare soil or your AOI results.");
    });
})();
