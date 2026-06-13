import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { LocateFixed } from 'lucide-react'
import type { Place } from '../services/geocode'
import type { RouteResult } from '../services/route'

export interface NavPosition {
  lat: number
  lng: number
  heading: number
}

interface Props {
  start: Place | null
  end: Place | null
  route: RouteResult | null
  traceToken: number // bump to (re)start the tracing animation
  navigating: boolean
  navPosition: NavPosition | null
}

const LONDON_CENTER: L.LatLngExpression = [51.5074, -0.1278]

function pinIcon(color: string, glyph: string) {
  return L.divIcon({
    className: 'pin-wrap',
    html: `<div class="pin" style="--pin:${color}"><span>${glyph}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
  })
}

const BIKE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>'

const NAV_ARROW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>'

const cyclistIcon = L.divIcon({
  className: 'cyclist-wrap',
  html: `<div class="cyclist">${BIKE_SVG}</div>`,
  iconSize: [34, 34],
  iconAnchor: [17, 17],
})

const navArrowIcon = L.divIcon({
  className: 'nav-pos-wrap',
  html: `<div class="nav-pos"><div class="nav-pos-arrow">${NAV_ARROW_SVG}</div></div>`,
  iconSize: [38, 38],
  iconAnchor: [19, 19],
})

export default function MapView({ start, end, route, traceToken, navigating, navPosition }: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const startMarker = useRef<L.Marker | null>(null)
  const endMarker = useRef<L.Marker | null>(null)
  const routeLine = useRef<L.Polyline | null>(null)
  const progressLine = useRef<L.Polyline | null>(null)
  const cyclist = useRef<L.Marker | null>(null)
  const animRef = useRef<number | null>(null)
  const navMarker = useRef<L.Marker | null>(null)
  const followRef = useRef(true)
  const navigatingRef = useRef(navigating)
  const [showRecenter, setShowRecenter] = useState(false)

  useEffect(() => { navigatingRef.current = navigating }, [navigating])

  // Create the map once.
  useEffect(() => {
    if (mapRef.current || !elRef.current) return
    const map = L.map(elRef.current, { zoomControl: false, attributionControl: true }).setView(
      LONDON_CENTER,
      12,
    )
    L.control.zoom({ position: 'bottomright' }).addTo(map)

    // Dark, modern basemap (CARTO Dark Matter) — keyless and open, matches the app UI.
    const dark = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      {
        subdomains: 'abcd',
        maxZoom: 20,
        detectRetina: true,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> | routing &copy; <a href="https://brouter.de">BRouter</a>',
      },
    ).addTo(map)

    // Optional bike-focused layer that highlights the cycle network.
    const cycle = L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.cyclosm.org">CyclOSM</a> | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | routing &copy; <a href="https://brouter.de">BRouter</a>',
    })

    L.control
      .layers(
        { Dark: dark, 'Cycle network': cycle },
        undefined,
        { position: 'topright', collapsed: true },
      )
      .addTo(map)

    // If the rider drags the map away during navigation, stop auto-following
    // and surface a "recenter" button instead of fighting their pan.
    map.on('dragstart', () => {
      if (navigatingRef.current) {
        followRef.current = false
        setShowRecenter(true)
      }
    })

    mapRef.current = map
  }, [])

  // Start / end markers.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    startMarker.current?.remove()
    startMarker.current = null
    if (start) {
      startMarker.current = L.marker([start.lat, start.lon], { icon: pinIcon('#5cf27a', 'A') })
        .addTo(map)
        .bindTooltip(start.short, { direction: 'top', offset: [0, -28] })
    }

    endMarker.current?.remove()
    endMarker.current = null
    if (end) {
      endMarker.current = L.marker([end.lat, end.lon], { icon: pinIcon('#ff6b6b', 'B') })
        .addTo(map)
        .bindTooltip(end.short, { direction: 'top', offset: [0, -28] })
    }

    if (start && end && !route) {
      map.fitBounds(
        L.latLngBounds([start.lat, start.lon], [end.lat, end.lon]),
        { padding: [80, 80] },
      )
    } else if (start && !end) {
      map.setView([start.lat, start.lon], 14)
    }
  }, [start, end, route])

  // Draw the route line and fit the map to it.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    routeLine.current?.remove()
    progressLine.current?.remove()
    cyclist.current?.remove()
    routeLine.current = null
    progressLine.current = null
    cyclist.current = null
    if (animRef.current) cancelAnimationFrame(animRef.current)

    if (!route) return
    routeLine.current = L.polyline(route.coordinates, {
      color: '#5cf27a',
      weight: 5,
      opacity: 0.9,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(map)
    map.fitBounds(routeLine.current.getBounds(), { padding: [70, 70] })
  }, [route])

  // Trace the route: a cyclist rides from A to B while a brighter line follows.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !route || route.coordinates.length < 2 || traceToken === 0) return

    if (animRef.current) cancelAnimationFrame(animRef.current)
    progressLine.current?.remove()
    cyclist.current?.remove()

    const pts = route.coordinates.map((c) => L.latLng(c[0], c[1]))
    // Cumulative distance so the rider moves at constant ground speed.
    const cum: number[] = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i - 1].distanceTo(pts[i]))
    const total = cum[cum.length - 1]

    progressLine.current = L.polyline([pts[0]], {
      color: '#fbbf24',
      weight: 6,
      opacity: 0.95,
    }).addTo(map)
    cyclist.current = L.marker(pts[0], { icon: cyclistIcon, zIndexOffset: 1000 }).addTo(map)

    const duration = Math.min(14000, Math.max(6000, total * 1.2)) // ms, scales with distance
    const startTs = performance.now()

    function frame(now: number) {
      const f = Math.min(1, (now - startTs) / duration)
      const target = f * total
      let i = 1
      while (i < cum.length && cum[i] < target) i++
      const segStart = pts[i - 1]
      const segEnd = pts[Math.min(i, pts.length - 1)]
      const segLen = cum[i] - cum[i - 1] || 1
      const segF = (target - cum[i - 1]) / segLen
      const lat = segStart.lat + (segEnd.lat - segStart.lat) * segF
      const lng = segStart.lng + (segEnd.lng - segStart.lng) * segF
      const here = L.latLng(lat, lng)

      cyclist.current?.setLatLng(here)
      progressLine.current?.setLatLngs([...pts.slice(0, i), here])

      if (f < 1) {
        animRef.current = requestAnimationFrame(frame)
      }
    }
    animRef.current = requestAnimationFrame(frame)

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current)
    }
  }, [traceToken, route])

  // Satnav mode: drop a heading arrow that the map follows along the route.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (!navigating || !navPosition) {
      navMarker.current?.remove()
      navMarker.current = null
      followRef.current = true
      setShowRecenter(false)
      return
    }

    // Entering nav: clear the preview trace so only the live position shows.
    if (animRef.current) cancelAnimationFrame(animRef.current)
    progressLine.current?.remove()
    progressLine.current = null
    cyclist.current?.remove()
    cyclist.current = null

    const ll = L.latLng(navPosition.lat, navPosition.lng)
    if (!navMarker.current) {
      navMarker.current = L.marker(ll, { icon: navArrowIcon, zIndexOffset: 2000 }).addTo(map)
      map.setView(ll, 17, { animate: true })
    } else {
      navMarker.current.setLatLng(ll)
      if (followRef.current) {
        map.panTo(ll, { animate: true, duration: 0.3 })
      }
    }
    const arrow = navMarker.current.getElement()?.querySelector<HTMLElement>('.nav-pos-arrow')
    // The lucide "navigation" glyph points north-east by default, so offset by -45deg.
    if (arrow) arrow.style.transform = `rotate(${navPosition.heading - 45}deg)`
  }, [navigating, navPosition])

  function recenter() {
    const map = mapRef.current
    if (!map || !navMarker.current) return
    followRef.current = true
    setShowRecenter(false)
    map.panTo(navMarker.current.getLatLng(), { animate: true })
  }

  return (
    <>
      <div ref={elRef} className="map" />
      {navigating && showRecenter && (
        <button
          className="recenter-btn"
          onClick={recenter}
          aria-label="Recenter map on my location"
          title="Recenter"
        >
          <LocateFixed size={20} />
        </button>
      )}
    </>
  )
}
