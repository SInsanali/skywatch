import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Aircraft, AircraftCategory, classifyAircraft, categoryColors, typeName } from '../types';
import { MapStyle } from './Globe';
import { Satellite } from '../hooks/useSatellites';
import { Earthquake } from '../hooks/useEarthquakes';
import { Ship } from '../hooks/useShips';
import type { SatelliteCategory } from '../App';

type RegionKey = 'global' | 'na' | 'eu' | 'asia' | 'me' | 'af' | 'sa' | 'oc';

interface RegionBounds {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

const regions: { key: RegionKey; label: string; bounds?: RegionBounds }[] = [
  { key: 'global', label: 'Global' },
  { key: 'na', label: 'N. America', bounds: { latMin: 10, latMax: 72, lonMin: -170, lonMax: -50 } },
  { key: 'eu', label: 'Europe', bounds: { latMin: 35, latMax: 72, lonMin: -12, lonMax: 45 } },
  { key: 'asia', label: 'Asia', bounds: { latMin: 5, latMax: 55, lonMin: 60, lonMax: 150 } },
  { key: 'me', label: 'Middle East', bounds: { latMin: 12, latMax: 42, lonMin: 25, lonMax: 65 } },
  { key: 'af', label: 'Africa', bounds: { latMin: -38, latMax: 38, lonMin: -20, lonMax: 55 } },
  { key: 'sa', label: 'S. America', bounds: { latMin: -58, latMax: 15, lonMin: -85, lonMax: -30 } },
  { key: 'oc', label: 'Oceania', bounds: { latMin: -50, latMax: 0, lonMin: 110, lonMax: 180 } },
];

interface SidebarProps {
  flights: Aircraft[];
  total: number;
  lastUpdate: number;
  error: string | null;
  filters: Record<AircraftCategory, boolean>;
  onFilterChange: (cat: AircraftCategory, val: boolean) => void;
  selected: Aircraft | null;
  selectedSat: Satellite | null;
  selectedQuake: Earthquake | null;
  onSelect: (ac: Aircraft) => void;
  onClose: () => void;
  mapStyle: MapStyle;
  onMapStyleChange: (style: MapStyle) => void;
  showAircraft: boolean;
  onAircraftChange: (val: boolean) => void;
  showTrails: boolean;
  onTrailsChange: (val: boolean) => void;
  showSatellites: boolean;
  onSatellitesChange: (val: boolean) => void;
  showEarthquakes: boolean;
  onEarthquakesChange: (val: boolean) => void;
  satelliteCount: number;
  earthquakeCount: number;
  selectedShip: Ship | null;
  showShips: boolean;
  onShipsChange: (val: boolean) => void;
  shipCount: number;
  showJamming: boolean;
  onJammingChange: (val: boolean) => void;
  jammingCount: number;
  showSatFootprint: boolean;
  onSatFootprintChange: (val: boolean) => void;
  satFilters: Record<SatelliteCategory, boolean>;
  onSatFilterChange: (cat: SatelliteCategory, val: boolean) => void;
  satCategoryCounts: Record<SatelliteCategory, number>;
  nearbySats: Satellite[];
  onSelectSat: (sat: Satellite) => void;
  onFlyToRegion: (region: RegionKey, bounds?: RegionBounds) => void;
}

const catLabels: Record<AircraftCategory, string> = {
  airline: 'Airline',
  private: 'Private / GA',
  military: 'Military',
  ground: 'On Ground',
};

const satCatLabels: Record<SatelliteCategory, string> = {
  earthObs: 'Earth Observation',
  comms: 'Communications',
  nav: 'Navigation',
  science: 'Space Science',
  stations: 'Space Stations',
  military: 'Military',
};

const satCatOrder: SatelliteCategory[] = ['earthObs', 'comms', 'nav', 'science', 'stations', 'military'];

const satCatColors: Record<SatelliteCategory, string> = {
  earthObs: '#4fc3f7',
  comms: '#b388ff',
  nav: '#69f0ae',
  science: '#ffd54f',
  stations: '#ffffff',
  military: '#ef5350',
};

const groupToCat: Record<string, SatelliteCategory> = {
  'Weather': 'earthObs', 'NOAA': 'earthObs', 'GOES': 'earthObs', 'Planet Labs': 'earthObs',
  'Starlink': 'comms', 'Iridium': 'comms', 'Globalstar': 'comms', 'OneWeb': 'comms',
  'GPS': 'nav', 'Galileo': 'nav',
  'Science': 'science', 'Space Stations': 'stations', 'Military': 'military',
};

function satGroupColor(group: string): string {
  return satCatColors[groupToCat[group] || 'comms'];
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><span style={styles.label}>{label}</span><br/><span style={{ fontWeight: 600, fontSize: 13 }}>{value}</span></div>;
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
      <span style={{ color: '#6b7685', fontSize: 11 }}>{label}</span>
      <span style={{ color: '#b0b8c4', fontSize: 11, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function metersToFeet(m: number | null): string {
  if (m == null) return '--';
  return Math.round(m * 3.28084).toLocaleString() + ' ft';
}

function msToKnots(ms: number | null): string {
  if (ms == null) return '--';
  return Math.round(ms * 1.94384).toLocaleString() + ' kts';
}

function fpmFromMs(ms: number | null): string {
  if (ms == null) return '--';
  const fpm = Math.round(ms * 196.85);
  return (fpm > 0 ? '+' : '') + fpm.toLocaleString() + ' fpm';
}

function Caret({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <span
      onClick={e => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      style={{
        fontSize: 8, cursor: 'pointer', transition: 'transform 0.15s',
        transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
        color: '#6b7685', userSelect: 'none', padding: '2px 0',
        display: 'inline-flex', alignItems: 'center',
      }}
    >&#9660;</span>
  );
}

function TopTypes({ flights, filters }: { flights: Aircraft[]; filters: Record<AircraftCategory, boolean> }) {
  const [expanded, setExpanded] = useState(false);

  const typeCounts = useMemo(() => {
    const bucket: Record<string, number> = {};
    for (const ac of flights) {
      const cat = classifyAircraft(ac);
      if (!filters[cat]) continue;
      const t = ac.type;
      if (t) bucket[t] = (bucket[t] || 0) + 1;
    }
    return Object.entries(bucket).sort((a, b) => b[1] - a[1]);
  }, [flights, filters]);

  return (
    <div style={styles.section}>
      <div
        style={{ ...styles.sectionTitle, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ fontSize: 8, transition: 'transform 0.15s', transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>&#9660;</span>
        Top Aircraft Types
      </div>
      {expanded && (
        <div style={{ maxHeight: 200, overflowY: 'auto' }}>
          {typeCounts.slice(0, 20).map(([code, count]) => (
            <div key={code} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 8px', fontSize: 11 }}>
              <span style={{ color: '#b0b8c4', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flex: 1 }}>{typeName(code)}</span>
              <span style={{ color: '#6b7685', fontWeight: 600, fontVariantNumeric: 'tabular-nums', marginLeft: 8 }}>{count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Sidebar({
  flights, total, lastUpdate, error, filters, onFilterChange, selected, onSelect, onClose,
  mapStyle, onMapStyleChange, showAircraft, onAircraftChange, showTrails, onTrailsChange,
  showSatellites, onSatellitesChange, showEarthquakes, onEarthquakesChange,
  satelliteCount, earthquakeCount,
  selectedSat, selectedQuake, selectedShip,
  showShips, onShipsChange, shipCount, showJamming, onJammingChange, jammingCount,
  showSatFootprint, onSatFootprintChange,
  satFilters, onSatFilterChange, satCategoryCounts,
  nearbySats, onSelectSat, onFlyToRegion,
}: SidebarProps) {
  const [search, setSearch] = useState('');
  const [activeRegion, setActiveRegion] = useState<RegionKey>('global');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const counts: Record<AircraftCategory, number> = { airline: 0, private: 0, military: 0, ground: 0 };
  for (const ac of flights) counts[classifyAircraft(ac)]++;

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || q.length < 2) return [];
    return flights.filter(ac => {
      const cs = ac.callsign?.toLowerCase() || '';
      const reg = ac.reg?.toLowerCase() || '';
      const op = ac.operator?.toLowerCase() || '';
      const icao = ac.icao24.toLowerCase();
      return cs.includes(q) || reg.includes(q) || op.includes(q) || icao.includes(q);
    }).slice(0, 8);
  }, [search, flights]);

  const handleRegionClick = (r: typeof regions[number]) => {
    setActiveRegion(r.key);
    onFlyToRegion(r.key, r.bounds);
  };

  return (
    <div style={styles.sidebar}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={styles.brand}>Sky<span style={{ color: '#4a90d9' }}>watch</span></div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Link to="/settings" title="Settings" style={{ ...styles.resetBtn, textDecoration: 'none' } as React.CSSProperties}>&#9881;</Link>
          <button
            onClick={() => onFlyToRegion('global')}
            title="Reset view"
            style={styles.resetBtn}
          >&#8962;</button>
        </div>
      </div>

      {/* Search */}
      <div style={styles.section}>
        <div style={styles.searchWrap}>
          <input
            type="text"
            placeholder="Search flights..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={styles.searchInput}
          />
          {search && (
            <button onClick={() => setSearch('')} style={styles.searchClear}>&times;</button>
          )}
        </div>
        {searchResults.length > 0 && (
          <div style={styles.searchResults}>
            {searchResults.map(ac => (
              <div
                key={ac.icao24}
                style={styles.searchRow}
                onClick={() => { onSelect(ac); setSearch(''); }}
                onMouseEnter={e => (e.currentTarget.style.background = '#1a2230')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={styles.searchCallsign}>{ac.callsign || ac.icao24.toUpperCase()}</span>
                <span style={styles.searchMeta}>
                  {ac.reg || ''}{ac.operator ? ` \u00B7 ${ac.operator}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Aircraft detail */}
      {selected && (
        <div style={styles.detail}>
          <div style={styles.detailHeader}>
            <span style={styles.detailCallsign}>{selected.flight || selected.callsign || selected.reg || selected.icao24.toUpperCase()}</span>
            <button onClick={onClose} style={styles.closeBtn}>&times;</button>
          </div>
          <div style={styles.detailSub}>{selected.airline || selected.operator || 'N/A'}</div>
          <div style={styles.detailModel}>{selected.model || typeName(selected.type)}</div>
          <div style={styles.detailGrid}>
            <Field label="ALT" value={metersToFeet(selected.baro_altitude)} />
            <Field label="GS" value={msToKnots(selected.velocity)} />
            <Field label="HDG" value={selected.true_track != null ? Math.round(selected.true_track) + '\u00B0' : 'N/A'} />
            <Field label="V/S" value={fpmFromMs(selected.vertical_rate)} />
            <Field label="IAS" value={selected.ias != null ? selected.ias + ' kts' : 'N/A'} />
            <Field label="MACH" value={selected.mach != null ? selected.mach.toFixed(3) : 'N/A'} />
          </div>
          <div style={styles.fieldList}>
            <FieldRow label="Registration" value={selected.reg || 'N/A'} />
            <FieldRow label="Operator" value={selected.operator || 'N/A'} />
            <FieldRow label="Squawk" value={selected.squawk || 'N/A'} />
            <FieldRow label="ICAO" value={selected.icao24.toUpperCase()} />
          </div>
          <a
            href={`https://www.flightradar24.com/${selected.callsign || selected.reg || selected.icao24.toUpperCase()}`}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.fr24Link}
          >
            Track on FR24 &#8599;
          </a>
        </div>
      )}

      {/* Satellite detail */}
      {selectedSat && (
        <div style={styles.detail}>
          <div style={styles.detailHeader}>
            <span style={{ ...styles.detailCallsign, color: satGroupColor(selectedSat.group) }}>{selectedSat.name}</span>
            <button onClick={onClose} style={styles.closeBtn}>&times;</button>
          </div>
          <div style={styles.detailSub}>{selectedSat.group || 'Satellite'}</div>
          <div style={styles.detailGrid}>
            <Field label="ALT" value={Math.round(selectedSat.altitude).toLocaleString() + ' km'} />
            <Field label="SPEED" value={selectedSat.velocity.toFixed(1) + ' km/s'} />
            <Field label="LAT" value={selectedSat.latitude.toFixed(2) + '\u00B0'} />
            <Field label="LON" value={selectedSat.longitude.toFixed(2) + '\u00B0'} />
          </div>
          {nearbySats.length > 0 && (
            <div style={styles.fieldList}>
              <div style={{ fontSize: 10, color: '#6b7685', textTransform: 'uppercase' as const, letterSpacing: 0.4, marginBottom: 4 }}>
                {selectedSat.group} constellation ({nearbySats.length})
              </div>
              <div style={{ maxHeight: 120, overflowY: 'auto' }}>
                {nearbySats.map(ns => (
                  <div
                    key={ns.name}
                    onClick={() => onSelectSat(ns)}
                    style={styles.nearbyRow}
                    onMouseEnter={e => (e.currentTarget.style.background = '#1a2230')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span style={{ color: satGroupColor(ns.group), fontSize: 11, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{ns.name}</span>
                    <span style={{ color: '#6b7685', fontSize: 10 }}>{Math.round(ns.altitude)} km</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Earthquake detail */}
      {selectedQuake && (
        <div style={styles.detail}>
          <div style={styles.detailHeader}>
            <span style={{ ...styles.detailCallsign, color: '#ff9800' }}>M{selectedQuake.magnitude.toFixed(1)}</span>
            <button onClick={onClose} style={styles.closeBtn}>&times;</button>
          </div>
          <div style={{ ...styles.detailSub, wordBreak: 'break-word' as const }}>{selectedQuake.place}</div>
          <div style={styles.detailGrid}>
            <Field label="DEPTH" value={Math.round(selectedQuake.depth) + ' km'} />
            <Field label="TIME" value={new Date(selectedQuake.time).toLocaleDateString()} />
            <Field label="LAT" value={selectedQuake.latitude.toFixed(2) + '\u00B0'} />
            <Field label="LON" value={selectedQuake.longitude.toFixed(2) + '\u00B0'} />
          </div>
        </div>
      )}

      {/* Ship detail */}
      {selectedShip && (
        <div style={styles.detail}>
          <div style={styles.detailHeader}>
            <span style={{ ...styles.detailCallsign, color: '#8bc34a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{selectedShip.name || 'Unknown'}</span>
            <button onClick={onClose} style={styles.closeBtn}>&times;</button>
          </div>
          <div style={styles.detailSub}>{selectedShip.category ? selectedShip.category.charAt(0).toUpperCase() + selectedShip.category.slice(1) : 'Vessel'}</div>
          <div style={styles.detailGrid}>
            <Field label="SOG" value={(selectedShip.sog?.toFixed(1) || '0') + ' kts'} />
            <Field label="COG" value={selectedShip.cog != null ? Math.round(selectedShip.cog) + '\u00B0' : 'N/A'} />
            <Field label="LENGTH" value={selectedShip.length ? selectedShip.length + ' m' : 'N/A'} />
            <Field label="WIDTH" value={selectedShip.width ? selectedShip.width + ' m' : 'N/A'} />
          </div>
          <div style={styles.fieldList}>
            <FieldRow label="Destination" value={selectedShip.destination || 'N/A'} />
            <FieldRow label="Call Sign" value={selectedShip.callsign || 'N/A'} />
            <FieldRow label="IMO" value={selectedShip.imo ? String(selectedShip.imo) : 'N/A'} />
            <FieldRow label="MMSI" value={String(selectedShip.mmsi)} />
          </div>
        </div>
      )}

      {/* Region pills */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Region</div>
        <div style={styles.pillGrid}>
          {regions.map(r => (
            <button
              key={r.key}
              onClick={() => handleRegionClick(r)}
              style={{
                ...styles.pill,
                ...(activeRegion === r.key ? styles.pillActive : {}),
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Layers — unified collapsible groups */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Layers</div>

        {/* Aircraft */}
        <div>
          <div style={styles.filterRow}>
            <input type="checkbox" checked={showAircraft} onChange={e => onAircraftChange(e.target.checked)} style={styles.checkbox} />
            <Caret open={!!expanded.aircraft} onClick={() => toggle('aircraft')} />
            <span style={{ ...styles.dot, background: '#f0c040' }} />
            <span style={styles.filterLabel}>Aircraft</span>
            <span style={styles.filterCount}>{total.toLocaleString()}</span>
          </div>
          {expanded.aircraft && (
            <div style={styles.subFilters}>
              <div style={styles.toggleAll} onClick={() => {
                const keys = Object.keys(catLabels) as AircraftCategory[];
                const allOn = keys.every(k => filters[k]);
                keys.forEach(k => onFilterChange(k, !allOn));
              }}>
                {(Object.keys(catLabels) as AircraftCategory[]).every(k => filters[k]) ? 'Deselect all' : 'Select all'}
              </div>
              {(Object.keys(catLabels) as AircraftCategory[]).map(cat => (
                <label key={cat} style={styles.subRow}>
                  <input type="checkbox" checked={filters[cat]} onChange={e => onFilterChange(cat, e.target.checked)} style={styles.checkbox} />
                  <span style={{ ...styles.dot, background: categoryColors[cat] }} />
                  <span style={styles.filterLabel}>{catLabels[cat]}</span>
                  <span style={styles.filterCount}>{counts[cat].toLocaleString()}</span>
                </label>
              ))}
              <label style={styles.subRow}>
                <input type="checkbox" checked={showTrails} onChange={e => onTrailsChange(e.target.checked)} style={styles.checkbox} />
                <span style={{ ...styles.dot, background: '#58a6ff' }} />
                <span style={styles.filterLabel}>Flight Trails</span>
              </label>
            </div>
          )}
        </div>

        {/* Satellites */}
        <div>
          <div style={styles.filterRow}>
            <input type="checkbox" checked={showSatellites} onChange={e => onSatellitesChange(e.target.checked)} style={styles.checkbox} />
            <Caret open={!!expanded.satellites} onClick={() => toggle('satellites')} />
            <span style={{ ...styles.dot, background: '#b388ff' }} />
            <span style={styles.filterLabel}>Satellites</span>
            <span style={styles.filterCount}>{satelliteCount.toLocaleString()}</span>
          </div>
          {expanded.satellites && (
            <div style={styles.subFilters}>
              <div style={styles.toggleAll} onClick={() => {
                const allOn = satCatOrder.every(k => satFilters[k]);
                satCatOrder.forEach(k => onSatFilterChange(k, !allOn));
              }}>
                {satCatOrder.every(k => satFilters[k]) ? 'Deselect all' : 'Select all'}
              </div>
              {satCatOrder.map(cat => (
                <label key={cat} style={styles.subRow}>
                  <input type="checkbox" checked={satFilters[cat]} onChange={e => onSatFilterChange(cat, e.target.checked)} style={styles.checkbox} />
                  <span style={{ ...styles.dot, background: satCatColors[cat] }} />
                  <span style={styles.filterLabel}>{satCatLabels[cat]}</span>
                  <span style={styles.filterCount}>{satCategoryCounts[cat].toLocaleString()}</span>
                </label>
              ))}
              <label style={styles.subRow}>
                <input type="checkbox" checked={showSatFootprint} onChange={e => onSatFootprintChange(e.target.checked)} style={styles.checkbox} />
                <span style={styles.filterLabel}>Scan Cones</span>
              </label>
            </div>
          )}
        </div>

        {/* Earthquakes */}
        <div style={styles.filterRow}>
          <input type="checkbox" checked={showEarthquakes} onChange={e => onEarthquakesChange(e.target.checked)} style={styles.checkbox} />
          <span style={{ ...styles.dot, background: '#ff9800' }} />
          <span style={styles.filterLabel}>Earthquakes</span>
          <span style={styles.filterCount}>{earthquakeCount}</span>
        </div>

        {/* Ships */}
        <div style={styles.filterRow}>
          <input type="checkbox" checked={showShips} onChange={e => onShipsChange(e.target.checked)} style={styles.checkbox} />
          <span style={{ ...styles.dot, background: '#8bc34a' }} />
          <span style={styles.filterLabel}>Ships</span>
          <span style={styles.filterCount}>{shipCount}</span>
        </div>

        {/* GPS Jamming */}
        <div style={styles.filterRow}>
          <input type="checkbox" checked={showJamming} onChange={e => onJammingChange(e.target.checked)} style={styles.checkbox} />
          <span style={{ ...styles.dot, background: '#ef5350' }} />
          <span style={styles.filterLabel}>GPS Jamming</span>
          <span style={styles.filterCount}>{jammingCount}</span>
        </div>
      </div>

      {/* Top Aircraft Types */}
      <TopTypes flights={flights} filters={filters} />

      {/* Map Style */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Map</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['dark', 'satellite'] as MapStyle[]).map(s => (
            <button
              key={s}
              onClick={() => onMapStyleChange(s)}
              style={{
                ...styles.pill,
                ...(mapStyle === s ? styles.pillActive : {}),
              }}
            >
              {s === 'dark' ? 'Dark' : 'Satellite'}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div style={styles.stats}>
        <div>Total: <strong>{total.toLocaleString()}</strong></div>
        {lastUpdate > 0 && (
          <div style={{ color: '#6b7685', fontSize: 11 }}>
            {new Date(lastUpdate * 1000).toLocaleTimeString()}
          </div>
        )}
        {error && <div style={{ color: '#f85149', fontSize: 11 }}>{error}</div>}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sidebar: {
    position: 'absolute', top: 0, left: 0, bottom: 0, width: 240,
    background: 'rgba(10, 14, 20, 0.92)', backdropFilter: 'blur(12px)',
    borderRight: '1px solid #1a2230', zIndex: 10,
    display: 'flex', flexDirection: 'column', padding: '16px 14px',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', color: '#b0b8c4',
    fontSize: 13, overflowY: 'auto',
  },
  brand: { fontSize: 18, fontWeight: 700, letterSpacing: -0.5, marginBottom: 16 },
  section: { marginBottom: 16 },
  sectionTitle: {
    fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const,
    letterSpacing: 0.8, color: '#6b7685', marginBottom: 6,
  },
  filterRow: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
    cursor: 'pointer', borderRadius: 6, marginBottom: 1,
  },
  subFilters: {
    paddingLeft: 16, borderLeft: '1px solid #1a2230', marginLeft: 18, marginBottom: 4,
  },
  subRow: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '3px 8px',
    cursor: 'pointer', borderRadius: 6, marginBottom: 1, fontSize: 12,
  },
  toggleAll: {
    fontSize: 10, fontWeight: 500, color: '#4a90d9', cursor: 'pointer',
    padding: '2px 8px', marginBottom: 2, textAlign: 'right' as const,
  },
  checkbox: { width: 14, height: 14, accentColor: '#4a90d9', flexShrink: 0 },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  filterLabel: { flex: 1, fontWeight: 500 },
  filterCount: { color: '#3d4654', fontSize: 11, fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
  stats: { marginTop: 'auto', paddingTop: 14, borderTop: '1px solid #1a2230', fontSize: 12 },
  detail: {
    background: '#141c26', border: '1px solid #1a2230', borderRadius: 10,
    padding: 14, marginBottom: 14,
  },
  detailHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  detailCallsign: { fontSize: 18, fontWeight: 700, color: '#f0c040' },
  closeBtn: {
    background: 'none', border: 'none', color: '#6b7685', fontSize: 20,
    cursor: 'pointer', padding: '0 4px',
  },
  detailSub: { fontSize: 13, color: '#b0b8c4', fontWeight: 500, marginTop: 2 },
  detailModel: { fontSize: 14, color: '#b0b8c4', fontWeight: 600, marginTop: 6 },
  detailType: { fontSize: 12, color: '#6b7685', marginTop: 2 },
  detailGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 12px',
    marginTop: 10, fontSize: 13, fontWeight: 600,
  },
  label: { fontSize: 10, color: '#6b7685', textTransform: 'uppercase' as const, letterSpacing: 0.4 },
  detailField: { fontSize: 12, color: '#6b7685', marginTop: 4 },
  fieldList: { marginTop: 10, borderTop: '1px solid #1a2230', paddingTop: 8 },
  nearbyRow: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px',
    cursor: 'pointer', borderRadius: 4, transition: 'background 0.1s',
  } as React.CSSProperties,
  fr24Link: {
    display: 'inline-block', marginTop: 10, padding: '5px 12px',
    background: '#4a90d9', color: '#fff', textDecoration: 'none',
    borderRadius: 6, fontSize: 12, fontWeight: 600, textAlign: 'center' as const,
  },
  resetBtn: {
    background: '#141c26', border: '1px solid #1a2230', color: '#6b7685',
    borderRadius: 6, width: 28, height: 28, fontSize: 16, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'all 0.15s',
  } as React.CSSProperties,
  pill: {
    padding: '4px 12px', fontSize: 11, fontWeight: 600, borderRadius: 10,
    border: '1px solid #1a2230', background: '#141c26', color: '#6b7685',
    cursor: 'pointer', transition: 'all 0.15s',
  } as React.CSSProperties,
  pillActive: {
    background: '#4a90d9', color: '#fff', borderColor: '#4a90d9',
  } as React.CSSProperties,
  pillGrid: {
    display: 'flex', flexWrap: 'wrap' as const, gap: 6,
  },
  searchWrap: {
    position: 'relative' as const,
  },
  searchInput: {
    width: '100%', padding: '7px 28px 7px 10px', fontSize: 12,
    background: '#141c26', border: '1px solid #1a2230', borderRadius: 8,
    color: '#b0b8c4', outline: 'none',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    boxSizing: 'border-box' as const,
  },
  searchClear: {
    position: 'absolute' as const, right: 6, top: '50%', transform: 'translateY(-50%)',
    background: 'none', border: 'none', color: '#6b7685', fontSize: 16,
    cursor: 'pointer', padding: '0 4px', lineHeight: 1,
  },
  searchResults: {
    marginTop: 4, background: '#141c26', border: '1px solid #1a2230',
    borderRadius: 8, overflow: 'hidden',
  },
  searchRow: {
    padding: '6px 10px', cursor: 'pointer',
    display: 'flex', flexDirection: 'column' as const, gap: 1,
    transition: 'background 0.1s',
  },
  searchCallsign: {
    fontSize: 12, fontWeight: 600, color: '#f0c040',
  },
  searchMeta: {
    fontSize: 11, color: '#6b7685', whiteSpace: 'nowrap' as const,
    overflow: 'hidden', textOverflow: 'ellipsis',
  },
};
