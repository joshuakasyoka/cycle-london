// Address search via Nominatim (OpenStreetMap's open geocoder).
// Results are constrained to Greater London so suggestions stay relevant.

export interface Place {
  label: string
  short: string
  lat: number
  lon: number
}

// Greater London bounding box as Nominatim viewbox: west,south,east,north
const LONDON_VIEWBOX = '-0.563,51.261,0.318,51.686'

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const q = query.trim()
  if (q.length < 3) return []

  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', q)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('limit', '6')
  url.searchParams.set('countrycodes', 'gb')
  url.searchParams.set('viewbox', LONDON_VIEWBOX)
  url.searchParams.set('bounded', '1')

  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error('Address search failed')
  const data: any[] = await res.json()

  return data.map((d) => {
    const a = d.address ?? {}
    const name =
      d.name ||
      a.road ||
      a.neighbourhood ||
      a.suburb ||
      (d.display_name as string).split(',')[0]
    const area = a.suburb || a.city_district || a.town || a.city || 'London'
    return {
      label: d.display_name as string,
      short: area && name !== area ? `${name}, ${area}` : name,
      lat: parseFloat(d.lat),
      lon: parseFloat(d.lon),
    }
  })
}

// Look up an address for a GPS fix, used for the "current location" shortcut.
export async function reverseGeocode(lat: number, lon: number): Promise<Place> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('lat', String(lat))
  url.searchParams.set('lon', String(lon))
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('addressdetails', '1')

  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error('Reverse geocoding failed')
  const d = await res.json()
  const a = d.address ?? {}
  const name = d.name || a.road || a.neighbourhood || a.suburb || 'Current location'
  const area = a.suburb || a.city_district || a.town || a.city || 'London'
  return {
    label: (d.display_name as string) || 'Current location',
    short: area && name !== area ? `${name}, ${area}` : name,
    lat,
    lon,
  }
}
