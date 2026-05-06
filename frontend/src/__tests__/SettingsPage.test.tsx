import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from '../pages/SettingsPage';

afterEach(() => { vi.restoreAllMocks(); });

const mockConfig = {
  feeds: [
    { name: 'aircraft', enabled: true, interval_seconds: 15, fixed: true, needs_key: false, has_api_key: false, api_key_masked: null, last_error: null },
    { name: 'earthquakes', enabled: false, interval_seconds: 1800, fixed: false, needs_key: false, has_api_key: false, api_key_masked: null, last_error: null },
  ],
  server: { host: '0.0.0.0', port: 8078 },
};

describe('SettingsPage', () => {
  it('renders one card per feed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockConfig), { status: 200 }));
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await waitFor(() => {
      expect(screen.getByText('aircraft')).toBeTruthy();
      expect(screen.getByText('earthquakes')).toBeTruthy();
    });
  });

  it('shows back link to globe', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockConfig), { status: 200 }));
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /globe/i })).toBeTruthy();
  });
});
