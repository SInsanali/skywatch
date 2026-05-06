import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useEonet } from '../hooks/useEonet';

afterEach(() => { vi.restoreAllMocks(); });

const mockResp = {
  events: [
    { id: 'X1', title: 'Fire', category: 'wildfires', geometry: [{ date: '2026-04-30T18:00:00Z', type: 'Point', coordinates: [-120.5, 38.7] }], last_update: '2026-04-30T18:00:00Z' },
  ],
};

describe('useEonet', () => {
  it('returns empty when disabled', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const { result } = renderHook(() => useEonet(false));
    expect(result.current).toEqual([]);
  });

  it('fetches and returns events when enabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockResp), { status: 200 }));
    const { result } = renderHook(() => useEonet(true));
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0].id).toBe('X1');
    expect(result.current[0].category).toBe('wildfires');
  });

  it('returns empty on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fail'));
    const { result } = renderHook(() => useEonet(true));
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
