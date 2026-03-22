import { useState, useCallback, useRef } from 'react';
import { Viewer as CesiumViewer, Cartesian3, Math as CesiumMath, Rectangle } from 'cesium';
import Globe, { MapStyle } from './components/Globe';
import FlightLayer from './components/FlightLayer';
import AltitudeIndicator from './components/AltitudeIndicator';
import SatelliteLayer from './components/SatelliteLayer';
import EarthquakeLayer from './components/EarthquakeLayer';
import Sidebar from './components/Sidebar';
import { useFlights } from './hooks/useFlights';
import { useSatellites, Satellite } from './hooks/useSatellites';
import { useEarthquakes, Earthquake } from './hooks/useEarthquakes';
import { useShips, Ship } from './hooks/useShips';
import ShipLayer from './components/ShipLayer';
import { Aircraft, AircraftCategory } from './types';

export default function App() {
  const [filters, setFilters] = useState<Record<AircraftCategory, boolean>>({
    airline: true, private: true, military: true, ground: true,
  });
  const [selected, setSelected] = useState<Aircraft | null>(null);
  const [selectedSat, setSelectedSat] = useState<Satellite | null>(null);
  const [selectedQuake, setSelectedQuake] = useState<Earthquake | null>(null);
  const [selectedShip, setSelectedShip] = useState<Ship | null>(null);
  const [mapStyle, setMapStyle] = useState<MapStyle>('dark');
  const [showAircraft, setShowAircraft] = useState(true);
  const [showTrails, setShowTrails] = useState(true);
  const [showSatellites, setShowSatellites] = useState(true);
  const [showEarthquakes, setShowEarthquakes] = useState(true);
  const [showShips, setShowShips] = useState(true);
  const [showSatFootprint, setShowSatFootprint] = useState(true);
  const viewerRef = useRef<CesiumViewer | null>(null);

  const { flights, total, lastUpdate, error } = useFlights(true);
  const satellites = useSatellites(showSatellites);
  const earthquakes = useEarthquakes(showEarthquakes);
  const ships = useShips(showShips);

  const handleFilterChange = useCallback((cat: AircraftCategory, val: boolean) => {
    setFilters(prev => ({ ...prev, [cat]: val }));
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
      <Globe mapStyle={mapStyle} onViewerReady={handleViewerReady}>
        {showAircraft && <FlightLayer
          flights={flights}
          selected={selected}
          onSelect={handleSelect}
          filters={filters}
          showTrails={showTrails}
        />}
        <AltitudeIndicator />
        {showSatellites && <SatelliteLayer satellites={satellites} selected={selectedSat} onSelect={handleSelectSat} showFootprint={showSatFootprint} />}
        {showEarthquakes && <EarthquakeLayer earthquakes={earthquakes} onSelect={handleSelectQuake} />}
        {showShips && <ShipLayer ships={ships} selected={selectedShip} onSelect={handleSelectShip} />}
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
        satelliteCount={satellites.length}
        earthquakeCount={earthquakes.length}
        selectedShip={selectedShip}
        showShips={showShips}
        onShipsChange={setShowShips}
        shipCount={ships.length}
        showSatFootprint={showSatFootprint}
        onSatFootprintChange={setShowSatFootprint}
        onFlyToRegion={handleFlyToRegion}
      />
    </>
  );
}
