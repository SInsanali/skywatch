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

const satIcon = makeSatSvg('#b388ff');
const issIcon = makeIssSvg();

function makeGlowSvg(color: string, size: number = 48): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="4"/></filter></defs>
    <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 6}" fill="none" stroke="${color}" stroke-width="2.5" filter="url(#g)" opacity="0.8"/>
    <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 6}" fill="none" stroke="${color}" stroke-width="1" opacity="0.9"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
const satGlow = makeGlowSvg('#b388ff');

interface SatelliteLayerProps {
  satellites: Satellite[];
  selected: Satellite | null;
  onSelect: (sat: Satellite | null) => void;
  showFootprint: boolean;
}

export default function SatelliteLayer({ satellites, selected, onSelect, showFootprint }: SatelliteLayerProps) {
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

    for (const sat of satellites) {
      const isIss = ISS_NAMES.includes(sat.name);
      const isSelected = selected?.name === sat.name;
      const altMeters = sat.altitude * 1000;
      const position = Cartesian3.fromDegrees(sat.longitude, sat.latitude, altMeters);

      if (isSelected) {
        bbCol.add({
          position,
          image: satGlow,
          scale: 1.0,
          verticalOrigin: VerticalOrigin.CENTER,
          horizontalOrigin: HorizontalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(1e5, 2.0, 5e7, 0.5),
        });
      }

      const bb = bbCol.add({
        position,
        image: isIss ? issIcon : satIcon,
        scale: isSelected ? 1.2 : isIss ? 1.0 : 0.7,
        verticalOrigin: VerticalOrigin.CENTER,
        horizontalOrigin: HorizontalOrigin.CENTER,
        scaleByDistance: new NearFarScalar(1e5, 1.5, 5e7, 0.4),
        translucencyByDistance: new NearFarScalar(1e5, 1.0, 5e7, 0.6),
      });
      (bb as any)._skywatch_satellite = sat;

      // Label for ISS (always visible)
      if (isIss) {
        lblCol.add({
          position,
          text: 'ISS',
          font: '12px -apple-system, sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          style: LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: { x: 0, y: -18 } as any,
          scaleByDistance: new NearFarScalar(1e5, 1.0, 5e7, 0.5),
        });
      }
    }

    // Scan cone + footprint — for selected satellite
    try {
      for (const ent of footprintEntities.current) {
        viewer.entities.remove(ent);
      }
    } catch {}
    footprintEntities.current = [];

    if (selected && showFootprint) {
      const altM = selected.altitude * 1000;
      const scanRadiusM = selected.altitude * 900;

      try {
        // Ground footprint circle
        const footprint = viewer.entities.add({
          position: Cartesian3.fromDegrees(selected.longitude, selected.latitude, 0),
          ellipse: new (window as any).Cesium.EllipseGraphics({
            semiMajorAxis: scanRadiusM,
            semiMinorAxis: scanRadiusM,
            material: Color.fromCssColorString('#b388ff').withAlpha(0.12),
            outline: true,
            outlineColor: Color.fromCssColorString('#b388ff').withAlpha(0.4),
            outlineWidth: 1,
            height: 0,
          }),
        });
        footprintEntities.current.push(footprint);

        // 3D cone from satellite to ground
        const cone = viewer.entities.add({
          position: Cartesian3.fromDegrees(selected.longitude, selected.latitude, altM / 2),
          cylinder: new (window as any).Cesium.CylinderGraphics({
            length: altM,
            topRadius: 0,
            bottomRadius: scanRadiusM,
            material: Color.fromCssColorString('#b388ff').withAlpha(0.04),
            outline: true,
            outlineColor: Color.fromCssColorString('#b388ff').withAlpha(0.15),
            outlineWidth: 1,
          }),
        });
        footprintEntities.current.push(cone);
      } catch {}
    }
  }, [satellites, selected, showFootprint, viewer]);

  return null;
}
