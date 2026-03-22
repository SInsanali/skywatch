import { useEffect, useRef } from 'react';
import { useCesium } from 'resium';
import {
  BillboardCollection,
  Cartesian3,
  Cartesian2,
  VerticalOrigin,
  HorizontalOrigin,
  NearFarScalar,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  PolylineCollection,
  Material,
  Color,
  LabelCollection,
  LabelStyle,
} from 'cesium';
import { Aircraft, AircraftCategory, classifyAircraft, categoryColors } from '../types';

const MAX_TRAIL_POINTS = 30;
const TRAIL_STALE_MS = 5 * 60 * 1000; // 5 min

// Airplane SVG icon
function makeAirplaneSvg(color: string, size: number = 36): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">
    <path fill="${color}" d="M16 1.5 L14.5 12 L5 17 L5 19 L14.5 16 L14.5 26 L11 28.5 L11 30 L16 28 L21 30 L21 28.5 L17.5 26 L17.5 16 L27 19 L27 17 L17.5 12 Z"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// Glowing selection ring
function makeGlowSvg(color: string, size: number = 64): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <filter id="g" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="4"/>
      </filter>
    </defs>
    <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 8}" fill="none" stroke="${color}" stroke-width="3" filter="url(#g)" opacity="0.8"/>
    <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 8}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.9"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const iconCache: Record<string, string> = {};
function getIcon(category: AircraftCategory): string {
  if (!iconCache[category]) {
    iconCache[category] = makeAirplaneSvg(categoryColors[category]);
  }
  return iconCache[category];
}

const glowCache: Record<string, string> = {};
function getGlow(category: AircraftCategory): string {
  if (!glowCache[category]) {
    glowCache[category] = makeGlowSvg(categoryColors[category]);
  }
  return glowCache[category];
}

interface TrailPoint {
  lat: number;
  lon: number;
  alt: number;
  time: number;
}

interface FlightLayerProps {
  flights: Aircraft[];
  selected: Aircraft | null;
  onSelect: (ac: Aircraft | null) => void;
  filters: Record<AircraftCategory, boolean>;
  showTrails: boolean;
}

export default function FlightLayer({ flights, selected, onSelect, filters, showTrails }: FlightLayerProps) {
  const { viewer } = useCesium();
  const billboardsRef = useRef<BillboardCollection | null>(null);
  const glowRef = useRef<BillboardCollection | null>(null);
  const trailsRef = useRef<PolylineCollection | null>(null);
  const labelsRef = useRef<LabelCollection | null>(null);
  const billboardMapRef = useRef<Map<string, any>>(new Map());
  const trailHistoryRef = useRef<Map<string, TrailPoint[]>>(new Map());
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  // Initialize collections
  useEffect(() => {
    if (!viewer) return;

    const trailCol = new PolylineCollection();
    const glowCol = new BillboardCollection({ scene: viewer.scene });
    const bbCol = new BillboardCollection({ scene: viewer.scene });
    const lblCol = new LabelCollection({ scene: viewer.scene });
    viewer.scene.primitives.add(trailCol);
    viewer.scene.primitives.add(glowCol);
    viewer.scene.primitives.add(bbCol);
    viewer.scene.primitives.add(lblCol);
    trailsRef.current = trailCol;
    glowRef.current = glowCol;
    billboardsRef.current = bbCol;
    labelsRef.current = lblCol;

    // Hover tooltip
    const tooltip = document.createElement('div');
    tooltip.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;display:none;background:rgba(10,14,20,0.9);color:#b0b8c4;border:1px solid #1a2230;border-radius:6px;padding:3px 8px;font:600 11px -apple-system,sans-serif;white-space:nowrap;';
    document.body.appendChild(tooltip);
    tooltipRef.current = tooltip;

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

    // Click
    handler.setInputAction((click: any) => {
      const picked = viewer.scene.pick(click.position);
      if (picked?.primitive?._skywatch_aircraft) {
        onSelect(picked.primitive._skywatch_aircraft);
      } else {
        onSelect(null);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Hover
    handler.setInputAction((move: any) => {
      const picked = viewer.scene.pick(move.endPosition);
      if (picked?.primitive?._skywatch_aircraft) {
        const ac = picked.primitive._skywatch_aircraft as Aircraft;
        tooltip.textContent = ac.flight || ac.callsign || ac.reg || ac.icao24.toUpperCase();
        tooltip.style.display = 'block';
        tooltip.style.left = (move.endPosition.x + 14) + 'px';
        tooltip.style.top = (move.endPosition.y - 28) + 'px';
        viewer.scene.canvas.style.cursor = 'pointer';
      } else {
        tooltip.style.display = 'none';
        viewer.scene.canvas.style.cursor = '';
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    return () => {
      handler.destroy();
      tooltip.remove();
      if (viewer.scene.primitives.contains(bbCol)) viewer.scene.primitives.remove(bbCol);
      if (viewer.scene.primitives.contains(glowCol)) viewer.scene.primitives.remove(glowCol);
      if (viewer.scene.primitives.contains(trailCol)) viewer.scene.primitives.remove(trailCol);
      if (viewer.scene.primitives.contains(lblCol)) viewer.scene.primitives.remove(lblCol);
      billboardsRef.current = null;
      glowRef.current = null;
      trailsRef.current = null;
      labelsRef.current = null;
      billboardMapRef.current.clear();
    };
  }, [viewer]);

  // Update trail history, billboards, and trail polylines
  useEffect(() => {
    const bbCol = billboardsRef.current;
    const glowCol = glowRef.current;
    const trailCol = trailsRef.current;
    const lblCol = labelsRef.current;
    if (!bbCol || !glowCol || !trailCol || !lblCol || !viewer) return;

    bbCol.removeAll();
    glowCol.removeAll();
    trailCol.removeAll();
    lblCol.removeAll();
    billboardMapRef.current.clear();

    const now = Date.now();
    const history = trailHistoryRef.current;
    const activeIds = new Set<string>();

    for (const ac of flights) {
      const cat = classifyAircraft(ac);
      if (!filters[cat]) continue;
      activeIds.add(ac.icao24);

      // Update trail history
      let trail = history.get(ac.icao24);
      if (!trail) {
        trail = [];
        history.set(ac.icao24, trail);
      }

      const lastPoint = trail[trail.length - 1];
      const alt = ac.baro_altitude ?? 0;
      // Only add if position changed meaningfully
      if (!lastPoint || Math.abs(lastPoint.lat - ac.latitude) > 0.001 || Math.abs(lastPoint.lon - ac.longitude) > 0.001) {
        trail.push({ lat: ac.latitude, lon: ac.longitude, alt: alt > 0 ? alt : 0, time: now });
        if (trail.length > MAX_TRAIL_POINTS) trail.shift();
      }

      // Prune old points
      while (trail.length > 0 && now - trail[0].time > TRAIL_STALE_MS) trail.shift();

      // Dead reckoning
      let lat = ac.latitude;
      let lon = ac.longitude;

      if (ac._updateTime && ac.velocity && ac.true_track != null) {
        const elapsed = (now - ac._updateTime) / 1000;
        if (elapsed > 0 && elapsed < 30) {
          const speed = ac.velocity;
          const hdg = ac.true_track * Math.PI / 180;
          const dist = speed * elapsed;
          const dlat = (dist * Math.cos(hdg)) / 111320;
          const dlon = (dist * Math.sin(hdg)) / (111320 * Math.cos(lat * Math.PI / 180));
          lat += dlat;
          lon += dlon;
        }
      }

      const altMeters = alt > 0 ? alt : 0;
      const position = Cartesian3.fromDegrees(lon, lat, altMeters);
      const rotation = ac.true_track != null ? CesiumMath.toRadians(-(ac.true_track)) : 0;
      const isSelected = selected?.icao24 === ac.icao24;
      const color = categoryColors[cat];

      // Draw trail polyline (only for selected aircraft)
      if (showTrails && isSelected && trail.length >= 2) {
        const positions = trail.map(p => Cartesian3.fromDegrees(p.lon, p.lat, p.alt));
        // Add current (dead-reckoned) position as trail tip
        positions.push(position);

        trailCol.add({
          positions,
          width: isSelected ? 2.5 : 1.5,
          material: Material.fromType('Color', {
            color: Color.fromCssColorString(color).withAlpha(isSelected ? 0.7 : 0.35),
          }),
        });
      }

      // Selection glow ring
      if (isSelected) {
        glowCol.add({
          position,
          image: getGlow(cat),
          scale: 1.0,
          verticalOrigin: VerticalOrigin.CENTER,
          horizontalOrigin: HorizontalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(5e3, 2.2, 2e7, 0.4),
        });
      }

      // Aircraft icon
      const bb = bbCol.add({
        position,
        image: getIcon(cat),
        scale: isSelected ? 1.3 : 1.0,
        rotation,
        alignedAxis: Cartesian3.UNIT_Z,
        verticalOrigin: VerticalOrigin.CENTER,
        horizontalOrigin: HorizontalOrigin.CENTER,
        scaleByDistance: new NearFarScalar(5e3, 1.4, 2e7, 0.18),
        translucencyByDistance: new NearFarScalar(5e3, 1.0, 3e7, 0.5),
      });
      (bb as any)._skywatch_aircraft = ac;
      billboardMapRef.current.set(ac.icao24, bb);

      // Persistent callsign label (visible when zoomed in past ~2000km)
      const labelText = ac.flight || ac.callsign || ac.reg || '';
      if (labelText) {
        lblCol.add({
          position,
          text: labelText,
          font: '13px -apple-system, sans-serif',
          fillColor: Color.fromCssColorString(color).withAlpha(0.95),
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cartesian2(0, 16),
          verticalOrigin: VerticalOrigin.TOP,
          horizontalOrigin: HorizontalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(5e3, 1.0, 5e6, 0.5),
          translucencyByDistance: new NearFarScalar(1e5, 1.0, 5e6, 0.0),
        });
      }
    }

    // Prune trail history for aircraft no longer tracked
    for (const id of history.keys()) {
      if (!activeIds.has(id)) history.delete(id);
    }
  }, [flights, filters, selected, showTrails, viewer]);

  return null;
}
