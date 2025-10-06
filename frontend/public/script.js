// Import the necessary Firebase functions from the SDKs
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { getFirestore, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";

// --- ⚠️ CRITICAL CONFIGURATION ⚠️ ---
const firebaseConfig = {
  apiKey: "AIzaSyDij_eZ-paBlxuTnRA53X8oZK4TxRjZ3WQ",
  authDomain: "cscm-id.firebaseapp.com",
  projectId: "cscm-id",
  storageBucket: "cscm-id.firebasestorage.app",
  messagingSenderId: "613113904857",
  appId: "1:613113904857:web:b2ca12fd1de1655de808c8",
  measurementId: "G-PYB4H2THSE"
};
const CLOUD_FUNCTION_URL = "https://asia-south1-cscm-id.cloudfunctions.net/analyze-web-footprint";
// ------------------------------------

// Data for DNS Latency Heatmap
const DNS_RESOLVER_LOCATIONS = { "Google (USA)": { lat: 37.751, lon: -97.822 }, "Cloudflare (USA)": { lat: 37.751, lon: -97.822 }, "Quad9 (Switzerland)": { lat: 47.3769, lon: 8.5417 }, "OpenDNS (USA)": { lat: 37.751, lon: -97.822 }, "Comodo (USA)": { lat: 39.0438, lon: -77.4874 }, "Yandex (Russia)": { lat: 55.7558, lon: 37.6173 }, "DNS.WATCH (Germany)": { lat: 52.5200, lon: 13.4050 }, "Level3 (USA)": { lat: 39.8617, lon: -104.6737 }, "Neustar (USA)": { lat: 39.0438, lon: -77.4874 }, "AdGuard (Cyprus)": { lat: 35.1264, lon: 33.4299 }};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- DOM Element References ---
const urlInput = document.getElementById('urlInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const resultsSection = document.getElementById('resultsSection');
const statusText = document.getElementById('statusText');
const detailsPanel = document.getElementById('detailsPanel');
const mapTitle = document.getElementById('mapTitle');
const listTitle = document.getElementById('listTitle');
const tabButtons = document.querySelectorAll('.tab-btn');
const animationControls = document.getElementById('animationControls');
const replayBtn = document.getElementById('replayBtn');

// --- State Variables ---
let currentMapLayers = [];
let currentAnalysisData = null;
let currentView = 'loadingJourney';
let userLocation = null;
let unsubscribeFirestore = null;
let animationTimeoutId = null; // ID for the current animation sequence

// --- Map Initialization ---
const map = L.map('map').setView([20, 0], 2);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { attribution: '&copy; <a href="https://openstreetmap.org">OSM</a> &copy; <a href="https://carto.com">CARTO</a>' }).addTo(map);

// --- Geolocation ---
function getUserLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => { userLocation = [position.coords.latitude, position.coords.longitude]; },
            () => { console.warn("User denied geolocation. Using fallback."); userLocation = [20, 0]; }
        );
    } else {
        userLocation = [20, 0]; // Fallback location
    }
}
getUserLocation();

// --- Main Application Logic & Event Listeners ---

analyzeBtn.addEventListener('click', async () => {
    const targetUrl = urlInput.value;
    if (!targetUrl || !targetUrl.startsWith('http')) return alert('Please enter a full URL.');
    resetUI();
    resultsSection.style.opacity = '1';
    analyzeBtn.disabled = true;
    document.getElementById('btnText').textContent = 'Analyzing...';
    document.getElementById('btnSpinner').classList.remove('hidden');
    try {
        statusText.textContent = "Contacting analysis orchestrator...";
        const response = await fetch(CLOUD_FUNCTION_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: targetUrl }),
        });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        const data = await response.json();
        setupFirestoreListener(data.analysis_id);
    } catch (error) {
        statusText.textContent = `Error: ${error.message}`;
        analyzeBtn.disabled = false;
        document.getElementById('btnText').textContent = 'Analyze';
        document.getElementById('btnSpinner').classList.add('hidden');
    }
});

tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) return;
        stopAnimation();
        currentView = btn.dataset.view;
        tabButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (currentAnalysisData) renderCurrentView();
    });
});

replayBtn.addEventListener('click', () => {
    if (currentAnalysisData && currentAnalysisData.assets) {
        stopAnimation();
        clearVisuals();
        setupLoadingJourney(currentAnalysisData.assets);
    }
});

function setupFirestoreListener(analysisId) {
    if (unsubscribeFirestore) unsubscribeFirestore();
    const docRef = doc(db, "analyses", analysisId);
    unsubscribeFirestore = onSnapshot(docRef, (docSnap) => {
        if (!docSnap.exists()) return;
        currentAnalysisData = docSnap.data();
        renderCurrentView();
        updateStatus(currentAnalysisData);
    });
}

function renderCurrentView() {
    if (!currentAnalysisData) return;
    clearVisuals();
    animationControls.classList.add('hidden');
    switch (currentView) {
        case 'loadingJourney':
            mapTitle.textContent = 'Geographic Loading Journey';
            listTitle.textContent = 'Asset Origins';
            setupLoadingJourney(currentAnalysisData.assets);
            break;
        case 'densityHeatmap':
            mapTitle.textContent = 'Infrastructure Density Heatmap';
            listTitle.textContent = 'Infrastructure Hot Zones';
            renderDensityHeatmapView(currentAnalysisData.assets);
            break;
        case 'dnsLatency':
            mapTitle.textContent = 'Global DNS Latency Heatmap';
            listTitle.textContent = 'Resolver Performance';
            renderDnsLatencyView(currentAnalysisData.dns_latency_results);
            break;
    }
    setTimeout(() => map.invalidateSize(), 100);
}

// --- View Rendering Functions ---

function renderDensityHeatmapView(assets = []) {
    const points = assets.filter(a => a.lat && a.lon).map(a => [a.lat, a.lon, 1.0]);
    if (points.length > 0) {
        const heatLayer = L.heatLayer(points, { 
            radius: 35, blur: 25, maxZoom: 12, max: 1.0,
            gradient: {0.4: 'blue', 0.7: 'lime', 0.9: 'yellow', 1.0: 'red'}
        }).addTo(map);
        currentMapLayers.push(heatLayer);
        const bounds = L.latLngBounds(points);
        if (bounds.isValid()) map.flyToBounds(bounds, { padding: L.point(50, 50), maxZoom: 10 });
    }
    const uniqueLocations = new Set(assets.filter(a => a.lat && a.lon).map(a => `${a.city}, ${a.country}`)).size;
    detailsPanel.innerHTML = `<div class="p-2 text-sm text-gray-600">This heatmap visualizes the geographic concentration of the <strong>${uniqueLocations}</strong> unique server locations that make up this website. Red areas indicate a high density of infrastructure.</div>`;
}

function renderDnsLatencyView(results = []) {
    const points = results.map(res => {
        const loc = DNS_RESOLVER_LOCATIONS[res.resolver_name];
        if (!loc) return null;
        const intensity = Math.max(0.1, 1 - (res.latency_ms / 500));
        return [loc.lat, loc.lon, intensity];
    }).filter(p => p !== null);

    if (points.length > 0) {
        const heatLayer = L.heatLayer(points, { 
            radius: 50, blur: 40, maxZoom: 12, max: 1.0,
            gradient: {0.2: '#ef4444', 0.5: '#facc15', 1.0: '#4ade80'} // Red -> Yellow -> Green
        }).addTo(map);
        currentMapLayers.push(heatLayer);
        const bounds = L.latLngBounds(points.map(p => [p[0], p[1]]));
        if (bounds.isValid()) map.flyToBounds(bounds, { padding: L.point(50, 50), maxZoom: 10 });
    }

    detailsPanel.innerHTML = '';
    results.sort((a, b) => a.latency_ms - b.latency_ms).forEach(res => {
        detailsPanel.innerHTML += `<div class="text-sm flex justify-between border-b border-gray-100 py-2 px-2"><p class="font-medium text-gray-900">${res.resolver_name}</p><p class="text-blue-600 font-semibold">${res.latency_ms.toFixed(0)} ms</p></div>`;
    });
}

// --- Geographic Loading Journey Functions ---

function setupLoadingJourney(assets = []) {
    stopAnimation();
    if (!userLocation) {
        detailsPanel.innerHTML = `<div class="p-2 text-sm text-gray-500">Please enable location access to visualize the loading journey.</div>`;
        return;
    }
    const timedAssets = assets.filter(a => a.load_start_time && a.lat && a.lon)
                              .sort((a, b) => a.load_start_time - b.load_start_time);
    
    if (timedAssets.length < 1) {
        detailsPanel.innerHTML = `<div class="p-2 text-sm text-gray-500">No performance data found to build a loading journey.</div>`;
        return;
    }
    
    animationControls.classList.remove('hidden');
    renderStaticAssetList(timedAssets);
    startStaggeredAnimation(timedAssets);
}

function renderStaticAssetList(assets) {
    detailsPanel.innerHTML = '';
    const locations = {};
    assets.forEach(asset => {
        const locKey = `${asset.city}, ${asset.country}`;
        if (!locations[locKey]) {
            locations[locKey] = { details: asset, assets: [] };
        }
        locations[locKey].assets.push(asset);
    });

    Object.keys(locations).sort().forEach(locKey => {
        const locData = locations[locKey];
        const assetsHtml = locData.assets.map(asset => 
            `<div class="flex items-center space-x-2">
                <span class="text-xs font-mono bg-gray-200 text-gray-600 rounded px-1.5 py-0.5">${asset.type}</span>
                <span class="text-xs text-gray-500 truncate" title="${asset.url}">${asset.url}</span>
            </div>`
        ).join('');
        detailsPanel.innerHTML += 
            `<div class="p-3 bg-gray-50 rounded-lg border border-gray-200">
                <p class="font-bold text-gray-800">${locKey}</p>
                <p class="text-xs text-gray-500 mb-2">${locData.details.isp}</p>
                <div class="space-y-1.5">${assetsHtml}</div>
            </div>`;
    });
}

async function startStaggeredAnimation(assets) {
    clearVisuals();
    if (!userLocation) return;
    resetAndRenderUserMarker();

    const serverMarkers = new Map();
    const allServerCoords = [];

    // Pre-process to find all unique server locations and add markers
    assets.forEach(asset => {
        const serverCoords = [asset.lat, asset.lon];
        const serverId = serverCoords.toString();
        if (!serverMarkers.has(serverId)) {
            const marker = L.marker(serverCoords).addTo(map).bindPopup(`<b>${asset.city}</b><br>${asset.isp}`);
            serverMarkers.set(serverId, marker);
            currentMapLayers.push(marker);
            allServerCoords.push(serverCoords);
        }
    });

    // Fit map to user and all server locations
    const bounds = L.latLngBounds([userLocation, ...allServerCoords]);
    if (bounds.isValid()) {
        map.flyToBounds(bounds, { padding: L.point(50, 50), maxZoom: 10 });
    }

    // Animation loop
    for (const asset of assets) {
        const serverCoords = [asset.lat, asset.lon];
        
        // Animate the request path (red, dotted)
        const reqPath = L.polyline([userLocation, serverCoords], { color: '#ef4444', weight: 1.5, className: 'request-path' }).addTo(map);
        
        await new Promise(resolve => {
            animationTimeoutId = setTimeout(() => {
                map.removeLayer(reqPath); // Remove request path
                
                // Animate the response path (green, solid)
                const resPath = L.polyline([userLocation, serverCoords], { color: '#22c55e', weight: 3, className: 'response-path' }).addTo(map);
                currentMapLayers.push(resPath); // Keep response path on map
                
                // Trigger CSS animation
                const totalLength = resPath.getElement().getTotalLength();
                resPath.getElement().style.strokeDasharray = totalLength;
                resPath.getElement().style.strokeDashoffset = totalLength;
                requestAnimationFrame(() => { 
                    resPath.getElement().style.strokeDashoffset = 0;
                });
                
                resolve();
            }, 100); // 100ms delay for each asset step
        });
    }
}


// --- UI Helper Functions ---
function stopAnimation() {
    if (animationTimeoutId) {
        clearTimeout(animationTimeoutId);
        animationTimeoutId = null;
    }
}

function clearVisuals() {
    stopAnimation();
    currentMapLayers.forEach(layer => map.removeLayer(layer));
    currentMapLayers = [];
    // Do not clear the detailsPanel here, as it's populated before the animation starts
}

function resetUI() {
    if (unsubscribeFirestore) {
        unsubscribeFirestore();
        unsubscribeFirestore = null;
    }
    resultsSection.style.opacity = '0';
    statusText.textContent = 'Enter a URL to begin analysis.';
    tabButtons.forEach(b => b.classList.remove('active'));
    document.querySelector('.tab-btn[data-view="loadingJourney"]').classList.add('active');
    currentView = 'loadingJourney';
    clearVisuals();
    detailsPanel.innerHTML = ''; // Clear details panel on full reset
    analyzeBtn.disabled = false;
    document.getElementById('btnText').textContent = 'Analyze';
    document.getElementById('btnSpinner').classList.add('hidden');
}

function resetAndRenderUserMarker() {
    // We only want to clear the lines, not the markers which are now pre-loaded
    currentMapLayers.forEach(layer => {
        if (layer instanceof L.Polyline) {
            map.removeLayer(layer);
        }
    });
    currentMapLayers = currentMapLayers.filter(layer => !(layer instanceof L.Polyline));


    if (userLocation) {
        const userMarker = L.circleMarker(userLocation, { radius: 8, color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 1 }).addTo(map).bindPopup("Your Location");
        currentMapLayers.push(userMarker);
    }
}

function updateStatus(data) { 
    let scStatus = data.status_supply_chain || 'pending';
    let dnsStatus = data.status_dns_latency || 'pending';
    if (scStatus === 'completed' && dnsStatus === 'completed') {
        statusText.textContent = 'Analysis Complete!';
        analyzeBtn.disabled = false;
        document.getElementById('btnText').textContent = 'Analyze';
        document.getElementById('btnSpinner').classList.add('hidden');
    } else {
        statusText.textContent = `Analyzing... [Supply Chain: ${scStatus}] [DNS: ${dnsStatus}]`;
    }
}