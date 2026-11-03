// ZIP centroid lookup (US Census 2024 ZCTA gazetteer, Florida only) + distance math.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let zips: Record<string, [number, number]> | null = null;

export function zipToLatLng(zip: string): { lat: number; lng: number } | null {
  if (!zips) zips = JSON.parse(readFileSync(join(here, '..', 'data', 'fl-zips.json'), 'utf8'));
  const hit = zips![String(zip).trim().slice(0, 5)];
  return hit ? { lat: hit[0], lng: hit[1] } : null;
}

export function nearestZip(lat: number, lng: number): { zip: string; distanceMi: number } | null {
  zipToLatLng('00000'); // ensure table is loaded
  let best: { zip: string; distanceMi: number } | null = null;
  for (const [zip, [zl, zg]] of Object.entries(zips!)) {
    const d = haversineMi(lat, lng, zl, zg);
    if (!best || d < best.distanceMi) best = { zip, distanceMi: d };
  }
  return best;
}

export function haversineMi(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
