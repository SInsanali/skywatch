import { Entity } from 'resium';
import { Cartesian3, Color, LabelStyle, VerticalOrigin } from 'cesium';
import type { EonetEvent } from '../hooks/useEonet';

interface Props {
  events: EonetEvent[];
}

const CATEGORY_EMOJI: Record<string, string> = {
  wildfires: '🔥',
  severeStorms: '🌀',
  volcanoes: '🌋',
  seaLakeIce: '🧊',
  earthquakes: '〰️',
  drought: '🌵',
  dustHaze: '🌫️',
  manmade: '🏭',
  snow: '❄️',
  waterColor: '🌊',
  landslides: '⛰️',
  tempExtremes: '🌡️',
};

const DEFAULT_EMOJI = '❓';

function latestPoint(ev: EonetEvent): [number, number] | null {
  for (let i = ev.geometry.length - 1; i >= 0; i--) {
    const g = ev.geometry[i];
    if (g.type === 'Point' && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      return [g.coordinates[0], g.coordinates[1]];
    }
  }
  return null;
}

export default function EonetLayer({ events }: Props) {
  return (
    <>
      {events.map(ev => {
        const pt = latestPoint(ev);
        if (!pt) return null;
        const [lon, lat] = pt;
        const emoji = CATEGORY_EMOJI[ev.category] || DEFAULT_EMOJI;
        return (
          <Entity
            key={ev.id}
            position={Cartesian3.fromDegrees(lon, lat)}
            label={{
              text: emoji,
              font: '20px sans-serif',
              style: LabelStyle.FILL,
              fillColor: Color.WHITE,
              verticalOrigin: VerticalOrigin.CENTER,
              showBackground: false,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            }}
            description={`${ev.title} (${ev.category}) — last seen ${ev.last_update}`}
          />
        );
      })}
    </>
  );
}
