import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { Viewer as CesiumViewer, Cartesian3, Math as CesiumMath, Rectangle } from 'cesium';
import Globe, { MapStyle } from './components/Globe';
import FlightLayer from './components/FlightLayer';
import AltitudeIndicator from './components/AltitudeIndicator';
import SatelliteLayer from './components/SatelliteLayer';
import EarthquakeLayer from './components/EarthquakeLayer';
import JammingLayer from './components/JammingLayer';
import Sidebar from './components/Sidebar';
import { useFlights } from './hooks/useFlights';
import { useSatellites, Satellite } from './hooks/useSatellites';
import { useEarthquakes, Earthquake } from './hooks/useEarthquakes';
import { useShips, Ship } from './hooks/useShips';
import { useJamming } from './hooks/useJamming';
import ShipLayer from './components/ShipLayer';
import { Aircraft, AircraftCategory } from './types';
import type { ShaderMode } from './shaders/postprocess';

export type SatelliteCategory = 'earthObs' | 'comms' | 'nav' | 'science' | 'stations' | 'military';

const SAT_CATEGORY_MAP: Record<string, SatelliteCategory> = {
  'Weather': 'earthObs', 'NOAA': 'earthObs', 'GOES': 'earthObs', 'Planet Labs': 'earthObs',
  'Starlink': 'comms', 'Iridium': 'comms', 'Globalstar': 'comms', 'OneWeb': 'comms',
  'GPS': 'nav', 'Galileo': 'nav',
  'Science': 'science',
  'Space Stations': 'stations',
  'Military': 'military',
};

const PREFS_KEY = 'skywatch-prefs';
function loadPrefs(): Record<string, any> {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { return {}; }
}

export default function App() {
  const [prefs] = useState(loadPrefs);
  const [filters, setFilters] = useState<Record<AircraftCategory, boolean>>(
    prefs.filters ?? { airline: true, private: true, military: true, ground: true },
  );
  const [selected, setSelected] = useState<Aircraft | null>(null);
  const [selectedSat, setSelectedSat] = useState<Satellite | null>(null);
  const [selectedQuake, setSelectedQuake] = useState<Earthquake | null>(null);
  const [selectedShip, setSelectedShip] = useState<Ship | null>(null);
  const [mapStyle, setMapStyle] = useState<MapStyle>(prefs.mapStyle ?? 'dark');
  const [showAircraft, setShowAircraft] = useState(prefs.showAircraft ?? true);
  const [showTrails, setShowTrails] = useState(prefs.showTrails ?? true);
  const [showSatellites, setShowSatellites] = useState(prefs.showSatellites ?? true);
  const [showEarthquakes, setShowEarthquakes] = useState(prefs.showEarthquakes ?? true);
  const [showShips, setShowShips] = useState(prefs.showShips ?? true);
  const [showJamming, setShowJamming] = useState(prefs.showJamming ?? true);
  const [showSatFootprint, setShowSatFootprint] = useState(prefs.showSatFootprint ?? true);
  const [shaderMode, setShaderMode] = useState<ShaderMode>(prefs.shaderMode ?? 'none');
  const [satFilters, setSatFilters] = useState<Record<SatelliteCategory, boolean>>(
    prefs.satFilters ?? { earthObs: true, comms: true, nav: true, science: true, stations: true, military: true },
  );
  const [nearbySats, setNearbySats] = useState<Satellite[]>([]);
  const viewerRef = useRef<CesiumViewer | null>(null);

  const { flights, total, lastUpdate, error } = useFlights(true);
  const satellites = useSatellites(showSatellites);
  const earthquakes = useEarthquakes(showEarthquakes);
  const ships = useShips(showShips);
  const jammingZones = useJamming(showJamming);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        filters, satFilters, mapStyle, shaderMode,
        showAircraft, showTrails, showSatellites, showEarthquakes, showShips, showJamming, showSatFootprint,
      }));
    } catch {}
  }, [filters, satFilters, mapStyle, shaderMode, showAircraft, showTrails, showSatellites, showEarthquakes, showShips, showJamming, showSatFootprint]);

  const visibleSatellites = useMemo(
    () => satellites.filter(s => {
      const cat = SAT_CATEGORY_MAP[s.group];
      return cat ? satFilters[cat] : true;
    }),
    [satellites, satFilters],
  );

  const satCategoryCounts = useMemo(() => {
    const c: Record<SatelliteCategory, number> = { earthObs: 0, comms: 0, nav: 0, science: 0, stations: 0, military: 0 };
    for (const s of satellites) { const cat = SAT_CATEGORY_MAP[s.group]; if (cat) c[cat]++; }
    return c;
  }, [satellites]);

  const handleFilterChange = useCallback((cat: AircraftCategory, val: boolean) => {
    setFilters(prev => ({ ...prev, [cat]: val }));
  }, []);

  const handleSatFilterChange = useCallback((cat: SatelliteCategory, val: boolean) => {
    setSatFilters(prev => ({ ...prev, [cat]: val }));
  }, []);

  const handleSelect = useCallback((ac: Aircraft | null) => {
    setSelected(ac);
    setSelectedSat(null);
    setSelectedQuake(null);
    setSelectedShip(null);
    if (ac && viewerRef.current) {
      viewerRef.current.camera.flyTo({
        destination: Cartesian3.fromDegrees(ac.longitude, ac.latitude, 3_000_000),
        duration: 1.5,
      });
    }
  }, []);

  const handleSelectSat = useCallback((sat: Satellite | null) => {
    setSelectedSat(sat);
    setSelected(null);
    setSelectedQuake(null);
    setSelectedShip(null);
    if (sat && viewerRef.current) {
      const camAlt = Math.max(sat.altitude * 3000, 3_000_000);
      viewerRef.current.camera.flyTo({
        destination: Cartesian3.fromDegrees(sat.longitude, sat.latitude, camAlt),
        duration: 1.5,
      });
    }
  }, []);

  const handleSelectQuake = useCallback((eq: Earthquake | null) => {
    setSelectedQuake(eq);
    setSelected(null);
    setSelectedSat(null);
    setSelectedShip(null);
  }, []);

  const handleViewerReady = useCallback((viewer: CesiumViewer) => {
    viewerRef.current = viewer;
  }, []);

  const handleFlyToRegion = useCallback((region: string, bounds?: { latMin: number; latMax: number; lonMin: number; lonMax: number }) => {
    if (!viewerRef.current) return;
    const camera = viewerRef.current.camera;

    if (!bounds) {
      camera.flyTo({
        destination: Cartesian3.fromDegrees(-40, 30, 20_000_000),
        orientation: {
          heading: CesiumMath.toRadians(0),
          pitch: CesiumMath.toRadians(-90),
          roll: 0,
        },
        duration: 1.5,
      });
    } else {
      camera.flyTo({
        destination: Rectangle.fromDegrees(bounds.lonMin, bounds.latMin, bounds.lonMax, bounds.latMax),
        duration: 1.5,
      });
    }
  }, []);

  const handleSelectShip = useCallback((ship: Ship | null) => {
    setSelectedShip(ship);
    setSelected(null);
    setSelectedSat(null);
    setSelectedQuake(null);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelected(null);
    setSelectedSat(null);
    setSelectedQuake(null);
    setSelectedShip(null);
  }, []);

  return (
    <>
      <Globe mapStyle={mapStyle} shaderMode={shaderMode} onViewerReady={handleViewerReady}>
        {showAircraft && <FlightLayer
          flights={flights}
          selected={selected}
          onSelect={handleSelect}
          filters={filters}
          showTrails={showTrails}
        />}
        <AltitudeIndicator />
        {showSatellites && <SatelliteLayer satellites={visibleSatellites} selected={selectedSat} onSelect={handleSelectSat} showFootprint={showSatFootprint} onNearbySatellites={setNearbySats} />}
        {showEarthquakes && <EarthquakeLayer earthquakes={earthquakes} onSelect={handleSelectQuake} />}
        {showShips && <ShipLayer ships={ships} selected={selectedShip} onSelect={handleSelectShip} />}
        {showJamming && <JammingLayer zones={jammingZones} />}
      </Globe>
      <Sidebar
        flights={flights}
        total={total}
        lastUpdate={lastUpdate}
        error={error}
        filters={filters}
        onFilterChange={handleFilterChange}
        selected={selected}
        selectedSat={selectedSat}
        selectedQuake={selectedQuake}
        onSelect={handleSelect}
        onClose={handleCloseDetail}
        mapStyle={mapStyle}
        onMapStyleChange={setMapStyle}
        showAircraft={showAircraft}
        onAircraftChange={setShowAircraft}
        showTrails={showTrails}
        onTrailsChange={setShowTrails}
        showSatellites={showSatellites}
        onSatellitesChange={setShowSatellites}
        showEarthquakes={showEarthquakes}
        onEarthquakesChange={setShowEarthquakes}
        satelliteCount={visibleSatellites.length}
        earthquakeCount={earthquakes.length}
        selectedShip={selectedShip}
        showShips={showShips}
        onShipsChange={setShowShips}
        shipCount={ships.length}
        showJamming={showJamming}
        onJammingChange={setShowJamming}
        jammingCount={jammingZones.length}
        showSatFootprint={showSatFootprint}
        onSatFootprintChange={setShowSatFootprint}
        satFilters={satFilters}
        onSatFilterChange={handleSatFilterChange}
        satCategoryCounts={satCategoryCounts}
        nearbySats={nearbySats}
        onSelectSat={handleSelectSat}
        onFlyToRegion={handleFlyToRegion}
        shaderMode={shaderMode}
        onShaderModeChange={setShaderMode}
      />
      <div style={{
        position: 'absolute', bottom: 8, left: 260, display: 'flex', gap: 14,
        padding: '3px 12px', background: 'rgba(10,14,20,0.6)', borderRadius: 10,
        fontSize: 10, color: '#6b7685', fontFamily: '-apple-system, sans-serif',
        pointerEvents: 'none', zIndex: 5,
      }}>
        {[
          ['#f0c040', 'Aircraft'],
          ['#b388ff', 'Satellites'],
          ['#ff9800', 'Earthquakes'],
          ['#8bc34a', 'Ships'],
          ['#ef5350', 'GPS Jamming'],
        ].map(([color, label]) => (
          <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
            {label}
          </span>
        ))}
      </div>
    </>
  );
}
