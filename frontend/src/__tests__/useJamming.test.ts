import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useJamming } from '../hooks/useJamming';

afterEach(() => {
  vi.restoreAllMocks();
});

const mockJammingResponse = {
  zones: [
    { lat: 33.5, lon: 36.3, total: 100, degraded: 45, pct: 45, level: 'high' as const },
    { lat: 50.4, lon: 30.5, total: 80, degraded: 10, pct: 12.5, level: 'low' as const },
  ],
  timestamp: 1700000000,
};

describe('useJamming', () => {
  it('returns empty array when disabled', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const { result } = renderHook(() => useJamming(false));
    expect(result.current).toEqual([]);
  });

  it('fetches and returns jamming zones', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockJammingResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useJamming(true));

    await waitFor(() => {
      expect(result.current.length).toBe(2);
    });

    expect(result.current[0].lat).toBe(33.5);
    expect(result.current[0].level).toBe('high');
    expect(result.current[0].pct).toBe(45);

    expect(result.current[1].lat).toBe(50.4);
    expect(result.current[1].level).toBe('low');
  });

  it('handles response with empty zones array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ zones: [], timestamp: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useJamming(true));

    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });

  it('handles missing zones key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ timestamp: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useJamming(true));

    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });

  it('stays empty on fetch error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fail'));
    const { result } = renderHook(() => useJamming(true));

    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });

  it('stays empty on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 500 }),
    );

    const { result } = renderHook(() => useJamming(true));

    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });
});
