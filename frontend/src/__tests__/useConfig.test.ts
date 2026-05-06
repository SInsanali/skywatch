import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useConfig } from '../hooks/useConfig';

afterEach(() => {
  vi.restoreAllMocks();
});

const mockConfigResponse = {
  feeds: [
    { name: 'aircraft', enabled: true, interval_seconds: 15, fixed: true, needs_key: false, has_api_key: false, api_key_masked: null, last_error: null },
    { name: 'eonet', enabled: false, interval_seconds: 1800, fixed: false, needs_key: false, has_api_key: false, api_key_masked: null, last_error: null },
  ],
  server: { host: '0.0.0.0', port: 8078 },
};

describe('useConfig', () => {
  it('fetches config on mount', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockConfigResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const { result } = renderHook(() => useConfig());
    await waitFor(() => {
      expect(result.current.feeds.length).toBe(2);
    });
    expect(result.current.feeds[0].name).toBe('aircraft');
  });

  it('updateFeed PUTs and refetches', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(mockConfigResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, restart_required: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(mockConfigResponse), { status: 200 }));

    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.feeds.length).toBe(2));

    await act(async () => {
      await result.current.updateFeed('eonet', { enabled: true });
    });

    const putCall = fetchMock.mock.calls.find(c => (c[1] as any)?.method === 'PUT');
    expect(putCall).toBeTruthy();
    expect(putCall![0]).toBe('/api/config/eonet');
    expect(JSON.parse((putCall![1] as any).body)).toEqual({ enabled: true });
  });

  it('throws on a failed update', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(mockConfigResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'interval out of range' }), { status: 400 }));

    const { result } = renderHook(() => useConfig());
    await waitFor(() => expect(result.current.feeds.length).toBe(2));

    let caught: Error | null = null;
    await act(async () => {
      try {
        await result.current.updateFeed('eonet', { interval: 1 });
      } catch (e) {
        caught = e as Error;
      }
    });
    expect(caught).toBeTruthy();
  });
});
