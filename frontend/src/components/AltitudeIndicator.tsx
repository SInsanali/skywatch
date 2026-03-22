import { useEffect, useRef, useState } from 'react';
import { useCesium } from 'resium';
import { Math as CesiumMath } from 'cesium';

function formatAlt(meters: number): string {
  if (meters > 1_000_000) return (meters / 1_000_000).toFixed(1) + 'M km';
  if (meters > 100_000) return Math.round(meters / 1000) + ' km';
  if (meters > 1_000) return (meters / 1000).toFixed(1) + ' km';
  return Math.round(meters) + ' m';
}

export default function AltitudeIndicator() {
  const { viewer } = useCesium();
  const [altitude, setAltitude] = useState('');
  const rafRef = useRef(0);

  useEffect(() => {
    if (!viewer) return;

    const update = () => {
      const height = viewer.camera.positionCartographic.height;
      setAltitude(formatAlt(height));
      rafRef.current = requestAnimationFrame(update);
    };

    rafRef.current = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafRef.current);
  }, [viewer]);

  if (!altitude) return null;

  return (
    <div style={styles.container}>
      <div style={styles.label}>ALT</div>
      <div style={styles.value}>{altitude}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    background: 'rgba(10, 14, 20, 0.85)',
    backdropFilter: 'blur(8px)',
    border: '1px solid #1a2230',
    borderRadius: 8,
    padding: '6px 12px',
    zIndex: 10,
    textAlign: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
  },
  label: {
    fontSize: 9,
    fontWeight: 600,
    color: '#6b7685',
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
  },
  value: {
    fontSize: 13,
    fontWeight: 700,
    color: '#b0b8c4',
    fontVariantNumeric: 'tabular-nums',
  },
};
