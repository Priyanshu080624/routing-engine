/**
 * FleetQ Simulator — Vehicles follow REAL road coordinates
 * ─────────────────────────────────────────────────────────
 * Loads city_roads.json and chains road segments into
 * continuous GPS paths. Each tick moves the vehicle along
 * the actual OSM coordinates — no straight-line shortcuts.
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const API_URL = 'http://localhost:3000/api/telematics';

// ─── Load real road geometries ────────────────────────────────
console.log('[Simulator] Loading real Bengaluru road geometries...');
const allRoads = JSON.parse(fs.readFileSync(path.join(__dirname, 'city_roads.json'), 'utf8'));
console.log(`[Simulator] ${allRoads.length} road segments loaded\n`);

// Group segments by road name
const roadsByName = {};
for (const r of allRoads) {
    if (!roadsByName[r.name]) roadsByName[r.name] = [];
    roadsByName[r.name].push(r);
}

// Squared Euclidean distance between two [lon, lat] points
function d2(a, b) {
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

/**
 * Chain all OSM segments of a named road into one continuous
 * coordinate array. Handles segments that are stored in any order
 * and any direction (forward/backward).
 *
 * Returns [[lon, lat], ...] — full road geometry on actual roads.
 */
function chainRoadSegments(name) {
    const segs = roadsByName[name];
    if (!segs || segs.length === 0) {
        console.warn(`[Path] ⚠ Road not found: "${name}"`);
        return [];
    }

    // Start with the longest segment
    const sorted  = [...segs].sort((a, b) => b.coords.length - a.coords.length);
    const result  = [...sorted[0].coords];
    const pending = sorted.slice(1);

    // Greedily attach the nearest unattached segment
    const GAP_THRESHOLD = 0.002 * 0.002; // ~200m² tolerance in degrees²

    while (pending.length > 0) {
        const lastPt = result[result.length - 1];
        let bestIdx  = -1;
        let bestRev  = false;
        let bestDist = GAP_THRESHOLD;

        for (let i = 0; i < pending.length; i++) {
            const s  = pending[i];
            const dS = d2(lastPt, s.coords[0]);
            const dE = d2(lastPt, s.coords[s.coords.length - 1]);

            if (dS < bestDist) { bestDist = dS; bestIdx = i; bestRev = false; }
            if (dE < bestDist) { bestDist = dE; bestIdx = i; bestRev = true; }
        }

        if (bestIdx === -1) break; // remaining segments are disconnected

        const seg = pending.splice(bestIdx, 1)[0];
        const nc  = bestRev ? [...seg.coords].reverse() : seg.coords;
        result.push(...nc);
    }

    return result; // [[lon, lat], ...]
}

/**
 * Build a full route by chaining multiple road names in order.
 * Each road's segments are chained first, then roads are joined.
 * Roads that are more than MAX_GAP_DEG apart are skipped to
 * prevent the truck from teleporting across the city.
 *
 * Returns: { coords: [[lon,lat],...], roadAt: [roadName,...] }
 */
const MAX_GAP_DEG = 0.0015; // ~150 m tolerance between roads
const MAX_GAP_SQ  = MAX_GAP_DEG * MAX_GAP_DEG;

function buildRoute(roadNames) {
    const coords = [];
    const roadAt = [];

    for (const name of roadNames) {
        const roadCoords = chainRoadSegments(name);
        if (roadCoords.length === 0) continue;

        if (coords.length === 0) {
            // First road — add as-is
            coords.push(...roadCoords);
            roadAt.push(...roadCoords.map(() => name));
            continue;
        }

        const lastPt   = coords[coords.length - 1];
        const dToStart = d2(lastPt, roadCoords[0]);
        const dToEnd   = d2(lastPt, roadCoords[roadCoords.length - 1]);
        const minDist  = Math.min(dToStart, dToEnd);

        // Skip this road if too far away — avoids jumps between disconnected roads
        if (minDist > MAX_GAP_SQ) {
            console.warn(`[Path] Gap too large between previous road and "${name}" (${(Math.sqrt(minDist)*111000).toFixed(0)} m) — skipping`);
            continue;
        }

        const oriented = dToEnd < dToStart ? [...roadCoords].reverse() : roadCoords;
        coords.push(...oriented);
        roadAt.push(...oriented.map(() => name));
    }

    return { coords, roadAt };
}

// ─── Vehicle route definitions ────────────────────────────────
// Routes verified to be geographically adjacent (endpoints <150m apart)
// All trucks ping-pong back and forth — no teleporting.
const VEHICLE_DEFS = [
    {
        vehicleId:    'VIN-001',
        name:         'Alpha Truck',
        // Richmond Road: 17 segments crossing central Bengaluru east-west
        // starts near Victoria Road (lon 77.614) and ends near Kasturba (lon 77.597)
        roadNames:    ['Richmond Road'],
        fromLabel:    'Richmond Circle',
        toLabel:      'Kasturba Road Junction',
        fuelLevel:    85,
        tirePressure: { FL: 32, FR: 32, RL: 31, RR: 32 }
    },
    {
        vehicleId:    'VIN-002',
        name:         'Bravo Truck',
        // Brigade Road → Museum Road: adjacent parallel roads in city centre
        roadNames:    ['Brigade Road', 'Museum Road'],
        fromLabel:    'Brigade Road',
        toLabel:      'Museum Road',
        fuelLevel:    62,
        tirePressure: { FL: 33, FR: 33, RL: 32, RR: 33 }
    },
    {
        vehicleId:    'VIN-003',
        name:         'Charlie Truck',
        // Victoria Road: 6 connected segments near Domlur/Richmond area
        roadNames:    ['Victoria Road'],
        fromLabel:    'Victoria Road (West)',
        toLabel:      'Victoria Road (East)',
        fuelLevel:    22,
        tirePressure: { FL: 30, FR: 31, RL: 30, RR: 31 }
    }
];

// ─── Build routes and initialize vehicle state ─────────────────
const vehicles = VEHICLE_DEFS.map(def => {
    const { coords, roadAt } = buildRoute(def.roadNames);

    // Warn if route has fewer coords than expected (road not found / disconnected)
    if (coords.length < 5) {
        console.warn(`[${def.vehicleId}] ⚠ Very short path (${coords.length} coords) — roads may be disconnected`);
    } else {
        console.log(`[${def.vehicleId}] "${def.name}" — ${coords.length} coords | ${def.fromLabel} ↔ ${def.toLabel}`);
    }

    // Sample path for frontend display (max 400 points to keep payload light)
    const step        = Math.max(1, Math.floor(coords.length / 400));
    const pathSampled = coords
        .filter((_, i) => i % step === 0)
        .map(c => ({ lat: c[1], lon: c[0] }));

    // First and last coord as human-readable from/to labels
    const startCoord = coords[0]   ? { lat: coords[0][1],   lon: coords[0][0]   } : null;
    const endCoord   = coords[coords.length-1] ? { lat: coords[coords.length-1][1], lon: coords[coords.length-1][0] } : null;

    return {
        ...def,
        coords,          // full [[lon,lat]] path on real roads
        roadAt,          // road name per coord
        pathSampled,     // downsampled for frontend polyline display
        startCoord,      // first GPS point
        endCoord,        // last GPS point
        coordIdx:  0,
        direction: 1,    // +1 = forward along path, -1 = backward (ping-pong)
        speed:     60
    };
});

// ─── POST vehicle paths to server once on startup ──────────────
async function postVehiclePaths() {
    for (const v of vehicles) {
        try {
            await axios.post('http://localhost:3000/api/vehicle-path', {
                vehicleId:  v.vehicleId,
                name:       v.name,
                path:       v.pathSampled,
                roadNames:  v.roadNames,
                fromLabel:  v.fromLabel,
                toLabel:    v.toLabel,
                startCoord: v.startCoord,
                endCoord:   v.endCoord
            });
            console.log(`[${v.vehicleId}] ✅ Path posted — ${v.fromLabel} ↔ ${v.toLabel} (${v.pathSampled.length} pts)`);
        } catch (e) {
            console.warn(`[${v.vehicleId}] Path post failed — is server running? ${e.message}`);
        }
    }
}

// ─── Simulation tick ───────────────────────────────────────────
async function tick() {
    for (const v of vehicles) {
        if (v.coords.length === 0) continue;

        // Current GPS position from actual road coordinate
        const [lon, lat] = v.coords[v.coordIdx];
        const currentRoad = v.roadAt[v.coordIdx] || v.roadNames[0];

        // Peek ahead for "next road" label
        const nextIdx  = (v.coordIdx + 1) % v.coords.length;
        const nextRoad = v.roadAt[nextIdx] || currentRoad;

        // Realistic speed
        const bursting = Math.random() < 0.15;
        v.speed = bursting
            ? Math.floor(Math.random() * 10) + 81
            : Math.floor(Math.random() * 21) + 55;

        // Fuel drain with auto-refuel
        v.fuelLevel = parseFloat((v.fuelLevel - 0.3).toFixed(1));
        if (v.fuelLevel <= 10) {
            v.fuelLevel = 95;
            console.log(`⛽ ${v.vehicleId} refuelled → 95%`);
        }

        const payload = {
            vehicleId:    v.vehicleId,
            timestamp:    new Date().toISOString(),
            speed:        v.speed,
            fuelLevel:    v.fuelLevel,
            location:     { lat, lon },
            tirePressure: v.tirePressure,
            segment:      {
                from:     currentRoad,
                to:       nextRoad,
                progress: +(v.coordIdx / v.coords.length * 100).toFixed(1)
            }
        };

        try {
            await axios.post(API_URL, payload);
        } catch (e) {
            console.error(`[${v.vehicleId}] ❌ ${e.message}`);
        }

        // ── Ping-pong: flip direction at ends, NO teleporting ─
        const steps = 2;
        v.coordIdx += steps * v.direction;

        if (v.coordIdx >= v.coords.length - 1) {
            v.coordIdx  = v.coords.length - 1;
            v.direction = -1;   // reached end → reverse
        } else if (v.coordIdx <= 0) {
            v.coordIdx  = 0;
            v.direction = 1;    // reached start → go forward
        }
    }
}

// ─── Start ─────────────────────────────────────────────────────
console.log('\n🚛  FleetQ Simulator — vehicles on REAL Bengaluru roads');
console.log('   VIN-001  Richmond Road (Richmond Circle ↔ Kasturba Junction)');
console.log('   VIN-002  Brigade Road ↔ Museum Road (city centre)');
console.log('   VIN-003  Victoria Road (West ↔ East, near Domlur)\n');

// Post paths first (with retry), then start ticking
setTimeout(postVehiclePaths, 1500);   // wait 1.5s for server to be ready
setInterval(tick, 2000);
tick();
