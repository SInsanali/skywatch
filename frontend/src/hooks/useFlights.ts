import { useState, useEffect, useRef, useCallback } from 'react';
import { Aircraft, AircraftResponse } from '../types';

const POLL_INTERVAL = 5_000;
const HEARTBEAT_INTERVAL = 20_000;

export function useFlights(enabled: boolean) {
  const [flights, setFlights] = useState<Aircraft[]>([]);
  const [total, setTotal] = useState(0);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const prevDataRef = useRef<Map<string, Aircraft>>(new Map());

  // Heartbeat
  useEffect(() => {
    if (!enabled) return;
    const hb = () => fetch('/api/heartbeat', { method: 'POST' }).catch(() => {});
    hb();
    const id = setInterval(hb, HEARTBEAT_INTERVAL);
    return () => clearInterval(id);
  }, [enabled]);

  // Polling
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const fetchData = async () => {
      try {
        const res = await fetch('/api/aircraft');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: AircraftResponse = await res.json();

        if (cancelled) return;

        const now = Date.now();
        const prev = prevDataRef.current;
        const updated: Aircraft[] = [];

        for (const ac of data.aircraft) {
          const old = prev.get(ac.icao24);
          if (old) {
            ac._prevLat = old.latitude;
            ac._prevLon = old.longitude;
            ac._prevAlt = old.baro_altitude ?? undefined;
          } else {
            ac._prevLat = ac.latitude;
            ac._prevLon = ac.longitude;
            ac._prevAlt = ac.baro_altitude ?? undefined;
          }
          ac._updateTime = now;
          updated.push(ac);
        }

        const newMap = new Map<string, Aircraft>();
        for (const ac of updated) newMap.set(ac.icao24, ac);
        prevDataRef.current = newMap;

        setFlights(updated);
        setTotal(data.aircraft.length);
        setLastUpdate(data.timestamp);
        setError(null);
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'Connection error');
      }
    };

    fetchData();
    const id = setInterval(fetchData, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);

  return { flights, total, lastUpdate, error };
}
