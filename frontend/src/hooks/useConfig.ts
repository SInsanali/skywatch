import { useState, useEffect, useCallback } from 'react';

export interface FeedConfig {
  name: string;
  enabled: boolean;
  interval_seconds: number;
  fixed: boolean;
  needs_key: boolean;
  has_api_key: boolean;
  api_key_masked: string | null;
  last_error: string | null;
}

export interface ConfigSnapshot {
  feeds: FeedConfig[];
  server: { host: string; port: number };
}

export interface FeedUpdatePartial {
  enabled?: boolean;
  interval?: number;
  api_key?: string;
}

export function useConfig() {
  const [feeds, setFeeds] = useState<FeedConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ConfigSnapshot = await res.json();
      setFeeds(data.feeds);
      setError(null);
    } catch (e: any) {
      console.error('[Skywatch] Config fetch failed:', e);
      setError(e.message || 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  const updateFeed = useCallback(async (name: string, partial: FeedUpdatePartial) => {
    const res = await fetch(`/api/config/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    const result = await res.json();
    await refetch();
    return result as { ok: boolean; restart_required: string[] };
  }, [refetch]);

  return { feeds, loading, error, updateFeed, refetch };
}
