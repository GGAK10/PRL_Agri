// Global State
let miniTsChart = null;
window.currentTileLayer = null;
window.opacityValue = 0.7;
window.aoiGeojson = null;
Cesium.Ion.defaultAccessToken = ""; // disable Ion, we don't need it
function showToast(message, ms=2300) {
    let toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('toast-show');
    toast.classList.remove('toast-hide');
    setTimeout(() => {
        toast.classList.remove('toast-show');
        toast.classList.add('toast-hide');
    }, ms);
}
function showSpinner(msg="Loading...") {
    document.getElementById('spinner-msg').textContent = msg;
    document.getElementById('spinner').style.display = "flex";
}
function hideSpinner() {
    document.getElementById('spinner').style.display = "none";
}
function openModal(id) { document.getElementById(id).style.display = 'block'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function getColorRamp() {
    let rampSel = document.getElementById('colorRamp').value;
    if (rampSel === "redgreen") return ["f80000","ffe500","18c016"];
    if (rampSel === "bluered") return ["0044ff","ffebeb","ff0000"];
    if (rampSel === "earth") return ["543005","a6611a","dfc27d","f6e8c3"];
    return ["440154","3B528B","21908C","5DC863","FDE725"];
}
// Map overlay helpers
function addLeafletAnalysis(tileUrl) {
  // Remove old overlay from map and Layers Control if it exists
  if (window.currentTileLayer && map.hasLayer(window.currentTileLayer)) {
    map.removeLayer(window.currentTileLayer);
  }
  if (window.layersControl && window.overlays && window.overlays['Analysis']) {
    window.layersControl.removeLayer(window.overlays['Analysis']);
    delete window.overlays['Analysis'];
  }

  // Create new overlay
  window.currentTileLayer = L.tileLayer(tileUrl, { opacity: window.opacityValue });

  // Add to overlays and Layers Control (keeps reference for internal tracking)
  window.overlays = window.overlays || {};
  window.overlays['Analysis'] = window.currentTileLayer;
  window.layersControl.addOverlay(window.currentTileLayer, "Analysis");

  // Only add to map if toggle is ON
  if(document.getElementById('toggleAnalysisLayer').checked) {
    window.currentTileLayer.addTo(map);
  }
}
function addCesiumAnalysis(tileUrl) {
    cesiumViewer.imageryLayers.addImageryProvider(
        new Cesium.UrlTemplateImageryProvider({ url: tileUrl })
    );
}


document.addEventListener("DOMContentLoaded", function () {
    let sidebar = document.getElementById('sidebar');
    let sidebarToggle = document.getElementById('sidebarToggle');
    let chevron = document.getElementById('chevron');
    sidebarToggle.onclick = function (e) {
        sidebar.classList.toggle('sidebar-collapsed');
        chevron.classList.toggle('chevron-right');
        chevron.classList.toggle('chevron-left');
        setTimeout(() => {document.getElementById('fab-bar').style.pointerEvents = "auto";}, 80);
    };
    // Add this inside your DOMContentLoaded listener in main.js
const indexSelect = document.getElementById('indexSelect');
const guidanceBox = document.getElementById('indexGuidance');
const visMinInput = document.getElementById('visMin');
const visMaxInput = document.getElementById('visMax');

const guidanceData = {
    'SATELLITE': {
        text: "<strong>Satellite Guidance:</strong> This shows the field in True Color (as the human eye sees it). No color ramp is applied.",
        min: 0.0,
        max: 0.3
    },
    'NDVI': {
        text: "<strong>NDVI Guidance:</strong> Standard range is 0.2 to 0.9. Set Min to 0.25 to mask bare soil and highlight active crop growth.",
        min: 0.2,
        max: 0.9
    },
    'YIELD': {
        text: "<strong>Yield Guidance:</strong> Values are in t/ha. For cereal crops, a range of 1.0 (Min) to 6.0 (Max) usually captures field variability best.",
        min: 1.0,
        max: 6.0
    },
    'BSI': {
        text: "<strong>BSI Guidance:</strong> Bare Soil Index. High values (0.1+) indicate exposed earth. Use a range of -0.1 to 0.3 to find fallow patches.",
        min: -0.1,
        max: 0.3
    },
    'SAVI': {
        text: "<strong>SAVI Guidance:</strong> Use for areas with sparse vegetation. Similar to NDVI but more accurate in low-density fields.",
        min: 0.2,
        max: 0.8
    },
    'NDSI': {
        text: "<strong>NDSI Guidance:</strong> Snow/Moisture index. Values above 0.4 typically indicate snow cover or high surface water content.",
        min: 0.0,
        max: 1.0
    }
};

indexSelect.addEventListener('change', function() {
    const selected = this.value;
    if (guidanceData[selected]) {
        // Update the text
        guidanceBox.innerHTML = guidanceData[selected].text;
        // Automatically suggest optimal Min/Max values
        visMinInput.value = guidanceData[selected].min;
        visMaxInput.value = guidanceData[selected].max;
    }
});
    document.getElementById('aboutBtn').onclick = () => openModal("aboutModal");
    document.getElementById('closeAboutModal').onclick = () => closeModal("aboutModal");
    document.getElementById('statsBtn').onclick = function() { openStats(); };
    document.getElementById('closeStatsModal').onclick = function(){ closeModal('statsModal'); };

    window.map = L.map('map').setView([9.505, 77.755], 12);

// Basemaps
window.baseLayers = {
  "OpenStreetMap": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { minZoom: 1, maxZoom: 20 }),
  "Satellite": L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { minZoom: 1, maxZoom: 25 }),
  "Topographic": L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', { minZoom: 1, maxZoom: 20 }),
  "Dark": L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}.png', { minZoom: 1, maxZoom: 20 })
};
baseLayers["OpenStreetMap"].addTo(map);

// Overlays (must be global for layersControl to track)
window.overlays = {};

// Layers Control (need to refer to window.baseLayers, window.overlays)
window.layersControl = L.control.layers(window.baseLayers, window.overlays).addTo(map);

// -------- ONE baselayerchange handler only! ----------
map.on('baselayerchange', function () {
  const toggle = document.getElementById('toggleAnalysisLayer');
  if (toggle && toggle.checked && window.currentTileLayer) {
    if (map.hasLayer(window.currentTileLayer)) map.removeLayer(window.currentTileLayer);
    window.currentTileLayer.addTo(map);
  }
});

// --------- Overlayadd/Overlayremove for sync (NEW) ----------
map.on('overlayadd', function (e) {
  if (e.name === 'Analysis') {
    document.getElementById('toggleAnalysisLayer').checked = true;
  }
});
map.on('overlayremove', function (e) {
  if (e.name === 'Analysis') {
    document.getElementById('toggleAnalysisLayer').checked = false;
  }
});

// --------- One toggle handler only ----------
document.getElementById('toggleAnalysisLayer').addEventListener('change', function() {
  if (window.currentTileLayer) {
    if (this.checked) {
      if (!map.hasLayer(window.currentTileLayer)) {
        window.currentTileLayer.addTo(map);
      }
    } else {
      if (map.hasLayer(window.currentTileLayer)) {
        map.removeLayer(window.currentTileLayer);
      }
    }
  }
});

// --------- When adding or updating Analysis Layer (this goes inside your addLeafletAnalysis or similar function) ---------
// Example:
function addLeafletAnalysis(tileUrl) {
  // Remove old overlay from map
  if (window.currentTileLayer && map.hasLayer(window.currentTileLayer)) {
    map.removeLayer(window.currentTileLayer);
  }
  // Remove old overlay from Layers Control
  if (window.layersControl && window.overlays["Analysis"]) {
    window.layersControl.removeLayer(window.overlays["Analysis"]);
    delete window.overlays["Analysis"];
  }
  // Create new overlay
  window.currentTileLayer = L.tileLayer(tileUrl, { opacity: window.opacityValue });

  // Add to overlays object and Layers Control
  window.overlays["Analysis"] = window.currentTileLayer;
  window.layersControl.addOverlay(window.currentTileLayer, "Analysis");

  // Show the overlay if toggle is checked
  if(document.getElementById('toggleAnalysisLayer').checked) {
    window.currentTileLayer.addTo(map);
  }
}

    let drawnItems = new L.FeatureGroup();
    let drawCtrl = new L.Control.Draw({ edit: { featureGroup: drawnItems } });
    map.addLayer(drawnItems);
    map.addControl(drawCtrl);

    map.on(L.Draw.Event.CREATED, function (e) {
        drawnItems.clearLayers();
        drawnItems.addLayer(e.layer);
        if (e.layer instanceof L.Circle) {
            let latlng = e.layer.getLatLng();
            let radius = e.layer.getRadius();
            let circlePoly = turf.circle([latlng.lng, latlng.lat], radius / 1000, {steps: 64, units:'kilometers'});
            aoiGeojson = circlePoly.geometry;
        } else {
            aoiGeojson = e.layer.toGeoJSON().geometry;
        }
        var bounds = e.layer.getBounds ? e.layer.getBounds() : e.layer._bounds;
        var msg = 'AOI Selected.<br>SW: ' + bounds.getSouthWest().toString() + '<br>NE: ' + bounds.getNorthEast().toString();
        e.layer.bindPopup(msg).openPopup();
    });

    //window.opacityValue = 0.7;

    const opacitySlider = document.getElementById('opacitySlider');
    const opacityValueSpan = document.getElementById('opacityValue');

    opacitySlider.value = 70;
    opacityValueSpan.textContent = window.opacityValue.toFixed(2);

    opacitySlider.addEventListener('input', function () {
    window.opacityValue = this.value / 100;
    opacityValueSpan.textContent = window.opacityValue.toFixed(2);
    if (window.currentTileLayer)
        window.currentTileLayer.setOpacity(window.opacityValue);
    });


    // Disable Cesium Ion completely - we don't need it for 2D mode
Cesium.Ion.defaultAccessToken = null;
window.cesiumViewer = new Cesium.Viewer('cesiumContainer', { 
  imageryProvider: false, 
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  geocoder: false
});
cesiumViewer.scene.globe.enableLighting = false;
    document.getElementById('runBtn').onclick = function(){ if (!aoiGeojson) {showToast("Draw AOI first!");return;} runAnalysis(); };
    document.getElementById('downloadBtn').onclick = function(){ if (!aoiGeojson) {showToast("Draw AOI first!");return;} downloadAOI(); };
    document.getElementById('switchViewBtn').onclick = function () {
        var mapDiv = document.getElementById('map'), cesiumDiv = document.getElementById('cesiumContainer');
        if (mapDiv.style.display !== "none") {
            mapDiv.style.display = "none";
            cesiumDiv.style.display = "block";
            var center = map.getCenter();
            cesiumViewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(center.lng, center.lat, 5000)
            });
            if (aoiGeojson) showCesiumAOI(aoiGeojson);
        } else {
            cesiumDiv.style.display = "none";
            mapDiv.style.display = "block";
        }
    };
    function showCesiumAOI(geojson) {
        cesiumViewer.entities.removeAll();
        if (geojson.type === "Polygon") {
            var coords = geojson.coordinates[0].map(function (c) { return { lat: c[1], lng: c[0] }; });
            var positions = coords.map(function (coord) { return Cesium.Cartesian3.fromDegrees(coord.lng, coord.lat, 0); });
            cesiumViewer.entities.add({
                polygon: {
                    hierarchy: new Cesium.PolygonHierarchy(positions),
                    material: Cesium.Color.GREEN.withAlpha(0.4),
                    outline: true,
                    outlineColor: Cesium.Color.DARKGREEN
                }
            });
        }
    }

    // Photon place autocomplete
    let searchBox = document.getElementById('searchBox');
    let suggestionList = document.createElement('ul');
    suggestionList.style.position = "absolute";
    suggestionList.style.background = "#222";
    suggestionList.style.color = "#fff";
    suggestionList.style.listStyle = "none";
    suggestionList.style.margin = "0";
    suggestionList.style.padding = "3px 0";
    suggestionList.style.borderRadius = "8px";
    suggestionList.style.boxShadow = "0 2px 6px #0009";
    suggestionList.style.zIndex = "9999";
    suggestionList.style.display = "none";
    suggestionList.style.maxHeight = "180px";
    suggestionList.style.overflowY = "auto";
    document.getElementById('search-panel').appendChild(suggestionList);

    searchBox.oninput = function () {
        let q = searchBox.value.trim();
        if (q.match(/^\s*-?\d+\.\d+\s*,\s*-?\d+\.\d+\s*$/)) { suggestionList.style.display = "none"; return; }
        if (q.length < 3) { suggestionList.style.display = "none"; return;}
        fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&limit=5')
        .then(response => response.json())
        .then(data => {
            suggestionList.innerHTML = '';
            if (!data.features.length) { suggestionList.style.display = "none"; return;}
            data.features.forEach(feature => {
                let li = document.createElement('li');
                li.style.padding = "5px 18px";
                li.style.cursor = "pointer";
                li.onmouseenter = ()=>li.style.background="#2b5253";
                li.onmouseleave = ()=>li.style.background="unset";
                li.textContent = (feature.properties.name ? feature.properties.name : '') +
                    (feature.properties.city ? ", " + feature.properties.city : '') +
                    (feature.properties.country ? ", " + feature.properties.country : '');
                li.onclick = function () {
                    map.setView([feature.geometry.coordinates[1], feature.geometry.coordinates[0]], 13);
                    searchBox.value = li.textContent;
                    suggestionList.style.display = "none";
                    showToast("Moved to: " + li.textContent);
                };
                suggestionList.appendChild(li);
            });
            suggestionList.style.left = searchBox.offsetLeft + "px";
            suggestionList.style.top = (searchBox.offsetTop + searchBox.offsetHeight+37) + "px";
            suggestionList.style.width = searchBox.offsetWidth+"px";
            suggestionList.style.display = 'block';
        }).catch(()=>{ suggestionList.style.display = "none"; });
    };
    searchBox.onblur = ()=>{ setTimeout(()=>{ suggestionList.style.display="none"; }, 330);}
    document.getElementById('searchBtn').onclick = function() {
        let query = searchBox.value.trim();
        var matches = query.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
        if (matches) {
            map.setView([parseFloat(matches[1]), parseFloat(matches[2])], 13);
            showToast("Moved to specified coordinates.");
        }
    };

    // Stats/Charts modal and download
    document.getElementById('statsDownloadBtn').onclick = function() {
        if (!aoiGeojson) { showToast("Draw AOI first!"); return;}
        let selectedIndex = document.getElementById('indexSelect').value;
        let start = document.getElementById('startDate').value;
        let end = document.getElementById('endDate').value;
        window.open(`/stats_csv?aoi=${encodeURIComponent(JSON.stringify(aoiGeojson))}&index=${selectedIndex}&start=${start}&end=${end}`, '_blank');
    };

    let histChart = null; let tsChart = null;
    function openStats() { if (!aoiGeojson) { showToast("Draw AOI first!"); return;} fetchStatsModal(); openModal('statsModal'); }
    function fetchStatsModal() {
        let selectedIndex = document.getElementById('indexSelect').value;
        let start = document.getElementById('startDate').value;
        let end = document.getElementById('endDate').value;
        fetch('/stats', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({aoi: aoiGeojson, index: selectedIndex, startDate: start, endDate: end})
        })
        .then(res => res.json()).then(data => {
            let area = document.getElementById('statsArea');
            if (data.error) { area.innerHTML = data.error; return; }
            let stats = data.stats || {};
            let meanVal = Number(stats[data.index + '_mean'] || stats['mean'] || 0).toFixed(3);
    
// Logic to show Total Yield if the index is Yield
    let totalYieldHtml = "";
    if(data.index === "Yield") {
        let totalProduction = (meanVal * data.area_ha).toFixed(2);
        totalYieldHtml = `<br>Est. Total Production: <b>${totalProduction} tons</b>`;
    }

    area.innerHTML = `
        <div style="border-bottom: 1px solid #444; margin-bottom: 10px; padding-bottom: 5px;">
            Field Area: <b>${data.area_ha} ha</b>
        </div>
        <b>${data.index} Analysis:</b><br>
        Average: <b>${meanVal}</b> ${data.index === 'Yield' ? 't/ha' : ''}
        ${totalYieldHtml}<br>
        Min: <b>${Number(stats[data.index + '_min'] || 0).toFixed(3)}</b><br>
        Max: <b>${Number(stats[data.index + '_max'] || 0).toFixed(3)}</b>
    `;
            area.innerHTML =
                `<b>${data.index}:</b> <br>
                Mean: <b>${Number(stats[data.index + '_mean'] || stats['mean'] || 0).toFixed(3)}</b><br>
                Min: <b>${Number(stats[data.index + '_min'] || stats['min'] || 0).toFixed(3)}</b><br>
                Max: <b>${Number(stats[data.index + '_max'] || stats['max'] || 0).toFixed(3)}</b><br>`;
            if(data.histogram && data.histogram[data.index]) {
                let arr = data.histogram[data.index];
                let bins = arr[0];
                let values = arr[1];
                let ctx = document.getElementById('histChart').getContext('2d');
                document.getElementById('histChart').style.display = '';
                if (histChart) { histChart.destroy(); }
                histChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: bins.map(x => Number(x).toFixed(2)),
                        datasets: [{
                            label: `${data.index} Histogram`,
                            data: values,
                            backgroundColor: '#28c857dd'
                        }]
                    },
                    options: {
                        scales: {x: {title: {display:true, text:data.index}}, y: {title: {display:true, text:'Frequency'}}},
                        plugins: {legend: {display: false}}
                    }
                });
            } else {
                document.getElementById('histChart').style.display = 'none';
            }
            fetch('/timeseries', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ aoi: aoiGeojson, index: selectedIndex, startDate: start, endDate: end })
            })
            .then(r => r.json()).then(d => {
                let ctx = document.getElementById('tsChart').getContext('2d');
                if (!d.series || d.series.length === 0) {
                    document.getElementById('tsChart').style.display = 'none';
                    return;
                }
                document.getElementById('tsChart').style.display = '';
                if (tsChart) tsChart.destroy();
                tsChart = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: d.series.map(x=>x.date),
                        datasets: [{
                            label: d.index + " (mean AOI)",
                            data: d.series.map(x=>x.value),
                            borderColor: '#21908C',
                            backgroundColor: 'rgba(33,144,140,0.25)',
                            pointBackgroundColor: '#43d375'
                        }]
                    },
                    options: {
                        scales: {
                            x: { title: {display:true,text:"Date"} },
                            y: { title: {display:true,text:d.index} }
                        },
                        plugins: {legend:{display:false}}
                    }
                });
            });
        });
    }

    
    function downloadAOI() {
        let selectedIndex = document.getElementById('indexSelect').value;
        let start = document.getElementById('startDate').value;
        let end = document.getElementById('endDate').value;
        showSpinner('Preparing download...');
        fetch('/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ aoi: aoiGeojson, index: selectedIndex, startDate: start, endDate: end })
        })
        .then(response => response.json())
        .then(data => {
            hideSpinner();
            if (data.url) {
            showToast('Download ready.', 2300);
            // Construct filename
            let selectedIndex = document.getElementById('indexSelect').value;
            let now = new Date();
            let dateStr = `${now.getFullYear()}${(now.getMonth()+1).toString().padStart(2,"0")}${now.getDate().toString().padStart(2,"0")}`;
            let timeStr = `${now.getHours().toString().padStart(2,"0")}${now.getMinutes().toString().padStart(2,"0")}${now.getSeconds().toString().padStart(2,"0")}`;
            let filename = `${selectedIndex}_${dateStr}_${timeStr}.tif`;

            // Download via Blob for custom filename
            fetch(data.url)
            .then(resp => resp.blob())
            .then(blob => {
                let link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            });
                }
             else if (data.error) {
                showToast("Error: " + data.error, 3200);
            } else {
                showToast("Download failed!", 2500);
            }
        })
        .catch(err => {
            hideSpinner();
            showToast('Download error: ' + err, 2200);
        });
    }

    // Hover value logic (follows pointer)
    const hoverBox = document.getElementById('hoverValue');
    map.on('mousemove', function(e) {
        if (!window.currentTileLayer || !window.aoiGeojson) { hoverBox.style.display = "none"; return;}
        var pt = turf.point([e.latlng.lng, e.latlng.lat]); 
        var aoiPoly = turf.feature(window.aoiGeojson);
        if (!turf.booleanPointInPolygon(pt, aoiPoly)) { hoverBox.style.display = "none"; return; }
        let index = document.getElementById('indexSelect').value;
        let start = document.getElementById('startDate').value;
        let end = document.getElementById('endDate').value;
        let unit = (index === "YIELD") ? " t/ha" : "";
        fetch('/value_at', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        lat: e.latlng.lat,
        lng: e.latlng.lng,
        index,
        startDate: start,
        endDate: end
        })
        })
        .then(resp => resp.json()).then(data => {
        hoverBox.style.left = (e.originalEvent.clientX + 18) + 'px';
        hoverBox.style.top = (e.originalEvent.clientY + 34) + 'px';
    
    // Check if value exists (isn't masked/NaN)
    if (data.value !== null && data.value !== undefined) {
        let val = parseFloat(data.value).toFixed(3);
        hoverBox.textContent = `Value: ${val}${unit}`;
        hoverBox.style.border = "1px solid #43d375";
    } else {
        // This triggers for the masked-out areas
        hoverBox.textContent = "Non-Agri / Bare Soil";
        hoverBox.style.border = "1px solid #ff4444";
        }
        hoverBox.style.display = "block";
        });
    });
    map.on('mouseout', function() { hoverBox.style.display = "none"; });

    // === MODERN AI ASSISTANT SLIDER ===
// Get chat UI elements
const aiBtn = document.getElementById('ai-chat-launch');
const aiPanel = document.getElementById('ai-chat-panel');
const aiClose = document.getElementById('ai-chat-close');
const aiBody = document.getElementById('ai-chat-messages');
const aiInput = document.getElementById('ai-chat-input');
const aiSend = document.getElementById('ai-chat-send');

// Show/hide logic
aiBtn.onclick = ()=>{
    aiPanel.style.display='flex';
    aiBtn.style.display="none";
    aiInput.focus();
};
aiClose.onclick = ()=>{
    aiPanel.style.display='none';
    aiBtn.style.display="flex";
};

aiSend.onclick = sendGeminiAI;
aiInput.onkeypress = function(e){ if (e.key === "Enter") sendGeminiAI(); };

// Show greeting only on startup
if(aiBody.childElementCount === 0){
    appendChat('ai', "Hi! I'm your PRITHVI AI assistant. Ask me about NDVI, Sentinel data, vegetation indexes, AOI tools, or general dashboard help anytime.");
}

function appendChat(role, msg) {
    let d = document.createElement('div');
    d.className = (role==="user" ? 'ai-msg-user' : (role==="thinking" ? "ai-msg-thinking" : "ai-msg-ai"));
    d.textContent = (role==="user") ? "You: "+msg : (role==="thinking" ? msg : "AI: "+msg);
    aiBody.appendChild(d); aiBody.scrollTop = aiBody.scrollHeight;
}

async function sendGeminiAI() {
    let q = aiInput.value.trim();
    if(!q) return;

    // 1. Capture current UI state for Palette Stretch and Stats
    let selectedIndex = document.getElementById('indexSelect')?.value || '';
    let startDate = document.getElementById('startDate')?.value || '';
    let endDate = document.getElementById('endDate')?.value || '';
    let minStretch = document.getElementById('minStretch')?.value || '-0.3';
    let maxStretch = document.getElementById('maxStretch')?.value || '1.0';
    let statsLabel = document.getElementById('statsArea')?.innerText || 'No stats calculated yet';
    
    // 2. Define Units for specific indexes
    let unit = (selectedIndex === "YIELD") ? " t/ha" : "";

    // 3. Build a comprehensive context for the AI
    let dashboardContext = `You are PRITHVI, an expert AI assistant for a precision agriculture dashboard. 
    You have access to real-time analysis data. Always use the units (e.g., t/ha for yield) provided in the context.
    If a user asks about a specific value, explain it based on the current index and agricultural standards.`;

    let contextState = `
    Current Analysis Context:
    - Active Index: ${selectedIndex}
    - Units: ${unit}
    - Date Range: ${startDate} to ${endDate}
    - Color Stretch Range: ${minStretch} to ${maxStretch} (Values outside this range are clipped)
    - Calculated AOI Stats: ${statsLabel}
    
    Instructions: 
    - If Yield is discussed, append "t/ha" to numerical values.
    - If asked why yield is low, reference the BSI (Bare Soil Index) or suggest checking for water stress.
    - If a user asks about a specific value (e.g., 2.890), interpret it relative to the ${selectedIndex} mean in the stats.
    `;

    appendChat("user", q);
    aiInput.value = ""; 
    aiInput.disabled = true; 
    aiSend.disabled = true;
    appendChat("thinking", "Analyzing dashboard data...");

    try {
        let fullPrompt = `${dashboardContext}\n${contextState}\nUser: ${q}`;
        let r = await fetch("/ask_gemini", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt: fullPrompt })
        });
        
        let data = await r.json();
        let aiMsg = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

        // Topic filter to maintain professional focus
        let keywords = ["ndvi", "aoi", "sentinel", "vegetation", "satellite", "soil", "index", "dashboard", "map", "yield", "t/ha", "bsi"];
        if (
            !aiMsg ||
            (!keywords.some(k => aiMsg.toLowerCase().includes(k)) 
            && !q.toLowerCase().includes("dashboard") && aiMsg.length < 140)
        ) {
            aiBody.lastElementChild.textContent = 
                "AI: I am specialized in agricultural analytics. Please ask about your Yield, NDVI, or AOI statistics.";
        } else {
            aiBody.lastElementChild.textContent = "AI: " + aiMsg;
        }
    } catch (err) {
        aiBody.lastElementChild.textContent = "AI: I'm having trouble reaching the analytics engine right now.";
    }
    
    aiInput.disabled = false; 
    aiSend.disabled = false; 
    aiInput.focus();
}
// --- Chart & Overlay Logic ---
    makeDraggable(document.getElementById("onMapChartContainer"));
document.getElementById('toggleLiveChart').onchange = function() {
        const container = document.getElementById('onMapChartContainer');
        if (this.checked) {
            if (!window.aoiGeojson) {
                showToast("Draw an AOI first!");
                this.checked = false;
                return;
            }
            container.style.display = 'block';
            updateMiniChart();
            fetchStatsData();
        } else {
            container.style.display = 'none';
        }
    };

    document.getElementById('chartDownloadBtn').onclick = function() {
        if (!miniTsChart) return;
        const link = document.createElement('a');
        link.href = miniTsChart.toDataURL("image/png");
        link.download = `Trend_${document.getElementById('indexSelect').value}.png`;
        link.click();
    };

    // RECTIFIED: Stats Button Click Handler
    document.getElementById('statsBtn').onclick = function() {
        if (!window.aoiGeojson) { 
            showToast("Draw AOI first!"); 
            return; 
        }
        // Open the draggable overlay instead of the old modal
        const container = document.getElementById('onMapChartContainer');
        container.style.display = 'block';
        
        // Sync the toggle switch
        document.getElementById('toggleLiveChart').checked = true;
        
        // Load data
        updateMiniChart(); 
        fetchStatsData(); 
    };

    document.getElementById('closeOverlay').onclick = function() {
        document.getElementById('onMapChartContainer').style.display = 'none';
        document.getElementById('toggleLiveChart').checked = false;
    };
});

function makeDraggable(el) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    const header = document.getElementById(el.id + "Header");

    if (header) {
        header.onmousedown = dragMouseDown;
    }

    function dragMouseDown(e) {
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        el.style.top = (el.offsetTop - pos2) + "px";
        el.style.left = (el.offsetLeft - pos1) + "px";
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
    }
}
// RECTIFIED: fetchStatsData to point to the correct UI element
function fetchStatsData() {
    let area = document.getElementById('statsArea');
    area.innerHTML = "Calculating stats..."; // Feedback for the user

    fetch('/stats', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            aoi: window.aoiGeojson, 
            index: document.getElementById('indexSelect').value,
            startDate: document.getElementById('startDate').value,
            endDate: document.getElementById('endDate').value
        })
    })
    .then(res => res.json())
    .then(data => {
        if (data.error) { 
            area.innerHTML = `<span style="color:red">${data.error}</span>`; 
            return; 
        }
        
        let stats = data.stats || {};
        // Accessing keys dynamically based on Earth Engine reducer output
        let meanKey = data.index + "_mean";
        let meanVal = stats[meanKey] !== undefined ? stats[meanKey] : (stats['mean'] || 0);
        
        area.innerHTML = `
            <div style="border-bottom: 1px solid #43d37533; padding-bottom:5px; margin-bottom:5px;">
                <b>${data.index}</b>: ${Number(meanVal).toFixed(3)}
            </div>
            <div style="font-size:11px; opacity:0.8;">
                Area: ${data.area_ha} ha
            </div>
        `;
    })
    .catch(err => {
        area.innerHTML = "Error loading stats.";
    });
}
// RECTIFIED: updateMiniChart for better sizing
function updateMiniChart() {
    const selectedIndex = document.getElementById('indexSelect').value;
    const canvas = document.getElementById('miniTsChart');
    
    fetch('/timeseries', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ 
            aoi: window.aoiGeojson, 
            index: selectedIndex, 
            startDate: document.getElementById('startDate').value, 
            endDate: document.getElementById('endDate').value 
        })
    })
    .then(r => r.json())
    .then(d => {
        let ctx = canvas.getContext('2d');
        if (miniTsChart) miniTsChart.destroy();
        
        // Force canvas to fill container
        canvas.style.width = '100%';
        canvas.style.height = '100%';

        miniTsChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: d.series.map(x => x.date),
                datasets: [{
                    label: selectedIndex,
                    data: d.series.map(x => x.value),
                    borderColor: '#43d375',
                    backgroundColor: 'rgba(67, 211, 117, 0.1)',
                    borderWidth: 2,
                    pointRadius: 3,
                    tension: 0.3,
                    fill: true
                }]
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false, // Critical for fixed-height containers
                plugins: { 
                    legend: { display: false } // Save space in small overlay
                },
                scales: {
                    y: { 
                        ticks: { color: '#ccc', font: { size: 10 } },
                        grid: { color: 'rgba(255,255,255,0.05)' }
                    },
                    x: { 
                        ticks: { color: '#ccc', font: { size: 10 } },
                        grid: { display: false }
                    }
                }
            }
        });
    });
}
function runAnalysis() {
        let selectedIndex = document.getElementById('indexSelect').value;
        let start = document.getElementById('startDate').value;
        let end = document.getElementById('endDate').value;
        let ramp = getColorRamp();
        showSpinner('Running analysis...');
        let vMin = parseFloat(document.getElementById('visMin').value);
        let vMax = parseFloat(document.getElementById('visMax').value);
        
// Override parameters if "SATELLITE" is selected
        let params = {
        aoi: aoiGeojson,
        index: selectedIndex,
        startDate: start,
        endDate: end,
        min: vMin,
        max: vMax,
        colorRamp: ramp
        };

        if (selectedIndex === "SATELLITE") {
        params.min = 0.0;
        params.max = 0.3; // Standard reflectance stretch for True Color
        params.colorRamp = null; // No palette for RGB images
        }

        showSpinner('Fetching Imagery...');
        fetch('/get_tiles', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(params)
        })

        .then(response => response.json())
        .then(data => {
            hideSpinner();
            if (data.tile_url) {
                addLeafletAnalysis(data.tile_url);
                addCesiumAnalysis(data.tile_url);
                showToast("Analysis complete! Hover AOI for values.");
            } else if (data.error) {
                showToast(data.error, 3400);
            } else {
                showToast("Error: Could not fetch map tiles", 3200);
            }
        })
        .catch(err => {
            hideSpinner();
            showToast('Analysis failed: ' + err, 2800);
        });
    }
