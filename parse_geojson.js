/**
 * FleetQ GeoJSON Parser — RFC 7946
 * ─────────────────────────────────────────────────────────────
 * Streams Bengaluru export.geojson (669k lines, 13 MB) using
 * Node.js readline — never loads the full file into RAM.
 *
 * Structure (Overpass Turbo export):
 *   Line 1:   {                          ← root object (depth 0)
 *   Line 6:     "features": [
 *   Line 7:     {                        ← feature starts at depth 1 (4-space indent)
 *   Line 41:    },                       ← feature ends: trimmed starts with "},"
 *   Line 42:    ],                       ← array close
 *   Line 43: }                           ← root close
 *
 * Detection: feature starts when line.trim() === '{' AND
 * line starts with exactly 4 spaces (indent level 1 inside array).
 *
 * Usage:  node parse_geojson.js
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

// ─── Config ──────────────────────────────────────────────────
const INPUT_FILE = path.join(__dirname, 'export.geojson');
const OUT_DIR    = __dirname;

const HIGHWAY_WHITELIST = new Set([
    'motorway', 'motorway_link',
    'trunk', 'trunk_link',
    'primary', 'primary_link',
    'secondary', 'secondary_link',
    'tertiary', 'tertiary_link',
    'unclassified', 'residential',
    'living_street', 'road'
]);

const SPEED_BY_HIGHWAY = {
    motorway: 100, motorway_link: 60,
    trunk: 80,     trunk_link: 60,
    primary: 60,   primary_link: 40,
    secondary: 50, secondary_link: 30,
    tertiary: 40,  tertiary_link: 30,
    unclassified: 30, residential: 25,
    living_street: 15, road: 30,
};

// ─── Haversine distance (metres) ─────────────────────────────
function haversine(lon1, lat1, lon2, lat2) {
    const R = 6371000;
    const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function travelMinutes(lon1, lat1, lon2, lat2, highway) {
    const dist     = haversine(lon1, lat1, lon2, lat2);
    const speedMs  = (SPEED_BY_HIGHWAY[highway] || 30) * 1000 / 3600;
    return dist / speedMs / 60;
}

// Snap to ~11 m grid (4 decimal places ≈ 11 m precision)
function snapKey(lon, lat) {
    return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

// ─── State ────────────────────────────────────────────────────
let buf    = [];          // current feature line buffer
let depth  = 0;          // brace depth inside a feature
let inFeat = false;      // currently inside a feature

const roads     = [];
const graph     = {};
const nodes     = {};
const landmarks = {};

let scanned = 0, kept = 0;

// ─── Process one complete feature JSON string ─────────────────
function processFeature(raw) {
    scanned++;
    let feat;
    try {
        feat = JSON.parse(raw);
    } catch (_) {
        return;
    }

    const props   = feat.properties || {};
    const geom    = feat.geometry   || {};
    const highway = props.highway;
    const name    = props.name;
    const oneway  = props.oneway === 'yes';

    if (geom.type !== 'LineString')            return;
    if (!HIGHWAY_WHITELIST.has(highway))       return;
    if (!name)                                 return;

    const coords = geom.coordinates;
    if (!coords || coords.length < 2)          return;

    kept++;
    roads.push({ id: feat.id || props['@id'], name, highway, oneway, coords });

    // Build graph edges between consecutive coordinate pairs
    for (let i = 0; i < coords.length - 1; i++) {
        const [lon1, lat1] = coords[i];
        const [lon2, lat2] = coords[i + 1];
        const kA = snapKey(lon1, lat1);
        const kB = snapKey(lon2, lat2);

        if (!nodes[kA]) nodes[kA] = { lat: lat1, lon: lon1, roads: new Set() };
        if (!nodes[kB]) nodes[kB] = { lat: lat2, lon: lon2, roads: new Set() };
        nodes[kA].roads.add(name);
        nodes[kB].roads.add(name);

        if (!graph[kA]) graph[kA] = [];
        if (!graph[kB]) graph[kB] = [];

        const w = +travelMinutes(lon1, lat1, lon2, lat2, highway).toFixed(4);
        graph[kA].push({ to: kB, road: name, highway, weight: w });
        if (!oneway) graph[kB].push({ to: kA, road: name, highway, weight: w });
    }

    // Landmark: midpoint of each named road
    if (!landmarks[name]) {
        const mid = Math.floor(coords.length / 2);
        landmarks[name] = {
            name,
            highway,
            start:    { lat: coords[0][1],   lon: coords[0][0]   },
            end:      { lat: coords[coords.length-1][1], lon: coords[coords.length-1][0] },
            midpoint: { lat: coords[mid][1],  lon: coords[mid][0] }
        };
    }
}

// ─── Main streaming loop ──────────────────────────────────────
console.log('📂 FleetQ GeoJSON Parser — streaming Bengaluru OSM data');
console.log(`   File: ${INPUT_FILE}\n`);

const rl = readline.createInterface({
    input:     fs.createReadStream(INPUT_FILE, { encoding: 'utf8' }),
    crlfDelay: Infinity
});

let lineNum = 0;

rl.on('line', (line) => {
    lineNum++;

    // Progress heartbeat every 100k lines
    if (lineNum % 100000 === 0) {
        process.stdout.write(`   ... ${(lineNum/1000).toFixed(0)}k lines | ${kept} roads kept\r`);
    }

    const trimmed = line.trim();

    if (!inFeat) {
        // Feature objects at indent level 1 start with exactly "    {" (4 spaces)
        // but trimmed they're just "{"
        if (trimmed === '{' && line.startsWith('    ') && !line.startsWith('     ')) {
            inFeat = true;
            depth  = 1;
            buf    = ['{'];  // start clean
        }
        return;
    }

    // Count every '{' and '}' on this line to track depth
    for (const ch of line) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
    }

    // Don't add the first opening '{' again (already in buf)
    if (buf.length > 0 || trimmed !== '{') {
        buf.push(line);
    }

    // Feature ends when depth returns to 0
    if (depth === 0) {
        // Strip trailing comma from last line if present ("    }," → "    }")
        const last = buf[buf.length - 1];
        buf[buf.length - 1] = last.replace(/,\s*$/, '');

        processFeature(buf.join('\n'));
        buf    = [];
        inFeat = false;
    }
});

rl.on('close', () => {
    process.stdout.write('\n');
    console.log(`\n✅ Parse complete`);
    console.log(`   Lines read             : ${lineNum.toLocaleString()}`);
    console.log(`   Features scanned       : ${scanned.toLocaleString()}`);
    console.log(`   Named roads kept       : ${kept.toLocaleString()}`);
    console.log(`   Graph nodes            : ${Object.keys(graph).length.toLocaleString()}`);
    console.log(`   Unique named landmarks : ${Object.keys(landmarks).length.toLocaleString()}`);
    console.log('');

    // Serialise nodes (convert Set → array)
    const nodesOut = {};
    for (const [k, v] of Object.entries(nodes)) {
        nodesOut[k] = { lat: v.lat, lon: v.lon, roads: [...v.roads] };
    }

    // Write files
    const files = {
        'city_graph.json':     graph,
        'city_roads.json':     roads,
        'city_nodes.json':     nodesOut,
        'city_landmarks.json': landmarks,
    };

    for (const [fname, data] of Object.entries(files)) {
        const fpath = path.join(OUT_DIR, fname);
        fs.writeFileSync(fpath, JSON.stringify(data, null, 2));
        const kb = (fs.statSync(fpath).size / 1024).toFixed(0);
        console.log(`   ✔ ${fname.padEnd(25)} ${kb} KB`);
    }

    // Road-type breakdown
    const typeCounts = {};
    for (const r of roads) typeCounts[r.highway] = (typeCounts[r.highway] || 0) + 1;
    console.log('\n📊 Road types:');
    for (const [t, c] of Object.entries(typeCounts).sort((a,b) => b[1]-a[1])) {
        console.log(`   ${t.padEnd(22)} ${c} segments`);
    }

    // Sample landmarks
    const sampleRoads = Object.values(landmarks)
        .filter(l => ['primary','secondary','trunk'].includes(l.highway))
        .slice(0, 10);

    console.log('\n📍 Sample primary/secondary landmarks:');
    for (const l of sampleRoads) {
        console.log(`   "${l.name}" (${l.highway})`);
        console.log(`      midpoint → lat=${l.midpoint.lat.toFixed(5)}, lon=${l.midpoint.lon.toFixed(5)}`);
    }

    console.log('\n🎉 Done!');
    console.log('   → Use city_landmarks.json to pick real nodes for simulator.js & main.cpp');
    console.log('   → city_graph.json is the adjacency list for your Dijkstra engine');
});

rl.on('error', (err) => {
    console.error('\n❌ Stream error:', err.message);
    process.exit(1);
});
