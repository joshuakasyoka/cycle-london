// Address search — Photon (Komoot/OSM) for house-level matches, Nominatim as
// a fallback for areas and POIs. Biased to Greater London.

export interface Place {
  label: string
  short: string
  lat: number
  lon: number
}

const LONDON_VIEWBOX = '-0.563,51.261,0.318,51.686'
const LONDON_CENTER = { lat: 51.5074, lon: -0.1278 }
const SEARCH_LIMIT = 12
const NOMINATIM_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'CycleLondon/1.0 (bike routing app)',
}

interface ParsedQuery {
  freeText: string
  housenumber?: string
  street?: string
  /** e.g. "81" from "81b" — used as a fallback when letter-suffix addresses miss */
  housenumberBase?: string
}

/** Split "81b flaxman road" into structured parts for targeted lookups. */
export function parseAddressQuery(query: string): ParsedQuery {
  const freeText = query.trim().replace(/\s+/g, ' ')
  const match = freeText.match(/^(\d+\s*[a-zA-Z]?)\s+(.+)$/i)
  if (!match) return { freeText }

  const housenumber = match[1].replace(/\s/g, '')
  const street = match[2].trim()
  const base = housenumber.match(/^(\d+)/)?.[1]
  return {
    freeText,
    housenumber,
    street,
    housenumberBase: base && base !== housenumber ? base : undefined,
  }
}

function withLondonContext(query: string): string {
  const q = query.trim()
  if (/\blondon\b/i.test(q)) return q
  return `${q}, London`
}

function placeKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)}:${lon.toFixed(4)}`
}

function formatShort(parts: {
  housenumber?: string
  street?: string
  name?: string
  postcode?: string
  suburb?: string
  city?: string
}): { short: string; label: string } {
  const line1 = [parts.housenumber, parts.street || parts.name].filter(Boolean).join(' ')
  const name = line1 || parts.name || 'Unknown'
  const locality = parts.postcode || parts.suburb || parts.city || 'London'
  const labelParts = [name, parts.postcode, parts.suburb, parts.city, 'United Kingdom'].filter(Boolean)
  return {
    short: locality && name !== locality ? `${name}, ${locality}` : name,
    label: labelParts.join(', '),
  }
}

function fromNominatim(d: Record<string, unknown>): Place {
  const a = (d.address ?? {}) as Record<string, string>
  const housenumber = a.house_number
  const road = a.road
  const name =
    (d.name as string) ||
    [housenumber, road].filter(Boolean).join(' ') ||
    a.neighbourhood ||
    a.suburb ||
    (d.display_name as string).split(',')[0]
  const { short, label } = formatShort({
    housenumber,
    street: road,
    name,
    postcode: a.postcode,
    suburb: a.suburb || a.city_district,
    city: a.city || a.town,
  })
  return {
    label: (d.display_name as string) || label,
    short,
    lat: parseFloat(d.lat as string),
    lon: parseFloat(d.lon as string),
  }
}

function fromPhoton(f: GeoJSON.Feature): Place | null {
  const p = f.properties as Record<string, string | undefined> | undefined
  if (!p || f.geometry?.type !== 'Point') return null
  const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates
  const { short, label } = formatShort({
    housenumber: p.housenumber,
    street: p.street,
    name: p.name,
    postcode: p.postcode,
    suburb: p.district || p.locality,
    city: p.city,
  })
  return { label, short, lat, lon }
}

function streetMatches(street: string, candidate?: string): boolean {
  if (!candidate) return false
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const a = norm(street)
  const b = norm(candidate)
  return b.includes(a) || a.includes(b)
}

/** Prefer the housenumber the user typed when we only found the numeric neighbour. */
function applyRequestedHousenumber(places: Place[], parsed: ParsedQuery): Place[] {
  if (!parsed.housenumber || !parsed.street) return places

  const exact = places.find((p) => {
    const head = p.short.split(',')[0].toLowerCase()
    return head.startsWith(parsed.housenumber!.toLowerCase()) && head.includes(parsed.street!.toLowerCase())
  })
  if (exact) {
    return [exact, ...places.filter((p) => p !== exact)]
  }

  const onStreetWithNumber = places.find((p) => {
    const head = p.short.split(',')[0]
    return (
      streetMatches(parsed.street!, head) &&
      parsed.housenumberBase != null &&
      head.toLowerCase().startsWith(parsed.housenumberBase)
    )
  })

  const onStreet = onStreetWithNumber ?? places.find((p) => streetMatches(parsed.street!, p.short.split(',')[0]))

  if (onStreet && parsed.housenumber !== parsed.housenumberBase) {
    const locality = onStreet.short.includes(',') ? onStreet.short.split(',').slice(1).join(',').trim() : 'London'
    const adjusted: Place = {
      ...onStreet,
      short: `${parsed.housenumber} ${parsed.street}, ${locality}`,
      label: onStreet.label.replace(/^\d+\s*[a-zA-Z]?/i, parsed.housenumber),
    }
    return [adjusted, ...places.filter((p) => p !== onStreet)]
  }

  return places
}

function rankPlaces(places: Place[], parsed: ParsedQuery): Place[] {
  const street = parsed.street?.toLowerCase()
  const house = parsed.housenumber?.toLowerCase()
  const houseBase = parsed.housenumberBase?.toLowerCase()

  return [...places].sort((a, b) => {
    const score = (p: Place) => {
      const head = p.short.split(',')[0].toLowerCase()
      let s = 0
      if (house && head.startsWith(house)) s += 50
      else if (houseBase && head.startsWith(houseBase) && street && head.includes(street)) s += 45
      if (street && head.includes(street)) s += 30
      else if (street && p.label.toLowerCase().includes(street)) s += 15
      if (/^\d/.test(head)) s += 8
      if (p.label.toLowerCase().includes('london')) s += 5
      if (p.label.match(/\bSE\d|SW\d|N\d|E\d|W\d|EC\d|WC\d|NW\d|NE\d/i)) s += 3
      return s
    }
    return score(b) - score(a)
  })
}

async function searchPhoton(query: string, signal?: AbortSignal): Promise<Place[]> {
  const url = new URL('https://photon.komoot.io/api/')
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(SEARCH_LIMIT))
  url.searchParams.set('lat', String(LONDON_CENTER.lat))
  url.searchParams.set('lon', String(LONDON_CENTER.lon))
  url.searchParams.set('bbox', LONDON_VIEWBOX)

  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error('Address search failed')
  const data = (await res.json()) as GeoJSON.FeatureCollection
  return (data.features ?? [])
    .map(fromPhoton)
    .filter((p): p is Place => p != null)
}

async function searchNominatim(
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<Place[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('limit', String(SEARCH_LIMIT))
  url.searchParams.set('countrycodes', 'gb')
  url.searchParams.set('viewbox', LONDON_VIEWBOX)
  // Bias to London but don't discard good matches at the edge of the box.
  url.searchParams.set('bounded', '0')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url, { signal, headers: NOMINATIM_HEADERS })
  if (!res.ok) throw new Error('Address search failed')
  const data = (await res.json()) as Record<string, unknown>[]
  return data.map(fromNominatim)
}

function mergePlaces(lists: Place[][]): Place[] {
  const seen = new Set<string>()
  const out: Place[] = []
  for (const list of lists) {
    for (const p of list) {
      const key = placeKey(p.lat, p.lon)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(p)
    }
  }
  return out
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const parsed = parseAddressQuery(query)
  if (parsed.freeText.length < 2) return []

  const queries = new Set<string>([withLondonContext(parsed.freeText)])

  if (parsed.housenumber && parsed.street) {
    queries.add(withLondonContext(`${parsed.housenumber} ${parsed.street}`))
    if (parsed.housenumberBase) {
      queries.add(withLondonContext(`${parsed.housenumberBase} ${parsed.street}`))
    }
  }

  const photonLists = await Promise.all(
    [...queries].map((q) => searchPhoton(q, signal).catch(() => [] as Place[])),
  )

  const nominatimParams: Record<string, string>[] = [
    { q: withLondonContext(parsed.freeText) },
  ]

  if (parsed.housenumber && parsed.street) {
    nominatimParams.push({
      street: parsed.street,
      housenumber: parsed.housenumber,
      city: 'London',
      country: 'United Kingdom',
    })
    if (parsed.housenumberBase) {
      nominatimParams.push({
        street: parsed.street,
        housenumber: parsed.housenumberBase,
        city: 'London',
        country: 'United Kingdom',
      })
    }
  }

  const nominatimLists = await Promise.all(
    nominatimParams.map((p) => searchNominatim(p, signal).catch(() => [] as Place[])),
  )

  const merged = mergePlaces([...photonLists, ...nominatimLists])
  const ranked = rankPlaces(merged, parsed)
  const withHouse = applyRequestedHousenumber(ranked, parsed)
  return withHouse.slice(0, SEARCH_LIMIT)
}

// Look up an address for a GPS fix, used for the "current location" shortcut.
export async function reverseGeocode(lat: number, lon: number): Promise<Place> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lon))
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('addressdetails', '1')

  const res = await fetch(url, { headers: NOMINATIM_HEADERS })
  if (!res.ok) throw new Error('Reverse geocoding failed')
  const d = await res.json()
  return fromNominatim(d)
}
