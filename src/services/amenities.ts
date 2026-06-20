// Bike parking (TfL + OSM) and cyclist amenities (pumps, repair, cafés) along a route.

import { bboxAroundCoords, distToSegmentM, haversineM, type Bbox } from './mapFeatures'
import type { Place } from './geocode'

export type AmenityKind = 'parking' | 'pump' | 'repair' | 'cafe'

export function amenityKindLabel(kind: AmenityKind): string {
  switch (kind) {
    case 'parking':
      return 'Parking'
    case 'pump':
      return 'Pump'
    case 'repair':
      return 'Bike shop'
    case 'cafe':
      return 'Café'
  }
}

export interface Amenity {
  id: string
  kind: AmenityKind
  name: string
  lat: number
  lon: number
  note?: string
  capacity?: number
  source: 'osm' | 'tfl'
}

export interface RouteAmenities {
  parking: Amenity[] // near destination
  alongRoute: Amenity[] // pumps, repair, cafés on the route corridor
  all: Amenity[]
}

const ROUTE_BUFFER_M = 45
const PARKING_RADIUS_M = 550
const AMENITY_CACHE = new Map<string, RouteAmenities>()

interface OverpassElement {
  type: 'node' | 'way'
  id: number
  tags?: Record<string, string>
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
}

interface OverpassResponse {
  elements: OverpassElement[]
}

interface TflPlace {
  id: string
  commonName?: string
  lat: number
  lon: number
  additionalProperties?: { category?: string; key?: string; value?: string }[]
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

function amenityKey(end: Place, coords: [number, number][]): string {
  const sig = coords.map(([lat, lon]) => `${lat.toFixed(3)},${lon.toFixed(3)}`).join('|')
  return `${end.lat.toFixed(4)},${end.lon.toFixed(4)}:${sig}`
}

function elementLatLon(el: OverpassElement): [number, number] | null {
  if (el.lat != null && el.lon != null) return [el.lat, el.lon]
  if (el.center) return [el.center.lat, el.center.lon]
  return null
}

function parkingNote(tags: Record<string, string>): string | undefined {
  const cap = tags.capacity ?? tags['capacity:bicycle']
  const covered = tags.covered === 'yes' ? 'Covered' : tags.covered === 'no' ? 'Open-air' : null
  const type = tags.bicycle_parking?.replace(/_/g, ' ')
  const parts = [type, cap ? `${cap} spaces` : null, covered].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

function osmAmenity(el: OverpassElement, kind: AmenityKind): Amenity | null {
  const ll = elementLatLon(el)
  if (!ll) return null
  const tags = el.tags ?? {}
  const name =
    tags.name ??
    (kind === 'parking' ? 'Cycle parking' : kind === 'pump' ? 'Pump' : kind === 'repair' ? 'Bike shop' : 'Café')
  return {
    id: `osm-${el.type}-${el.id}`,
    kind,
    name,
    lat: ll[0],
    lon: ll[1],
    note: kind === 'parking' ? parkingNote(tags) : tags.opening_hours ?? tags['service:bicycle:repair'],
    capacity: tags.capacity ? Number(tags.capacity) : tags['capacity:bicycle'] ? Number(tags['capacity:bicycle']) : undefined,
    source: 'osm',
  }
}

function classifyOsm(el: OverpassElement): AmenityKind | null {
  const t = el.tags ?? {}
  if (t.amenity === 'bicycle_parking') return 'parking'
  if (t.amenity === 'bicycle_repair_station') return 'repair'
  if (t.amenity === 'compressed_air' || t['service:bicycle:pump'] === 'yes') return 'pump'
  if (t.shop === 'bicycle') {
    if (t['service:bicycle:pump'] === 'yes') return 'pump'
    return 'repair'
  }
  if (t.amenity === 'cafe' || t.amenity === 'coffee_shop') {
    if (t.bicycle === 'yes' || t.bicycle === 'designated') return 'cafe'
  }
  return null
}

function nearRoute(lat: number, lon: number, route: [number, number][]): boolean {
  for (let i = 1; i < route.length; i++) {
    if (distToSegmentM(lat, lon, route[i - 1], route[i]) <= ROUTE_BUFFER_M) return true
  }
  return false
}

function nearPoint(lat: number, lon: number, point: [number, number], radiusM: number): boolean {
  return haversineM(lat, lon, point[0], point[1]) <= radiusM
}

function dedupe(amenities: Amenity[]): Amenity[] {
  const out: Amenity[] = []
  for (const a of amenities) {
    if (out.some((b) => haversineM(a.lat, a.lon, b.lat, b.lon) < 25 && a.kind === b.kind)) continue
    out.push(a)
  }
  return out
}

async function postOverpass(query: string): Promise<OverpassResponse | null> {
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
      })
      if (!res.ok) continue
      const text = await res.text()
      if (text.startsWith('<')) continue
      return JSON.parse(text) as OverpassResponse
    } catch {
      /* try next */
    }
  }
  return null
}

async function fetchOsmAmenities(bbox: Bbox, dest: Place): Promise<Amenity[]> {
  const bb = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
  const around = `${PARKING_RADIUS_M},${dest.lat},${dest.lon}`
  const query = `[out:json][timeout:25];
(
  node["amenity"="bicycle_parking"](around:${around});
  way["amenity"="bicycle_parking"](around:${around});
  node["amenity"~"^(bicycle_repair_station|compressed_air|cafe|coffee_shop)$"](${bb});
  node["shop"="bicycle"](${bb});
  node["service:bicycle:pump"="yes"](${bb});
  way["amenity"="bicycle_repair_station"](${bb});
);
out center;`

  const data = await postOverpass(query)
  if (!data) return []

  const items: Amenity[] = []
  for (const el of data.elements) {
    const kind = classifyOsm(el)
    if (!kind) continue
    const a = osmAmenity(el, kind)
    if (a) items.push(a)
  }
  return items
}

async function fetchTflCycleParks(dest: Place): Promise<Amenity[]> {
  try {
    const url = `https://api.tfl.gov.uk/Place/Type/cyclepark?lat=${dest.lat}&lon=${dest.lon}&radius=${PARKING_RADIUS_M}`
    const res = await fetch(url)
    if (!res.ok) return []
    const places = (await res.json()) as TflPlace[]
    return places.map((p) => {
      let capacity: number | undefined
      for (const prop of p.additionalProperties ?? []) {
        if (prop.key?.toLowerCase().includes('spaces') || prop.key?.toLowerCase().includes('capacity')) {
          const n = Number(prop.value)
          if (!Number.isNaN(n)) capacity = n
        }
      }
      return {
        id: `tfl-${p.id}`,
        kind: 'parking' as const,
        name: p.commonName ?? 'Cycle parking',
        lat: p.lat,
        lon: p.lon,
        capacity,
        source: 'tfl' as const,
      }
    })
  } catch {
    return []
  }
}

/** Parking near destination; pumps, repair & cafés along the route corridor. */
export async function fetchRouteAmenities(
  coords: [number, number][],
  dest: Place,
): Promise<RouteAmenities> {
  if (coords.length < 2) return { parking: [], alongRoute: [], all: [] }

  const key = amenityKey(dest, coords)
  const hit = AMENITY_CACHE.get(key)
  if (hit) return hit

  const bbox = bboxAroundCoords(coords, 0.006)
  const [osm, tfl] = await Promise.all([fetchOsmAmenities(bbox, dest), fetchTflCycleParks(dest)])
  const merged = dedupe([...osm, ...tfl])

  const destPoint: [number, number] = [dest.lat, dest.lon]
  const parking = merged
    .filter((a) => a.kind === 'parking' && nearPoint(a.lat, a.lon, destPoint, PARKING_RADIUS_M))
    .sort((a, b) => haversineM(a.lat, a.lon, dest.lat, dest.lon) - haversineM(b.lat, b.lon, dest.lat, dest.lon))
    .slice(0, 12)

  const alongRoute = merged
    .filter((a) => a.kind !== 'parking' && nearRoute(a.lat, a.lon, coords))
    .slice(0, 20)

  const result: RouteAmenities = {
    parking,
    alongRoute,
    all: [...parking, ...alongRoute],
  }
  AMENITY_CACHE.set(key, result)
  return result
}
