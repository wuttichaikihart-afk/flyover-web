let map;
let runCoordinates = [];
let routeLineString;
let gpxDataPoints = []; 

const mapStyles = {
    satellite: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
            'satellite-source': {
                'type': 'raster',
                'tiles': ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                'tileSize': 256,
                'attribution': 'Tiles &copy; Esri'
            },
            'terrain-source': {
                'type': 'raster-dem',
                'tiles': ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
                'encoding': 'terrarium',
                'tileSize': 256
            }
        },
        layers: [{
            'id': 'satellite-layer',
            'type': 'raster',
            'source': 'satellite-source'
        }],
        terrain: {
            'source': 'terrain-source',
            'exaggeration': 1.5 
        }
    },
    standard: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json'
};

document.getElementById('gpx-input').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const gpxText = e.target.result;
        const parser = new DOMParser();
        const gpxDom = parser.parseFromString(gpxText, 'text/xml');
        const geojson = toGeoJSON.gpx(gpxDom);
        const feature = geojson.features.find(f => f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString');
        
        if (!feature) { alert('ไม่พบเส้นทางในไฟล์ GPX'); return; }

        if (feature.geometry.type === 'LineString') {
            runCoordinates = feature.geometry.coordinates;
        } else if (feature.geometry.type === 'MultiLineString') {
            runCoordinates = feature.geometry.coordinates.flat();
        }

        routeLineString = turf.lineString(runCoordinates);
        gpxDataPoints = [];
        let accumulatedDistance = 0;
        const trkpts = gpxDom.getElementsByTagName('trkpt');
        
        for (let i = 0; i < trkpts.length; i++) {
            const pt = trkpts[i];
            const lat = parseFloat(pt.getAttribute('lat'));
            const lon = parseFloat(pt.getAttribute('lon'));
            const timeNode = pt.getElementsByTagName('time')[0];
            const time = timeNode ? new Date(timeNode.textContent).getTime() : null;
            let hr = null;
            const hrNode = pt.getElementsByTagNameNS('*', 'hr')[0]; 
            if (hrNode) hr = parseInt(hrNode.textContent);
            
            if (i > 0) {
                const prev = gpxDataPoints[i-1];
                const dist = turf.distance(turf.point([prev.lon, prev.lat]), turf.point([lon, lat]), {units: 'kilometers'});
                accumulatedDistance += dist;
            }
            gpxDataPoints.push({ lat, lon, time, hr, dist: accumulatedDistance });
        }

        document.getElementById('upload-panel').style.display = 'none';
        document.getElementById('map').style.display = 'block';
        document.getElementById('controls').style.display = 'block';
        document.getElementById('hud').style.display = 'flex'; 
        document.getElementById('run-title').innerText = file.name.replace('.gpx', '');
        initMap();
    };
    reader.readAsText(file);
});

function initMap() {
    const initialStyle = document.getElementById('map-style').value;
    map = new maplibregl.Map({
        container: 'map',
        style: mapStyles[initialStyle],
        center: runCoordinates[0],
        zoom: 14,
        pitch: 0,
        preserveDrawingBuffer: true
    });

    map.on('style.load', () => {
        if (!map.getSource('route')) drawRunLayers();
    });

    map.on('load', () => {
        const bounds = runCoordinates.reduce((b, coord) => b.extend(coord), new maplibregl.LngLatBounds(runCoordinates[0], runCoordinates[0]));
        map.fitBounds(bounds, { padding: 50 });
    });
}

function drawRunLayers() {
    if (!routeLineString) return;
    map.addSource('route', { 'type': 'geojson', 'data': turf.lineString([runCoordinates[0], runCoordinates[0]]) });
    map.addLayer({
        'id': 'route',
        'type': 'line',
        'source': 'route',
        'layout': { 'line-join': 'round', 'line-cap': 'round' },
        'paint': { 'line-color': '#00FFFF', 'line-width': 8, 'line-opacity': 0.8 }
    });
    
    map.addSource('runner', { 'type': 'geojson', 'data': turf.point(runCoordinates[0], { hudText: '' }) });
    map.addLayer({
        'id': 'runner-dot',
        'type': 'circle',
        'source': 'runner',
        'paint': { 'circle-radius': 10, 'circle-color': '#FFFFFF', 'circle-stroke-width': 5, 'circle-stroke-color': '#FF0055' }
    });
    
    map.addLayer({
        'id': 'runner-hud',
        'type': 'symbol',
        'source': 'runner',
        'layout': {
            'text-field': ['get', 'hudText'],
            'text-offset': [0, 2],
            'text-anchor': 'top',
            'text-size': 18
        },
        'paint': {
            'text-color': '#FFFFFF',
            'text-halo-color': '#000000',
            'text-halo-width': 2
        }
    });
}

document.getElementById('map-style').addEventListener('change', function(e) {
    map.setStyle(mapStyles[e.target.value]);
});

// ================= แอนิเมชัน & วิดีโอ =================
let animationId = null;
let startTime = null;
let currentCameraBearing = null; 
let isRecording = false;
let isFlying = false;
let isCancelled = false;
let mediaRecorder;
let recordedChunks = [];
let currentVideoBlob = null;
let currentVideoExt = '';
let currentVideoFile = null;

function lerpAngle(startAngle, targetAngle, smoothingAmount) {
    const delta = ((targetAngle - startAngle + 540) % 360) - 180;
    return (startAngle + delta * smoothingAmount + 360) % 360;
}

function formatPace(ms, distKm) {
    if (distKm < 0.05 || !ms) return "--:--"; 
    const minutesPerKm = (ms / 60000) / distKm;
    if (minutesPerKm > 30) return "--:--"; 
    const mins = Math.floor(minutesPerKm);
    const secs = Math.floor((minutesPerKm - mins) * 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ฟังก์ชันโหลดวิดีโอลงเครื่อง (กรณีที่แชร์ตรงๆ ไม่ได้)
function downloadVideo(blob, ext) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; 
    a.download = `Cinematic-Flyover.${ext}`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function startFlyover(shouldRecord = false) {
    isFlying = true;
    isCancelled = false;
    const btn = document.getElementById('start-btn');
    const recBtn = document.getElementById('record-btn');
    btn.disabled = true;
    recBtn.disabled = true;
    document.getElementById('controls').style.display = 'none';
    document.getElementById('stop-btn').style.display = 'block';

    if (shouldRecord) {
        try {
            const mapCanvas = map.getCanvas();
            const stream = mapCanvas.captureStream(30); 
            
            // ตรวจสอบว่าเบราว์เซอร์รองรับไฟล์แบบไหน (มือถือชอบ mp4, คอมชอบ webm)
            let mimeType = 'video/webm';
            let ext = 'webm';
            if (MediaRecorder.isTypeSupported('video/mp4')) {
                mimeType = 'video/mp4';
                ext = 'mp4';
            }

            mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });
            recordedChunks = [];
            
            mediaRecorder.ondataavailable = function(e) { if (e.data.size > 0) recordedChunks.push(e.data); };
            
            mediaRecorder.onstop = async function() {
                if (isCancelled) {
                    recordedChunks = [];
                    return;
                }
                currentVideoBlob = new Blob(recordedChunks, { type: mimeType });
                currentVideoExt = ext;
                currentVideoFile = new File([currentVideoBlob], `Cinematic-Flyover.${ext}`, { type: mimeType });

                document.getElementById('controls').style.display = 'block';
                document.getElementById('hud').style.display = 'flex';
                document.getElementById('stop-btn').style.display = 'none';
                btn.disabled = false;
                recBtn.disabled = false;

                // Show Modal
                document.getElementById('video-modal').style.display = 'block';
            };
            
            mediaRecorder.start();
            isRecording = true;
            document.getElementById('controls').style.display = 'none';
            document.getElementById('hud').style.display = 'none';
        } catch (err) {
            alert("ไม่สามารถบันทึกวิดีโอได้: " + err.message); return;
        }
    }

    map.flyTo({ center: runCoordinates[0], zoom: 17.5, pitch: 75, duration: 2500 });
    await new Promise(r => setTimeout(r, 2500));
    if (!isFlying) return;

    const totalDistance = turf.length(routeLineString, { units: 'kilometers' });
    const speedMultiplier = parseFloat(document.getElementById('speed-style').value);
    let baseDuration = totalDistance * 8000; 
    baseDuration = Math.max(30000, Math.min(90000, baseDuration)); 
    const animationDuration = baseDuration / speedMultiplier;
    currentCameraBearing = null; 

    function animate(timestamp) {
        if (!startTime) startTime = timestamp;
        const progress = (timestamp - startTime) / animationDuration;

        if (progress >= 1) {
            isFlying = false;
            document.getElementById('stop-btn').style.display = 'none';
            if (map.getSource('route') && routeLineString) {
                map.getSource('route').setData(routeLineString);
            }
            if (isRecording && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop();
                isRecording = false;
            } else {
                btn.disabled = false;
                recBtn.disabled = false;
                document.getElementById('controls').style.display = 'block';
            }
            startTime = null;
            return;
        }

        const currentDistance = totalDistance * progress;
        
        let matchedPointIndex = 0;
        let matchedPoint = gpxDataPoints[0];
        for (let i = 0; i < gpxDataPoints.length; i++) {
            if (gpxDataPoints[i].dist >= currentDistance) {
                matchedPoint = gpxDataPoints[i];
                matchedPointIndex = i;
                break;
            }
        }
        
        const currentDistanceStr = currentDistance.toFixed(2);
        const hrStr = matchedPoint.hr ? matchedPoint.hr : '--';
        let paceStr = '--:--';
        
        document.getElementById('hud-dist').innerHTML = `${currentDistanceStr}<span class="hud-unit">km</span>`;
        if (matchedPoint.hr) document.getElementById('hud-hr').innerHTML = `${hrStr}<span class="hud-unit">bpm</span>`;
        if (matchedPoint.time && gpxDataPoints[0].time) {
            paceStr = formatPace(matchedPoint.time - gpxDataPoints[0].time, currentDistance);
            document.getElementById('hud-pace').innerHTML = `${paceStr}<span class="hud-unit">/km</span>`;
        }

        const hudString = `${currentDistanceStr} km | Pace: ${paceStr} | HR: ${hrStr}`;

        const currentPoint = turf.along(routeLineString, currentDistance, { units: 'kilometers' });
        
        const drawnCoordinates = runCoordinates.slice(0, matchedPointIndex + 1);
        drawnCoordinates.push(currentPoint.geometry.coordinates);
        if (map.getSource('route') && drawnCoordinates.length > 1) {
            map.getSource('route').setData(turf.lineString(drawnCoordinates));
        }

        const lookAheadDistance = Math.min(currentDistance + 0.15, totalDistance); 
        const nextPoint = turf.along(routeLineString, lookAheadDistance, { units: 'kilometers' });
        const targetBearing = turf.bearing(currentPoint, nextPoint);
        if (currentCameraBearing === null) currentCameraBearing = targetBearing;
        currentCameraBearing = lerpAngle(currentCameraBearing, targetBearing, 0.05);

        if (map.getSource('runner')) {
            map.getSource('runner').setData(turf.point(currentPoint.geometry.coordinates, { hudText: hudString }));
        }

        map.jumpTo({ 
            center: currentPoint.geometry.coordinates, 
            bearing: currentCameraBearing, 
            pitch: 75,
            zoom: 17.2 
        });

        animationId = requestAnimationFrame(animate);
    }
    
    startTime = null;
    if(animationId) cancelAnimationFrame(animationId);
    animationId = requestAnimationFrame(animate);
}

function stopFlyover() {
    isFlying = false;
    isCancelled = true;

    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    startTime = null;

    if (map) {
        map.stop();
    }

    if (isRecording && mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        isRecording = false;
    }

    const btn = document.getElementById('start-btn');
    const recBtn = document.getElementById('record-btn');
    btn.disabled = false;
    recBtn.disabled = false;

    document.getElementById('controls').style.display = 'block';
    document.getElementById('hud').style.display = 'flex';
    document.getElementById('stop-btn').style.display = 'none';

    if (map && routeLineString) {
        if (map.getSource('route')) {
            map.getSource('route').setData(routeLineString);
        }
        if (map.getSource('runner')) {
            map.getSource('runner').setData(turf.point(runCoordinates[0]));
        }
        const bounds = runCoordinates.reduce((b, coord) => b.extend(coord), new maplibregl.LngLatBounds(runCoordinates[0], runCoordinates[0]));
        map.fitBounds(bounds, { padding: 50, pitch: 0, bearing: 0, duration: 1200 });
    }
}

document.getElementById('start-btn').addEventListener('click', () => startFlyover(false));
document.getElementById('record-btn').addEventListener('click', () => startFlyover(true));
document.getElementById('stop-btn').addEventListener('click', stopFlyover);

document.getElementById('btn-share-video').addEventListener('click', async () => {
    if (navigator.canShare && navigator.canShare({ files: [currentVideoFile] })) {
        try {
            await navigator.share({
                files: [currentVideoFile],
                title: 'My Running Flyover',
                text: 'ดูเส้นทางวิ่ง 3 มิติของฉันสิ!'
            });
        } catch (error) {
            console.log('Share error:', error);
        }
    } else {
        alert("เบราว์เซอร์นี้ไม่รองรับการกดแชร์วิดีโอโดยตรง กรุณากดปุ่มเซฟลงเครื่องแทนครับ");
    }
});

document.getElementById('btn-save-video').addEventListener('click', () => {
    if (currentVideoBlob) {
        downloadVideo(currentVideoBlob, currentVideoExt);
    }
});

document.getElementById('btn-close-modal').addEventListener('click', () => {
    document.getElementById('video-modal').style.display = 'none';
});
