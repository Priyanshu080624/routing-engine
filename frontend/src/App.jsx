import { Suspense, lazy } from 'react';
import { useSocket } from './hooks/useSocket';
import StatsBar from './components/StatsBar';
import AlertsPanel from './components/AlertsPanel';
import './App.css';

// Lazy-load the map so Leaflet only runs in the browser
const FleetMap = lazy(() => import('./components/FleetMap'));

export default function App() {
    const { vehicles, alerts, activeRoute, vehiclePaths, connected } = useSocket();

    return (
        <div className="app-shell">
            <StatsBar
                vehicles={vehicles}
                alerts={alerts}
                connected={connected}
                activeRoute={activeRoute}
            />

            <main className="app-body">
                {/* Map fills the center */}
                <div className="map-wrapper">
                    <Suspense fallback={<div className="map-loading">Loading map…</div>}>
                        <FleetMap vehicles={vehicles} activeRoute={activeRoute} vehiclePaths={vehiclePaths} />
                    </Suspense>
                </div>

                {/* Alerts sidebar on the right */}
                <AlertsPanel alerts={alerts} />
            </main>
        </div>
    );
}
