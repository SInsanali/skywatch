export interface Aircraft {
  icao24: string;
  callsign: string | null;
  latitude: number;
  longitude: number;
  baro_altitude: number | null;
  geo_altitude: number | null;
  on_ground: boolean;
  velocity: number | null;
  true_track: number | null;
  vertical_rate: number | null;
  squawk: string | null;
  ias: number | null;
  tas: number | null;
  mach: number | null;
  wind_dir: number | null;
  wind_speed: number | null;
  oat: number | null;
  nav_alt: number | null;
  reg: string | null;
  type: string | null;
  model: string | null;
  operator: string | null;
  airline: string | null;
  flight: string | null;
  year: number | null;
  mil: boolean;
  emergency: string | null;
  category: string | null;
  // Dead reckoning fields (client-side)
  _prevLat?: number;
  _prevLon?: number;
  _prevAlt?: number;
  _updateTime?: number;
}

export interface AircraftResponse {
  timestamp: number;
  aircraft: Aircraft[];
}

export type AircraftCategory = 'airline' | 'private' | 'military' | 'ground';

// Types that are almost always airline-operated
const airlineTypes = new Set([
  'A318','A319','A320','A321','A19N','A20N','A21N',
  'A332','A333','A338','A339','A342','A343','A345','A346','A359','A35K',
  'A380','A388',
  'B731','B732','B733','B734','B735','B736','B737','B738','B739',
  'B37M','B38M','B39M','B3XM',
  'B744','B748','B752','B753','B762','B763','B764',
  'B772','B773','B77L','B77W','B778','B779','B788','B789','B78X',
  'E170','E175','E190','E195','E75L','E75S','E290','E295',
  'CRJ2','CRJ7','CRJ9','CRJX','BCS1','BCS3',
  'AT72','AT75','AT76','DH8D',
  'MD11','MD80','MD82','MD83','MD88','MD90',
  'B712',
]);

export function classifyAircraft(a: Aircraft): AircraftCategory {
  if (a.on_ground) return 'ground';
  if (a.mil) return 'military';
  if (a.callsign && /^[A-Z]{3}\d/.test(a.callsign)) return 'airline';
  if (a.airline) return 'airline';
  if (a.type && airlineTypes.has(a.type.toUpperCase())) return 'airline';
  return 'private';
}

export const typeNames: Record<string, string> = {
  A318:'Airbus A318',A319:'Airbus A319',A320:'Airbus A320',A321:'Airbus A321',
  A19N:'Airbus A319neo',A20N:'Airbus A320neo',A21N:'Airbus A321neo',
  A332:'Airbus A330-200',A333:'Airbus A330-300',A338:'Airbus A330-800',A339:'Airbus A330-900',
  A342:'Airbus A340-200',A343:'Airbus A340-300',A345:'Airbus A340-500',A346:'Airbus A340-600',
  A359:'Airbus A350-900',A35K:'Airbus A350-1000',A380:'Airbus A380',A388:'Airbus A380-800',
  B731:'Boeing 737-100',B732:'Boeing 737-200',B733:'Boeing 737-300',B734:'Boeing 737-400',
  B735:'Boeing 737-500',B736:'Boeing 737-600',B737:'Boeing 737-700',B738:'Boeing 737-800',
  B739:'Boeing 737-900',B37M:'Boeing 737 MAX 7',B38M:'Boeing 737 MAX 8',B39M:'Boeing 737 MAX 9',
  B712:'Boeing 717',B744:'Boeing 747-400',B748:'Boeing 747-8',
  B752:'Boeing 757-200',B753:'Boeing 757-300',B762:'Boeing 767-200',B763:'Boeing 767-300',B764:'Boeing 767-400',
  B772:'Boeing 777-200',B773:'Boeing 777-300',B77L:'Boeing 777-200LR',B77W:'Boeing 777-300ER',
  B778:'Boeing 777-8',B779:'Boeing 777-9',B788:'Boeing 787-8',B789:'Boeing 787-9',B78X:'Boeing 787-10',
  MD11:'MD-11',MD80:'MD-80',MD82:'MD-82',MD83:'MD-83',MD88:'MD-88',MD90:'MD-90',
  E170:'Embraer E170',E175:'Embraer E175',E190:'Embraer E190',E195:'Embraer E195',
  E75L:'Embraer E175',E75S:'Embraer E175',E290:'Embraer E190-E2',E295:'Embraer E195-E2',
  CRJ2:'CRJ-200',CRJ7:'CRJ-700',CRJ9:'CRJ-900',CRJX:'CRJ-1000',
  BCS1:'Airbus A220-100',BCS3:'Airbus A220-300',
  AT72:'ATR 72',AT75:'ATR 72-500',AT76:'ATR 72-600',DH8D:'Dash 8-400',
  C172:'Cessna 172',C208:'Cessna Caravan',C210:'Cessna 210',C182:'Cessna 182',
  SR22:'Cirrus SR22',SR20:'Cirrus SR20',SF50:'Cirrus Vision Jet',
  PC12:'Pilatus PC-12',PC24:'Pilatus PC-24',
  C130:'C-130 Hercules',C17:'C-17 Globemaster',K35R:'KC-135',
  R22:'Robinson R22',R44:'Robinson R44',R66:'Robinson R66',
  EC35:'Airbus H135',H145:'Airbus H145',AS50:'Airbus AS350',
  A109:'Leonardo AW109',A139:'Leonardo AW139',
  B06:'Bell 206',B407:'Bell 407',S76:'Sikorsky S-76',S92:'Sikorsky S-92',
};

export function typeName(code: string | null): string {
  if (!code) return 'Unknown';
  return typeNames[code.toUpperCase()] || code;
}

export const categoryColors: Record<AircraftCategory, string> = {
  airline: '#f0c040',
  private: '#4ecdc4',
  military: '#f85149',
  ground: '#636e7b',
};
