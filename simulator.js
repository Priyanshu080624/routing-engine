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
 * coordinate array. Whenever two segment endpoints are more than
 * INTERP_DEG apart, insert LINEAR INTERPOLATION POINTS so the
 * truck never jumps more than ~25 m between consecutive coords.
 *
 * Returns [[lon, lat], ...]
 */

const INTERP_DEG   = 0.00025;  // ~25 m — max allowed gap between consecutive coords
const INTERP_DEG_SQ = INTERP_DEG * INTERP_DEG;

/** Insert smooth intermediate points between two [lon,lat] coords if gap > INTERP_DEG */
function fillGap(from, to, result) {
    const dist = Math.sqrt(d2(from, to));
    if (dist <= INTERP_DEG) {
        result.push(to);
        return;
    }
    // Number of interpolation steps needed
    const n = Math.ceil(dist / INTERP_DEG);
    for (let i = 1; i <= n; i++) {
        const t = i / n;
        result.push([
            from[0] + (to[0] - from[0]) * t,
            from[1] + (to[1] - from[1]) * t
        ]);
    }
}

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

    // Greedily attach nearest segment, interpolating the gap
    const GAP_THRESHOLD = 0.002 * 0.002; // ~200m² search radius

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

        const seg  = pending.splice(bestIdx, 1)[0];
        const nc   = bestRev ? [...seg.coords].reverse() : seg.coords;
        const join = nc[0];

        // ── Fill the gap with interpolated points if needed ──
        fillGap(lastPt, join, result);
        result.push(...nc.slice(1)); // nc[0] already added via fillGap
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
const MAX_GAP_DEG = 0.005; // ~500 m tolerance — allows long roads with some gaps to chain
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

        // Fill gap between roads with interpolated points
        fillGap(lastPt, oriented[0], coords);
        coords.push(...oriented.slice(1));
        roadAt.push(...oriented.map(() => name));
    }

    return { coords, roadAt };
}

// ════════════════════════════════════════════════════════════════
//  ✏️  CONFIGURE TRUCK ROUTES HERE
//
//  roadNames  — one or more road names from city_roads.json
//               Use long roads for big cross-city routes.
//               The truck ping-pongs between the two endpoints.
//
//  fromLabel  — display name for the starting end of the route
//  toLabel    — display name for the far end of the route
//
//  Top longest roads available (coords = number of GPS points):
//    2483 coords → "Outer Ring Road"     (full outer city ring)
//     943 coords → "Bannerghatta Road"   (south Bengaluru corridor)
//     865 coords → "Mysore Road"         (west Bengaluru corridor)
//     628 coords → "Hosur Road"          (south-east corridor)
//     625 coords → "Whitefield Road"     (east Bengaluru)
//     550 coords → "Bellary Road"        (north corridor)
//     504 coords → "Dr. Vishnuvardhan Road"
//     484 coords → "Yelahanka Road"      (far north)
//     461 coords → "Varthur Road"        (east)
//     565 coords → "Sarjapura Road"      (south-east)
//     976 coords → "Magadi Road"         (west)
//     970 coords → "Kanakapura Road"     (south)
// ════════════════════════════════════════════════════════════════
const VEHICLE_DEFS = [
    {
        vehicleId:    'VIN-001',
        name:         'Alpha Truck',
        // Hosur Road — major south-east Bengaluru corridor
        // 628 GPS coords running from Electronic City up toward the city centre
        roadNames:    ['Hosur Road'],
        fromLabel:    'Electronic City (SE)',
        toLabel:      'Silk Board Junction',
        fuelLevel:    85,
        tirePressure: { FL: 32, FR: 32, RL: 31, RR: 32 }
    },
    {
        vehicleId:    'VIN-002',
        name:         'Bravo Truck',
        // Bannerghatta Road — major south Bengaluru artery
        // Runs from city centre (Jayanagar) down to Bannerghatta National Park
        roadNames:    ['Bannerghatta Road'],
        fromLabel:    'Jayanagar (City)',
        toLabel:      'Bannerghatta (South)',
        fuelLevel:    62,
        tirePressure: { FL: 33, FR: 33, RL: 32, RR: 33 }
    },
    {
        vehicleId:    'VIN-003',
        name:         'Charlie Truck',
        // Mysore Road — major west Bengaluru corridor
        // Connects city centre to Mysore direction through Kengeri
        roadNames:    ['Mysore Road'],
        fromLabel:    'Mysore Road (City end)',
        toLabel:      'Kengeri (West end)',
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

        // Fuel drain scaled for 800ms tick (0.12 per tick ≈ same rate as before)
        v.fuelLevel = parseFloat((v.fuelLevel - 0.12).toFixed(2));
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

        // ── Ping-pong: 1 step per tick, NO teleporting ────────
        // 1 step = ~25m (INTERP_DEG spacing), every 800ms
        // = visibly smooth motion across the city
        v.coordIdx += v.direction;

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
setTimeout(postVehiclePaths, 1500);
setInterval(tick, 800);  // 800ms tick = smooth movement at ~25m per step
tick();
