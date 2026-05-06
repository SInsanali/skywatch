import { Entity } from 'resium';
import { Cartesian3, VerticalOrigin } from 'cesium';
import type { EonetEvent } from '../hooks/useEonet';

interface Props {
  events: EonetEvent[];
}

// Stylized SVG icon per category. Color is baked in so we cache once.
const ICONS: Record<string, string> = {
  wildfires: makeIcon(`
    <path d="M14 4 C16 8, 20 9, 19 14 C19 18, 16 21, 14 22 C12 21, 9 18, 9 14 C9 11, 11 9, 12 6 Z"
          fill="#ff5722" stroke="#fff" stroke-width="0.8"/>
    <path d="M14 11 C15 13, 16 14, 15.5 16 C15 17.5, 14 18, 14 18 C13.5 18, 13 17, 13 16 C13 14, 13.5 13, 14 11 Z"
          fill="#ffeb3b"/>
  `),
  severeStorms: makeIcon(`
    <g stroke="#29b6f6" stroke-width="1.6" fill="none" stroke-linecap="round">
      <path d="M14 6 C8 6, 6 10, 8 14 C10 17, 14 17, 16 14 C18 11, 17 8, 14 6 Z"/>
      <path d="M14 9 C11 9, 10 11, 11 13 C12 15, 14 15, 15 13"/>
      <circle cx="14" cy="14" r="1.2" fill="#29b6f6"/>
    </g>
  `),
  volcanoes: makeIcon(`
    <path d="M5 22 L11 9 L13 13 L15 9 L17 12 L23 22 Z" fill="#ff9800" stroke="#fff" stroke-width="0.6"/>
    <path d="M11 9 C11 6, 13 5, 14 6" stroke="#ef5350" stroke-width="1.4" fill="none" stroke-linecap="round"/>
    <path d="M14 6 C15 5, 17 6, 17 8" stroke="#ef5350" stroke-width="1.4" fill="none" stroke-linecap="round"/>
  `),
  seaLakeIce: makeIcon(`
    <polygon points="14,4 22,9 22,19 14,24 6,19 6,9"
             fill="#90caf9" stroke="#fff" stroke-width="0.8" opacity="0.9"/>
    <polygon points="14,9 18,11.5 18,16.5 14,19 10,16.5 10,11.5" fill="#e3f2fd" opacity="0.6"/>
  `),
  drought: makeIcon(`
    <circle cx="14" cy="14" r="6" fill="#fbc02d" stroke="#fff" stroke-width="0.6"/>
    <g stroke="#fbc02d" stroke-width="1.6" stroke-linecap="round">
      <line x1="14" y1="2" x2="14" y2="6"/>
      <line x1="14" y1="22" x2="14" y2="26"/>
      <line x1="2" y1="14" x2="6" y2="14"/>
      <line x1="22" y1="14" x2="26" y2="14"/>
      <line x1="5" y1="5" x2="8" y2="8"/>
      <line x1="20" y1="20" x2="23" y2="23"/>
      <line x1="5" y1="23" x2="8" y2="20"/>
      <line x1="20" y1="8" x2="23" y2="5"/>
    </g>
  `),
  dustHaze: makeIcon(`
    <g stroke="#bcaaa4" stroke-width="1.8" fill="none" stroke-linecap="round">
      <path d="M4 9 C8 7, 12 11, 16 9 C20 7, 24 11, 24 9"/>
      <path d="M4 14 C8 12, 12 16, 16 14 C20 12, 24 16, 24 14"/>
      <path d="M4 19 C8 17, 12 21, 16 19 C20 17, 24 21, 24 19"/>
    </g>
  `),
  manmade: makeIcon(`
    <rect x="6" y="14" width="6" height="9" fill="#9e9e9e" stroke="#fff" stroke-width="0.5"/>
    <rect x="13" y="10" width="6" height="13" fill="#bdbdbd" stroke="#fff" stroke-width="0.5"/>
    <rect x="20" y="12" width="3" height="11" fill="#9e9e9e" stroke="#fff" stroke-width="0.5"/>
    <path d="M14 10 L14 6 C14 4, 17 4, 17 6 L17 8" stroke="#9e9e9e" stroke-width="1.2" fill="none"/>
  `),
  snow: makeIcon(`
    <g stroke="#e0e0e0" stroke-width="1.8" stroke-linecap="round" fill="none">
      <line x1="14" y1="3" x2="14" y2="25"/>
      <line x1="4" y1="14" x2="24" y2="14"/>
      <line x1="6" y1="6" x2="22" y2="22"/>
      <line x1="22" y1="6" x2="6" y2="22"/>
      <path d="M11 5 L14 8 L17 5"/>
      <path d="M11 23 L14 20 L17 23"/>
      <path d="M5 11 L8 14 L5 17"/>
      <path d="M23 11 L20 14 L23 17"/>
    </g>
  `),
  waterColor: makeIcon(`
    <g stroke="#26a69a" stroke-width="2" fill="none" stroke-linecap="round">
      <path d="M3 11 C7 8, 11 14, 15 11 C19 8, 23 14, 25 11"/>
      <path d="M3 16 C7 13, 11 19, 15 16 C19 13, 23 19, 25 16"/>
    </g>
  `),
  landslides: makeIcon(`
    <polygon points="3,22 11,8 18,17 25,22" fill="#a1887f" stroke="#fff" stroke-width="0.6"/>
    <path d="M14 14 L14 22 M11 19 L14 22 L17 19" stroke="#5d4037" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  `),
  tempExtremes: makeIcon(`
    <rect x="12" y="4" width="4" height="14" rx="2" fill="#fff" stroke="#ef5350" stroke-width="1"/>
    <circle cx="14" cy="20" r="4" fill="#ef5350" stroke="#fff" stroke-width="0.6"/>
    <line x1="14" y1="8" x2="14" y2="16" stroke="#ef5350" stroke-width="2"/>
  `),
};

function makeIcon(inner: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">${inner}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const DEFAULT_ICON = makeIcon(`
  <circle cx="14" cy="14" r="6" fill="#ff5722" stroke="#fff" stroke-width="1"/>
`);

function iconFor(category: string): string {
  return ICONS[category] || DEFAULT_ICON;
}

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
        return (
          <Entity
            key={ev.id}
            position={Cartesian3.fromDegrees(lon, lat)}
            billboard={{
              image: iconFor(ev.category),
              scale: 1,
              verticalOrigin: VerticalOrigin.CENTER,
            }}
            description={`${ev.title} (${ev.category}) — last seen ${ev.last_update}`}
          />
        );
      })}
    </>
  );
}
