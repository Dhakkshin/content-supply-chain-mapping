// Import the necessary Firebase functions from the SDKs
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { getFirestore, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";

// --- ⚠️ CRITICAL CONFIGURATION ⚠️ ---
// TODO: Replace with your actual Firebase project configuration.
const firebaseConfig = {
  apiKey: "AIzaSyDij_eZ-paBlxuTnRA53X8oZK4TxRjZ3WQ",
  authDomain: "cscm-id.firebaseapp.com",
  projectId: "cscm-id",
  storageBucket: "cscm-id.firebasestorage.app",
  messagingSenderId: "613113904857",
  appId: "1:613113904857:web:b2ca12fd1de1655de808c8",
  measurementId: "G-PYB4H2THSE"
};

const CLOUD_FUNCTION_URL = "https://asia-south1-cscm-id.cloudfunctions.net/analyze-supply-chain";
// ------------------------------------

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- DOM Element References ---
const urlInput = document.getElementById('urlInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const btnText = document.getElementById('btnText');
const btnSpinner = document.getElementById('btnSpinner');
const resultsSection = document.getElementById('resultsSection');
const statusText = document.getElementById('statusText');
const assetList = document.getElementById('assetList');
const summaryStats = document.getElementById('summaryStats');

// --- State Variables ---
let currentMapLayers = []; // To manage all layers (markers, lines, etc.)
let userLocation = null; // To store the user's coordinates

// --- Map Initialization ---
const map = L.map('map').setView([20, 0], 2);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
}).addTo(map);

// --- Main Application Logic ---

// Get user's location as soon as the page loads.
navigator.geolocation.getCurrentPosition(position => {
    userLocation = [position.coords.latitude, position.coords.longitude];
    console.log("User location found:", userLocation);
    // Add a marker for the user's location (e.g., Coimbatore)
    L.marker(userLocation, { icon: createHomeIcon() }).addTo(map)
      .bindPopup("Your Location")
      .openPopup();
    map.setView(userLocation, 5);
}, () => {
    // Fallback if user denies location access
    console.log("Geolocation denied. Using fallback.");
    userLocation = [11.0168, 76.9558]; // Fallback to Coimbatore
    L.marker(userLocation, { icon: createHomeIcon() }).addTo(map)
      .bindPopup("Your Approx. Location");
});

analyzeBtn.addEventListener('click', async () => {
    const targetUrl = urlInput.value;
    if (!targetUrl || !targetUrl.startsWith('http')) {
        alert('Please enter a full, valid URL (e.g., https://...)');
        return;
    }

    resetUI();
    resultsSection.style.opacity = '1';
    
    // Animate button state
    btnText.textContent = 'Analyzing...';
    btnSpinner.classList.remove('hidden');
    analyzeBtn.disabled = true;

    try {
        statusText.textContent = "Contacting analysis server...";
        const response = await fetch(CLOUD_FUNCTION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: targetUrl }),
        });

        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        
        const data = await response.json();
        if (!data.analysis_id) throw new Error("Invalid response from server.");
        
        statusText.textContent = "Waiting for analysis data...";
        setupFirestoreListener(data.analysis_id);

    } catch (error) {
        handleError(error.message);
    }
});

function setupFirestoreListener(analysisId) {
    const docRef = doc(db, "analyses", analysisId);

    onSnapshot(docRef, (docSnap) => {
        if (!docSnap.exists()) return;
        const data = docSnap.data();
        
        updateStatus(data.status);
        
        if (data.assets && data.assets.length > 0) {
            renderAssets(data.assets);
        }

        if (data.status === 'completed' || data.status === 'error') {
            btnText.textContent = 'Analyze';
            btnSpinner.classList.add('hidden');
            analyzeBtn.disabled = false;
        }
    });
}

function renderAssets(assets) {
    const locations = {};
    assets.forEach(asset => {
        const key = asset.ip;
        if (!locations[key]) {
            locations[key] = {
                details: { ...asset },
                assets: []
            };
        }
        locations[key].assets.push(asset);
    });

    clearMap();
    assetList.innerHTML = '';
    const bounds = userLocation ? [userLocation] : [];

    for (const ip in locations) {
        const loc = locations[ip];
        const serverCoords = [loc.details.lat, loc.details.lon];
        
        if (serverCoords[0] && serverCoords[1]) {
            // 1. Add color-coded lines
            if(userLocation) {
                const color = getColorForISP(loc.details.isp);
                const polyline = L.polyline([userLocation, serverCoords], { color: color, weight: 2, opacity: 0.7 }).addTo(map);
                currentMapLayers.push(polyline);
            }
            
            // 2. Add server markers
            const marker = L.marker(serverCoords).addTo(map);
            marker.bindPopup(`<b>${loc.details.city}, ${loc.details.country}</b><br>${loc.details.isp}<br>${loc.assets.length} assets`);
            currentMapLayers.push(marker);
            bounds.push(serverCoords);
        }

        // 3. Build the asset list
        assetList.appendChild(createLocationCard(loc));
    }
    
    // Fit map to show all points
    if (bounds.length > 0) {
        map.flyToBounds(bounds, { padding: L.point(50, 50) });
    }

    summaryStats.innerHTML = `
        <p class="font-semibold">${assets.length} Assets</p>
        <p class="text-sm text-slate-500">from ${Object.keys(locations).length} Servers</p>
    `;
}

// --- UI Helper Functions ---

function createLocationCard(locationData) {
    const card = document.createElement('div');
    card.className = 'border-t border-slate-200 pt-4 animate-fade-in';
    
    const title = document.createElement('h3');
    title.className = 'font-bold text-md flex items-center';
    title.innerHTML = `<span class="w-6 text-center mr-2 text-slate-400"><i class="fas fa-server"></i></span> <span>${locationData.details.city}, ${locationData.details.country}</span>`;
    
    const isp = document.createElement('p');
    isp.className = 'ml-8 text-sm text-slate-500';
    isp.textContent = locationData.details.isp;
    
    const list = document.createElement('ul');
    list.className = 'ml-8 mt-2 space-y-1 text-xs';
    
    locationData.assets.slice(0, 5).forEach(asset => { // Show first 5 assets
        const item = document.createElement('li');
        item.className = 'truncate text-slate-600';
        item.innerHTML = `<span class="font-medium bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded text-xs mr-2">${asset.type}</span> <a href="${asset.url}" target="_blank" class="hover:underline">${asset.url}</a>`;
        list.appendChild(item);
    });
    
    if(locationData.assets.length > 5) {
        const more = document.createElement('li');
        more.className = 'text-slate-500 italic ml-4';
        more.textContent = `...and ${locationData.assets.length - 5} more`;
        list.appendChild(more);
    }
    
    card.append(title, isp, list);
    return card;
}

function updateStatus(status) {
    if (!status) return;
    
    if (status.startsWith('found')) {
        statusText.textContent = `Analyzing ${status.split('_')[1]} assets...`;
    } else if (status === 'completed') {
        statusText.textContent = 'Analysis Complete!';
    } else if (status === 'error') {
        statusText.textContent = 'An error occurred.';
    } else {
        statusText.textContent = status.charAt(0).toUpperCase() + status.slice(1) + '...';
    }
}

function resetUI() {
    resultsSection.style.opacity = '0';
    statusText.textContent = 'Preparing analysis...';
    assetList.innerHTML = '';
    summaryStats.innerHTML = '';
    clearMap();
    
    // This is the FIX for the partially loaded map!
    // It tells Leaflet to re-check its size after the container becomes visible.
    setTimeout(() => map.invalidateSize(), 100);
}

function handleError(message) {
    statusText.textContent = `Error: ${message}`;
    btnText.textContent = 'Analyze';
    btnSpinner.classList.add('hidden');
    analyzeBtn.disabled = false;
}

function clearMap() {
    currentMapLayers.forEach(layer => map.removeLayer(layer));
    currentMapLayers = [];
    if(userLocation) { // Re-add home marker
       L.marker(userLocation, { icon: createHomeIcon() }).addTo(map).bindPopup("Your Location");
    }
}

function createHomeIcon() {
    return L.divIcon({
        html: '<i class="fas fa-street-view text-blue-600 text-2xl"></i>',
        className: 'bg-transparent',
        iconSize: [24, 24],
        iconAnchor: [12, 24]
    });
}

function getColorForISP(isp) {
    if (!isp) return '#64748b'; // slate-500
    const lowerIsp = isp.toLowerCase();
    if (lowerIsp.includes('google')) return '#3b82f6'; // blue-500
    if (lowerIsp.includes('cloudflare')) return '#f97316'; // orange-500
    if (lowerIsp.includes('amazon') || lowerIsp.includes('aws')) return '#f59e0b'; // amber-500
    if (lowerIsp.includes('fastly')) return '#ef4444'; // red-500
    if (lowerIsp.includes('microsoft') || lowerIsp.includes('azure')) return '#0ea5e9'; // sky-500
    return '#64748b';
}

