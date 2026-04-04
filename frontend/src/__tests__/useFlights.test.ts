import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useFlights } from '../hooks/useFlights';

afterEach(() => {
  vi.restoreAllMocks();
});

const mockAircraftResponse = {
  timestamp: 1700000000,
  aircraft: [
    {
      icao24: 'abc123',
      callsign: 'UAL456',
      latitude: 40.6,
      longitude: -73.8,
      baro_altitude: 11000,
      geo_altitude: 11000,
      on_ground: false,
      velocity: 240,
      true_track: 180,
      vertical_rate: 0,
      squawk: '1200',
      ias: null,
      tas: null,
      mach: null,
      wind_dir: null,
      wind_speed: null,
      oat: null,
      nav_alt: null,
      reg: 'N12345',
      type: 'B738',
      model: 'Boeing 737-800',
      operator: 'United Airlines',
      airline: 'United',
      flight: 'UA456',
      year: 2015,
      mil: false,
      emergency: null,
      category: 'A3',
    },
  ],
};

describe('useFlights', () => {
  it('returns empty state when disabled', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const { result } = renderHook(() => useFlights(false));

    expect(result.current.flights).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('fetches and parses aircraft data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockAircraftResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useFlights(true));

    await waitFor(() => {
      expect(result.current.flights.length).toBe(1);
    });

    expect(result.current.total).toBe(1);
    expect(result.current.lastUpdate).toBe(1700000000);
    expect(result.current.flights[0].icao24).toBe('abc123');
    expect(result.current.flights[0].callsign).toBe('UAL456');
    expect(result.current.error).toBeNull();
  });

  it('sets dead reckoning fields on first fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockAircraftResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useFlights(true));

    await waitFor(() => {
      expect(result.current.flights.length).toBe(1);
    });

    const ac = result.current.flights[0];
    expect(ac._prevLat).toBe(40.6);
    expect(ac._prevLon).toBe(-73.8);
    expect(ac._updateTime).toBeGreaterThan(0);
  });

  it('sets error on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network down'));

    const { result } = renderHook(() => useFlights(true));

    await waitFor(() => {
      expect(result.current.error).toBe('Network down');
    });
  });

  it('sets error on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 500 }),
    );

    const { result } = renderHook(() => useFlights(true));

    await waitFor(() => {
      expect(result.current.error).toBe('HTTP 500');
    });
  });
});
