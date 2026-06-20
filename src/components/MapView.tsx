import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { Compass, LocateFixed } from 'lucide-react'
import { DANGER_ZONES } from '../data/dangerZones'
import type { Place } from '../services/geocode'
import {
  fetchRouteContext,
  type FeatureLayer,
  type RouteMapContext,
} from '../services/mapFeatures'
import type { Amenity, AmenityKind } from '../services/amenities'
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
  amenities: Amenity[]
  focusAmenity: Amenity | null
}

const LONDON_CENTER: L.LatLngExpression = [51.5074, -0.1278]

const HAZARD_COLOR = '#FF1B1B'

const DANGER_ZONE_STYLE = {
  color: HAZARD_COLOR,
  weight: 1.5,
  opacity: 0.55,
  fillColor: HAZARD_COLOR,
  fillOpacity: 0.18,
}

const HAZARD_LINE_STYLE = {
  color: HAZARD_COLOR,
  weight: 5,
  opacity: 0.55,
  dashArray: '2 10',
  lineCap: 'round' as const,
}

const HAZARD_PENDING_LINE_STYLE = {
  color: HAZARD_COLOR,
  weight: 5,
  opacity: 0.55,
  dashArray: '6 8',
  lineCap: 'round' as const,
}

const HAZARD_POINT_STYLE = {
  radius: 7,
  color: HAZARD_COLOR,
  weight: 2,
  fillColor: HAZARD_COLOR,
  fillOpacity: 0.55,
  opacity: 0.55,
}

const PIN_SVG = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="${color}" stroke="#0a0a0c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>`

const THUMBS_UP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/><path d="M7 10v12"/></svg>'

const THUMBS_DOWN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/><path d="M17 14V2"/></svg>'

const LAYERS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>'

const AREA_STYLES: Record<'park' | 'pedestrian' | 'living-street' | 'canal', {
  fill: string
  stroke: string
  fillOpacity: number
  weight: number
}> = {
  park: { fill: '#4ade80', stroke: '#16a34a', fillOpacity: 0.28, weight: 1.5 },
  pedestrian: { fill: '#c4b5fd', stroke: '#7c3aed', fillOpacity: 0.3, weight: 1.5 },
  'living-street': { fill: '#fcd34d', stroke: '#d97706', fillOpacity: 0.28, weight: 2 },
  canal: { fill: '#7dd3fc', stroke: '#0284c7', fillOpacity: 0, weight: 4 },
}

type OverlayStyleType = keyof typeof AREA_STYLES
type StyleMode = 'muted' | 'emphasis'

function overlayStyle(type: OverlayStyleType, mode: StyleMode, feature?: GeoJSON.Feature): L.PathOptions {
  const s = AREA_STYLES[type]
  const muted = mode === 'muted'
  const geom = feature?.geometry
  const isPoly = geom?.type === 'Polygon' || geom?.type === 'MultiPolygon'
  if (isPoly) {
    return {
      color: s.stroke,
      weight: muted ? 1 : 2,
      fillColor: s.fill,
      fillOpacity: muted ? s.fillOpacity * 0.55 : s.fillOpacity,
      opacity: muted ? 0.35 : 0.92,
    }
  }
  const weight =
    (type === 'living-street' ? 5 : type === 'pedestrian' ? 4 : type === 'canal' ? 4 : 3) * (muted ? 0.9 : 1.1)
  return {
    color: s.stroke,
    weight,
    opacity: muted ? 0.28 : 0.95,
    lineCap: 'round',
    lineJoin: 'round',
  }
}

interface TaggedPath extends L.Path {
  _overlayType?: OverlayStyleType
}

const OVERLAY_KEYS: Record<string, FeatureLayer> = {
  'Parks & green spaces': 'parks',
  'Pedestrian & car-free': 'pedestrian',
  'Low-traffic neighbourhoods': 'livingStreets',
  'Canals & towpaths': 'canals',
}

function areaTooltip(name: string, note?: string) {
  return `<span class="tt-label">${name}${note ? ` — ${note}` : ''}</span>`
}

function overlayAnchorOrigin(el: HTMLElement): string {
  if (el.classList.contains('leaflet-tooltip-top') || el.classList.contains('leaflet-popup-top')) return 'bottom center'
  if (el.classList.contains('leaflet-tooltip-bottom') || el.classList.contains('leaflet-popup-bottom')) return 'top center'
  if (el.classList.contains('leaflet-tooltip-left') || el.classList.contains('leaflet-popup-left')) return 'center right'
  if (el.classList.contains('leaflet-tooltip-right') || el.classList.contains('leaflet-popup-right')) return 'center left'
  // Popups usually open above the tap point with the tip at the bottom edge.
  if (el.classList.contains('leaflet-popup')) return 'bottom center'
  return 'center center'
}

/** Keep tooltip/popup boxes readable when the map rotor is spun (track-up or manual twist). */
function setOverlayUpright(el: HTMLElement, degrees: number) {
  if (!degrees) {
    el.style.rotate = ''
    el.style.transformOrigin = ''
    el.style.transition = ''
    return
  }
  el.style.transformOrigin = overlayAnchorOrigin(el)
  el.style.rotate = `${degrees}deg`
}

function syncAllOverlaysUpright(container: HTMLElement, degrees: number, transition = '') {
  container.querySelectorAll<HTMLElement>('.leaflet-tooltip, .leaflet-popup').forEach((el) => {
    el.style.transition = transition
    setOverlayUpright(el, degrees)
  })
}

const ROUTE_LAYERS: FeatureLayer[] = ['parks', 'pedestrian', 'livingStreets', 'canals']

function buildCyclingAreaLayers() {
  return {
    parks: L.layerGroup(),
    pedestrian: L.layerGroup(),
    livingStreets: L.layerGroup(),
    canals: L.layerGroup(),
  }
}

function streetLabel(props: Record<string, unknown>): string {
  const name = props.name
  if (typeof name === 'string' && name) return name
  const highway = props.highway
  if (typeof highway === 'string') return highway.replace(/_/g, ' ')
  return 'Quiet street'
}

function geoJsonStyle(type: OverlayStyleType) {
  return (feature?: GeoJSON.Feature) => overlayStyle(type, 'muted', feature)
}

function bindOverlayInteractions(
  path: TaggedPath,
  type: OverlayStyleType,
  feature: GeoJSON.Feature,
  selectedRef: { current: L.Layer | null },
  routeRef: { current: L.Polyline | null },
) {
  path._overlayType = type
  path.on('mouseover', () => {
    path.setStyle(overlayStyle(type, 'emphasis', feature))
    path.bringToFront()
    routeRef.current?.bringToFront()
  })
  path.on('mouseout', () => {
    if (selectedRef.current === path) return
    path.setStyle(overlayStyle(type, 'muted', feature))
  })
  path.on('click', (e) => {
    L.DomEvent.stopPropagation(e)
    if (selectedRef.current && selectedRef.current !== path) {
      const prev = selectedRef.current as TaggedPath
      if (prev._overlayType) prev.setStyle(overlayStyle(prev._overlayType, 'muted'))
    }
    selectedRef.current = path
    path.setStyle(overlayStyle(type, 'emphasis', feature))
    path.bringToFront()
    routeRef.current?.bringToFront()
    path.openTooltip()
  })
}

function amenityMarkerIcon(kind: AmenityKind, active = false) {
  const glyph = kind === 'parking' ? 'P' : kind === 'pump' ? '·' : kind === 'repair' ? '✕' : 'C'
  return L.divIcon({
    className: 'amenity-marker-wrap',
    html: `<div class="amenity-marker amenity-marker--${kind}${active ? ' amenity-marker--active' : ''}">${glyph}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  })
}

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
  amenities,
  focusAmenity,
}: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const rotorRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const startMarker = useRef<L.Marker | null>(null)
  const endMarker = useRef<L.Marker | null>(null)
  const routeLine = useRef<L.Polyline | null>(null)
  const routeLineRef = useRef<L.Polyline | null>(null)
  const routeUnderlay = useRef<L.Polyline | null>(null)
  const selectedOverlayRef = useRef<L.Layer | null>(null)
  const progressLine = useRef<L.Polyline | null>(null)
  const cyclist = useRef<L.Marker | null>(null)
  const animRef = useRef<number | null>(null)
  const navMarker = useRef<L.Marker | null>(null)
  const followRef = useRef(true)
  const navigatingRef = useRef(navigating)
  const deviceHeadingRef = useRef<number | null>(null)
  const currentHeadingRef = useRef(0)
  const baseHeadingRef = useRef(0)
  const manualRotationRef = useRef(0)
  const rotateGestureRef = useRef<{
    pointers: Map<number, { x: number; y: number }>
    lastAngle: number | null
    lastSpan: number | null
  }>({
    pointers: new Map(),
    lastAngle: null,
    lastSpan: null,
  })
  const hazardsLayer = useRef<L.LayerGroup | null>(null)
  const pendingLayer = useRef<L.LayerGroup | null>(null)
  const routeHazardLayer = useRef<L.LayerGroup | null>(null)
  const cyclingLayers = useRef<Record<FeatureLayer, L.LayerGroup> | null>(null)
  const osmLayerRefs = useRef<Map<FeatureLayer, L.GeoJSON>>(new Map())
  const routeContextRef = useRef<RouteMapContext | null>(null)
  const amenityMarkersRef = useRef<L.LayerGroup | null>(null)
  const renderRouteFeaturesRef = useRef<() => void>(() => {})
  const activeOverlays = useRef<Set<FeatureLayer>>(new Set(['parks', 'pedestrian', 'canals', 'livingStreets']))
  const hazardLinesRef = useRef<Map<string, L.Polyline>>(new Map())
  const dragStateRef = useRef<{ active: boolean; lastX: number; lastY: number; pointerId: number | null }>({
    active: false,
    lastX: 0,
    lastY: 0,
    pointerId: null,
  })
  const [showRecenter, setShowRecenter] = useState(false)
  const [showCompass, setShowCompass] = useState(false)

  useEffect(() => { navigatingRef.current = navigating }, [navigating])

  const typeFor: Record<FeatureLayer, 'park' | 'pedestrian' | 'living-street' | 'canal'> = {
    parks: 'park',
    pedestrian: 'pedestrian',
    livingStreets: 'living-street',
    canals: 'canal',
  }

  function clearRouteFeatures() {
    const map = mapRef.current
    const cycling = cyclingLayers.current
    if (!map || !cycling) return
    for (const layer of ROUTE_LAYERS) {
      osmLayerRefs.current.get(layer)?.remove()
      osmLayerRefs.current.delete(layer)
      cycling[layer].clearLayers()
      if (map.hasLayer(cycling[layer])) map.removeLayer(cycling[layer])
    }
    routeContextRef.current = null
    selectedOverlayRef.current = null
  }

  function renderRouteFeatures() {
    const map = mapRef.current
    const cycling = cyclingLayers.current
    const ctx = routeContextRef.current
    if (!map || !cycling || !ctx) return

    for (const layer of ROUTE_LAYERS) {
      osmLayerRefs.current.get(layer)?.remove()
      osmLayerRefs.current.delete(layer)
      cycling[layer].clearLayers()

      if (!activeOverlays.current.has(layer)) {
        if (map.hasLayer(cycling[layer])) map.removeLayer(cycling[layer])
        continue
      }

      const data = ctx.layers[layer]
      if (!data?.features.length) {
        if (map.hasLayer(cycling[layer])) map.removeLayer(cycling[layer])
        continue
      }

      const geoLayer = L.geoJSON(data as GeoJSON.FeatureCollection, {
        style: geoJsonStyle(typeFor[layer]),
        onEachFeature: (feature, l) => {
          const label = streetLabel((feature.properties ?? {}) as Record<string, unknown>)
          l.bindTooltip(areaTooltip(label), { sticky: true })
          bindOverlayInteractions(l as TaggedPath, typeFor[layer], feature, selectedOverlayRef, routeLineRef)
        },
      })
      geoLayer.addTo(cycling[layer])
      osmLayerRefs.current.set(layer, geoLayer)
      if (!map.hasLayer(cycling[layer])) cycling[layer].addTo(map)
    }
    routeLineRef.current?.bringToFront()
  }

  renderRouteFeaturesRef.current = renderRouteFeatures

  function syncRouteVectors() {
    routeLine.current?.redraw()
    routeUnderlay.current?.redraw()
    progressLine.current?.redraw()
    routeLineRef.current?.bringToFront()
    for (const geo of osmLayerRefs.current.values()) {
      geo.eachLayer((layer) => {
        if ('redraw' in layer && typeof (layer as L.Path).redraw === 'function') {
          (layer as L.Path).redraw()
        }
      })
    }
  }

  // Apply the combined rotation — the satnav compass heading plus any manual
  // two-finger twist the rider has applied on top — to the rotor, the position
  // arrow, and any open tooltips/popups.
  function applyRotation() {
    const total = baseHeadingRef.current + manualRotationRef.current
    currentHeadingRef.current = total
    const arrow = navMarker.current?.getElement()?.querySelector<HTMLElement>('.nav-pos-arrow')
    // The lucide "navigation" glyph points north-east by default, so offset by -45deg.
    if (arrow) arrow.style.transform = `rotate(${baseHeadingRef.current - 45}deg)`
    if (rotorRef.current) rotorRef.current.style.transform = `rotate(${-total}deg)`

    const container = mapRef.current?.getContainer()
    if (container) {
      const rotor = rotorRef.current
      const rotorTransition = rotor ? getComputedStyle(rotor).transitionDuration : '0s'
      const overlayTransition =
        rotorTransition !== '0s' && rotorTransition !== '' ? 'rotate .35s ease-out' : ''
      syncAllOverlaysUpright(container, total, overlayTransition)
    }
  }

  // Point the position arrow in the given compass direction, and rotate the
  // whole map so that direction faces "up" the screen — a track-up satnav view.
  function applyHeading(heading: number) {
    baseHeadingRef.current = heading
    applyRotation()
  }

  // Snap a manual two-finger rotation back to north-up.
  function resetRotation() {
    if (rotorRef.current) rotorRef.current.style.transition = 'transform .35s ease-out'
    manualRotationRef.current = 0
    applyRotation()
    setShowCompass(false)
    setTimeout(() => {
      if (rotorRef.current) rotorRef.current.style.transition = ''
    }, 400)
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
    L.control.zoom({
      position: 'bottomright',
      zoomInText: '+',
      zoomOutText: '−',
      zoomInTitle: 'Zoom in',
      zoomOutTitle: 'Zoom out',
    }).addTo(map)

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
          ...DANGER_ZONE_STYLE,
        }).bindTooltip(`<span class="tt-label">${z.name} — ${z.note}</span>`, { sticky: true }),
      ),
    ).addTo(map)

    // Route-context overlays — populated only after a route is planned.
    const cycling = buildCyclingAreaLayers()
    cyclingLayers.current = cycling

    // Rider-reported unsafe stretches, and the in-progress pending report.
    hazardsLayer.current = L.layerGroup().addTo(map)
    pendingLayer.current = L.layerGroup().addTo(map)
    routeHazardLayer.current = L.layerGroup().addTo(map)
    amenityMarkersRef.current = L.layerGroup().addTo(map)

    const layersControl = L.control
      .layers(
        { Light: light, 'Cycle network': cycle },
        {
          'Parks & green spaces': cycling.parks,
          'Pedestrian & car-free': cycling.pedestrian,
          'Low-traffic neighbourhoods': cycling.livingStreets,
          'Canals & towpaths': cycling.canals,
          'Danger zones': dangerZones,
          'Unsafe roads (reported)': hazardsLayer.current,
        },
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

    // Tooltips and popups live inside the rotated track-up container — counter-
    // rotate the whole box so it stays upright on open.
    function onTooltipOpen(e: L.LeafletEvent) {
      const el = (e as L.TooltipEvent).tooltip.getElement()
      if (el) setOverlayUpright(el, currentHeadingRef.current)
    }
    function onPopupOpen(e: L.LeafletEvent) {
      const el = (e as L.PopupEvent).popup.getElement()
      if (el) setOverlayUpright(el, currentHeadingRef.current)
    }
    map.on('tooltipopen', onTooltipOpen)
    map.on('popupopen', onPopupOpen)

    function onOverlayAdd(e: L.LayersControlEvent) {
      const key = OVERLAY_KEYS[e.name]
      if (key) {
        activeOverlays.current.add(key)
        renderRouteFeaturesRef.current()
      }
    }
    function onOverlayRemove(e: L.LayersControlEvent) {
      const key = OVERLAY_KEYS[e.name]
      if (key) {
        activeOverlays.current.delete(key)
        renderRouteFeaturesRef.current()
      }
    }
    map.on('overlayadd', onOverlayAdd)
    map.on('overlayremove', onOverlayRemove)

    function onMapClick() {
      if (!selectedOverlayRef.current) return
      const prev = selectedOverlayRef.current as TaggedPath
      if (prev._overlayType) prev.setStyle(overlayStyle(prev._overlayType, 'muted'))
      selectedOverlayRef.current = null
    }
    map.on('click', onMapClick)

    function onZoomEnd() {
      syncRouteVectors()
    }
    map.on('zoomend', onZoomEnd)

    mapRef.current = map

    return () => {
      map.off('overlayadd', onOverlayAdd)
      map.off('overlayremove', onOverlayRemove)
      map.off('click', onMapClick)
      map.off('tooltipopen', onTooltipOpen)
      map.off('popupopen', onPopupOpen)
      map.off('zoomend', onZoomEnd)
    }
  }, [])

  // Start / end markers.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    startMarker.current?.remove()
    startMarker.current = null
    if (start) {
      startMarker.current = L.marker([start.lat, start.lon], { icon: pinIcon('#1a1a1a') })
        .addTo(map)
        .bindTooltip(`<span class="tt-label">${start.short}</span>`, { direction: 'top', offset: [0, -28] })
    }

    endMarker.current?.remove()
    endMarker.current = null
    if (end) {
      endMarker.current = L.marker([end.lat, end.lon], { icon: pinIcon('#888888') })
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
    routeUnderlay.current?.remove()
    progressLine.current?.remove()
    cyclist.current?.remove()
    routeLine.current = null
    routeLineRef.current = null
    routeUnderlay.current = null
    selectedOverlayRef.current = null
    if (animRef.current) cancelAnimationFrame(animRef.current)

    if (!route) {
      clearRouteFeatures()
      return
    }

    routeUnderlay.current = L.polyline(route.coordinates, {
      color: '#ffffff',
      weight: 9,
      opacity: 0.92,
      lineJoin: 'round',
      lineCap: 'round',
      smoothFactor: 0,
    }).addTo(map)

    routeLine.current = L.polyline(route.coordinates, {
      color: '#1a1a1a',
      weight: 5,
      opacity: 1,
      lineJoin: 'round',
      lineCap: 'round',
      smoothFactor: 0,
    }).addTo(map)
    routeLineRef.current = routeLine.current
    routeLine.current.bringToFront()
    map.fitBounds(routeLine.current.getBounds(), { padding: [70, 70] })

    let cancelled = false
    fetchRouteContext(route.coordinates).then((ctx) => {
      if (cancelled) return
      routeContextRef.current = ctx
      renderRouteFeatures()
    })

    return () => { cancelled = true }
  }, [route])

  // Cyclist amenities — parking at destination, pumps/shops/cafés on the route.
  useEffect(() => {
    const layer = amenityMarkersRef.current
    if (!layer) return
    layer.clearLayers()
    for (const a of amenities) {
      const note = [a.note, a.capacity ? `${a.capacity} spaces` : null].filter(Boolean).join(' · ')
      const active = focusAmenity?.id === a.id
      L.marker([a.lat, a.lon], {
        icon: amenityMarkerIcon(a.kind, active),
        zIndexOffset: active ? 800 : 400,
        opacity: active ? 1 : 0.42,
      })
        .bindTooltip(`<span class="tt-label">${a.name}${note ? ` — ${note}` : ''}</span>`, { sticky: true })
        .on('mouseover', (e) => { e.target.setOpacity(1) })
        .on('mouseout', (e) => { if (focusAmenity?.id !== a.id) e.target.setOpacity(0.42) })
        .on('click', (e) => {
          L.DomEvent.stopPropagation(e)
          e.target.setOpacity(1)
          e.target.openTooltip()
        })
        .addTo(layer)
    }
  }, [amenities, focusAmenity])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !focusAmenity) return
    map.setView([focusAmenity.lat, focusAmenity.lon], Math.max(map.getZoom(), 16), { animate: true })
  }, [focusAmenity])

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
      color: '#737373',
      weight: 6,
      opacity: 0.95,
    }).addTo(map)
    cyclist.current = L.marker(pts[0], { icon: cyclistIcon, zIndexOffset: 1000 }).addTo(map)

    // The progress line is redrawn via setLatLngs() on every animation frame
    // rather than Leaflet's own pan/zoom hooks, so a zoom that lands between
    // two frames can leave it projected for the old scale — force a
    // reprojection once the zoom settles.
    function syncToZoom() {
      progressLine.current?.redraw()
      const at = cyclist.current?.getLatLng()
      if (at) cyclist.current?.setLatLng(at)
    }
    map.on('zoomend', syncToZoom)

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
      map.off('zoomend', syncToZoom)
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
      // Leaving nav drops the compass-driven heading, but keep any manual
      // rotation the rider applied — they can reset it via the compass button.
      baseHeadingRef.current = 0
      applyRotation()

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
        line = L.polyline(h.points, HAZARD_LINE_STYLE).addTo(layer)
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
      L.circleMarker([lat, lon], HAZARD_POINT_STYLE).addTo(layer)
    }
    if (pendingPoints.length === 2) {
      const path = pendingPath && pendingPath.length >= 2 ? pendingPath : pendingPoints
      L.polyline(path, HAZARD_PENDING_LINE_STYLE).addTo(layer)
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

  // Two-finger rotate: twisting two fingers spins the map clockwise or
  // anticlockwise, like turning a paper map on a table. Works in both the
  // planning view and track-up navigation, layering on top of (or in place
  // of) the compass heading.
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const gesture = rotateGestureRef.current

    function angleBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
      return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
    }
    function spanBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
      return Math.hypot(b.x - a.x, b.y - a.y)
    }
    function normalizeDelta(deg: number) {
      return (((deg + 180) % 360) + 360) % 360 - 180
    }

    function onPointerDown(e: PointerEvent) {
      gesture.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (gesture.pointers.size === 2) {
        // A second finger landed — hand off from single-finger panning (if
        // any) to two-finger rotation, and track live without CSS lag.
        dragStateRef.current.active = false
        gesture.lastAngle = null
        gesture.lastSpan = null
        if (rotorRef.current) rotorRef.current.style.transition = 'none'
      }
    }

    function onPointerMove(e: PointerEvent) {
      if (!gesture.pointers.has(e.pointerId)) return
      gesture.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (gesture.pointers.size !== 2) return

      const [p1, p2] = [...gesture.pointers.values()]
      const span = spanBetween(p1, p2)
      const a = angleBetween(p1, p2)

      // Pinch-to-zoom also uses two fingers — ignore rotation while span changes.
      if (gesture.lastSpan != null) {
        const spanDelta = Math.abs(span - gesture.lastSpan) / gesture.lastSpan
        if (spanDelta > 0.035) {
          gesture.lastAngle = a
          gesture.lastSpan = span
          return
        }
      }

      if (gesture.lastAngle != null) {
        const delta = normalizeDelta(a - gesture.lastAngle)
        if (Math.abs(delta) > 0.35) {
          manualRotationRef.current -= delta
          applyRotation()
          if (Math.abs(manualRotationRef.current) > 0.5) setShowCompass(true)
        }
      }
      gesture.lastAngle = a
      gesture.lastSpan = span
    }

    function onPointerUp(e: PointerEvent) {
      gesture.pointers.delete(e.pointerId)
      if (gesture.pointers.size < 2) {
        gesture.lastAngle = null
        gesture.lastSpan = null
      }
      if (gesture.pointers.size === 0 && rotorRef.current) rotorRef.current.style.transition = ''
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

  // A manual rotation needs the same oversized, centred rotor that track-up
  // navigation uses so spinning the map doesn't expose blank corners.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !showCompass || navigatingRef.current) return
    const center = map.getCenter()
    const zoom = map.getZoom()
    requestAnimationFrame(() => {
      map.invalidateSize()
      map.setView(center, zoom, { animate: false })
      syncRouteVectors()
    })
  }, [showCompass])

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
        <div
          ref={rotorRef}
          className={`map-rotor ${navigating ? 'map-rotor--tracking' : ''} ${showCompass ? 'map-rotor--expanded' : ''}`}
        >
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
      {showCompass && (
        <button
          className="compass-btn"
          onClick={resetRotation}
          aria-label="Reset map rotation to north-up"
          title="Reset rotation"
        >
          <Compass size={20} />
        </button>
      )}
    </>
  )
}
