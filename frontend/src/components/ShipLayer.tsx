import { useEffect, useRef } from 'react';
import { useCesium } from 'resium';
import {
  BillboardCollection,
  Cartesian3,
  VerticalOrigin,
  HorizontalOrigin,
  NearFarScalar,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
} from 'cesium';
import { Ship } from '../hooks/useShips';

const catColors: Record<string, string> = {
  cargo: '#8bc34a',
  tanker: '#e91e63',
  passenger: '#2196f3',
  fishing: '#ff9800',
  military: '#f44336',
  tug: '#9c27b0',
  pleasure: '#00bcd4',
  highspeed: '#ffeb3b',
  other: '#78909c',
};

// Ship hull shape — pointed bow, flat stern
function makeShipSvg(color: string, size: number = 28): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 28 28">
    <!-- Hull -->
    <path fill="${color}" d="M14 2 L9 12 L8 22 L11 24 L17 24 L20 22 L19 12 Z" opacity="0.9"/>
    <!-- Bridge/superstructure -->
    <rect x="11" y="14" width="6" height="4" rx="0.5" fill="#fff" fill-opacity="0.3"/>
    <!-- Bow line -->
    <line x1="14" y1="2" x2="14" y2="10" stroke="#fff" stroke-width="0.6" opacity="0.4"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const iconCache: Record<string, string> = {};
function getShipIcon(category: string): string {
  if (!iconCache[category]) {
    iconCache[category] = makeShipSvg(catColors[category] || catColors.other);
  }
  return iconCache[category];
}

function makeGlowSvg(color: string, size: number = 48): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="4"/></filter></defs>
    <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 6}" fill="none" stroke="${color}" stroke-width="2.5" filter="url(#g)" opacity="0.8"/>
    <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 6}" fill="none" stroke="${color}" stroke-width="1" opacity="0.9"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}
const shipGlow = makeGlowSvg('#8bc34a');

interface ShipLayerProps {
  ships: Ship[];
  selected: Ship | null;
  onSelect: (ship: Ship | null) => void;
}

export default function ShipLayer({ ships, selected, onSelect }: ShipLayerProps) {
  const { viewer } = useCesium();
  const bbRef = useRef<BillboardCollection | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!viewer) return;

    const bbCol = new BillboardCollection({ scene: viewer.scene });
    viewer.scene.primitives.add(bbCol);
    bbRef.current = bbCol;

    const tooltip = document.createElement('div');
    tooltip.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;display:none;background:rgba(10,14,20,0.9);color:#b0b8c4;border:1px solid #1a2230;border-radius:6px;padding:3px 8px;font:600 11px -apple-system,sans-serif;white-space:nowrap;';
    document.body.appendChild(tooltip);
    tooltipRef.current = tooltip;

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction((click: any) => {
      const picked = viewer.scene.pick(click.position);
      if (picked?.primitive?._skywatch_ship) {
        onSelect(picked.primitive._skywatch_ship);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction((move: any) => {
      const picked = viewer.scene.pick(move.endPosition);
      if (picked?.primitive?._skywatch_ship) {
        const s = picked.primitive._skywatch_ship as Ship;
        tooltip.textContent = s.name || `MMSI ${s.mmsi}`;
        tooltip.style.display = 'block';
        tooltip.style.left = (move.endPosition.x + 14) + 'px';
        tooltip.style.top = (move.endPosition.y - 28) + 'px';
      } else if (!picked?.primitive?._skywatch_aircraft) {
        tooltip.style.display = 'none';
      }
    }, ScreenSpaceEventType.MOUSE_MOVE);

    return () => {
      handler.destroy();
      tooltip.remove();
      if (viewer.scene.primitives.contains(bbCol)) viewer.scene.primitives.remove(bbCol);
      bbRef.current = null;
    };
  }, [viewer]);

  useEffect(() => {
    const bbCol = bbRef.current;
    if (!bbCol || !viewer) return;

    bbCol.removeAll();

    for (const ship of ships) {
      const cat = ship.category || 'other';
      const isSelected = selected?.mmsi === ship.mmsi;
      const position = Cartesian3.fromDegrees(ship.longitude, ship.latitude, 0);
      const heading = ship.heading ?? ship.cog ?? 0;
      const rotation = CesiumMath.toRadians(-(heading));

      if (isSelected) {
        bbCol.add({
          position,
          image: shipGlow,
          scale: 1.0,
          verticalOrigin: VerticalOrigin.CENTER,
          horizontalOrigin: HorizontalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(5e3, 2.0, 1e7, 0.3),
        });
      }

      const bb = bbCol.add({
        position,
        image: getShipIcon(cat),
        scale: isSelected ? 1.1 : 0.8,
        rotation,
        alignedAxis: Cartesian3.UNIT_Z,
        verticalOrigin: VerticalOrigin.CENTER,
        horizontalOrigin: HorizontalOrigin.CENTER,
        scaleByDistance: new NearFarScalar(5e3, 1.6, 1e7, 0.15),
        translucencyByDistance: new NearFarScalar(5e3, 1.0, 2e7, 0.4),
      });
      (bb as any)._skywatch_ship = ship;
    }
  }, [ships, selected, viewer]);

  return null;
}
