// Turn-by-turn navigation helpers.
// Maneuvers are derived from the route geometry itself (bearing change at each
// vertex), so they work for any BRouter route without extra API calls.
import L from 'leaflet'
import type { HazardSegment } from './hazards'

export type ManeuverType =
  | 'depart'
  | 'arrive'
  | 'straight'
  | 'left'
  | 'right'
  | 'slight-left'
  | 'slight-right'
  | 'sharp-left'
  | 'sharp-right'

export interface Maneuver {
  type: ManeuverType
  text: string
  at: L.LatLng
  distanceFromStart: number // metres along the route
}

export interface NavRoute {
  points: L.LatLng[]
  cum: number[] // cumulative distance to each point (metres)
  total: number
  maneuvers: Maneuver[]
}

function bearing(a: L.LatLng, b: L.LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat))
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng))
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360
}

// Positive angle = turning right, negative = left.
function classify(delta: number): Pick<Maneuver, 'type' | 'text'> | null {
  const a = Math.abs(delta)
  if (a < 23) return null // road curve, not a junction
  const right = delta > 0
  if (a < 50)
    return right
      ? { type: 'slight-right', text: 'Slight right' }
      : { type: 'slight-left', text: 'Slight left' }
  if (a <= 115)
    return right
      ? { type: 'right', text: 'Turn right' }
      : { type: 'left', text: 'Turn left' }
  return right
    ? { type: 'sharp-right', text: 'Sharp right' }
    : { type: 'sharp-left', text: 'Sharp left' }
}

export function buildNavRoute(coordinates: [number, number][]): NavRoute {
  const points = coordinates.map((c) => L.latLng(c[0], c[1]))
  const cum: number[] = [0]
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + points[i - 1].distanceTo(points[i]))
  }
  const total = cum[cum.length - 1]

  const maneuvers: Maneuver[] = [
    { type: 'depart', text: 'Start your ride', at: points[0], distanceFromStart: 0 },
  ]

  for (let i = 1; i < points.length - 1; i++) {
    const inB = bearing(points[i - 1], points[i])
    const outB = bearing(points[i], points[i + 1])
    const delta = ((outB - inB + 540) % 360) - 180
    const turn = classify(delta)
    if (!turn) continue
    // Suppress near-duplicate maneuvers from clusters of OSM vertices.
    const last = maneuvers[maneuvers.length - 1]
    if (cum[i] - last.distanceFromStart < 18) continue
    maneuvers.push({ ...turn, at: points[i], distanceFromStart: cum[i] })
  }

  maneuvers.push({
    type: 'arrive',
    text: 'You have arrived',
    at: points[points.length - 1],
    distanceFromStart: total,
  })

  return { points, cum, total, maneuvers }
}

// Interpolated position (and heading) a given distance along the route.
export function positionAt(nav: NavRoute, dist: number): { lat: number; lng: number; heading: number } {
  const { points, cum, total } = nav
  const d = Math.max(0, Math.min(dist, total))
  let i = 1
  while (i < cum.length && cum[i] < d) i++
  const a = points[i - 1]
  const b = points[Math.min(i, points.length - 1)]
  const segLen = (cum[i] ?? total) - cum[i - 1] || 1
  const f = (d - cum[i - 1]) / segLen
  return {
    lat: a.lat + (b.lat - a.lat) * f,
    lng: a.lng + (b.lng - a.lng) * f,
    heading: bearing(a, b),
  }
}

export interface RouteProjection {
  dist: number // distance along the route to the snapped point (metres)
  lat: number // snapped point on the route
  lng: number
  heading: number // travel direction of the route at that point
  offRouteMeters: number // how far the raw fix is from the route
}

// Snap a live GPS fix onto the nearest point of the route so we can tell how far
// along the rider is and which maneuver is next. Uses a local planar
// approximation, which is accurate over the short distances involved.
export function projectOntoRoute(nav: NavRoute, lat: number, lng: number): RouteProjection {
  const mLat = 110540
  const mLng = 111320 * Math.cos((lat * Math.PI) / 180)
  const px = lng * mLng
  const py = lat * mLat

  let best: RouteProjection = { dist: 0, lat, lng, heading: 0, offRouteMeters: Infinity }
  for (let i = 1; i < nav.points.length; i++) {
    const a = nav.points[i - 1]
    const b = nav.points[i]
    const ax = a.lng * mLng
    const ay = a.lat * mLat
    const dx = b.lng * mLng - ax
    const dy = b.lat * mLat - ay
    const len2 = dx * dx + dy * dy || 1
    let t = ((px - ax) * dx + (py - ay) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const off = Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
    if (off < best.offRouteMeters) {
      best = {
        offRouteMeters: off,
        dist: nav.cum[i - 1] + t * (nav.cum[i] - nav.cum[i - 1]),
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        heading: bearing(a, b),
      }
    }
  }
  return best
}

// The next maneuver ahead of the current distance, plus the one after it.
export function upcoming(nav: NavRoute, dist: number) {
  const idx = nav.maneuvers.findIndex((m) => m.distanceFromStart > dist + 1)
  const next = idx === -1 ? nav.maneuvers[nav.maneuvers.length - 1] : nav.maneuvers[idx]
  const then = idx === -1 || idx + 1 >= nav.maneuvers.length ? null : nav.maneuvers[idx + 1]
  return { next, then, distanceToNext: Math.max(0, next.distanceFromStart - dist) }
}

// Rider-reported hazards whose endpoints fall on (or near) the upcoming
// stretch of the route — used to warn riders during navigation.
export function hazardsAhead(
  nav: NavRoute,
  hazards: HazardSegment[],
  dist: number,
  lookaheadM = 150,
  maxOffsetM = 30,
): HazardSegment[] {
  return hazards.filter((h) =>
    h.points.some(([lat, lon]) => {
      const proj = projectOntoRoute(nav, lat, lon)
      return proj.offRouteMeters <= maxOffsetM && proj.dist >= dist && proj.dist <= dist + lookaheadM
    }),
  )
}

// Rider-reported hazards that fall on (or near) the route at all, ordered by
// distance along the route — used to preview unsafe stretches before a ride.
export function hazardsOnRoute(
  nav: NavRoute,
  hazards: HazardSegment[],
  maxOffsetM = 30,
): HazardSegment[] {
  const withDist: { hazard: HazardSegment; dist: number }[] = []
  for (const h of hazards) {
    let best = Infinity
    for (const [lat, lon] of h.points) {
      const proj = projectOntoRoute(nav, lat, lon)
      if (proj.offRouteMeters <= maxOffsetM && proj.dist < best) best = proj.dist
    }
    if (best !== Infinity) withDist.push({ hazard: h, dist: best })
  }
  return withDist.sort((a, b) => a.dist - b.dist).map((x) => x.hazard)
}

export function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`
  if (m >= 100) return `${Math.round(m / 10) * 10} m`
  return `${Math.max(0, Math.round(m / 5) * 5)} m`
}
