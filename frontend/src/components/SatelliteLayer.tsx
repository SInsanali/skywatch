import { useEffect, useRef } from 'react';
import { useCesium } from 'resium';
import {
  BillboardCollection,
  Cartesian3,
  VerticalOrigin,
  HorizontalOrigin,
  NearFarScalar,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Color,
  LabelCollection,
  LabelStyle,
} from 'cesium';
import { Satellite } from '../hooks/useSatellites';

const ISS_NAMES = ['ISS (ZARYA)', 'ISS'];

const EARTH_RADIUS_M = 6_371_000;

// Geometric ground coverage radius from orbital altitude
function getFootprintRadius(altKm: number): number {
  const altM = altKm * 1000;
  const cosAngle = EARTH_RADIUS_M / (EARTH_RADIUS_M + altM);
  const groundArc = EARTH_RADIUS_M * Math.acos(cosAngle);
  // Use 40% of the geometric max — looks cleaner and represents the usable coverage area
  return Math.min(groundArc * 0.4, 5_000_000);
}

// Satellite with solar panels
function makeSatSvg(color: string, size: number = 28): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 28 28">
    <!-- Body -->
    <rect x="11" y="10" width="6" height="8" rx="1" fill="${color}"/>
    <!-- Left solar panel -->
    <rect x="1" y="11" width="9" height="6" rx="0.5" fill="${color}" fill-opacity="0.7"/>
    <line x1="4" y1="11" x2="4" y2="17" stroke="#000" stroke-width="0.4" opacity="0.4"/>
    <line x1="7" y1="11" x2="7" y2="17" stroke="#000" stroke-width="0.4" opacity="0.4"/>
    <!-- Right solar panel -->
    <rect x="18" y="11" width="9" height="6" rx="0.5" fill="${color}" fill-opacity="0.7"/>
    <line x1="21" y1="11" x2="21" y2="17" stroke="#000" stroke-width="0.4" opacity="0.4"/>
    <line x1="24" y1="11" x2="24" y2="17" stroke="#000" stroke-width="0.4" opacity="0.4"/>
    <!-- Antenna -->
    <line x1="14" y1="10" x2="14" y2="5" stroke="${color}" stroke-width="1"/>
    <circle cx="14" cy="4" r="1.2" fill="${color}"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// ISS — larger station with detailed solar arrays
function makeIssSvg(size: number = 36): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 36 36">
    <!-- Central module -->
    <rect x="14" y="12" width="8" height="12" rx="1.5" fill="#fff"/>
    <!-- Left arrays -->
    <rect x="1" y="8" width="12" height="5" rx="0.5" fill="#b388ff" fill-opacity="0.8"/>
    <rect x="1" y="23" width="12" height="5" rx="0.5" fill="#b388ff" fill-opacity="0.8"/>
    <line x1="4.5" y1="8" x2="4.5" y2="13" stroke="#000" stroke-width="0.4" opacity="0.3"/>
    <line x1="8.5" y1="8" x2="8.5" y2="13" stroke="#000" stroke-width="0.4" opacity="0.3"/>
    <line x1="4.5" y1="23" x2="4.5" y2="28" stroke="#000" stroke-width="0.4" opacity="0.3"/>
    <line x1="8.5" y1="23" x2="8.5" y2="28" stroke="#000" stroke-width="0.4" opacity="0.3"/>
    <!-- Right arrays -->
    <rect x="23" y="8" width="12" height="5" rx="0.5" fill="#b388ff" fill-opacity="0.8"/>
    <rect x="23" y="23" width="12" height="5" rx="0.5" fill="#b388ff" fill-opacity="0.8"/>
    <line x1="26.5" y1="8" x2="26.5" y2="13" stroke="#000" stroke-width="0.4" opacity="0.3"/>
    <line x1="30.5" y1="8" x2="30.5" y2="13" stroke="#000" stroke-width="0.4" opacity="0.3"/>
    <line x1="26.5" y1="23" x2="26.5" y2="28" stroke="#000" stroke-width="0.4" opacity="0.3"/>
    <line x1="30.5" y1="23" x2="30.5" y2="28" stroke="#000" stroke-width="0.4" opacity="0.3"/>
    <!-- Truss -->
    <rect x="13" y="17" width="10" height="2" rx="0.5" fill="#ccc"/>
    <!-- Connections -->
    <line x1="13" y1="10.5" x2="1" y2="10.5" stroke="#aaa" stroke-width="0.8"/>
    <line x1="13" y1="25.5" x2="1" y2="25.5" stroke="#aaa" stroke-width="0.8"/>
    <line x1="23" y1="10.5" x2="35" y2="10.5" stroke="#aaa" stroke-width="0.8"/>
    <line x1="23" y1="25.5" x2="35" y2="25.5" stroke="#aaa" stroke-width="0.8"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const issIcon = makeIssSvg();

// Color per satellite group
const SAT_GROUP_COLORS: Record<string, string> = {
  'Weather': '#4fc3f7', 'NOAA': '#4fc3f7', 'GOES': '#4fc3f7', 'Planet Labs': '#4fc3f7',
  'Starlink': '#b388ff', 'Iridium': '#b388ff', 'Globalstar': '#b388ff', 'OneWeb': '#b388ff',
  'GPS': '#69f0ae', 'Galileo': '#69f0ae',
  'Science': '#ffd54f',
  'Space Stations': '#ffffff',
  'Military': '#ef5350',
};
const DEFAULT_SAT_COLOR = '#b388ff';
const LEO_CEILING = 2000; // km — anything above this gets the high-orbit style

function satColor(group: string): string {
  return SAT_GROUP_COLORS[group] || DEFAULT_SAT_COLOR;
}

// Diamond marker for high-orbit satellites
function makeDiamondSvg(color: string, size: number = 20): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 20 20">
    <polygon points="10,2 18,10 10,18 2,10" fill="none" stroke="${color}" stroke-width="1.2" opacity="0.8"/>
    <circle cx="10" cy="10" r="2" fill="${color}"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const diamondCache = new Map<string, string>();
function getDiamond(color: string): string {
  let icon = diamondCache.get(color);
  if (!icon) { icon = makeDiamondSvg(color); diamondCache.set(color, icon); }
  return icon;
}

// Cache generated SVGs per color
const iconCache = new Map<string, string>();
function getSatIcon(color: string): string {
  let icon = iconCache.get(color);
  if (!icon) { icon = makeSatSvg(color); iconCache.set(color, icon); }
  return icon;
}

function makeGlowSvg(color: string, size: number = 48): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="4"/></filter></defs>
    <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 6}" fill="none" stroke="${color}" stroke-width="2.5" filter="url(#g)" opacity="0.8"/>
    <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 6}" fill="none" stroke="${color}" stroke-width="1" opacity="0.9"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const glowCache = new Map<string, string>();
function getSatGlow(color: string): string {
  let glow = glowCache.get(color);
  if (!glow) { glow = makeGlowSvg(color); glowCache.set(color, glow); }
  return glow;
}

function findGroupSatellites(selected: Satellite, all: Satellite[]): Satellite[] {
  return all.filter(s => s.name !== selected.name && s.group === selected.group);
}

interface SatelliteLayerProps {
  satellites: Satellite[];
  selected: Satellite | null;
  onSelect: (sat: Satellite | null) => void;
  showFootprint: boolean;
  onNearbySatellites?: (nearby: Satellite[]) => void;
}

export default function SatelliteLayer({ satellites, selected, onSelect, showFootprint, onNearbySatellites }: SatelliteLayerProps) {
  const { viewer } = useCesium();
  const bbRef = useRef<BillboardCollection | null>(null);
  const labelRef = useRef<LabelCollection | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const footprintEntities = useRef<any[]>([]);

  useEffect(() => {
    if (!viewer) return;

    const bbCol = new BillboardCollection({ scene: viewer.scene });
    const lblCol = new LabelCollection({ scene: viewer.scene });
    viewer.scene.primitives.add(bbCol);
    viewer.scene.primitives.add(lblCol);
    bbRef.current = bbCol;
    labelRef.current = lblCol;

    const tooltip = document.createElement('div');
    tooltip.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;display:none;background:rgba(10,14,20,0.9);color:#b388ff;border:1px solid #1a2230;border-radius:6px;padding:3px 8px;font:600 11px -apple-system,sans-serif;white-space:nowrap;';
    document.body.appendChild(tooltip);
    tooltipRef.current = tooltip;

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click: any) => {
      const picked = viewer.scene.pick(click.position);
      if (picked?.primitive?._skywatch_satellite) {
        onSelect(picked.primitive._skywatch_satellite);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction((move: any) => {
      const picked = viewer.scene.pick(move.endPosition);
      if (picked?.primitive?._skywatch_satellite) {
        const sat = picked.primitive._skywatch_satellite as Satellite;
        tooltip.textContent = `${sat.name} (${Math.round(sat.altitude)} km)`;
        tooltip.style.color = satColor(sat.group);
        tooltip.style.display = 'block';
        tooltip.style.left = (move.endPosition.x + 14) + 'px';
        tooltip.style.top = (move.endPosition.y - 28) + 'px';
      } else if (!picked?.primitive?._skywatch_aircraft && !picked?.primitive?._skywatch_ship) {
        tooltip.style.display = 'none';
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    return () => {
      handler.destroy();
      tooltip.remove();
      if (viewer.scene.primitives.contains(bbCol)) viewer.scene.primitives.remove(bbCol);
      if (viewer.scene.primitives.contains(lblCol)) viewer.scene.primitives.remove(lblCol);
      bbRef.current = null;
      labelRef.current = null;
    };
  }, [viewer]);

  useEffect(() => {
    const bbCol = bbRef.current;
    const lblCol = labelRef.current;
    if (!bbCol || !lblCol || !viewer) return;

    bbCol.removeAll();
    lblCol.removeAll();

    // Find same-constellation satellites for the selected one
    const nearby = selected ? findGroupSatellites(selected, satellites) : [];
    const nearbyNames = new Set(nearby.map(s => s.name));
    if (onNearbySatellites) onNearbySatellites(nearby);

    for (const sat of satellites) {
      const isIss = ISS_NAMES.includes(sat.name);
      const isSelected = selected?.name === sat.name;
      const isNearby = nearbyNames.has(sat.name);
      const altMeters = sat.altitude * 1000;
      const position = Cartesian3.fromDegrees(sat.longitude, sat.latitude, altMeters);
      const color = satColor(sat.group);
      const isHighOrbit = sat.altitude > LEO_CEILING;

      if (isSelected || isNearby) {
        bbCol.add({
          position,
          image: getSatGlow(color),
          scale: isSelected ? 1.0 : 0.7,
          verticalOrigin: VerticalOrigin.CENTER,
          horizontalOrigin: HorizontalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(1e5, 2.0, 5e7, 0.5),
        });
      }

      if (isHighOrbit) {
        // High-orbit: diamond marker + always-on label
        const bb = bbCol.add({
          position,
          image: getDiamond(color),
          scale: isSelected ? 1.3 : 1.0,
          verticalOrigin: VerticalOrigin.CENTER,
          horizontalOrigin: HorizontalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(1e6, 1.2, 1e8, 0.5),
        });
        (bb as any)._skywatch_satellite = sat;

        const label = sat.name.length > 18 ? sat.name.slice(0, 16) + '..' : sat.name;
        lblCol.add({
          position,
          text: label,
          font: isSelected ? '11px monospace' : '10px monospace',
          fillColor: isSelected ? Color.WHITE : Color.fromCssColorString(color).withAlpha(0.85),
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          style: LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: { x: 14, y: 0 } as any,
          horizontalOrigin: HorizontalOrigin.LEFT,
          scaleByDistance: new NearFarScalar(1e6, 1.0, 1e8, 0.45),
        });
      } else {
        // LEO: satellite icon
        const bb = bbCol.add({
          position,
          image: isIss ? issIcon : getSatIcon(color),
          scale: isSelected ? 1.2 : isNearby ? 1.0 : isIss ? 1.0 : 0.7,
          verticalOrigin: VerticalOrigin.CENTER,
          horizontalOrigin: HorizontalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(1e5, 1.5, 5e7, 0.4),
          translucencyByDistance: new NearFarScalar(1e5, 1.0, 5e7, 0.45),
        });
        (bb as any)._skywatch_satellite = sat;

        if (isIss || isSelected || isNearby) {
          lblCol.add({
            position,
            text: isIss ? 'ISS' : sat.name.length > 16 ? sat.name.slice(0, 14) + '..' : sat.name,
            font: (isSelected || isIss) ? '12px -apple-system, sans-serif' : '10px -apple-system, sans-serif',
            fillColor: isSelected ? Color.WHITE : Color.fromCssColorString(color).withAlpha(0.8),
            outlineColor: Color.BLACK,
            outlineWidth: 2,
            style: LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: { x: 0, y: -18 } as any,
            scaleByDistance: new NearFarScalar(1e5, 1.0, 5e7, 0.5),
          });
        }
      }
    }

    // Scan cones + footprints — for selected AND nearby satellites
    try {
      for (const ent of footprintEntities.current) {
        viewer.entities.remove(ent);
      }
    } catch {}
    footprintEntities.current = [];

    if (showFootprint && selected) {
      const sat = satellites.find(s => s.name === selected.name) ?? selected;
      const color = satColor(sat.group);
      const altM = sat.altitude * 1000;
      const radiusM = getFootprintRadius(sat.altitude);

      try {
        const footprint = viewer.entities.add({
          position: Cartesian3.fromDegrees(sat.longitude, sat.latitude, 0),
          ellipse: new (window as any).Cesium.EllipseGraphics({
            semiMajorAxis: radiusM,
            semiMinorAxis: radiusM,
            material: Color.fromCssColorString(color).withAlpha(0.15),
            outline: true,
            outlineColor: Color.fromCssColorString(color).withAlpha(0.5),
            outlineWidth: 1,
            height: 0,
          }),
        });
        footprintEntities.current.push(footprint);

        if (sat.altitude <= LEO_CEILING) {
          const cone = viewer.entities.add({
            position: Cartesian3.fromDegrees(sat.longitude, sat.latitude, altM / 2),
            cylinder: new (window as any).Cesium.CylinderGraphics({
              length: altM,
              topRadius: 0,
              bottomRadius: radiusM,
              material: Color.fromCssColorString(color).withAlpha(0.06),
              outline: true,
              outlineColor: Color.fromCssColorString(color).withAlpha(0.2),
              outlineWidth: 1,
            }),
          });
          footprintEntities.current.push(cone);
        }
      } catch {}
    }
  }, [satellites, selected, showFootprint, viewer]);

  return null;
}
