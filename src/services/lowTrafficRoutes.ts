// Detect where a planned route follows low-traffic streets from OSM geometry.

import { distToSegmentM, ROUTE_INTERACTION_BUFFER_M } from './mapFeatures'

let quietStreetLines: [number, number][][] = []

export function setQuietStreetLines(lines: [number, number][][]) {
  quietStreetLines = lines
}

function isOnQuietStreet(lat: number, lon: number): boolean {
  for (const line of quietStreetLines) {
    for (let i = 1; i < line.length; i++) {
      if (distToSegmentM(lat, lon, line[i - 1], line[i]) <= ROUTE_INTERACTION_BUFFER_M) return true
    }
  }
  return false
}

/** Rough share of the route (by point count) on low-traffic streets. */
export function quietRouteShare(coords: [number, number][]): number {
  if (coords.length === 0 || quietStreetLines.length === 0) return 0
  const quiet = coords.filter(([lat, lon]) => isOnQuietStreet(lat, lon)).length
  return quiet / coords.length
}
