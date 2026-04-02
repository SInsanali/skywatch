import { useState, useEffect } from 'react';

export interface JammingZone {
  lat: number;
  lon: number;
  total: number;
  degraded: number;
  pct: number;
  level: 'low' | 'medium' | 'high';
}

interface JammingResponse {
  zones: JammingZone[];
  timestamp: number;
}

const POLL_INTERVAL = 15_000;

export function useJamming(enabled: boolean) {
  const [zones, setZones] = useState<JammingZone[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const fetchData = async () => {
      try {
        const res = await fetch('/api/jamming');
        if (!res.ok) return;
        const data: JammingResponse = await res.json();
        if (!cancelled) setZones(data.zones || []);
      } catch {}
    };

    fetchData();
    const id = setInterval(fetchData, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);

  return zones;
}
