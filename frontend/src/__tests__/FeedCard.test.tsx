import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FeedCard from '../components/FeedCard';
import type { FeedConfig } from '../hooks/useConfig';

afterEach(() => { vi.restoreAllMocks(); });

const baseFeed: FeedConfig = {
  name: 'earthquakes', enabled: false, interval_seconds: 1800,
  fixed: false, needs_key: false, has_api_key: false,
  api_key_masked: null, last_error: null,
};

describe('FeedCard', () => {
  it('renders feed name', () => {
    render(<FeedCard feed={baseFeed} onSave={vi.fn()} />);
    expect(screen.getByText(/earthquakes/i)).toBeTruthy();
  });

  it('calls onSave with toggled enabled when Save clicked after toggling', () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, restart_required: [] });
    render(<FeedCard feed={baseFeed} onSave={onSave} />);
    const toggle = screen.getByRole('checkbox', { name: /enabled/i });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith('earthquakes', expect.objectContaining({ enabled: true }));
  });

  it('disables enabled toggle when feed.fixed is true', () => {
    render(<FeedCard feed={{ ...baseFeed, name: 'aircraft', fixed: true, enabled: true }} onSave={vi.fn()} />);
    const toggle = screen.getByRole('checkbox', { name: /enabled/i });
    expect((toggle as HTMLInputElement).disabled).toBe(true);
  });

  it('shows masked key and an Edit button when has_api_key', () => {
    render(<FeedCard feed={{ ...baseFeed, name: 'ships', needs_key: true, has_api_key: true, api_key_masked: '••••3456' }} onSave={vi.fn()} />);
    expect(screen.getByText('••••3456')).toBeTruthy();
    expect(screen.getByRole('button', { name: /edit/i })).toBeTruthy();
  });

  it('shows last_error in red when set', () => {
    render(<FeedCard feed={{ ...baseFeed, last_error: 'HTTP 503' }} onSave={vi.fn()} />);
    expect(screen.getByText(/HTTP 503/)).toBeTruthy();
  });
});
