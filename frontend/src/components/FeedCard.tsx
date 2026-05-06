import { useState } from 'react';
import type { FeedConfig, FeedUpdatePartial } from '../hooks/useConfig';

interface Props {
  feed: FeedConfig;
  onSave: (name: string, partial: FeedUpdatePartial) => Promise<{ ok: boolean; restart_required: string[] }>;
}

export default function FeedCard({ feed, onSave }: Props) {
  const [enabled, setEnabled] = useState(feed.enabled);
  const [interval, setIntervalValue] = useState(feed.interval_seconds);
  const [editingKey, setEditingKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [restartRequired, setRestartRequired] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty = enabled !== feed.enabled || interval !== feed.interval_seconds || (editingKey && !!keyDraft);

  const handleSave = async () => {
    const partial: FeedUpdatePartial = {};
    if (enabled !== feed.enabled) partial.enabled = enabled;
    if (interval !== feed.interval_seconds) partial.interval = interval;
    if (editingKey && keyDraft) partial.api_key = keyDraft;

    setSaving(true);
    setSaveError(null);
    try {
      const result = await onSave(feed.name, partial);
      setRestartRequired(result.restart_required);
      setEditingKey(false);
      setKeyDraft('');
    } catch (e: any) {
      setSaveError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const statusColor = feed.last_error ? '#ef5350' : feed.enabled ? '#69f0ae' : '#6b7685';

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={{ ...styles.dot, background: statusColor }} />
        <span style={styles.name}>{feed.name}</span>
      </div>

      <label style={styles.row}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={feed.fixed}
          aria-label="enabled"
          onChange={e => setEnabled(e.target.checked)}
        />
        <span>Enabled{feed.fixed ? ' (locked)' : ''}</span>
      </label>

      <label style={styles.row}>
        <span style={styles.label}>Polling interval (s)</span>
        <input
          type="number"
          min={5}
          max={86400}
          value={interval}
          onChange={e => setIntervalValue(Number(e.target.value))}
          style={styles.input}
        />
      </label>

      {feed.needs_key && (
        <div style={styles.row}>
          <span style={styles.label}>API key</span>
          {!editingKey ? (
            <>
              <span style={styles.maskedKey}>{feed.api_key_masked || '— not set —'}</span>
              <button onClick={() => setEditingKey(true)} style={styles.smallBtn}>Edit</button>
            </>
          ) : (
            <input
              type="text"
              value={keyDraft}
              onChange={e => setKeyDraft(e.target.value)}
              placeholder="paste new key"
              style={styles.input}
            />
          )}
        </div>
      )}

      {feed.last_error && (
        <div style={styles.error}>Last error: {feed.last_error}</div>
      )}
      {restartRequired.length > 0 && (
        <div style={styles.warn}>Restart required for: {restartRequired.join(', ')}. Run: <code>docker compose restart</code></div>
      )}
      {saveError && <div style={styles.error}>{saveError}</div>}

      <button onClick={handleSave} disabled={!dirty || saving} style={styles.saveBtn}>
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: { background: '#141c26', border: '1px solid #1a2230', borderRadius: 10, padding: 16, marginBottom: 14, color: '#b0b8c4', fontFamily: '-apple-system, sans-serif' },
  header: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  dot: { width: 10, height: 10, borderRadius: '50%' },
  name: { fontSize: 16, fontWeight: 700, textTransform: 'capitalize' },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 13 },
  label: { minWidth: 140, color: '#6b7685' },
  input: { background: '#0a1018', border: '1px solid #1a2230', borderRadius: 6, color: '#b0b8c4', padding: '4px 8px', fontSize: 13 },
  maskedKey: { fontFamily: 'monospace', color: '#b0b8c4' },
  smallBtn: { background: 'none', border: '1px solid #1a2230', color: '#4a90d9', padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11 },
  error: { color: '#ef5350', fontSize: 12, marginTop: 6 },
  warn: { color: '#ffb74d', fontSize: 12, marginTop: 6 },
  saveBtn: { background: '#4a90d9', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', marginTop: 10 },
};
