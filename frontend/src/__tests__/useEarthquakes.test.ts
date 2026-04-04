import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useEarthquakes } from '../hooks/useEarthquakes';

afterEach(() => {
  vi.restoreAllMocks();
});

const mockGeoJsonResponse = {
  features: [
    {
      id: 'us7000abc1',
      properties: {
        mag: 5.2,
        place: '10 km NW of Somewhere',
        time: 1700000000000,
      },
      geometry: {
        coordinates: [-118.5, 34.0, 12.3],
      },
    },
    {
      id: 'us7000abc2',
      properties: {
        mag: 3.1,
        place: '20 km SE of Elsewhere',
        time: 1700001000000,
      },
      geometry: {
        coordinates: [139.7, 35.7, 30.0],
      },
    },
  ],
};

describe('useEarthquakes', () => {
  it('returns empty array when disabled', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const { result } = renderHook(() => useEarthquakes(false));
    expect(result.current).toEqual([]);
  });

  it('fetches and parses GeoJSON features', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockGeoJsonResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useEarthquakes(true));

    await waitFor(() => {
      expect(result.current.length).toBe(2);
    });

    const [eq1, eq2] = result.current;
    expect(eq1.id).toBe('us7000abc1');
    expect(eq1.magnitude).toBe(5.2);
    expect(eq1.latitude).toBe(34.0);
    expect(eq1.longitude).toBe(-118.5);
    expect(eq1.depth).toBe(12.3);
    expect(eq1.place).toBe('10 km NW of Somewhere');

    expect(eq2.id).toBe('us7000abc2');
    expect(eq2.magnitude).toBe(3.1);
  });

  it('handles empty features array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ features: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useEarthquakes(true));

    // Stays empty since features is []
    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });

  it('handles missing features key gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useEarthquakes(true));

    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });

  it('stays empty on fetch error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fail'));
    const { result } = renderHook(() => useEarthquakes(true));

    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });
});
