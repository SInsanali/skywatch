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
} from 'cesium';
import { Earthquake } from '../hooks/useEarthquakes';

function magToColor(mag: number): string {
  if (mag >= 7) return '#ff1744';
  if (mag >= 6) return '#ff5722';
  if (mag >= 5.5) return '#ff9800';
  if (mag >= 5) return '#ffc107';
  return '#ffeb3b';
}

function magToSize(mag: number): number {
  if (mag >= 7) return 28;
  if (mag >= 6) return 22;
  if (mag >= 5.5) return 18;
  if (mag >= 5) return 14;
  return 10;
}

// Seismograph-style concentric rings
function makeQuakeSvg(color: string, size: number): string {
  const r = size / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${r}" cy="${r}" r="${r * 0.3}" fill="${color}"/>
    <circle cx="${r}" cy="${r}" r="${r * 0.55}" fill="none" stroke="${color}" stroke-width="1.2" opacity="0.6"/>
    <circle cx="${r}" cy="${r}" r="${r * 0.85}" fill="none" stroke="${color}" stroke-width="0.8" opacity="0.3"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const iconCache: Record<string, string> = {};
function getQuakeIcon(mag: number): string {
  const key = `${Math.round(mag * 2)}`;
  if (!iconCache[key]) {
    iconCache[key] = makeQuakeSvg(magToColor(mag), magToSize(mag));
  }
  return iconCache[key];
}

interface EarthquakeLayerProps {
  earthquakes: Earthquake[];
  onSelect: (eq: Earthquake | null) => void;
}

export default function EarthquakeLayer({ earthquakes, onSelect }: EarthquakeLayerProps) {
  const { viewer } = useCesium();
  const bbRef = useRef<BillboardCollection | null>(null);

  useEffect(() => {
    if (!viewer) return;

    const bbCol = new BillboardCollection({ scene: viewer.scene });
    viewer.scene.primitives.add(bbCol);
    bbRef.current = bbCol;

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click: any) => {
      const picked = viewer.scene.pick(click.position);
      if (picked?.primitive?._skywatch_earthquake) {
        onSelect(picked.primitive._skywatch_earthquake);
      }
    }, ScreenSpaceEventType.LEFT_CLICK);

    return () => {
      handler.destroy();
      if (viewer.scene.primitives.contains(bbCol)) viewer.scene.primitives.remove(bbCol);
      bbRef.current = null;
    };
  }, [viewer]);

  useEffect(() => {
    const bbCol = bbRef.current;
    if (!bbCol || !viewer) return;

    bbCol.removeAll();

    for (const eq of earthquakes) {
      const position = Cartesian3.fromDegrees(eq.longitude, eq.latitude, 0);

      const bb = bbCol.add({
        position,
        image: getQuakeIcon(eq.magnitude),
        scale: 1.0,
        verticalOrigin: VerticalOrigin.CENTER,
        horizontalOrigin: HorizontalOrigin.CENTER,
        scaleByDistance: new NearFarScalar(1e4, 1.5, 2e7, 0.3),
        translucencyByDistance: new NearFarScalar(1e4, 1.0, 3e7, 0.5),
      });
      (bb as any)._skywatch_earthquake = eq;
    }
  }, [earthquakes, viewer]);

  return null;
}
