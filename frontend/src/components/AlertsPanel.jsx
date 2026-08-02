function timeAgo(isoString) {
    const diff = Math.floor((Date.now() - new Date(isoString)) / 1000);
    if (diff < 60)  return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
}

const ISSUE_META = {
    Speeding:  { color: '#ff4d4d', bg: '#ff4d4d18', icon: '🚨' },
    'Low Fuel':{ color: '#ffaa00', bg: '#ffaa0018', icon: '⛽' },
};

export default function AlertsPanel({ alerts }) {
    const sorted = [...alerts]; // already newest-first from useSocket

    return (
        <aside className="alerts-panel">
            <div className="panel-header">
                <span>⚠️  Live Alerts</span>
                <span className="alert-count">{alerts.length}</span>
            </div>

            <div className="alerts-list">
                {sorted.length === 0 && (
                    <div className="no-alerts">
                        <span>✅</span>
                        <p>All vehicles nominal</p>
                    </div>
                )}
                {sorted.map((a, i) => {
                    const meta = ISSUE_META[a.issue] || { color: '#aaa', bg: '#aaa18', icon: '🔔' };
                    return (
                        <div
                            key={i}
                            className="alert-card"
                            style={{ borderLeft: `3px solid ${meta.color}`, background: meta.bg }}
                        >
                            <div className="alert-top">
                                <span className="alert-icon">{meta.icon}</span>
                                <span className="alert-vehicle">{a.vehicleId}</span>
                                <span className="alert-time">{timeAgo(a.timestamp)}</span>
                            </div>
                            <div className="alert-detail" style={{ color: meta.color }}>
                                {a.issue} — <strong>{a.value}{a.issue === 'Speeding' ? ' mph' : '%'}</strong>
                            </div>
                        </div>
                    );
                })}
            </div>
        </aside>
    );
}
