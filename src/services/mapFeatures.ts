// Fetch OpenStreetMap features via Overpass — only those along a planned route.

export type FeatureLayer = 'parks' | 'pedestrian' | 'livingStreets' | 'canals'

export interface Bbox {
  south: number
  west: number
  north: number
  east: number
}

interface OverpassNode {
  lat: number
  lon: number
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  tags?: Record<string, string>
  geometry?: OverpassNode[]
}

interface OverpassResponse {
  elements: OverpassElement[]
}

export interface GeoFeatureCollection {
  type: 'FeatureCollection'
  features: GeoFeature[]
}

export interface GeoFeature {
  type: 'Feature'
  properties: Record<string, string | number>
  geometry: GeoPolygon | GeoLineString | GeoMultiLineString
}

interface GeoPolygon {
  type: 'Polygon'
  coordinates: [number, number][][]
}

interface GeoLineString {
  type: 'LineString'
  coordinates: [number, number][]
}

interface GeoMultiLineString {
  type: 'MultiLineString'
  coordinates: [number, number][][]
}

export interface RouteMapContext {
  layers: Partial<Record<FeatureLayer, GeoFeatureCollection>>
  streetLines: [number, number][][]
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

export const ROUTE_INTERACTION_BUFFER_M = 35

const ALL_LAYERS: FeatureLayer[] = ['parks', 'pedestrian', 'livingStreets', 'canals']

const cache = new Map<string, GeoFeatureCollection>()
const routeContextCache = new Map<string, RouteMapContext>()

function bboxKey(layer: FeatureLayer, bbox: Bbox): string {
  const p = 3
  return `${layer}:${bbox.south.toFixed(p)},${bbox.west.toFixed(p)},${bbox.north.toFixed(p)},${bbox.east.toFixed(p)}`
}

function routeKey(coords: [number, number][]): string {
  return coords.map(([lat, lon]) => `${lat.toFixed(4)},${lon.toFixed(4)}`).join('|')
}

function queryFor(layer: FeatureLayer, b: Bbox): string {
  const bb = `${b.south},${b.west},${b.north},${b.east}`
  switch (layer) {
    case 'parks':
      return `[out:json][timeout:25];
(
  way["leisure"~"^(park|garden|nature_reserve|common)$"](${bb});
  relation["leisure"~"^(park|garden|nature_reserve|common)$"](${bb});
  way["landuse"~"^(forest|meadow|recreation_ground)$"](${bb});
  relation["landuse"~"^(forest|meadow|recreation_ground)$"](${bb});
);
out geom;`
    case 'pedestrian':
      return `[out:json][timeout:25];
(
  way["highway"="pedestrian"](${bb});
  way["highway"="footway"]["footway"="square"](${bb});
  way["highway"="living_street"](${bb});
  way["motor_vehicle"="no"]["highway"~"^(residential|unclassified|service|tertiary)$"](${bb});
  way["motor_vehicle"="destination"]["highway"~"^(residential|unclassified|service)$"](${bb});
);
out geom;`
    case 'livingStreets':
      return `[out:json][timeout:25];
(
  way["highway"="living_street"](${bb});
  way["highway"="residential"]["motor_vehicle"~"^(no|destination|private)$"](${bb});
  way["highway"="residential"]["traffic_calming"](${bb});
  way["highway"="unclassified"]["motor_vehicle"~"^(no|destination)$"](${bb});
  way["highway"="service"]["motor_vehicle"="no"](${bb});
);
out geom;`
    case 'canals':
      return `[out:json][timeout:25];
(
  way["waterway"="canal"](${bb});
  relation["waterway"="canal"](${bb});
  way["highway"="cycleway"]["bicycle"="designated"](${bb});
  way["highway"="path"]["bicycle"="designated"]["foot"="designated"](${bb});
);
out geom;`
  }
}

function isClosedRing(geometry: OverpassNode[]): boolean {
  if (geometry.length < 4) return false
  const a = geometry[0], z = geometry[geometry.length - 1]
  return Math.abs(a.lat - z.lat) < 1e-6 && Math.abs(a.lon - z.lon) < 1e-6
}

function isParkArea(el: OverpassElement): boolean {
  const t = el.tags ?? {}
  if (t.leisure && ['park', 'garden', 'nature_reserve', 'common'].includes(t.leisure)) return true
  if (t.landuse && ['forest', 'meadow', 'recreation_ground'].includes(t.landuse)) return true
  return false
}

function toCoords(geometry: OverpassNode[]): [number, number][] {
  return geometry.map((n) => [n.lon, n.lat])
}

function overpassToGeoJSON(layer: FeatureLayer, data: OverpassResponse): GeoFeatureCollection {
  const features: GeoFeature[] = []

  for (const el of data.elements) {
    if (!el.geometry || el.geometry.length < 2) continue
    const coords = toCoords(el.geometry)
    const props: Record<string, string | number> = { osmId: el.id, ...(el.tags ?? {}) }

    if (layer === 'parks' && isParkArea(el) && isClosedRing(el.geometry)) {
      const ring =
        coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1]
          ? coords
          : [...coords, coords[0]]
      features.push({
        type: 'Feature',
        properties: props,
        geometry: { type: 'Polygon', coordinates: [ring] },
      })
      continue
    }

    if (layer === 'parks') continue

    features.push({
      type: 'Feature',
      properties: props,
      geometry: { type: 'LineString', coordinates: coords },
    })
  }

  return { type: 'FeatureCollection', features }
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
      /* try next endpoint */
    }
  }
  return null
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6_371_000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(a))
}

export function distToSegmentM(
  lat: number,
  lon: number,
  [lat1, lon1]: [number, number],
  [lat2, lon2]: [number, number],
): number {
  const dx = lat2 - lat1
  const dy = lon2 - lon1
  if (dx === 0 && dy === 0) return haversineM(lat, lon, lat1, lon1)
  const t = Math.max(0, Math.min(1, ((lat - lat1) * dx + (lon - lon1) * dy) / (dx * dx + dy * dy)))
  return haversineM(lat, lon, lat1 + t * dx, lon1 + t * dy)
}

function pointNearRoute(
  lat: number,
  lon: number,
  route: [number, number][],
  bufferM = ROUTE_INTERACTION_BUFFER_M,
): boolean {
  for (let i = 1; i < route.length; i++) {
    if (distToSegmentM(lat, lon, route[i - 1], route[i]) <= bufferM) return true
  }
  return false
}

function pointInRing(lat: number, lon: number, ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i]
    const [yj, xj] = ring[j]
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi + 0.0) + xi)) {
      inside = !inside
    }
  }
  return inside
}

function lineNearRoute(line: [number, number][], route: [number, number][]): boolean {
  for (const [lat, lon] of line) {
    if (pointNearRoute(lat, lon, route)) return true
  }
  for (const [lat, lon] of route) {
    for (let i = 1; i < line.length; i++) {
      if (distToSegmentM(lat, lon, line[i - 1], line[i]) <= ROUTE_INTERACTION_BUFFER_M) return true
    }
  }
  return false
}

export function featureIntersectsRoute(feature: GeoFeature, route: [number, number][]): boolean {
  const g = feature.geometry
  if (g.type === 'LineString') {
    const line = g.coordinates.map(([lon, lat]) => [lat, lon] as [number, number])
    return lineNearRoute(line, route)
  }
  if (g.type === 'MultiLineString') {
    return g.coordinates.some((coords) =>
      lineNearRoute(coords.map(([lon, lat]) => [lat, lon] as [number, number]), route),
    )
  }
  if (g.type === 'Polygon') {
    const ring = g.coordinates[0].map(([lon, lat]) => [lat, lon] as [number, number])
    for (const [lat, lon] of route) {
      if (pointInRing(lat, lon, ring)) return true
    }
    for (let i = 1; i < ring.length; i++) {
      if (lineNearRoute([ring[i - 1], ring[i]], route)) return true
    }
  }
  return false
}

export function filterGeoJsonForRoute(
  geo: GeoFeatureCollection,
  route: [number, number][],
): GeoFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: geo.features.filter((f) => featureIntersectsRoute(f, route)),
  }
}

export function bboxAroundCoords(coords: [number, number][], paddingDeg = 0.004): Bbox {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity
  for (const [lat, lon] of coords) {
    south = Math.min(south, lat)
    north = Math.max(north, lat)
    west = Math.min(west, lon)
    east = Math.max(east, lon)
  }
  return {
    south: south - paddingDeg,
    west: west - paddingDeg,
    north: north + paddingDeg,
    east: east + paddingDeg,
  }
}

export function extractStreetLines(geo: GeoFeatureCollection): [number, number][][] {
  const lines: [number, number][][] = []
  for (const f of geo.features) {
    const g = f.geometry
    if (g.type === 'LineString') {
      lines.push(g.coordinates.map(([lon, lat]) => [lat, lon]))
    } else if (g.type === 'MultiLineString') {
      for (const line of g.coordinates) {
        lines.push(line.map(([lon, lat]) => [lat, lon]))
      }
    }
  }
  return lines
}

async function fetchMapFeatures(layer: FeatureLayer, bbox: Bbox): Promise<GeoFeatureCollection | null> {
  const key = bboxKey(layer, bbox)
  const hit = cache.get(key)
  if (hit) return hit

  const data = await postOverpass(queryFor(layer, bbox))
  if (!data) return null

  const geo = overpassToGeoJSON(layer, data)
  cache.set(key, geo)
  return geo
}

/** Fetch OSM layers along a route bbox, keeping only features the route uses. */
export async function fetchRouteContext(coords: [number, number][]): Promise<RouteMapContext> {
  if (coords.length < 2) return { layers: {}, streetLines: [] }

  const key = routeKey(coords)
  const hit = routeContextCache.get(key)
  if (hit) return hit

  const bbox = bboxAroundCoords(coords)
  const results = await Promise.all(ALL_LAYERS.map((layer) => fetchMapFeatures(layer, bbox)))

  const layers: Partial<Record<FeatureLayer, GeoFeatureCollection>> = {}
  for (let i = 0; i < ALL_LAYERS.length; i++) {
    const geo = results[i]
    if (!geo) continue
    const filtered = filterGeoJsonForRoute(geo, coords)
    if (filtered.features.length > 0) layers[ALL_LAYERS[i]] = filtered
  }

  const streetLines = [
    ...(layers.livingStreets ? extractStreetLines(layers.livingStreets) : []),
    ...(layers.pedestrian ? extractStreetLines(layers.pedestrian) : []),
  ]

  const ctx = { layers, streetLines }
  routeContextCache.set(key, ctx)
  return ctx
}
