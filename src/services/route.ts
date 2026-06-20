// Bike routing via BRouter — an open-source router built on OpenStreetMap data.
// BRouter ships cycle-specific profiles that weight cycleways, quiet streets and
// surface quality, which is exactly what "most bike-friendly" needs.
import type { Place } from './geocode'

// BRouter's "safety" profile favours cycleways and quiet streets over speed.
const PROFILE = 'safety'

export interface RouteResult {
  coordinates: [number, number][] // [lat, lon] for Leaflet
  distanceKm: number
  durationMin: number
  ascentM: number
}

export async function fetchRoute(start: Place, end: Place): Promise<RouteResult> {
  return fetchRouteLonLats(`${start.lon},${start.lat}|${end.lon},${end.lat}`)
}

/** Recalculate from the rider's current position to the same destination. */
export async function fetchRouteFromPosition(
  lat: number,
  lon: number,
  end: Place,
): Promise<RouteResult> {
  return fetchRouteLonLats(`${lon},${lat}|${end.lon},${end.lat}`)
}

async function fetchRouteLonLats(lonlats: string): Promise<RouteResult> {
  const url = new URL('https://brouter.de/brouter')
  url.searchParams.set('lonlats', lonlats)
  url.searchParams.set('profile', PROFILE)
  url.searchParams.set('alternativeidx', '0')
  url.searchParams.set('format', 'geojson')

  const res = await fetch(url)
  if (!res.ok) {
    throw new Error('Could not find a cycle route between those points.')
  }
  const geojson = await res.json()
  const feature = geojson?.features?.[0]
  if (!feature?.geometry?.coordinates?.length) {
    throw new Error('No cycle route found — try points a little closer together.')
  }

  const props = feature.properties ?? {}
  const coordinates: [number, number][] = feature.geometry.coordinates.map(
    (c: number[]) => [c[1], c[0]],
  )

  return {
    coordinates,
    distanceKm: Number(props['track-length'] ?? 0) / 1000,
    durationMin: Number(props['total-time'] ?? 0) / 60,
    ascentM: Number(props['filtered ascend'] ?? props['plain-ascend'] ?? 0),
  }
}

// Snap two tapped points onto the road network between them, so a hazard
// report follows the actual street rather than a straight line.
export async function snapToRoad(a: [number, number], b: [number, number]): Promise<[number, number][]> {
  const lonlats = `${a[1]},${a[0]}|${b[1]},${b[0]}`
  const url = new URL('https://brouter.de/brouter')
  url.searchParams.set('lonlats', lonlats)
  url.searchParams.set('profile', 'shortest')
  url.searchParams.set('alternativeidx', '0')
  url.searchParams.set('format', 'geojson')

  const res = await fetch(url)
  if (!res.ok) throw new Error('Could not snap to road')
  const geojson = await res.json()
  const feature = geojson?.features?.[0]
  if (!feature?.geometry?.coordinates?.length) throw new Error('No road found')
  return feature.geometry.coordinates.map((c: number[]) => [c[1], c[0]])
}
