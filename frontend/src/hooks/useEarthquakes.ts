import { useState, useEffect } from 'react';

export interface Earthquake {
  id: string;
  magnitude: number;
  place: string;
  time: number;
  latitude: number;
  longitude: number;
  depth: number; // km
}

const POLL_INTERVAL = 60_000; // check every minute (backend refreshes every 5 min)

export function useEarthquakes(enabled: boolean) {
  const [earthquakes, setEarthquakes] = useState<Earthquake[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const fetchData = async () => {
      try {
        const res = await fetch('/api/earthquakes');
        if (!res.ok) { console.error(`[Skywatch] Earthquake fetch failed: HTTP ${res.status}`); return; }
        const data = await res.json();
        const features = data?.features || [];
        const parsed: Earthquake[] = features.map((f: any) => ({
          id: f.id,
          magnitude: f.properties.mag,
          place: f.properties.place,
          time: f.properties.time,
          latitude: f.geometry.coordinates[1],
          longitude: f.geometry.coordinates[0],
          depth: f.geometry.coordinates[2],
        }));
        if (!cancelled) setEarthquakes(parsed);
      } catch (e) {
        console.error('[Skywatch] Earthquake data fetch failed:', e);
      }
    };

    fetchData();
    const id = setInterval(fetchData, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);

  return earthquakes;
}
