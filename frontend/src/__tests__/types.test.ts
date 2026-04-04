import { describe, it, expect } from 'vitest';
import { classifyAircraft, categoryColors, typeName, Aircraft, AircraftCategory } from '../types';

function makeAircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    icao24: 'abc123',
    callsign: null,
    latitude: 40.0,
    longitude: -74.0,
    baro_altitude: 10000,
    geo_altitude: 10000,
    on_ground: false,
    velocity: 250,
    true_track: 90,
    vertical_rate: 0,
    squawk: null,
    ias: null,
    tas: null,
    mach: null,
    wind_dir: null,
    wind_speed: null,
    oat: null,
    nav_alt: null,
    reg: null,
    type: null,
    model: null,
    operator: null,
    airline: null,
    flight: null,
    year: null,
    mil: false,
    emergency: null,
    category: null,
    ...overrides,
  };
}

describe('classifyAircraft', () => {
  it('classifies on-ground aircraft as ground', () => {
    const ac = makeAircraft({ on_ground: true });
    expect(classifyAircraft(ac)).toBe('ground');
  });

  it('ground takes priority over military', () => {
    const ac = makeAircraft({ on_ground: true, mil: true });
    expect(classifyAircraft(ac)).toBe('ground');
  });

  it('classifies military aircraft', () => {
    const ac = makeAircraft({ mil: true });
    expect(classifyAircraft(ac)).toBe('military');
  });

  it('classifies airline by ICAO-style callsign (3 letters + digits)', () => {
    const ac = makeAircraft({ callsign: 'UAL123' });
    expect(classifyAircraft(ac)).toBe('airline');
  });

  it('classifies airline by airline field', () => {
    const ac = makeAircraft({ airline: 'Delta Air Lines' });
    expect(classifyAircraft(ac)).toBe('airline');
  });

  it('classifies airline by known aircraft type', () => {
    const ac = makeAircraft({ type: 'B738' });
    expect(classifyAircraft(ac)).toBe('airline');
  });

  it('handles lowercase type codes', () => {
    const ac = makeAircraft({ type: 'a320' });
    expect(classifyAircraft(ac)).toBe('airline');
  });

  it('classifies everything else as private', () => {
    const ac = makeAircraft({ callsign: 'N12345' });
    expect(classifyAircraft(ac)).toBe('private');
  });

  it('classifies bare aircraft with no info as private', () => {
    const ac = makeAircraft();
    expect(classifyAircraft(ac)).toBe('private');
  });

  it('military trumps airline callsign', () => {
    const ac = makeAircraft({ mil: true, callsign: 'UAL999' });
    expect(classifyAircraft(ac)).toBe('military');
  });
});

describe('categoryColors', () => {
  it('has entries for all four categories', () => {
    const categories: AircraftCategory[] = ['airline', 'private', 'military', 'ground'];
    for (const cat of categories) {
      expect(categoryColors[cat]).toBeDefined();
      expect(categoryColors[cat]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('each color is unique', () => {
    const values = Object.values(categoryColors);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('typeName', () => {
  it('returns full name for known type codes', () => {
    expect(typeName('B738')).toBe('Boeing 737-800');
    expect(typeName('A320')).toBe('Airbus A320');
  });

  it('is case-insensitive', () => {
    expect(typeName('b738')).toBe('Boeing 737-800');
  });

  it('returns the code itself for unknown types', () => {
    expect(typeName('ZZZZ')).toBe('ZZZZ');
  });

  it('returns Unknown for null', () => {
    expect(typeName(null)).toBe('Unknown');
  });
});
