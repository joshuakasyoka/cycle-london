import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { LocateFixed } from 'lucide-react'
import { DANGER_ZONES } from '../data/dangerZones'
import type { Place } from '../services/geocode'
import type { RouteResult } from '../services/route'
import type { HazardSegment } from '../services/hazards'

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
  hazards: HazardSegment[]
  routeHazards: HazardSegment[] // hazards overlapping the planned route, in order
  preview: { id: string; token: number } | null // pan/zoom to this hazard
  reporting: boolean
  pendingPoints: [number, number][]
  pendingPath: [number, number][] | null
  onMapClick: (lat: number, lon: number) => void
  onRemoveHazard: (id: string) => void
  onVoteHazard: (id: string, vote: 1 | -1) => void
}

const LONDON_CENTER: L.LatLngExpression = [51.5074, -0.1278]

const PIN_SVG = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="${color}" stroke="#0a0a0c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>`

const THUMBS_UP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/><path d="M7 10v12"/></svg>'

const THUMBS_DOWN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/><path d="M17 14V2"/></svg>'

const LAYERS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>'

function buildHazardPopup(
  h: HazardSegment,
  onVoteHazard: (id: string, vote: 1 | -1) => void,
  onRemoveHazard: (id: string) => void,
): HTMLElement {
  const popup = document.createElement('div')
  popup.className = 'hazard-popup'
  // Keep clicks inside the popup from bubbling to the map, which would
  // otherwise close the popup before the vote/remove handlers can run.
  L.DomEvent.disableClickPropagation(popup)
  L.DomEvent.on(popup, 'click', L.DomEvent.stopPropagation)

  const note = document.createElement('p')
  note.textContent = h.note || 'Reported as an unsafe stretch by a rider.'

  const votes = document.createElement('div')
  votes.className = 'hazard-votes'
  const up = document.createElement('button')
  up.className = `hazard-vote hazard-vote--up ${h.myVote === 1 ? 'hazard-vote--active' : ''}`
  up.innerHTML = `${THUMBS_UP_SVG}<span>${h.upvotes}</span>`
  up.setAttribute('aria-label', 'Agree this is unsafe')
  up.onclick = () => onVoteHazard(h.id, 1)
  const down = document.createElement('button')
  down.className = `hazard-vote hazard-vote--down ${h.myVote === -1 ? 'hazard-vote--active' : ''}`
  down.innerHTML = `${THUMBS_DOWN_SVG}<span>${h.downvotes}</span>`
  down.setAttribute('aria-label', 'Disagree this is unsafe')
  down.onclick = () => onVoteHazard(h.id, -1)
  votes.append(up, down)

  const remove = document.createElement('button')
  remove.className = 'hazard-remove'
  remove.textContent = 'Remove report'
  remove.onclick = () => onRemoveHazard(h.id)

  popup.append(note, votes, remove)
  return popup
}

function pinIcon(color: string) {
  return L.divIcon({
    className: 'pin-wrap',
    html: `<div class="pin-lucide">${PIN_SVG(color)}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 28],
  })
}

function hazardNumberIcon(n: number) {
  return L.divIcon({
    className: 'hazard-number-wrap',
    html: `<div class="hazard-number">${n}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
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

export default function MapView({
  start,
  end,
  route,
  traceToken,
  navigating,
  navPosition,
  hazards,
  routeHazards,
  preview,
  reporting,
  pendingPoints,
  pendingPath,
  onMapClick,
  onRemoveHazard,
  onVoteHazard,
}: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const rotorRef = useRef<HTMLDivElement>(null)
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
  const deviceHeadingRef = useRef<number | null>(null)
  const currentHeadingRef = useRef(0)
  const hazardsLayer = useRef<L.LayerGroup | null>(null)
  const pendingLayer = useRef<L.LayerGroup | null>(null)
  const routeHazardLayer = useRef<L.LayerGroup | null>(null)
  const hazardLinesRef = useRef<Map<string, L.Polyline>>(new Map())
  const dragStateRef = useRef<{ active: boolean; lastX: number; lastY: number; pointerId: number | null }>({
    active: false,
    lastX: 0,
    lastY: 0,
    pointerId: null,
  })
  const [showRecenter, setShowRecenter] = useState(false)

  useEffect(() => { navigatingRef.current = navigating }, [navigating])

  // Point the position arrow in the given compass direction, and rotate the
  // whole map so that direction faces "up" the screen — a track-up satnav view.
  function applyHeading(heading: number) {
    currentHeadingRef.current = heading
    const arrow = navMarker.current?.getElement()?.querySelector<HTMLElement>('.nav-pos-arrow')
    // The lucide "navigation" glyph points north-east by default, so offset by -45deg.
    if (arrow) arrow.style.transform = `rotate(${heading - 45}deg)`
    if (rotorRef.current) rotorRef.current.style.transform = `rotate(${-heading}deg)`

    // Counter-rotate any open tooltip labels so their text stays upright
    // inside the rotated track-up container.
    mapRef.current?.getContainer()
      .querySelectorAll<HTMLElement>('.leaflet-tooltip .tt-label')
      .forEach((el) => { el.style.transform = `rotate(${heading}deg)` })
  }

  // While navigating, point the position arrow — and the map itself — at the
  // compass heading of the phone (i.e. the direction it's physically facing)
  // rather than the route's travel direction.
  useEffect(() => {
    if (!navigating) {
      deviceHeadingRef.current = null
      return
    }

    function onOrientation(e: DeviceOrientationEvent) {
      const webkitHeading = (e as DeviceOrientationEvent & { webkitCompassHeading?: number })
        .webkitCompassHeading
      const heading = typeof webkitHeading === 'number' ? webkitHeading : e.alpha != null ? 360 - e.alpha : null
      if (heading == null) return

      deviceHeadingRef.current = heading
      applyHeading(heading)
    }

    const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation'
    window.addEventListener(eventName, onOrientation as EventListener)
    return () => window.removeEventListener(eventName, onOrientation as EventListener)
  }, [navigating])

  // Create the map once.
  useEffect(() => {
    if (mapRef.current || !elRef.current) return
    const map = L.map(elRef.current, { zoomControl: false, attributionControl: true }).setView(
      LONDON_CENTER,
      12,
    )
    L.control.zoom({ position: 'bottomright' }).addTo(map)

    // Clean, light basemap (CARTO Positron) — keyless, open, and easy to read at a glance.
    const light = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
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

    // Known collision hotspots for cyclists, shown as red zones.
    const dangerZones = L.layerGroup(
      DANGER_ZONES.map((z) =>
        L.circle([z.lat, z.lon], {
          radius: z.radiusM,
          color: '#ef4444',
          weight: 1.5,
          fillColor: '#ef4444',
          fillOpacity: 0.22,
        }).bindTooltip(`<span class="tt-label">${z.name} — ${z.note}</span>`, { sticky: true }),
      ),
    ).addTo(map)

    // Rider-reported unsafe stretches, and the in-progress pending report.
    hazardsLayer.current = L.layerGroup().addTo(map)
    pendingLayer.current = L.layerGroup().addTo(map)
    routeHazardLayer.current = L.layerGroup().addTo(map)

    const layersControl = L.control
      .layers(
        { Light: light, 'Cycle network': cycle },
        { 'Danger zones': dangerZones, 'Unsafe roads (reported)': hazardsLayer.current },
        { position: 'topright', collapsed: true },
      )
      .addTo(map)

    // Swap Leaflet's default stacked-layers image for a lucide icon.
    const layersToggle = layersControl.getContainer()?.querySelector<HTMLElement>('.leaflet-control-layers-toggle')
    if (layersToggle) {
      layersToggle.innerHTML = LAYERS_SVG
      layersToggle.classList.add('leaflet-control-layers-toggle--lucide')
    }

    // If the rider drags the map away during navigation, stop auto-following
    // and surface a "recenter" button instead of fighting their pan.
    map.on('dragstart', () => {
      if (navigatingRef.current) {
        followRef.current = false
        setShowRecenter(true)
      }
    })

    // Tooltips live inside the rotated track-up container, so newly opened
    // ones need their label counter-rotated to stay upright immediately.
    map.on('tooltipopen', (e) => {
      e.tooltip
        .getElement()
        ?.querySelectorAll<HTMLElement>('.tt-label')
        .forEach((el) => { el.style.transform = `rotate(${currentHeadingRef.current}deg)` })
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
      startMarker.current = L.marker([start.lat, start.lon], { icon: pinIcon('#16a34a') })
        .addTo(map)
        .bindTooltip(`<span class="tt-label">${start.short}</span>`, { direction: 'top', offset: [0, -28] })
    }

    endMarker.current?.remove()
    endMarker.current = null
    if (end) {
      endMarker.current = L.marker([end.lat, end.lon], { icon: pinIcon('#ef4444') })
        .addTo(map)
        .bindTooltip(`<span class="tt-label">${end.short}</span>`, { direction: 'top', offset: [0, -28] })
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
      color: '#16a34a',
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
      color: '#f59e0b',
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
      if (rotorRef.current) rotorRef.current.style.transform = 'rotate(0deg)'

      // Leaving track-up mode shrinks the map container back down — restore
      // the view so the same spot stays centred.
      const center = map.getCenter()
      const zoom = map.getZoom()
      requestAnimationFrame(() => {
        map.invalidateSize()
        map.setView(center, zoom, { animate: false })
      })
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
      // Entering track-up mode grows the map container to cover the rotated
      // viewport — resync Leaflet's size before centring on the rider.
      requestAnimationFrame(() => {
        map.invalidateSize()
        map.setView(ll, 17, { animate: true })
      })
    } else {
      navMarker.current.setLatLng(ll)
      if (followRef.current) {
        map.panTo(ll, { animate: true, duration: 0.3 })
      }
    }
    // Prefer the phone's own compass heading; fall back to the route's travel
    // direction when orientation data isn't available (e.g. desktop browsers).
    applyHeading(deviceHeadingRef.current ?? navPosition.heading)
  }, [navigating, navPosition])

  // Draw rider-reported unsafe stretches as dashed red lines. Existing
  // polylines/popups are updated in place (rather than cleared and rebuilt)
  // so an open popup doesn't get dismissed when its vote counts change.
  useEffect(() => {
    const layer = hazardsLayer.current
    if (!layer) return
    const existing = hazardLinesRef.current
    const seen = new Set<string>()

    for (const h of hazards) {
      seen.add(h.id)
      const content = buildHazardPopup(h, onVoteHazard, onRemoveHazard)
      let line = existing.get(h.id)
      if (line) {
        line.setPopupContent(content)
      } else {
        line = L.polyline(h.points, {
          color: '#ef4444',
          weight: 6,
          opacity: 0.85,
          dashArray: '2 10',
          lineCap: 'round',
        }).addTo(layer)
        line.bindPopup(content)
        existing.set(h.id, line)
      }
    }

    for (const [id, line] of existing) {
      if (!seen.has(id)) {
        line.remove()
        existing.delete(id)
      }
    }
  }, [hazards, onRemoveHazard, onVoteHazard])

  // While reporting, let the rider tap two points on the map to mark a stretch.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const container = map.getContainer()
    if (!reporting) {
      container.style.cursor = ''
      return
    }
    container.style.cursor = 'crosshair'
    function onClick(e: L.LeafletMouseEvent) {
      onMapClick(e.latlng.lat, e.latlng.lng)
    }
    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
      container.style.cursor = ''
    }
  }, [reporting, onMapClick])

  // Show the points picked so far for the in-progress hazard report, and the
  // road-snapped path once it's been resolved.
  useEffect(() => {
    const layer = pendingLayer.current
    if (!layer) return
    layer.clearLayers()
    for (const [lat, lon] of pendingPoints) {
      L.circleMarker([lat, lon], {
        radius: 7,
        color: '#ef4444',
        weight: 2,
        fillColor: '#ef4444',
        fillOpacity: 0.9,
      }).addTo(layer)
    }
    if (pendingPoints.length === 2) {
      const path = pendingPath && pendingPath.length >= 2 ? pendingPath : pendingPoints
      L.polyline(path, { color: '#ef4444', weight: 5, dashArray: '6 8', lineCap: 'round' }).addTo(layer)
    }
  }, [pendingPoints, pendingPath])

  // Numbered markers for hazards that overlap the planned route, shown before
  // the ride starts so the rider can preview each unsafe stretch.
  useEffect(() => {
    const layer = routeHazardLayer.current
    if (!layer) return
    layer.clearLayers()
    routeHazards.forEach((h, i) => {
      const mid = h.points[Math.floor(h.points.length / 2)]
      L.marker(mid, { icon: hazardNumberIcon(i + 1), zIndexOffset: 900 }).addTo(layer)
    })
  }, [routeHazards])

  // Pan/zoom to a hazard and open its popup when the rider taps it in the
  // overlap list.
  useEffect(() => {
    if (!preview) return
    const map = mapRef.current
    const line = hazardLinesRef.current.get(preview.id)
    if (!map || !line) return
    const bounds = line.getBounds()
    map.fitBounds(bounds, { padding: [80, 80], maxZoom: 17 })
    line.openPopup(bounds.getCenter())
  }, [preview])

  // Leaflet's drag handling computes pointer deltas in unrotated screen space,
  // which fights the CSS-rotated track-up container during navigation. Disable
  // Leaflet's own dragging while navigating and pan manually instead, rotating
  // the screen-space delta back into the map's (rotated) pixel space first so
  // the content tracks the finger correctly.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (navigating) map.dragging.disable()
    else map.dragging.enable()
  }, [navigating])

  useEffect(() => {
    const map = mapRef.current
    const el = elRef.current
    if (!map || !el) return

    function onPointerDown(e: PointerEvent) {
      if (!navigatingRef.current) return
      dragStateRef.current = { active: true, lastX: e.clientX, lastY: e.clientY, pointerId: e.pointerId }
      el!.setPointerCapture(e.pointerId)
      followRef.current = false
      setShowRecenter(true)
    }
    function onPointerMove(e: PointerEvent) {
      const s = dragStateRef.current
      if (!s.active || s.pointerId !== e.pointerId) return
      const dx = e.clientX - s.lastX
      const dy = e.clientY - s.lastY
      s.lastX = e.clientX
      s.lastY = e.clientY
      const rad = (currentHeadingRef.current * Math.PI) / 180
      const contentDx = dx * Math.cos(rad) - dy * Math.sin(rad)
      const contentDy = dx * Math.sin(rad) + dy * Math.cos(rad)
      map!.panBy([-contentDx, -contentDy], { animate: false })
    }
    function onPointerUp(e: PointerEvent) {
      const s = dragStateRef.current
      if (s.pointerId === e.pointerId) {
        s.active = false
        s.pointerId = null
        try { el!.releasePointerCapture(e.pointerId) } catch { /* already released */ }
      }
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
    }
  }, [])

  function recenter() {
    const map = mapRef.current
    if (!map || !navMarker.current) return
    followRef.current = true
    setShowRecenter(false)
    map.panTo(navMarker.current.getLatLng(), { animate: true })
  }

  return (
    <>
      <div className="map">
        <div ref={rotorRef} className={`map-rotor ${navigating ? 'map-rotor--tracking' : ''}`}>
          <div ref={elRef} className="map-inner" />
        </div>
      </div>
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
