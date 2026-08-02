import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = 'http://localhost:3000';

export function useSocket() {
    const socketRef = useRef(null);
    const [vehicles,     setVehicles]     = useState({});
    const [alerts,       setAlerts]       = useState([]);
    const [activeRoute,  setRoute]        = useState(null);
    const [vehiclePaths, setVehiclePaths] = useState({});  // real road paths per vehicle
    const [connected,    setConnected]    = useState(false);

    useEffect(() => {
        const socket = io(SOCKET_URL, { transports: ['websocket'] });
        socketRef.current = socket;

        socket.on('connect', () => {
            console.log('✅ Socket connected:', socket.id);
            setConnected(true);
        });

        socket.on('disconnect', () => {
            console.log('❌ Socket disconnected');
            setConnected(false);
        });

        // Full state snapshot on connect (includes vehiclePaths)
        socket.on('fleet:snapshot', ({ vehicles: v, alerts: a, activeRoute: r, vehiclePaths: vp }) => {
            setVehicles(v || {});
            setAlerts(a || []);
            setRoute(r);
            setVehiclePaths(vp || {});
        });

        socket.on('vehicle:update', (data) => {
            setVehicles(prev => ({ ...prev, [data.vehicleId]: data }));
        });

        // New alert only fires when state changes (server-side dedup)
        socket.on('vehicle:alert', (alert) => {
            setAlerts(prev => [alert, ...prev].slice(0, 50));
        });

        // C++ Dijkstra route — redraw polyline
        socket.on('route:update', (route) => {
            setRoute(route);
        });

        // Simulator posted new route paths (fired once per vehicle at startup)
        socket.on('vehicle:paths', (paths) => {
            setVehiclePaths(paths);
        });

        return () => socket.disconnect();
    }, []);

    return { vehicles, alerts, activeRoute, vehiclePaths, connected };
}

