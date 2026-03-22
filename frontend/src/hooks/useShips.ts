import { useState, useEffect } from 'react';

export interface Ship {
  mmsi: number;
  name: string;
  latitude: number;
  longitude: number;
  heading: number | null;
  cog: number | null;
  sog: number;
  nav_status: number;
  ship_type: number;
  category: string;
  destination: string;
  imo: number;
  callsign: string;
  length: number;
  width: number;
  timestamp: string;
}

const POLL_INTERVAL = 30_000;

export function useShips(enabled: boolean) {
  const [ships, setShips] = useState<Ship[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const fetchData = async () => {
      try {
        const res = await fetch('/api/ships');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setShips(data.ships || []);
      } catch {}
    };

    fetchData();
    const id = setInterval(fetchData, POLL_INTERVAL);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);

  return ships;
}
