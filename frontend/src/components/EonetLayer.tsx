import { Entity } from 'resium';
import { Cartesian3, Color } from 'cesium';
import type { EonetEvent } from '../hooks/useEonet';

interface Props {
  events: EonetEvent[];
}

const CATEGORY_COLORS: Record<string, string> = {
  wildfires: '#ff5722',
  severeStorms: '#29b6f6',
  volcanoes: '#ff9800',
  seaLakeIce: '#90caf9',
  earthquakes: '#ffb74d',
  drought: '#fbc02d',
  dustHaze: '#bcaaa4',
  manmade: '#9e9e9e',
  snow: '#e0e0e0',
  waterColor: '#26a69a',
  landslides: '#a1887f',
  default: '#b388ff',
};

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
        const color = CATEGORY_COLORS[ev.category] || CATEGORY_COLORS.default;
        return (
          <Entity
            key={ev.id}
            position={Cartesian3.fromDegrees(lon, lat)}
            point={{
              pixelSize: 8,
              color: Color.fromCssColorString(color),
              outlineColor: Color.WHITE,
              outlineWidth: 1,
            }}
            description={`${ev.title} (${ev.category}) — last seen ${ev.last_update}`}
          />
        );
      })}
    </>
  );
}
