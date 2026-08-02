export default function StatsBar({ vehicles, alerts, connected, activeRoute }) {
    const vehicleList = Object.values(vehicles);
    const totalVehicles = vehicleList.length;
    const avgSpeed = totalVehicles > 0
        ? Math.round(vehicleList.reduce((s, v) => s + (v.speed || 0), 0) / totalVehicles)
        : 0;
    const activeAlerts = vehicleList.filter(v => v.status && v.status !== 'normal').length;

    return (
        <header className="stats-bar">
            {/* Brand */}
            <div className="brand">
                <span className="brand-icon">⬡</span>
                <span className="brand-name">FleetQ</span>
                <span className="brand-sub">Telematics</span>
            </div>

            {/* Live stats */}
            <div className="stats-row">
                <StatChip icon="🚛" label="Vehicles" value={totalVehicles} />
                <StatChip icon="🏎" label="Avg Speed" value={`${avgSpeed} mph`} />
                <StatChip
                    icon="⚠️"
                    label="Alerts"
                    value={alerts.length}
                    danger={alerts.length > 0}
                />
                {activeRoute && (
                    <StatChip
                        icon="🗺"
                        label="C++ Route"
                        value={`${activeRoute.path?.join('→')}  (${activeRoute.duration}m)`}
                        highlight
                    />
                )}
            </div>

            {/* Connection indicator */}
            <div className={`conn-badge ${connected ? 'conn-live' : 'conn-off'}`}>
                <span className="conn-dot" />
                {connected ? 'LIVE' : 'OFFLINE'}
            </div>
        </header>
    );
}

function StatChip({ icon, label, value, danger, highlight }) {
    return (
        <div className={`stat-chip ${danger ? 'chip-danger' : ''} ${highlight ? 'chip-highlight' : ''}`}>
            <span className="chip-icon">{icon}</span>
            <div>
                <div className="chip-label">{label}</div>
                <div className="chip-value">{value}</div>
            </div>
        </div>
    );
}
