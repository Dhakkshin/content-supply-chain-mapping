// Import the necessary Firebase functions from the SDKs
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js";
import { getFirestore, doc, onSnapshot, collection, addDoc, getDocs, orderBy, query } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";

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
const summaryStats = document.getElementById('summaryStats');
const saveAnalysisBtn = document.getElementById('saveAnalysisBtn');
const savedAnalysesBtn = document.getElementById('savedAnalysesBtn');
const savedAnalysesModal = document.getElementById('savedAnalysesModal');
const closeSavedModal = document.getElementById('closeSavedModal');
const savedAnalysesList = document.getElementById('savedAnalysesList');

// New elements for save modal and notifications
const saveAnalysisModal = document.getElementById('saveAnalysisModal');
const closeSaveModal = document.getElementById('closeSaveModal');
const cancelSave = document.getElementById('cancelSave');
const confirmSave = document.getElementById('confirmSave');
const analysisTitle = document.getElementById('analysisTitle');
const notificationToast = document.getElementById('notificationToast');
const toastIcon = document.getElementById('toastIcon');
const toastTitle = document.getElementById('toastTitle');
const toastMessage = document.getElementById('toastMessage');
const closeToast = document.getElementById('closeToast');

// --- State Variables ---
let currentMapLayers = [];
let currentAnalysisData = null;
let currentView = 'loadingJourney';
let animationFrameId = null;
let userLocation = null;
let currentAnalysisId = null;
let selectedAssetId = null; // Track selected asset for highlighting

// Timeline / playback state
let timelineEvents = [];
let timelineIndex = 0;
let isPlaying = false;
let playbackSpeed = 1.0;
let playbackStartReal = 0;
let playbackBaseTime = 0;

// --- Map Initialization ---
const map = L.map('map').setView([20, 0], 2);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://openstreetmap.org">OSM</a> &copy; <a href="https://carto.com">CARTO</a>'
}).addTo(map);

// --- Get User's Location ---
function getUserLocation() {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                userLocation = [position.coords.latitude, position.coords.longitude];
                const userMarker = L.circleMarker(userLocation, { 
                    radius: 8, 
                    color: '#2563eb', 
                    fillColor: '#3b82f6', 
                    fillOpacity: 1 
                }).addTo(map);
                userMarker.bindPopup("Your Location");
                currentMapLayers.push(userMarker);
                map.setView(userLocation, 5);
            },
            () => {
                console.warn("User denied geolocation.");
                // Fallback to Coimbatore, India
                userLocation = [11.0168, 76.9558];
                const userMarker = L.circleMarker(userLocation, { 
                    radius: 8, 
                    color: '#2563eb', 
                    fillColor: '#3b82f6', 
                    fillOpacity: 1 
                }).addTo(map);
                userMarker.bindPopup("Approximate Location (Coimbatore, India)");
                currentMapLayers.push(userMarker);
                map.setView(userLocation, 5);
            }
        );
    }
}
getUserLocation();

// --- Heat helpers ---
function roundCoord(v, decimals=3) {
    return Math.round(Number(v || 0) * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function groupPointsByLatLon(items, latKey='lat', lonKey='lon') {
    const mapG = new Map();
    for (const it of items) {
        const lat = it[latKey], lon = it[lonKey];
        if (lat == null || lon == null) continue;
        const key = `${roundCoord(lat,3)}:${roundCoord(lon,3)}`;
        const ex = mapG.get(key);
        if (!ex) {
            mapG.set(key, { lat: Number(lat), lon: Number(lon), count: 1, sample: it });
        } else {
            ex.count += 1;
        }
    }
    return Array.from(mapG.values());
}

function normalizeWeights(values, min=0.1, max=1.0) {
    if (!values || values.length === 0) return [];
    const mn = Math.min(...values), mx = Math.max(...values);
    if (mn === mx) return values.map(() => (mn > 0 ? max : min));
    return values.map(v => {
        const t = (v - mn) / (mx - mn);
        return Math.max(min, Math.min(max, t * (max - min) + min));
    });
}

// --- Notification System ---
function showNotification(type, title, message, duration = 5000) {
    // Set icon and colors based on type
    let iconClass, borderColor;
    switch (type) {
        case 'success':
            iconClass = 'fas fa-check-circle text-green-500';
            borderColor = 'border-green-500';
            break;
        case 'error':
            iconClass = 'fas fa-exclamation-circle text-red-500';
            borderColor = 'border-red-500';
            break;
        case 'warning':
            iconClass = 'fas fa-exclamation-triangle text-yellow-500';
            borderColor = 'border-yellow-500';
            break;
        case 'info':
        default:
            iconClass = 'fas fa-info-circle text-blue-500';
            borderColor = 'border-blue-500';
            break;
    }

    // Update toast content
    toastIcon.innerHTML = `<i class="${iconClass}"></i>`;
    toastTitle.textContent = title;
    toastMessage.textContent = message;
    
    // Update border color
    const toastContainer = notificationToast.querySelector('div');
    toastContainer.className = `bg-white ${borderColor} border-l-4 rounded-lg shadow-lg p-4 max-w-sm`;

    // Show toast
    notificationToast.classList.remove('hidden');

    // Auto-hide after duration
    if (duration > 0) {
        setTimeout(() => {
            hideNotification();
        }, duration);
    }
}

function hideNotification() {
    notificationToast.classList.add('hidden');
}

// --- Input Validation ---
function validateUrl(url) {
    if (!url || !url.startsWith('http')) {
        showNotification('error', 'Invalid URL', 'Please enter a full URL (e.g., https://www.example.com)');
        return false;
    }
    return true;
}

// --- Main Application Logic ---
analyzeBtn.addEventListener('click', async () => {
    const targetUrl = urlInput.value.trim();
    if (!validateUrl(targetUrl)) return;
    
    resultsSection.classList.remove('hidden');
    resetUI();
    resultsSection.style.opacity = '1';
    analyzeBtn.disabled = true;

    try {
        statusText.textContent = "Contacting analysis orchestrator...";
        const response = await fetch(CLOUD_FUNCTION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: targetUrl }),
        });
        
        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        
        const data = await response.json();
        if (!data.analysis_id) throw new Error("No analysis ID returned");
        
        statusText.textContent = `Analysis started (ID: ${data.analysis_id})...`;
        setupFirestoreListener(data.analysis_id);
    } catch (error) {
        statusText.textContent = `Error: ${error.message}`;
        analyzeBtn.disabled = false;
        showNotification('error', 'Analysis Failed', error.message);
    }
});

// --- Save Analysis Functionality ---
function openSaveModal() {
    if (!currentAnalysisData || !currentAnalysisId) {
        showNotification('warning', 'No Data', 'No analysis data to save!');
        return;
    }

    // Pre-fill the title input
    analysisTitle.value = `Analysis of ${currentAnalysisData.target_url}`;
    saveAnalysisModal.classList.remove('hidden');
    analysisTitle.focus();
    analysisTitle.select();
}

function closeSaveModalFunc() {
    saveAnalysisModal.classList.add('hidden');
    analysisTitle.value = '';
}

async function saveCurrentAnalysis() {
    const title = analysisTitle.value.trim();
    if (!title) {
        showNotification('warning', 'Title Required', 'Please enter a title for this analysis');
        analysisTitle.focus();
        return;
    }

    try {
        // Use Firestore serverTimestamp instead of JavaScript Date
        const { serverTimestamp } = await import("https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js");
        
        const savedAnalysis = {
            title: title,
            originalId: currentAnalysisId,
            target_url: currentAnalysisData.target_url,
            assets: currentAnalysisData.assets || [],
            dns_latency_results: currentAnalysisData.dns_latency_results || [],
            savedAt: serverTimestamp(),
            assetCount: currentAnalysisData.assets?.length || 0,
            countryCount: new Set(currentAnalysisData.assets?.map(a => a.country).filter(c => c)).size
        };

        console.log("Attempting to save analysis:", savedAnalysis);
        const docRef = await addDoc(collection(db, 'savedAnalyses'), savedAnalysis);
        console.log("Analysis saved with ID:", docRef.id);
        
        closeSaveModalFunc();
        showNotification('success', 'Analysis Saved', 'Your analysis has been saved successfully!');
        
    } catch (error) {
        console.error('Detailed error saving analysis:', error);
        
        // Fallback: try with regular timestamp if serverTimestamp fails
        try {
            console.log("Trying fallback save method...");
            const savedAnalysis = {
                title: title,
                originalId: currentAnalysisId,
                target_url: currentAnalysisData.target_url,
                assets: currentAnalysisData.assets || [],
                dns_latency_results: currentAnalysisData.dns_latency_results || [],
                savedAt: new Date().toISOString(),
                assetCount: currentAnalysisData.assets?.length || 0,
                countryCount: new Set(currentAnalysisData.assets?.map(a => a.country).filter(c => c)).size
            };
            
            const docRef = await addDoc(collection(db, 'savedAnalyses'), savedAnalysis);
            console.log("Fallback save successful with ID:", docRef.id);
            
            closeSaveModalFunc();
            showNotification('success', 'Analysis Saved', 'Your analysis has been saved successfully!');
            
        } catch (fallbackError) {
            console.error('Fallback save also failed:', fallbackError);
            showNotification('error', 'Save Failed', 
                `Failed to save analysis: ${fallbackError.message}. This might be due to Firestore security rules.`);
        }
    }
}

// --- Save Analysis Modal Event Handlers ---
saveAnalysisBtn.addEventListener('click', openSaveModal);
closeSaveModal.addEventListener('click', closeSaveModalFunc);
cancelSave.addEventListener('click', closeSaveModalFunc);
confirmSave.addEventListener('click', saveCurrentAnalysis);
closeToast.addEventListener('click', hideNotification);

// Handle Enter key in save modal
analysisTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        saveCurrentAnalysis();
    }
});

// Close modals when clicking outside
saveAnalysisModal.addEventListener('click', (e) => {
    if (e.target === saveAnalysisModal) {
        closeSaveModalFunc();
    }
});

// --- Saved Analyses Functionality ---
async function loadSavedAnalyses() {
    try {
        console.log("Loading saved analyses...");
        const q = query(collection(db, 'savedAnalyses'), orderBy('savedAt', 'desc'));
        const querySnapshot = await getDocs(q);
        
        console.log("Query completed, docs found:", querySnapshot.size);
        
        if (querySnapshot.empty) {
            savedAnalysesList.innerHTML = '<div class="text-center text-gray-500">No saved analyses found.</div>';
            return;
        }

        let html = '<div class="grid gap-4">';
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            console.log("Processing saved analysis:", data);
            
            // Handle different timestamp formats
            let savedDate = 'Unknown date';
            try {
                if (data.savedAt) {
                    if (typeof data.savedAt === 'string') {
                        savedDate = new Date(data.savedAt).toLocaleDateString();
                    } else if (data.savedAt.toDate) {
                        savedDate = data.savedAt.toDate().toLocaleDateString();
                    } else if (data.savedAt.seconds) {
                        savedDate = new Date(data.savedAt.seconds * 1000).toLocaleDateString();
                    }
                }
            } catch (e) {
                console.warn("Error parsing date:", e);
            }
            
            html += `
                <div class="border rounded-lg p-4 hover:bg-gray-50 cursor-pointer transition-colors" data-analysis-id="${doc.id}">
                    <div class="flex justify-between items-start mb-2">
                        <h3 class="font-semibold text-lg">${data.title || 'Untitled Analysis'}</h3>
                        <span class="text-sm text-gray-500">${savedDate}</span>
                    </div>
                    <p class="text-gray-600 mb-2">${data.target_url || 'Unknown URL'}</p>
                    <div class="flex gap-4 text-sm text-gray-500">
                        <span><i class="fas fa-server mr-1"></i>${data.assetCount || 0} assets</span>
                        <span><i class="fas fa-globe mr-1"></i>${data.countryCount || 0} countries</span>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        savedAnalysesList.innerHTML = html;

        // Add click handlers
        savedAnalysesList.querySelectorAll('[data-analysis-id]').forEach(item => {
            item.addEventListener('click', () => {
                const analysisId = item.dataset.analysisId;
                loadSavedAnalysis(analysisId, querySnapshot);
            });
        });
    } catch (error) {
        console.error('Error loading saved analyses:', error);
        savedAnalysesList.innerHTML = `<div class="text-center text-red-500">Failed to load saved analyses: ${error.message}</div>`;
        showNotification('error', 'Load Failed', `Failed to load saved analyses: ${error.message}`);
    }
}

function loadSavedAnalysis(savedId, querySnapshot) {
    const doc = Array.from(querySnapshot.docs).find(d => d.id === savedId);
    if (!doc) {
        showNotification('error', 'Analysis Not Found', 'The selected analysis could not be loaded.');
        return;
    }

    const data = doc.data();
    currentAnalysisData = {
        target_url: data.target_url,
        assets: data.assets,
        dns_latency_results: data.dns_latency_results,
        status_supply_chain: 'completed',
        status_dns_latency: 'completed'
    };
    currentAnalysisId = data.originalId;
    
    // DEBUG: Log the data structure
    console.log("🔥 LOADED ANALYSIS DATA:", currentAnalysisData);
    console.log("🔥 Assets length:", currentAnalysisData.assets?.length);
    console.log("🔥 Sample asset:", currentAnalysisData.assets?.[0]);
    
    // Use the unified display function
    displayAnalysisData(currentAnalysisData, false); // false = don't show save button
    
    savedAnalysesModal.classList.add('hidden');
    showNotification('success', 'Analysis Loaded', `Loaded analysis: ${data.title}`);
}

// --- UI helpers ---
function clearVisuals() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    currentMapLayers.forEach(layer => map.removeLayer(layer));
    currentMapLayers = [];
    if (detailsPanel) detailsPanel.innerHTML = '';
    
    // Remove playback controls
    const existingControls = document.getElementById('playbackControls');
    if (existingControls) existingControls.remove();
    
    // Re-add user location marker and ensure map is properly positioned
    if (userLocation) {
        const userMarker = L.circleMarker(userLocation, {
            radius: 8,
            color: '#2563eb',
            fillColor: '#3b82f6',
            fillOpacity: 1
        }).addTo(map).bindPopup("Your Location");
        currentMapLayers.push(userMarker);
        
        // Set a reasonable default view, but don't force it - let individual render functions set better bounds
        map.setView(userLocation, 3);
    } else {
        // If no user location, set a global view
        map.setView([20, 0], 2);
    }
}

function resetUI() {
    resultsSection.style.opacity = '0';
    statusText.textContent = 'Enter a URL to begin analysis.';
    tabButtons.forEach(b => {
        b.classList.remove('active', 'bg-blue-600', 'text-white');
        b.classList.add('bg-slate-100', 'text-slate-800');
    });
    document.querySelector('.tab-btn[data-view="loadingJourney"]').classList.remove('bg-slate-100', 'text-slate-800');
    document.querySelector('.tab-btn[data-view="loadingJourney"]').classList.add('active', 'bg-blue-600', 'text-white');
    currentView = 'loadingJourney';
    clearVisuals();
    setTimeout(() => map.invalidateSize(), 500);
}

function updateStatus(data) {
    console.log("Updating status with data:", data);
    
    let scStatus = data.status_supply_chain || 'pending';
    let dnsStatus = data.status_dns_latency || 'pending';
    
    // Handle different status formats from backend
    if (typeof scStatus === 'string' && scStatus.includes('found_') && scStatus.includes('_assets')) {
        statusText.textContent = `Found ${scStatus.split('_')[1]} assets, analyzing locations...`;
    } else if (scStatus === 'completed' && dnsStatus === 'completed') {
        statusText.textContent = 'Analysis Complete!';
        analyzeBtn.disabled = false;
        saveAnalysisBtn.classList.remove('hidden'); // Show save button
        
        // Update summary stats
        if (summaryStats && data.assets) {
            const uniqueCountries = new Set(data.assets.map(a => a.country).filter(c => c));
            summaryStats.innerHTML = `
                <p class="font-semibold">${data.assets.length} Assets</p>
                <p class="text-sm text-slate-500">from ${uniqueCountries.size} Countries</p>
            `;
        }
    } else if (scStatus === 'completed' && dnsStatus !== 'completed') {
        statusText.textContent = `Supply chain analysis complete. Measuring DNS latency...`;
    } else if (scStatus !== 'completed' && dnsStatus === 'completed') {
        statusText.textContent = `DNS analysis complete. Finalizing supply chain...`;
    } else {
        // Show current status
        const scText = scStatus === 'running' ? 'Running' : (scStatus === 'completed' ? 'Complete' : 'Pending');
        const dnsText = dnsStatus === 'running' ? 'Running' : (dnsStatus === 'completed' ? 'Complete' : 'Pending');
        statusText.textContent = `Analyzing... [Supply Chain: ${scText}] [DNS: ${dnsText}]`;
        
        // If we have assets but analysis isn't complete, show partial results
        if (data.assets && data.assets.length > 0) {
            statusText.textContent += ` - Found ${data.assets.length} assets`;
            renderCurrentView();
        }
    }
}

// --- Playback controls ---
function ensurePlaybackControls() {
    const existingControls = document.getElementById('playbackControls');
    if (existingControls) existingControls.remove();
    
    const controls = document.createElement('div');
    controls.id = 'playbackControls';
    controls.className = 'ml-4 inline-flex items-center gap-2';

    const playBtn = document.createElement('button');
    playBtn.id = 'playPauseBtn';
    playBtn.className = 'px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700';
    playBtn.innerHTML = '<i class="fas fa-play mr-1"></i> Play';
    controls.appendChild(playBtn);

    const replayBtn = document.createElement('button');
    replayBtn.id = 'replayBtn';
    replayBtn.className = 'px-3 py-1 bg-slate-100 text-slate-800 rounded text-sm hover:bg-slate-200';
    replayBtn.innerHTML = '<i class="fas fa-redo mr-1"></i> Replay';
    controls.appendChild(replayBtn);

    const speedSel = document.createElement('select');
    speedSel.id = 'speedSel';
    speedSel.className = 'text-sm rounded border px-2 py-1';
    ['0.5x', '1x', '1.5x', '2x'].forEach(s => {
        const o = document.createElement('option');
        o.value = parseFloat(s.replace('x', ''));
        o.textContent = s;
        if (s === '1x') o.selected = true;
        speedSel.appendChild(o);
    });
    controls.appendChild(speedSel);

    if (mapTitle) mapTitle.appendChild(controls);

    playBtn.addEventListener('click', () => {
        if (!isPlaying) startPlayback();
        else pausePlayback();
    });
    
    replayBtn.addEventListener('click', replayJourney);
    
    speedSel.addEventListener('change', (e) => {
        playbackSpeed = parseFloat(e.target.value);
        if (isPlaying) {
            playbackBaseTime = getTimelineTime();
            playbackStartReal = performance.now();
        }
    });
}

// --- Timeline builder ---
function buildTimelineFromAssets(assets) {
    const events = [];
    for (const a of assets) {
        if (!a.lat || !a.lon) continue;
        const coords = [a.lat, a.lon];
        const color = getColorForISP(a.isp || a.hostname || a.ip);
        const start = a.load_start_time != null ? Number(a.load_start_time) : null;
        const end = a.load_end_time != null ? Number(a.load_end_time) : null;
        const estEnd = (start != null && end == null) ? (start + (a.load_duration_ms || 100)) : end;
        const id = a.ip || a.hostname || a.url || Math.random().toString(36).slice(2);
        
        if (start != null) {
            events.push({ time: start, type: 'request', asset: a, coords, color, id });
        }
        if (estEnd != null) {
            events.push({ 
                time: Math.max(estEnd, (start || 0) + 10), 
                type: 'response', 
                asset: a, 
                coords, 
                color, 
                id 
            });
        }
    }
    events.sort((x, y) => x.time - y.time);
    return events;
}

function getTimelineTime() {
    if (!isPlaying) return playbackBaseTime;
    const elapsed = (performance.now() - playbackStartReal) * playbackSpeed;
    return playbackBaseTime + elapsed;
}

function startPlayback() {
    if (timelineEvents.length === 0) return;
    if (!isPlaying) {
        isPlaying = true;
        playbackStartReal = performance.now();
        if (playbackBaseTime === 0 && timelineIndex === 0) {
            playbackBaseTime = timelineEvents[0].time;
        }
        const btn = document.getElementById('playPauseBtn');
        if (btn) btn.innerHTML = '<i class="fas fa-pause mr-1"></i> Pause';
        tickPlayback();
    }
}

function pausePlayback() {
    if (!isPlaying) return;
    playbackBaseTime = getTimelineTime();
    isPlaying = false;
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.innerHTML = '<i class="fas fa-play mr-1"></i> Play';
}

function replayJourney() {
    clearVisuals();
    if (userLocation) {
        const userMarker = L.circleMarker(userLocation, {
            radius: 8,
            color: '#2563eb',
            fillColor: '#3b82f6',
            fillOpacity: 1
        }).addTo(map).bindPopup("Your Location");
        currentMapLayers.push(userMarker);
    }
    timelineIndex = 0;
    playbackBaseTime = timelineEvents.length ? timelineEvents[0].time : 0;
    playbackStartReal = performance.now();
    isPlaying = true;
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.innerHTML = '<i class="fas fa-pause mr-1"></i> Pause';
    tickPlayback();
}

const activeRequestLines = {};

function tickPlayback() {
    if (!isPlaying) return;
    const nowTimeline = getTimelineTime();
    
    while (timelineIndex < timelineEvents.length && timelineEvents[timelineIndex].time <= nowTimeline) {
        processTimelineEvent(timelineEvents[timelineIndex]);
        timelineIndex++;
    }
    
    if (timelineIndex >= timelineEvents.length) {
        isPlaying = false;
        const btn = document.getElementById('playPauseBtn');
        if (btn) btn.innerHTML = '<i class="fas fa-play mr-1"></i> Play';
        return;
    }
    
    animationFrameId = requestAnimationFrame(tickPlayback);
}

function processTimelineEvent(ev) {
    if (!ev.coords || !userLocation) return;
    const color = ev.color || '#64748b';
    
    if (ev.type === 'request') {
        const reqLine = L.polyline([userLocation, ev.coords], {
            color,
            weight: 2,
            opacity: 0.7,
            dashArray: '6,8'
        }).addTo(map);
        
        const mk = L.circleMarker(ev.coords, {
            radius: 5,
            color,
            fillColor: color,
            fillOpacity: 0.9
        }).addTo(map);
        
        currentMapLayers.push(reqLine, mk);
        activeRequestLines[ev.id] = { requestLayer: reqLine, requestMarker: mk, responseLayer: null };
    } else if (ev.type === 'response') {
        const respLine = L.polyline([userLocation, ev.coords], {
            color,
            weight: 3,
            opacity: 0.95
        }).addTo(map);
        
        const respMarker = L.marker(ev.coords).addTo(map);
        respMarker.bindPopup(`<b>${ev.asset.city || 'Server'}</b><br>${ev.asset.isp || ''}<br>${ev.asset.ip || ''}`);
        
        currentMapLayers.push(respLine, respMarker);
        
        const existing = activeRequestLines[ev.id];
        if (existing && existing.requestLayer) {
            existing.requestLayer.setStyle({ opacity: 0.35 });
            existing.responseLayer = respLine;
        } else {
            activeRequestLines[ev.id] = { requestLayer: null, responseLayer: respLine };
        }
    }
}

// Add event handlers (missing from the previous code)
closeSavedModal.addEventListener('click', () => {
    savedAnalysesModal.classList.add('hidden');
});

// Close modal when clicking outside
savedAnalysesModal.addEventListener('click', (e) => {
    if (e.target === savedAnalysesModal) {
        savedAnalysesModal.classList.add('hidden');
    }
});

function getColorForISP(isp) {
    if (!isp) return '#64748b';
    const s = String(isp).toLowerCase();
    if (s.includes('google')) return '#3b82f6';
    if (s.includes('cloudflare')) return '#f97316';
    if (s.includes('amazon') || s.includes('aws')) return '#f59e0b';
    if (s.includes('fastly')) return '#ef4444';
    if (s.includes('microsoft') || s.includes('azure')) return '#0ea5e9';
    return '#64748b';
}

// --- Tab switching (Fixed for visibility) ---
tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        currentView = btn.dataset.view;
        selectedAssetId = null; // Clear selection when switching tabs
        
        tabButtons.forEach(b => {
            b.classList.remove('active', 'bg-blue-600', 'text-white');
            b.classList.add('bg-slate-100', 'text-slate-800');
        });
        btn.classList.remove('bg-slate-100', 'text-slate-800');
        btn.classList.add('active', 'bg-blue-600', 'text-white');
        renderCurrentView();
    });
});

savedAnalysesBtn.addEventListener('click', () => {
    savedAnalysesModal.classList.remove('hidden');
    loadSavedAnalyses();
});

// --- Move renderCurrentView and setupFirestoreListener functions here ---
function renderCurrentView() {
    console.log("🔥 renderCurrentView called, currentView:", currentView);
    console.log("🔥 currentAnalysisData:", currentAnalysisData);
    
    if (!currentAnalysisData) {
        console.log("❌ No analysis data available yet");
        return;
    }
    
    // Only render if we have some data to show
    if (!currentAnalysisData.assets || currentAnalysisData.assets.length === 0) {
        console.log("❌ No assets data available yet");
        return;
    }
    
    console.log("✅ About to render with", currentAnalysisData.assets.length, "assets");
    
    clearVisuals();

    switch (currentView) {
        case 'loadingJourney':
            mapTitle.innerHTML = 'Geographic Loading Journey';
            listTitle.textContent = 'Loading Timeline';
            if (currentAnalysisData.assets) renderLoadingJourneyView(currentAnalysisData.assets);
            break;
        case 'densityHeatmap':
            mapTitle.innerHTML = 'Infrastructure Density Heatmap';
            listTitle.textContent = 'Hot Zones';
            if (currentAnalysisData.assets) renderDensityHeatmapView(currentAnalysisData.assets);
            break;
        case 'dnsLatency':
            mapTitle.innerHTML = 'Global DNS Performance Heatmap';
            listTitle.textContent = 'Resolver Latency';
            if (currentAnalysisData.dns_latency_results) {
                renderDnsLatencyView(currentAnalysisData.dns_latency_results);
            } else {
                detailsPanel.innerHTML = '<div class="text-sm text-gray-500">No DNS latency data available for this saved analysis.</div>';
            }
            break;
    }
}

// --- Unified Analysis Display Function ---
function displayAnalysisData(data, showSaveButton = true) {
    console.log("🔥 displayAnalysisData called with:", data);
    currentAnalysisData = data;
    
    // Show results and update UI
    resultsSection.classList.remove('hidden');
    resultsSection.style.opacity = '1';
    
    // Show/hide save button
    if (showSaveButton) {
        saveAnalysisBtn.classList.remove('hidden');
    } else {
        saveAnalysisBtn.classList.add('hidden');
    }
    
    // Update status and render view
    updateStatus(currentAnalysisData);
    renderCurrentView();
}

function setupFirestoreListener(analysisId) {
    currentAnalysisId = analysisId;
    const docRef = doc(db, "analyses", analysisId);
    
    console.log(`Setting up Firestore listener for analysis: ${analysisId}`);
    
    onSnapshot(docRef, (docSnap) => {
        if (!docSnap.exists()) {
            console.log("Document does not exist yet");
            return;
        }
        
        const data = docSnap.data();
        console.log("🔥 NEW ANALYSIS DATA:", data);
        console.log("🔥 Assets length:", data.assets?.length);
        console.log("🔥 Sample asset:", data.assets?.[0]);
        
        // Use the unified display function
        displayAnalysisData(data, true); // true = show save button for new analysis
    }, (error) => {
        console.error("Firestore listener error:", error);
        statusText.textContent = `Error listening for updates: ${error.message}`;
        showNotification('error', 'Connection Error', `Error listening for updates: ${error.message}`);
    });
}

// --- Density Heatmap (Asset distribution) ---
function renderDensityHeatmapView(assets) {
    const groups = groupPointsByLatLon(assets, 'lat', 'lon');
    
    if (groups.length === 0) {
        // Show basic asset list instead of "no data"
        detailsPanel.innerHTML = `
            <div class="text-sm text-gray-500 mb-4">
                No geolocation data available for heatmap. Showing asset list instead.
            </div>
            <div class="space-y-2 max-h-96 overflow-y-auto">
                ${assets.slice(0, 50).map(asset => `
                    <div class="text-xs border-b pb-2">
                        <p class="font-semibold">${asset.hostname || asset.domain || 'Unknown Host'}</p>
                        <p class="text-gray-600">${asset.isp || 'Unknown ISP'} - ${asset.city || 'Unknown Location'}</p>
                        ${asset.ip ? `<p class="text-gray-500">${asset.ip}</p>` : ''}
                    </div>
                `).join('')}
            </div>
        `;
        return;
    }
    
    const counts = groups.map(g => g.count);
    const weights = normalizeWeights(counts, 0.2, 1.5);
    const heatPoints = groups.map((g, i) => [g.lat, g.lon, weights[i]]);

    try {
        if (typeof L.heatLayer !== 'function') throw new Error('Heat plugin not loaded');
        
        const heatLayer = L.heatLayer(heatPoints, {
            radius: 50,
            blur: 30,
            maxZoom: 12,
            minOpacity: 0.25,
            gradient: { 0.2: 'cyan', 0.45: 'lime', 0.7: 'orange', 1.0: 'red' }
        }).addTo(map);
        currentMapLayers.push(heatLayer);

        const coordsOnly = heatPoints.map(p => [p[0], p[1]]);
        if (userLocation) {
            coordsOnly.push(userLocation);
        }
        map.flyToBounds(coordsOnly, { padding: [50, 50], maxZoom: 6 });

        detailsPanel.innerHTML = `
            <div class="text-sm text-gray-500 mb-4">
                Heat signature shows server concentration. Brighter areas = more servers.
            </div>
            <div class="space-y-2">
                ${groups.slice(0, 20).map(g => `
                    <div class="text-xs border-b pb-2">
                        <p class="font-semibold">${g.sample.city || 'Unknown'}, ${g.sample.country || 'Unknown'}</p>
                        <p class="text-gray-600">${g.sample.isp || 'Unknown ISP'} - ${g.count} assets</p>
                    </div>
                `).join('')}
            </div>
        `;
    } catch (e) {
        console.warn('Heatmap fallback to markers', e);
        groups.forEach((g) => {
            const m = L.circleMarker([g.lat, g.lon], {
                radius: 4 + Math.log(g.count + 1) * 3,
                color: '#ef4444',
                fillColor: '#fb7185',
                fillOpacity: 0.9
            }).addTo(map);
            m.bindPopup(`${g.sample.city || 'Unknown'}<br>${g.count} assets`);
            currentMapLayers.push(m);
        });
        const coordsOnly = groups.map(g => [g.lat, g.lon]);
        if (userLocation) {
            coordsOnly.push(userLocation);
        }
        map.flyToBounds(coordsOnly, { padding: [50, 50], maxZoom: 6 });
    }
}

// --- Loading Journey (Replayable) ---
function renderLoadingJourneyView(assets) {
    // Don't call clearVisuals() here - it's already called by renderCurrentView()
    detailsPanel.innerHTML = '';

    // Always show static markers for all assets with coordinates
    const assetsWithCoords = assets.filter(a => a.lat && a.lon);
    
    assetsWithCoords.forEach(a => {
        const marker = L.marker([a.lat, a.lon]).addTo(map);
        marker.bindPopup(`<b>${a.city || 'Server'}</b><br>${a.isp || a.domain || ''}`);
        currentMapLayers.push(marker);
    });
    
    // Set map bounds to show all markers
    if (assetsWithCoords.length > 0) {
        const coords = assetsWithCoords.map(a => [a.lat, a.lon]);
        if (userLocation) {
            coords.push(userLocation);
        }
        map.flyToBounds(coords, { padding: [50, 50], maxZoom: 10 });
    }

    // Always try to show timeline data, even without user location
    timelineEvents = buildTimelineFromAssets(assets);
    
    if (userLocation && timelineEvents.length > 0) {
        // Full interactive timeline with playback controls
        timelineIndex = 0;
        playbackBaseTime = timelineEvents[0].time;
        isPlaying = false;
        playbackSpeed = 1.0;
        ensurePlaybackControls();
        renderTimelineList();
    } else if (timelineEvents.length > 0) {
        // Static timeline without playback controls (no user location)
        renderStaticTimelineList();
    } else {
        // Fallback: show basic asset list
        renderBasicAssetList(assets);
    }

    const bounds = [userLocation, ...timelineEvents.filter(e => e.coords).map(e => e.coords)];
    map.flyToBounds(bounds, { padding: [50, 50] });
}

function renderTimelineList() {
    const list = document.createElement('div');
    list.className = 'space-y-1 text-xs max-h-96 overflow-y-auto';
    
    // Add controls at the top
    const controlsContainer = document.createElement('div');
    controlsContainer.className = 'mb-4 pb-2 border-b';
    controlsContainer.innerHTML = `
        <div class="flex justify-between items-center mb-2">
            <span class="text-sm font-medium">Timeline Events</span>
            ${selectedAssetId ? `<button id="clearSelection" class="text-xs text-blue-600 hover:underline">Clear Selection</button>` : ''}
        </div>
    `;
    list.appendChild(controlsContainer);

    timelineEvents.slice(0, 200).forEach((ev, idx) => {
        const isSelected = selectedAssetId === ev.id;
        const row = document.createElement('div');
        row.className = `flex justify-between items-center py-1 border-b border-slate-100 cursor-pointer hover:bg-slate-50 ${isSelected ? 'bg-blue-50 border-blue-200' : ''}`;
        row.innerHTML = `
            <div class="truncate flex-1">
                <span class="font-semibold ${ev.type === 'request' ? 'text-blue-600' : 'text-green-600'}">
                    ${ev.type === 'request' ? 'REQ' : 'RES'}
                </span> - ${ev.asset.hostname || ev.asset.url || ev.asset.ip || ''}
            </div>
            <div class="text-slate-500 ml-2">${ev.time.toFixed(0)}ms</div>
        `;
        
        row.addEventListener('click', () => {
            // Toggle selection
            if (selectedAssetId === ev.id) {
                selectedAssetId = null;
                // Resume normal playback view
                renderTimelineList();
                clearVisuals();
                if (userLocation) {
                    const userMarker = L.circleMarker(userLocation, { 
                        radius: 8, color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 1 
                    }).addTo(map).bindPopup("Your Location");
                    currentMapLayers.push(userMarker);
                }
            } else {
                selectedAssetId = ev.id;
                // Highlight this specific asset
                highlightSpecificAsset(ev);
                renderTimelineList(); // Re-render to show selection
            }
        });
        list.appendChild(row);
    });

    // Add clear selection handler
    const clearBtn = list.querySelector('#clearSelection');
    if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedAssetId = null;
            renderTimelineList();
            clearVisuals();
            if (userLocation) {
                const userMarker = L.circleMarker(userLocation, { 
                    radius: 8, color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 1 
                }).addTo(map).bindPopup("Your Location");
                currentMapLayers.push(userMarker);
            }
        });
    }

    detailsPanel.innerHTML = '';
    detailsPanel.appendChild(list);
}

function renderStaticTimelineList() {
    const list = document.createElement('div');
    list.className = 'space-y-1 text-xs max-h-96 overflow-y-auto';
    
    const header = document.createElement('div');
    header.className = 'mb-4 pb-2 border-b';
    header.innerHTML = `
        <div class="text-sm font-medium">Timeline Events</div>
        <div class="text-xs text-gray-500 mt-1">Interactive playback requires location access</div>
    `;
    list.appendChild(header);

    timelineEvents.slice(0, 200).forEach((ev, idx) => {
        const row = document.createElement('div');
        row.className = 'flex justify-between items-center py-1 border-b border-slate-100';
        row.innerHTML = `
            <div class="truncate flex-1">
                <span class="font-semibold ${ev.type === 'request' ? 'text-blue-600' : 'text-green-600'}">
                    ${ev.type === 'request' ? 'REQ' : 'RES'}
                </span> - ${ev.asset.hostname || ev.asset.url || ev.asset.ip || 'Unknown'}
            </div>
            <div class="text-slate-500 ml-2">${ev.time.toFixed(0)}ms</div>
        `;
        list.appendChild(row);
    });

    detailsPanel.innerHTML = '';
    detailsPanel.appendChild(list);
}

function renderBasicAssetList(assets) {
    const list = document.createElement('div');
    list.className = 'space-y-1 text-xs max-h-96 overflow-y-auto';
    
    const header = document.createElement('div');
    header.className = 'mb-4 pb-2 border-b';
    header.innerHTML = `
        <div class="text-sm font-medium" style="color: red;">🔥 FIXED RIGHT PANEL - Assets Found</div>
        <div class="text-xs text-gray-500 mt-1">${assets.length} total assets</div>
    `;
    list.appendChild(header);

    assets.slice(0, 100).forEach((asset, idx) => {
        const row = document.createElement('div');
        row.className = 'flex justify-between items-center py-1 border-b border-slate-100';
        row.innerHTML = `
            <div class="truncate flex-1">
                <span class="font-semibold text-blue-600">${asset.hostname || asset.domain || 'Unknown Host'}</span>
                ${asset.city ? `<br><span class="text-gray-500">${asset.city}, ${asset.country || ''}</span>` : ''}
            </div>
            <div class="text-slate-500 ml-2 text-right">
                ${asset.isp ? `<div>${asset.isp}</div>` : ''}
                ${asset.ip ? `<div class="text-xs">${asset.ip}</div>` : ''}
            </div>
        `;
        list.appendChild(row);
    });

    detailsPanel.innerHTML = '';
    detailsPanel.appendChild(list);
}

function highlightSpecificAsset(event) {
    clearVisuals();
    
    // Add user marker
    if (userLocation) {
        const userMarker = L.circleMarker(userLocation, { 
            radius: 8, color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 1 
        }).addTo(map).bindPopup("Your Location");
        currentMapLayers.push(userMarker);
    }

    // Highlight the selected asset with a prominent line and marker
    if (event.coords && userLocation) {
        const color = event.color || '#ef4444';
        
        // Draw thick highlighted line
        const line = L.polyline([userLocation, event.coords], {
            color,
            weight: 5,
            opacity: 1
        }).addTo(map);
        
        // Add prominent marker
        const marker = L.marker(event.coords).addTo(map);
        marker.bindPopup(`
            <div class="font-bold">${event.asset.city || 'Server'}</div>
            <div>${event.asset.isp || ''}</div>
            <div class="text-sm text-gray-600">${event.asset.url}</div>
            <div class="text-xs text-gray-500">Load time: ${event.time.toFixed(0)}ms</div>
        `).openPopup();
        
        currentMapLayers.push(line, marker);
        
        // Zoom to show user and selected server
        map.flyToBounds([userLocation, event.coords], { padding: [50, 50] });
    }
}

// --- DNS Heatmap ---
function renderDnsLatencyView(results) {
    detailsPanel.innerHTML = '';
    
    if (!results || results.length === 0) {
        detailsPanel.innerHTML = '<div class="text-sm text-gray-500">Waiting for DNS latency results...</div>';
        return;
    }
    
    // Add coordinates for known DNS servers if missing
    const knownDNSLocations = {
        "Google (USA)": { lat: 37.7749, lon: -122.4194 },
        "Cloudflare (USA)": { lat: 37.7749, lon: -122.4194 },
        "Quad9 (Switzerland)": { lat: 47.3769, lon: 8.5417 },
        "OpenDNS (USA)": { lat: 37.7749, lon: -122.4194 },
        "Comodo (USA)": { lat: 40.7128, lon: -74.0060 },
        "Yandex (Russia)": { lat: 55.7558, lon: 37.6176 },
        "DNS.WATCH (Germany)": { lat: 52.5200, lon: 13.4050 },
        "Level3 (USA)": { lat: 39.7392, lon: -104.9903 },
        "Neustar (USA)": { lat: 38.9072, lon: -77.0369 },
        "AdGuard (Cyprus)": { lat: 35.1264, lon: 33.4299 }
    };
    
    // Enrich results with coordinates
    const enrichedResults = results.map(res => {
        if (res.lat != null && res.lon != null) return res;
        const known = knownDNSLocations[res.resolver_name];
        if (known) {
            return { ...res, lat: known.lat, lon: known.lon };
        }
        return res;
    });
    
    const geoResults = enrichedResults.filter(r => r.lat != null && r.lon != null);
    
    if (geoResults.length === 0) {
        results.sort((a, b) => a.latency_ms - b.latency_ms);
        results.forEach(res => {
            detailsPanel.innerHTML += `
                <div class="text-sm flex justify-between border-b border-gray-100 py-2">
                    <p class="font-medium text-gray-900">${res.resolver_name || res.ip || 'Unknown'}</p>
                    <p class="text-blue-600 font-semibold">${(res.latency_ms || 0).toFixed(0)} ms</p>
                </div>
            `;
        });
        return;
    }
    
    const latencies = geoResults.map(r => Number(r.latency_ms || 0));
    const norm = normalizeWeights(latencies, 0.15, 1.0);
    const heatPoints = geoResults.map((r, i) => [Number(r.lat), Number(r.lon), norm[i]]);

    try {
        if (typeof L.heatLayer !== 'function') throw new Error('Heat plugin not loaded');
        
        const heatLayer = L.heatLayer(heatPoints, {
            radius: 80,
            blur: 40,
            maxZoom: 10,
            minOpacity: 0.3,
            gradient: { 0.2: '#3b82f6', 0.5: '#fde047', 0.8: '#fb7185', 1.0: '#ef4444' }
        }).addTo(map);
        currentMapLayers.push(heatLayer);

        detailsPanel.innerHTML = `
            <div class="text-sm text-gray-500 mb-4">
                DNS latency heatmap. Blue = fast, Red = slow.
            </div>
        `;
        
        geoResults.sort((a, b) => a.latency_ms - b.latency_ms).forEach((res) => {
            detailsPanel.innerHTML += `
                <div class="text-sm flex justify-between border-b border-gray-100 py-2">
                    <div class="flex-1">
                        <p class="font-medium text-gray-900">${res.resolver_name || res.ip || 'Unknown'}</p>
                    </div>
                    <p class="text-red-600 font-semibold">${(res.latency_ms || 0).toFixed(0)} ms</p>
                </div>
            `;
        });

        const coordsOnly = heatPoints.map(p => [p[0], p[1]]);
        map.flyToBounds(coordsOnly, { padding: [50, 50], maxZoom: 3 });
    } catch (e) {
        console.warn('DNS heatmap fallback to markers', e);
        geoResults.forEach((r, i) => {
            const color = getColorForISP(r.resolver_name || r.ip);
            const marker = L.circleMarker([r.lat, r.lon], {
                radius: 8 + (latencies[i] / 100),
                color,
                fillColor: color,
                fillOpacity: 0.7
            }).addTo(map);
            marker.bindPopup(`${r.resolver_name || r.ip}<br>${(r.latency_ms || 0).toFixed(0)} ms`);
            currentMapLayers.push(marker);
        });
        const coordsOnly = geoResults.map(r => [r.lat, r.lon]);
        map.flyToBounds(coordsOnly, { padding: [50, 50], maxZoom: 3 });
    }
}