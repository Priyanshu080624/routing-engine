import { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ── Fix Leaflet default icon in Vite ───────────────────────────
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon   from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl: markerIcon2x, iconUrl: markerIcon, shadowUrl: markerShadow });

// ── Per-vehicle color identity ─────────────────────────────────
const VEHICLE_STYLE = {
    'VIN-001': { color: '#00d2ff', label: 'Alpha' },
    'VIN-002': { color: '#39ff14', label: 'Bravo' },
    'VIN-003': { color: '#ff9500', label: 'Charlie' },
};

// ── Alert override colors ──────────────────────────────────────
const ALERT_COLOR = { Speeding: '#ff4d4d', 'Low Fuel': '#ffaa00' };

// ── Road layer style by highway type ──────────────────────────
const ROAD_STYLE = {
    motorway:     { color: '#e06c00', weight: 3.5, opacity: 0.6 },
    trunk:        { color: '#c07000', weight: 2.5, opacity: 0.55 },
    primary:      { color: '#2563eb', weight: 2,   opacity: 0.5 },
    primary_link: { color: '#2563eb', weight: 1.5, opacity: 0.4 },
    secondary:    { color: '#1e3a6e', weight: 1.5, opacity: 0.45 },
};

// ── Glowing truck SVG icon ─────────────────────────────────────
function makeTruckIcon(vehicleId, status) {
    const vs    = VEHICLE_STYLE[vehicleId] || { color: '#00d2ff' };
    const color = ALERT_COLOR[status] || vs.color;
    const uid   = `${vehicleId}-${status}`.replace(/\W/g, '');
    const svg   = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
      <defs>
        <filter id="g${uid}" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.5" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <circle cx="24" cy="24" r="20" fill="${color}20" stroke="${color}" stroke-width="2.5"
              filter="url(#g${uid})"/>
      <text x="24" y="31" font-size="19" text-anchor="middle" fill="${color}">🚛</text>
    </svg>`;
    return L.divIcon({ html: svg, className: '', iconSize: [48,48], iconAnchor: [24,24], popupAnchor: [0,-28] });
}

// ── Route Legend Panel (shows all 3 vehicle routes) ───────────
function RouteLegend({ vehiclePaths, vehicles }) {
    return (
        <div style={{
            position: 'absolute', bottom: 28, left: 12, zIndex: 1000,
            background: 'rgba(10,15,25,0.88)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 12, padding: '12px 16px',
            minWidth: 240, maxWidth: 320,
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            fontFamily: 'Inter, system-ui, sans-serif',
        }}>
            <div style={{ color: '#8b949e', fontSize: 10, letterSpacing: 1.5,
                textTransform: 'uppercase', marginBottom: 10 }}>
                Active Routes
            </div>

            {Object.entries(vehiclePaths || {}).map(([vid, vp]) => {
                const vs      = VEHICLE_STYLE[vid] || { color: '#00d2ff', label: vid };
                const vehicle = vehicles[vid];
                const status  = vehicle?.status || 'normal';
                const sColor  = ALERT_COLOR[status] || vs.color;

                return (
                    <div key={vid} style={{
                        marginBottom: 10, paddingBottom: 10,
                        borderBottom: '1px solid rgba(255,255,255,0.06)',
                    }}>
                        {/* Vehicle ID + name */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                            <div style={{
                                width: 10, height: 10, borderRadius: '50%',
                                background: vs.color, boxShadow: `0 0 8px ${vs.color}`
                            }}/>
                            <span style={{ color: vs.color, fontWeight: 700, fontSize: 13 }}>
                                {vid}
                            </span>
                            <span style={{ color: '#8b949e', fontSize: 11 }}>
                                — {vs.label} Truck
                            </span>
                        </div>

                        {/* From → To */}
                        <div style={{ paddingLeft: 18, fontSize: 12 }}>
                            <span style={{ color: '#e6edf3', fontWeight: 600 }}>
                                📍 {vp.fromLabel || (vp.roadNames?.[0] || '?')}
                            </span>
                            <span style={{ color: '#8b949e', margin: '0 5px' }}>↔</span>
                            <span style={{ color: '#e6edf3', fontWeight: 600 }}>
                                {vp.toLabel || (vp.roadNames?.[vp.roadNames.length-1] || '?')}
                            </span>
                        </div>

                        {/* Live status row */}
                        {vehicle && (
                            <div style={{ paddingLeft: 18, marginTop: 3,
                                display: 'flex', gap: 10, fontSize: 11, color: '#8b949e' }}>
                                <span>🏎 {vehicle.speed} mph</span>
                                <span>⛽ {vehicle.fuelLevel}%</span>
                                {status !== 'normal' && (
                                    <span style={{ color: sColor, fontWeight: 700 }}>⚠ {status}</span>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}

            {Object.keys(vehiclePaths || {}).length === 0 && (
                <div style={{ color: '#8b949e', fontSize: 12 }}>
                    Waiting for simulator…
                </div>
            )}
        </div>
    );
}

// Center on real Bengaluru — Kasturba / Brigade Road area
const MAP_CENTER = [12.962, 77.596];

export default function FleetMap({ vehicles, activeRoute, vehiclePaths }) {
    const [roads, setRoads] = useState([]);

    useEffect(() => {
        fetch('http://localhost:3000/api/roads')
            .then(r => r.json())
            .then(data => {
                setRoads(data);
                console.log(`[FleetMap] ${data.length} OSM road segments loaded`);
            })
            .catch(e => console.warn('[FleetMap] Roads load failed:', e.message));
    }, []);

    const vehicleList  = Object.values(vehicles);
    const dijkstraLine = activeRoute?.coordinates?.map(c => [c.lat, c.lon]) || null;

    return (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <MapContainer
                center={MAP_CENTER} zoom={14}
                style={{ width: '100%', height: '100%' }}
                zoomControl={false}
            >
                {/* Dark CartoDB basemap */}
                <TileLayer
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    attribution='&copy; <a href="https://carto.com">CARTO</a> | OSM'
                    maxZoom={19}
                />

                {/* ── Real Bengaluru OSM road layer ──────────── */}
                {roads.map((road, i) => {
                    const style     = ROAD_STYLE[road.highway] || { color: '#1a3a6e', weight: 1, opacity: 0.35 };
                    const positions = road.coords.map(c => [c[1], c[0]]); // [lon,lat] → [lat,lon]
                    return (
                        <Polyline key={`r${i}`} positions={positions} pathOptions={style} />
                    );
                })}

                {/* ── Vehicle route trails — solid + glow ────── */}
                {Object.entries(vehiclePaths || {}).flatMap(([vid, vp]) => {
                    if (!vp?.path?.length) return [];
                    const vs        = VEHICLE_STYLE[vid] || { color: '#00d2ff' };
                    const positions = vp.path.map(p => [p.lat, p.lon]);
                    return [
                        // Wide glow halo under the trail
                        <Polyline
                            key={`glow-${vid}`}
                            positions={positions}
                            pathOptions={{ color: vs.color, weight: 16, opacity: 0.12 }}
                        />,
                        // Solid bright trail line — clearly visible on dark map
                        <Polyline
                            key={`trail-${vid}`}
                            positions={positions}
                            pathOptions={{ color: vs.color, weight: 3, opacity: 0.85 }}
                        >
                            <Tooltip sticky direction="top" offset={[0, -8]} opacity={0.95}>
                                <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12 }}>
                                    <b style={{ color: vs.color }}>{vid}</b>
                                    <br/>
                                    <span style={{ color: '#555' }}>
                                        {vp.fromLabel} ↔ {vp.toLabel}
                                    </span>
                                </div>
                            </Tooltip>
                        </Polyline>
                    ];
                })}

                {/* ── C++ Dijkstra computed route ─────────────── */}
                {dijkstraLine && dijkstraLine.length > 1 && [
                    <Polyline key="dijk-glow" positions={dijkstraLine}
                        pathOptions={{ color: '#00ffcc', weight: 16, opacity: 0.08 }} />,
                    <Polyline key="dijk-line" positions={dijkstraLine}
                        pathOptions={{ color: '#00ffcc', weight: 3.5, opacity: 0.9, dashArray: '12 6' }} />
                ]}

                {/* ── Truck markers ───────────────────────────── */}
                {vehicleList.map(v => {
                    if (!v.location) return null;
                    const status = v.status || 'normal';
                    const vs     = VEHICLE_STYLE[v.vehicleId] || { color: '#00d2ff', label: v.vehicleId };
                    const color  = ALERT_COLOR[status] || vs.color;
                    const vp     = (vehiclePaths || {})[v.vehicleId];

                    return (
                        <Marker
                            key={v.vehicleId}
                            position={[v.location.lat, v.location.lon]}
                            icon={makeTruckIcon(v.vehicleId, status)}
                            zIndexOffset={1000}
                        >
                            <Popup>
                                <div style={{ fontFamily: 'Inter, system-ui, sans-serif',
                                    fontSize: 12, lineHeight: 1.9, minWidth: 200, color: '#e6edf3' }}>
                                    <div style={{ color, fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
                                        🚛 {v.vehicleId} — {vs.label} Truck
                                    </div>
                                    <div>🏎 Speed: <b>{v.speed} mph</b></div>
                                    <div>⛽ Fuel: <b>{v.fuelLevel}%</b></div>
                                    {vp && (
                                        <div style={{ marginTop: 6, padding: '5px 8px',
                                            background: 'rgba(255,255,255,0.06)', borderRadius: 6,
                                            borderLeft: `3px solid ${vs.color}` }}>
                                            <div style={{ color: vs.color, fontWeight: 600, fontSize: 11 }}>
                                                ROUTE
                                            </div>
                                            <div>{vp.fromLabel}</div>
                                            <div style={{ color: '#8b949e' }}>↕ ping-pong</div>
                                            <div>{vp.toLabel}</div>
                                        </div>
                                    )}
                                    {v.segment && (
                                        <div style={{ marginTop: 4, color: '#8b949e', fontSize: 11 }}>
                                            On: <b style={{ color: '#e6edf3' }}>{v.segment.from}</b>
                                        </div>
                                    )}
                                    {status !== 'normal' && (
                                        <div style={{ marginTop: 6, color, fontWeight: 700 }}>
                                            ⚠ {status}
                                        </div>
                                    )}
                                </div>
                            </Popup>
                        </Marker>
                    );
                })}
            </MapContainer>

            {/* Route legend — rendered outside MapContainer so it floats above the map */}
            <RouteLegend vehiclePaths={vehiclePaths} vehicles={vehicles} />
        </div>
    );
}
