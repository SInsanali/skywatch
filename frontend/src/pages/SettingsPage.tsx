import { Link } from 'react-router-dom';
import FeedCard from '../components/FeedCard';
import { useConfig } from '../hooks/useConfig';

export default function SettingsPage() {
  const { feeds, loading, error, updateFeed } = useConfig();

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <Link to="/" style={styles.back}>← Globe</Link>
        <h1 style={styles.title}>Settings</h1>
      </div>
      {loading && <div style={styles.note}>Loading…</div>}
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.list}>
        {feeds.map(f => (
          <FeedCard key={f.name} feed={f} onSave={updateFeed} />
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    position: 'fixed', inset: 0, overflowY: 'auto',
    background: '#0a0e14', color: '#b0b8c4',
    fontFamily: '-apple-system, sans-serif', padding: 24,
  },
  header: { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 },
  back: { color: '#4a90d9', textDecoration: 'none', fontSize: 13 },
  title: { margin: 0, fontSize: 22, fontWeight: 700, color: '#f0c040' },
  list: { maxWidth: 720 },
  note: { color: '#6b7685', fontSize: 13 },
  error: { color: '#ef5350', fontSize: 13 },
};
