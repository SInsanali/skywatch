import { useState, useEffect } from 'react';

export interface EonetGeometryPoint {
  date: string;
  type: string;
  coordinates: number[];
}

export interface EonetEvent {
  id: string;
  title: string;
  category: string;
  geometry: EonetGeometryPoint[];
  last_update: string;
}

const POLL_INTERVAL = 60_000;

export function useEonet(enabled: boolean) {
  const [events, setEvents] = useState<EonetEvent[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const fetchData = async () => {
      try {
        const res = await fetch('/api/eonet');
        if (!res.ok) { console.error(`[Skywatch] EONET fetch failed: HTTP ${res.status}`); return; }
        const data = await res.json();
        if (!cancelled) setEvents(data.events || []);
      } catch (e) {
        console.error('[Skywatch] EONET fetch error:', e);
      }
    };
    fetchData();
    const id = setInterval(fetchData, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);

  return events;
}
