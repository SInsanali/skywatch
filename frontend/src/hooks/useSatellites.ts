import { useState, useEffect } from 'react';

export interface Satellite {
  name: string;
  latitude: number;
  longitude: number;
  altitude: number; // km
  velocity: number; // km/s
}

const POLL_INTERVAL = 5_000;

export function useSatellites(enabled: boolean) {
  const [satellites, setSatellites] = useState<Satellite[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const fetchData = async () => {
      try {
        const res = await fetch('/api/satellites');
        if (!res.ok) return;
        const data: Satellite[] = await res.json();
        if (!cancelled) setSatellites(data);
      } catch {}
    };

    fetchData();
    const id = setInterval(fetchData, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);

  return satellites;
}
