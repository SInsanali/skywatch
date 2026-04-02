import { useEffect, useRef } from 'react';
import { useCesium } from 'resium';
import {
  Cartesian3,
  Color,
  ColorMaterialProperty,
} from 'cesium';
import { JammingZone } from '../hooks/useJamming';

const HEX_RADIUS_DEG = 0.55;
const HEX_HEIGHT = 8000;       // meters above ground
const HEX_EXTRUDE = 12000;     // extruded height (top of the slab)

function levelFillColor(level: string): Color {
  switch (level) {
    case 'high':   return Color.fromCssColorString('rgba(200, 0, 255, 0.5)');
    case 'medium': return Color.fromCssColorString('rgba(160, 50, 240, 0.4)');
    case 'low':    return Color.fromCssColorString('rgba(180, 130, 255, 0.35)');
    default:       return Color.fromCssColorString('rgba(180, 130, 255, 0.35)');
  }
}

function levelOutlineColor(level: string): Color {
  switch (level) {
    case 'high':   return Color.fromCssColorString('rgba(230, 120, 255, 0.7)');
    case 'medium': return Color.fromCssColorString('rgba(200, 130, 255, 0.6)');
    case 'low':    return Color.fromCssColorString('rgba(210, 180, 255, 0.5)');
    default:       return Color.fromCssColorString('rgba(210, 180, 255, 0.5)');
  }
}

function hexagonPositions(centerLat: number, centerLon: number, radiusDeg: number): Cartesian3[] {
  const positions: Cartesian3[] = [];
  for (let i = 0; i < 6; i++) {
    const angleDeg = 60 * i + 30; // offset by 30 so flat edge faces south
    const angleRad = (angleDeg * Math.PI) / 180;
    const lat = centerLat + radiusDeg * Math.sin(angleRad);
    const lon = centerLon + radiusDeg * Math.cos(angleRad);
    positions.push(Cartesian3.fromDegrees(lon, lat, HEX_HEIGHT));
  }
  return positions;
}

interface JammingLayerProps {
  zones: JammingZone[];
}

export default function JammingLayer({ zones }: JammingLayerProps) {
  const { viewer } = useCesium();
  const entitiesRef = useRef<any[]>([]);

  useEffect(() => {
    if (!viewer) return;

    // Clean up previous entities
    for (const ent of entitiesRef.current) {
      try { viewer.entities.remove(ent); } catch {}
    }
    entitiesRef.current = [];

    if (zones.length === 0) return;

    for (const zone of zones) {
      const positions = hexagonPositions(zone.lat, zone.lon, HEX_RADIUS_DEG);
      const fill = levelFillColor(zone.level);
      const outline = levelOutlineColor(zone.level);

      try {
        const ent = viewer.entities.add({
          polygon: new (window as any).Cesium.PolygonGraphics({
            hierarchy: positions,
            material: new ColorMaterialProperty(fill),
            height: HEX_HEIGHT,
            extrudedHeight: HEX_EXTRUDE,
            outline: true,
            outlineColor: outline,
            outlineWidth: 1,
            perPositionHeight: false,
          }),
        });
        entitiesRef.current.push(ent);
      } catch {}
    }

    return () => {
      for (const ent of entitiesRef.current) {
        try { viewer.entities.remove(ent); } catch {}
      }
      entitiesRef.current = [];
    };
  }, [zones, viewer]);

  return null;
}
