// Bike routing via BRouter — an open-source router built on OpenStreetMap data.
// BRouter ships cycle-specific profiles that weight cycleways, quiet streets and
// surface quality, which is exactly what "most bike-friendly" needs.
import type { Place } from './geocode'

export type BikeProfile = 'safety' | 'trekking' | 'fastbike'

export interface RouteMode {
  id: BikeProfile
  label: string
  blurb: string
}

// The three modes the UI exposes, ordered from quietest to quickest.
export const ROUTE_MODES: RouteMode[] = [
  { id: 'safety', label: 'Quiet & Safe', blurb: 'Avoids traffic, favours cycleways' },
  { id: 'trekking', label: 'Balanced', blurb: 'Sensible mix of speed and calm streets' },
  { id: 'fastbike', label: 'Fastest', blurb: 'Most direct, road-confident riders' },
]

export interface RouteResult {
  coordinates: [number, number][] // [lat, lon] for Leaflet
  distanceKm: number
  durationMin: number
  ascentM: number
}

export async function fetchRoute(
  start: Place,
  end: Place,
  profile: BikeProfile,
): Promise<RouteResult> {
  const lonlats = `${start.lon},${start.lat}|${end.lon},${end.lat}`
  const url = new URL('https://brouter.de/brouter')
  url.searchParams.set('lonlats', lonlats)
  url.searchParams.set('profile', profile)
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
