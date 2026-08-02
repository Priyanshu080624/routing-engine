const express = require('express');
const cors    = require('cors');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { Server } = require('socket.io');

// ── Pre-load road geometries for the map layer ────────────────
// Filter to primary/secondary/trunk only to keep payload small (~1 MB vs 5.7 MB)
const ROADS_WHITELIST = new Set(['motorway','trunk','trunk_link','primary','primary_link','secondary']);
let mapRoads = [];
try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'city_roads.json'), 'utf8'));
    mapRoads  = raw.filter(r => ROADS_WHITELIST.has(r.highway));
    console.log(`🗺  Loaded ${mapRoads.length} road segments for map layer`);
} catch (e) {
    console.warn('⚠  city_roads.json not found — run parse_geojson.js first');
}

const app = express();
app.use(express.json());
app.use(cors());

// Wrap Express with a raw HTTP server so Socket.io can share port 3000
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: '*',        // Allow Vite dev server (localhost:5173)
        methods: ['GET', 'POST']
    }
});

// ──────────────────────────────────────────
// In-memory data store
// ──────────────────────────────────────────
let vehicleDataStore = {};   // { vehicleId: latestTelemetry }
let alerts = [];             // all-time alert log (capped at 200)
let activeRoute = null;      // latest route from C++ engine
let vehicleAlertState = {};  // { vehicleId: 'normal' | 'Speeding' | 'Low Fuel' }
                             // Only emit an alert event when the state CHANGES
let vehiclePaths = {};       // { vehicleId: { path: [{lat,lon}], roadNames: [] } }

// ──────────────────────────────────────────
// Socket.io connection lifecycle
// ──────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[Socket] Client connected → ${socket.id}`);

    // Send a full state snapshot to this brand-new client
    socket.emit('fleet:snapshot', {
        vehicles:     vehicleDataStore,
        alerts:       alerts.slice(-50),
        activeRoute,
        vehiclePaths  // real road path polylines per vehicle
    });

    socket.on('disconnect', () => {
        console.log(`[Socket] Client disconnected → ${socket.id}`);
    });
});

// ──────────────────────────────────────────
// REST — Ingest telemetry from simulator.js
// ──────────────────────────────────────────
app.post('/api/telematics', (req, res) => {
    const data = req.body;
    vehicleDataStore[data.vehicleId] = data;

    // ── Determine current alert status ────────────────────────
    let currentStatus = 'normal';
    if (data.speed > 80)      currentStatus = 'Speeding';
    if (data.fuelLevel < 15)  currentStatus = 'Low Fuel';   // Low Fuel wins over Speeding
    if (data.speed > 80 && data.fuelLevel < 15) currentStatus = 'Speeding'; // both: show speed

    const prevStatus = vehicleAlertState[data.vehicleId] || 'normal';
    vehicleAlertState[data.vehicleId] = currentStatus;

    // ── Only fire an alert event when the STATUS CHANGES ──────
    // This prevents 100 identical "Low Fuel" cards every 2s
    if (currentStatus !== 'normal' && currentStatus !== prevStatus) {
        const alert = {
            vehicleId: data.vehicleId,
            issue: currentStatus,
            value: currentStatus === 'Speeding' ? data.speed : data.fuelLevel,
            timestamp: data.timestamp
        };
        alerts.push(alert);
        if (alerts.length > 200) alerts.shift(); // cap total stored alerts
        io.emit('vehicle:alert', alert);
    }

    // ── Broadcast live position + status every tick ───────────
    io.emit('vehicle:update', {
        ...data,
        status: currentStatus
    });

    console.log(`[Telemetry] ${data.vehicleId} | ${data.speed} mph | Fuel: ${data.fuelLevel}% | ${currentStatus}`);
    res.status(200).json({ message: 'Data ingested successfully' });
});

// ──────────────────────────────────────────
// REST — Receive computed route from C++ engine
// ──────────────────────────────────────────
app.post('/api/route', (req, res) => {
    const routeData = req.body;
    activeRoute = routeData;

    // Broadcast to all clients so polyline redraws instantly
    io.emit('route:update', routeData);

    console.log(`[Route] C++ → ${routeData.from} → ${routeData.path?.join(' → ')} | ${routeData.duration} min`);
    res.status(200).json({ message: 'Route received and broadcast' });
});

// ──────────────────────────────────────────
// REST — Query endpoints (still available for C++ polling)
// ──────────────────────────────────────────
app.get('/api/fleet', (req, res) => {
    res.json({
        vehicles: vehicleDataStore,
        alerts: alerts.slice(-50),
        activeRoute
    });
});

app.get('/api/vehicle/:id', (req, res) => {
    const vehicle = vehicleDataStore[req.params.id];
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
    res.json(vehicle);
});

app.get('/api/alerts', (req, res) => {
    res.json(alerts);
});

// Vehicle route paths (posted once by simulator at startup)
app.post('/api/vehicle-path', (req, res) => {
    const { vehicleId, path, roadNames } = req.body;
    vehiclePaths[vehicleId] = { path, roadNames };
    io.emit('vehicle:paths', vehiclePaths);   // broadcast to all browser clients
    console.log(`[Path] ${vehicleId} route stored — ${path.length} pts on [${roadNames.join(' → ')}]`);
    res.status(200).json({ message: 'Path stored' });
});

// Road geometries for the map background layer (pre-filtered to major roads)
app.get('/api/roads', (req, res) => {
    res.json(mapRoads);
});

// ──────────────────────────────────────────
// Start
// ──────────────────────────────────────────
const PORT = 3000;
httpServer.listen(PORT, () => {
    console.log(`🚀 FleetQ API  →  http://localhost:${PORT}`);
    console.log(`🔌 Socket.io   →  ws://localhost:${PORT}`);
});
