import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Eye, MapPin, Play, X } from 'lucide-react'
import LocationInput from './components/LocationInput'
import MapView from './components/MapView'
import NavOverlay, { type GpsStatus } from './components/NavOverlay'
import AmenitiesPanel from './components/AmenitiesPanel'
import { reverseGeocode, type Place } from './services/geocode'
import { addHazard, listHazards, removeHazard, voteHazard, type HazardSegment } from './services/hazards'
import { fetchRoute, fetchRouteFromPosition, snapToRoad, type RouteResult } from './services/route'
import { fetchRouteAmenities, type Amenity, type RouteAmenities } from './services/amenities'
import { quietRouteShare, setQuietStreetLines } from './services/lowTrafficRoutes'
import { fetchRouteContext } from './services/mapFeatures'
import { bindFemaleVoice, pickFemaleVoice } from './services/voice'
import { useSheetDrag } from './hooks/useSheetDrag'
import {
  buildNavRoute,
  formatDistance,
  hazardsAhead,
  hazardsOnRoute,
  positionAt,
  projectOntoRoute,
  upcoming,
  type NavRoute,
} from './services/navigation'

// ─── Constants ────────────────────────────────────────────────────────────────
const SIM_SPEED = 6.5          // m/s (~23 km/h) — used only in demo mode
const OFF_ROUTE_THRESHOLD = 40  // metres — beyond this we warn the rider
const REROUTE_AFTER_MS = 4500   // sustained off-route before recalculating
const REROUTE_COOLDOWN_MS = 18000

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  // Planner state
  const [start, setStart]     = useState<Place | null>(null)
  const [end, setEnd]         = useState<Place | null>(null)
  const [route, setRoute]     = useState<RouteResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [traceToken, setTraceToken] = useState(0)
  const [collapsed, setCollapsed]   = useState(false)
  const [locating, setLocating]     = useState(false)

  // Hazard-reporting state
  const [hazards, setHazards]         = useState<HazardSegment[]>([])
  const [reporting, setReporting]     = useState(false)
  const [pendingPoints, setPendingPoints] = useState<[number, number][]>([])
  const [pendingPath, setPendingPath] = useState<[number, number][] | null>(null)
  const [snapping, setSnapping]       = useState(false)
  const [hazardNote, setHazardNote]   = useState('')
  const [showHazardList, setShowHazardList] = useState(false)
  const [preview, setPreview]         = useState<{ id: string; token: number } | null>(null)
  const [quietShare, setQuietShare]     = useState(0)
  const [amenities, setAmenities]       = useState<RouteAmenities>({ parking: [], alongRoute: [], all: [] })
  const [focusedAmenity, setFocusedAmenity] = useState<Amenity | null>(null)
  const [showNavAmenities, setShowNavAmenities] = useState(false)

  // Navigation state
  const [navigating, setNavigating] = useState(false)
  const [navDist, setNavDist]       = useState(0)
  const [arrived, setArrived]       = useState(false)
  const [muted, setMuted]           = useState(false)
  const [gpsStatus, setGpsStatus]   = useState<GpsStatus>('sim')
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null)

  // Refs that persist without re-render
  const navRouteRef    = useRef<NavRoute | null>(null)
  const simIntervalRef = useRef<number | null>(null)
  const lastTsRef      = useRef(0)
  const distRef        = useRef(0)
  const announcedRef   = useRef<Set<number>>(new Set())
  const mutedRef       = useRef(false)
  const watchIdRef     = useRef<number | null>(null)
  const gpsActiveRef   = useRef(false)  // true once watchPosition fires at least once
  const hazardsRef         = useRef<HazardSegment[]>([])
  const announcedHazardsRef = useRef<Set<string>>(new Set())
  const endRef = useRef<Place | null>(null)
  const rerouteInFlightRef = useRef(false)
  const lastRerouteAtRef = useRef(0)
  const offRouteSinceRef = useRef<number | null>(null)
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null)
  const sheetScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => { endRef.current = end }, [end])

  // Keep mutedRef in sync so speak() doesn't close over stale state
  useEffect(() => { mutedRef.current = muted }, [muted])
  // Keep hazardsRef in sync so callbacks don't close over stale state
  useEffect(() => { hazardsRef.current = hazards }, [hazards])

  function expandSheet() {
    setCollapsed(false)
  }

  function collapseSheet() {
    setCollapsed(true)
    setShowHazardList(false)
  }

  useLayoutEffect(() => {
    if (!collapsed && route && sheetScrollRef.current) {
      sheetScrollRef.current.scrollTop = 0
    }
  }, [collapsed, route])

  function toggleSheet() {
    if (!route) return
    if (collapsed) expandSheet()
    else collapseSheet()
  }

  const sheetDrag = useSheetDrag({
    enabled: !!route,
    expanded: !collapsed,
    onExpand: expandSheet,
    onCollapse: collapseSheet,
    scrollRef: sheetScrollRef,
  })

  function toggleHazardList() {
    setShowHazardList((open) => {
      if (open) return false
      expandSheet()
      return true
    })
  }

  // Load any hazards reported on this device
  useEffect(() => { listHazards().then(setHazards) }, [])

  // Pick a female English voice once the browser exposes the voice list.
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    function refreshVoice() {
      voiceRef.current = pickFemaleVoice()
    }
    refreshVoice()
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoice)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refreshVoice)
  }, [])

  // ── Voice ──────────────────────────────────────────────────────────────────
  const speak = useCallback((text: string) => {
    if (mutedRef.current) return
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    try {
      if (!voiceRef.current) voiceRef.current = pickFemaleVoice()
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.rate = 1.05
      bindFemaleVoice(u, voiceRef.current)
      window.speechSynthesis.speak(u)
    } catch { /* speech API unavailable */ }
  }, [])

  // ── Announce upcoming turn ─────────────────────────────────────────────────
  const maybeAnnounce = useCallback((nav: NavRoute, dist: number) => {
    const { next, distanceToNext } = upcoming(nav, dist)
    if (
      next.type !== 'depart' &&
      next.type !== 'arrive' &&
      distanceToNext < 45 &&
      !announcedRef.current.has(next.distanceFromStart)
    ) {
      announcedRef.current.add(next.distanceFromStart)
      speak(`In ${formatDistance(distanceToNext)}, ${next.text}`)
    }
  }, [speak])

  // ── Warn about reported hazards ahead ──────────────────────────────────────
  const maybeAnnounceHazard = useCallback((nav: NavRoute, dist: number) => {
    for (const h of hazardsAhead(nav, hazardsRef.current, dist)) {
      if (!announcedHazardsRef.current.has(h.id)) {
        announcedHazardsRef.current.add(h.id)
        speak('Riders have reported this stretch as less safe. Take care.')
      }
    }
  }, [speak])

  // ── Mark arrival ───────────────────────────────────────────────────────────
  const markArrived = useCallback(() => {
    if (!announcedRef.current.has(-1)) {
      announcedRef.current.add(-1)
      speak('You have arrived at your destination.')
    }
    setArrived(true)
  }, [speak])

  // ── Planner ────────────────────────────────────────────────────────────────
  async function findRoute() {
    if (!start || !end) return
    setLoading(true)
    setError(null)
    try {
      const r = await fetchRoute(start, end)
      setRoute(r)
      setTraceToken(t => t + 1)
      setCollapsed(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
      setRoute(null)
    } finally {
      setLoading(false)
    }
  }

  function swap() {
    setStart(end); setEnd(start); setRoute(null)
  }

  // ── "Use my location" for the start field ─────────────────────────────────
  function useMyLocation() {
    if (!('geolocation' in navigator)) return
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords
        try {
          setStart(await reverseGeocode(latitude, longitude))
        } catch {
          setStart({ label: 'Current location', short: 'Current location', lat: latitude, lon: longitude })
        } finally {
          setLocating(false)
        }
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    )
  }

  const applyRouteDuringNav = useCallback((newRoute: RouteResult, lat: number, lon: number) => {
    setRoute(newRoute)
    const nav = buildNavRoute(newRoute.coordinates)
    navRouteRef.current = nav
    const proj = projectOntoRoute(nav, lat, lon)
    distRef.current = proj.dist
    setNavDist(proj.dist)
    announcedRef.current = new Set()
    announcedHazardsRef.current = new Set()
    setGpsStatus('live')
  }, [])

  const rerouteFromPosition = useCallback(async (lat: number, lon: number) => {
    const dest = endRef.current
    if (!dest || rerouteInFlightRef.current) return
    rerouteInFlightRef.current = true
    setGpsStatus('rerouting')
    if (!announcedRef.current.has(-2)) {
      announcedRef.current.add(-2)
      speak('Recalculating route')
    }
    try {
      const newRoute = await fetchRouteFromPosition(lat, lon, dest)
      applyRouteDuringNav(newRoute, lat, lon)
      announcedRef.current.delete(-2)
    } catch {
      setGpsStatus('off-route')
    } finally {
      rerouteInFlightRef.current = false
      lastRerouteAtRef.current = Date.now()
      offRouteSinceRef.current = null
    }
  }, [applyRouteDuringNav, speak])

  // ── GPS position handler ───────────────────────────────────────────────────
  const onGpsFix = useCallback((pos: GeolocationPosition) => {
    const nav = navRouteRef.current
    if (!nav || rerouteInFlightRef.current) return

    gpsActiveRef.current = true
    const acc = pos.coords.accuracy
    setGpsAccuracy(acc)

    const proj = projectOntoRoute(nav, pos.coords.latitude, pos.coords.longitude)
    const isOffRoute = proj.offRouteMeters > OFF_ROUTE_THRESHOLD

    if (isOffRoute) {
      if (offRouteSinceRef.current == null) offRouteSinceRef.current = Date.now()
      setGpsStatus('off-route')

      const offMs = Date.now() - offRouteSinceRef.current
      const sinceReroute = Date.now() - lastRerouteAtRef.current
      if (offMs >= REROUTE_AFTER_MS && sinceReroute >= REROUTE_COOLDOWN_MS && endRef.current) {
        void rerouteFromPosition(pos.coords.latitude, pos.coords.longitude)
        return
      }
    } else {
      offRouteSinceRef.current = null
      setGpsStatus('live')
    }

    distRef.current = proj.dist
    setNavDist(proj.dist)

    if (proj.dist >= nav.total - 5) {
      markArrived()
    } else {
      maybeAnnounce(nav, proj.dist)
      maybeAnnounceHazard(nav, proj.dist)
    }
  }, [markArrived, maybeAnnounce, maybeAnnounceHazard, rerouteFromPosition])

  const onGpsError = useCallback((err: GeolocationPositionError) => {
    console.warn('GPS error:', err.message)
    // Permission denied → fall back to simulation permanently
    if (err.code === GeolocationPositionError.PERMISSION_DENIED) {
      setGpsStatus('denied')
      speak('Location access denied. Switching to demo ride.')
    }
    // For timeout / unavailable, keep trying (watchPosition will retry)
  }, [speak])

  // ── Start ride ─────────────────────────────────────────────────────────────
  function startRide() {
    if (!route) return

    // iOS requires the compass permission prompt to be triggered directly by
    // a user gesture — request it here so the satnav arrow can use it.
    const DOE = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<'granted' | 'denied'>
    }
    if (typeof DOE?.requestPermission === 'function') {
      DOE.requestPermission().catch(() => {})
    }

    const nav = buildNavRoute(route.coordinates)
    navRouteRef.current = nav
    announcedRef.current = new Set()
    announcedHazardsRef.current = new Set()
    distRef.current = 0
    gpsActiveRef.current = false
    rerouteInFlightRef.current = false
    lastRerouteAtRef.current = 0
    offRouteSinceRef.current = null
    setNavDist(0)
    setArrived(false)
    setNavigating(true)
    setShowNavAmenities(false)

    // Attempt live GPS first
    if ('geolocation' in navigator) {
      setGpsStatus('acquiring')
      watchIdRef.current = navigator.geolocation.watchPosition(
        onGpsFix,
        onGpsError,
        {
          enableHighAccuracy: true,
          maximumAge: 2000,
          timeout: 10000,
        },
      )
      speak('Starting ride. Acquiring GPS signal.')
    } else {
      setGpsStatus('sim')
      speak('GPS not available. Starting demo ride.')
    }
  }

  // ── End ride ───────────────────────────────────────────────────────────────
  function endRide() {
    if (simIntervalRef.current !== null) window.clearInterval(simIntervalRef.current)
    simIntervalRef.current = null
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    setNavigating(false)
    setShowNavAmenities(false)
    setFocusedAmenity(null)
    setArrived(false)
    setGpsStatus('sim')
    setGpsAccuracy(null)
    gpsActiveRef.current = false
  }

  // ── Simulation loop (runs in parallel; only drives nav when GPS has no fix) ─
  // Uses setInterval rather than requestAnimationFrame so the demo ride keeps
  // moving even when the tab/app is backgrounded or the screen is locked —
  // real GPS fixes from watchPosition aren't tied to animation frames either.
  useEffect(() => {
    if (!navigating) return
    const nav = navRouteRef.current as NavRoute
    if (!nav) return
    lastTsRef.current = performance.now()

    const TICK_MS = 250

    function tick() {
      // GPS has taken over — simulation idles
      if (gpsActiveRef.current) return

      const now = performance.now()
      const dt = Math.min(1, (now - lastTsRef.current) / 1000)
      lastTsRef.current = now

      const nd = Math.min(distRef.current + SIM_SPEED * dt, nav.total)
      distRef.current = nd
      setNavDist(nd)

      if (nd >= nav.total) {
        markArrived()
        if (simIntervalRef.current !== null) window.clearInterval(simIntervalRef.current)
        return
      }
      maybeAnnounce(nav, nd)
      maybeAnnounceHazard(nav, nd)
    }

    simIntervalRef.current = window.setInterval(tick, TICK_MS)
    return () => {
      if (simIntervalRef.current !== null) window.clearInterval(simIntervalRef.current)
      simIntervalRef.current = null
    }
  }, [navigating, markArrived, maybeAnnounce, maybeAnnounceHazard])

  // ── Derived view-model ─────────────────────────────────────────────────────
  const nav = navRouteRef.current
  const navPosition = navigating && nav
    ? (gpsStatus === 'live' || gpsStatus === 'off-route' || gpsStatus === 'rerouting' || gpsStatus === 'acquiring')
        // During GPS: use the last projected position from distRef
        ? positionAt(nav, distRef.current)
        : positionAt(nav, navDist)
    : null
  const navView      = navigating && nav ? upcoming(nav, navDist) : null
  const remaining    = nav ? Math.max(0, nav.total - navDist) : 0
  const remainingMin = nav && route
    ? route.durationMin * (nav.total > 0 ? remaining / nav.total : 0) : 0
  const hazardAhead  = navigating && nav ? hazardsAhead(nav, hazards, navDist).length > 0 : false

  // Hazards that overlap the planned route — shown as a flag before the ride starts.
  const routeNav = useMemo(() => (route ? buildNavRoute(route.coordinates) : null), [route])
  const routeHazards = useMemo(
    () => (!navigating && routeNav ? hazardsOnRoute(routeNav, hazards) : []),
    [navigating, routeNav, hazards],
  )

  // Reset the overlap list/preview whenever a new route is planned.
  useEffect(() => {
    setShowHazardList(false)
    setPreview(null)
  }, [route])

  // Load OSM street geometry along the route for the low-traffic % stat.
  useEffect(() => {
    if (!route) {
      setQuietShare(0)
      setAmenities({ parking: [], alongRoute: [], all: [] })
      setFocusedAmenity(null)
      return
    }
    let cancelled = false
    fetchRouteContext(route.coordinates).then((ctx) => {
      if (cancelled) return
      setQuietStreetLines(ctx.streetLines)
      setQuietShare(quietRouteShare(route.coordinates))
    })
    if (end) {
      fetchRouteAmenities(route.coordinates, end).then((a) => {
        if (!cancelled) setAmenities(a)
      })
    }
    return () => { cancelled = true }
  }, [route, end])

  function previewHazard(h: HazardSegment) {
    collapseSheet()
    setPreview({ id: h.id, token: Date.now() })
  }

  // ── Hazard reporting ───────────────────────────────────────────────────────
  function startReporting() {
    setReporting(true)
    setCollapsed(true)
    setPendingPoints([])
    setPendingPath(null)
    setHazardNote('')
  }

  function cancelReporting() {
    setReporting(false)
    setPendingPoints([])
    setPendingPath(null)
    setHazardNote('')
  }

  function handleMapClick(lat: number, lon: number) {
    setPendingPoints((pts) => (pts.length >= 2 ? [[lat, lon]] : [...pts, [lat, lon]]))
    setPendingPath(null)
  }

  // Once both points are picked, snap the straight line onto the road network.
  useEffect(() => {
    if (pendingPoints.length !== 2) return
    let cancelled = false
    setSnapping(true)
    snapToRoad(pendingPoints[0], pendingPoints[1])
      .then((path) => { if (!cancelled) setPendingPath(path) })
      .catch(() => { if (!cancelled) setPendingPath(null) })
      .finally(() => { if (!cancelled) setSnapping(false) })
    return () => { cancelled = true }
  }, [pendingPoints])

  async function saveHazard() {
    if (pendingPoints.length !== 2) return
    const points = pendingPath && pendingPath.length >= 2 ? pendingPath : pendingPoints
    const segment = await addHazard(points, hazardNote)
    setHazards((hs) => [...hs, segment])
    setReporting(false)
    setPendingPoints([])
    setPendingPath(null)
    setHazardNote('')
  }

  async function handleRemoveHazard(id: string) {
    await removeHazard(id)
    setHazards((hs) => hs.filter((h) => h.id !== id))
  }

  async function handleVoteHazard(id: string, vote: 1 | -1) {
    const updated = await voteHazard(id, vote)
    if (!updated) return
    setHazards((hs) => hs.map((h) => (h.id === id ? updated : h)))
  }

  return (
    <div className="app">
      <MapView
        start={start}
        end={end}
        route={route}
        traceToken={traceToken}
        navigating={navigating}
        navPosition={navPosition}
        hazards={hazards}
        routeHazards={routeHazards}
        preview={preview}
        reporting={reporting}
        pendingPoints={pendingPoints}
        pendingPath={pendingPath}
        onMapClick={handleMapClick}
        onRemoveHazard={handleRemoveHazard}
        onVoteHazard={handleVoteHazard}
        amenities={navigating && !showNavAmenities ? [] : amenities.all}
        focusAmenity={focusedAmenity}
      />

      {!navigating && (
        <button
          className={`report-btn ${reporting ? 'report-btn--active' : ''}`}
          onClick={() => (reporting ? cancelReporting() : startReporting())}
        >
          <AlertTriangle size={16} />
          {reporting ? 'Cancel reporting' : 'Report unsafe road'}
        </button>
      )}

      {reporting && (
        <div className="report-card">
          <p>
            {pendingPoints.length < 2
              ? `Tap ${2 - pendingPoints.length} more point${pendingPoints.length === 1 ? '' : 's'} on the map to mark the unsafe stretch.`
              : snapping
                ? 'Snapping to the road…'
                : 'Add a note (optional) and save this report.'}
          </p>
          {pendingPoints.length === 2 && !snapping && (
            <>
              <input
                className="report-card-input"
                placeholder="What makes this stretch unsafe? (optional)"
                value={hazardNote}
                onChange={(e) => setHazardNote(e.target.value)}
              />
              <div className="report-card-actions">
                <button className="report-save" onClick={saveHazard}>Save report</button>
                <button className="report-discard" onClick={cancelReporting}>Discard</button>
              </div>
            </>
          )}
        </div>
      )}

      {navigating && navView ? (
        <NavOverlay
          next={arrived ? nav!.maneuvers[nav!.maneuvers.length - 1] : navView.next}
          then={navView.then}
          distanceToNext={navView.distanceToNext}
          remainingDistance={remaining}
          remainingMin={remainingMin}
          arrived={arrived}
          muted={muted}
          gpsStatus={gpsStatus}
          gpsAccuracy={gpsAccuracy}
          hazardAhead={hazardAhead}
          onToggleMute={() => setMuted(m => !m)}
          onEnd={endRide}
          amenities={amenities}
          showAmenities={showNavAmenities}
          onToggleAmenities={() => setShowNavAmenities((s) => !s)}
          onFocusAmenity={setFocusedAmenity}
        />
      ) : reporting ? null : (
        <div
          className={`sheet ${collapsed && route ? 'sheet--peek' : ''}`}
          onTouchStart={sheetDrag.onTouchStart}
          onTouchEnd={sheetDrag.onTouchEnd}
        >
          <div className="sheet-drag">
            <button
              className="sheet-handle"
              onClick={toggleSheet}
              aria-label={collapsed && route ? 'Expand panel' : route ? 'Collapse panel' : 'Panel handle'}
            />
          </div>
          {collapsed && route ? (
            <div className="sheet-peek">
              <RoutePeekBar
                route={route}
                routeHazards={routeHazards}
                onStartRide={startRide}
                onToggleHazardList={toggleHazardList}
              />
            </div>
          ) : (
            <div className="sheet-scroll" ref={sheetScrollRef}>
            <div className="sheet-body">
              <header className="brand">
                <h1>Safe Cycles</h1>
                <p className="brand-sub">Open map routing · London</p>
              </header>

              <div className="inputs">
                <LocationInput
                  icon={<MapPin size={15} strokeWidth={2} />}
                  placeholder="Start — e.g. King's Cross"
                  value={start}
                  onChange={setStart}
                  onLocate={useMyLocation}
                  locating={locating}
                />
                <LocationInput
                  icon={<MapPin size={15} strokeWidth={2} />}
                  placeholder="Destination — e.g. London Bridge"
                  value={end}
                  onChange={setEnd}
                  onSwap={swap}
                />
              </div>

              <button className="cta" disabled={!start || !end || loading} onClick={() => findRoute()}>
                {loading ? 'Finding the calmest route…' : 'Find bike route'}
              </button>

              {error && <p className="error">{error}</p>}

              {route && (
                <div className="result">
                  <div className="stats">
                    <Stat value={`${route.distanceKm.toFixed(1)} km`} label="Distance" />
                    <Stat value={`${Math.round(route.durationMin)} min`} label="Ride time" />
                    <Stat value={`${Math.round(quietShare * 100)}%`} label="Low traffic" />
                    <Stat value={`${Math.round(route.ascentM)} m`} label="Climb" />
                  </div>
                  <div className="result-actions">
                    <div className="start-ride-row">
                      <button className="start-ride" onClick={startRide}>
                        <Play size={20} fill="currentColor" /> Start ride
                      </button>
                      {routeHazards.length > 0 && (
                        <button className="hazard-flag" onClick={toggleHazardList}>
                          <AlertTriangle size={14} /> {routeHazards.length}
                        </button>
                      )}
                    </div>
                    <button className="trace" onClick={() => setTraceToken(t => t + 1)}>
                      <Eye size={14} /> Preview route
                    </button>
                  </div>
                  {showHazardList && routeHazards.length > 0 && (
                    <HazardListPanel
                      routeHazards={routeHazards}
                      onClose={() => setShowHazardList(false)}
                      onPreview={previewHazard}
                    />
                  )}
                  {(amenities.parking.length > 0 || amenities.alongRoute.length > 0) && (
                    <AmenitiesPanel
                      parking={amenities.parking}
                      alongRoute={amenities.alongRoute}
                      onFocus={setFocusedAmenity}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}

function HazardListPanel({
  routeHazards,
  onClose,
  onPreview,
}: {
  routeHazards: HazardSegment[]
  onClose: () => void
  onPreview: (h: HazardSegment) => void
}) {
  return (
    <div className="hazard-list">
      <button className="hazard-list-close" onClick={onClose} aria-label="Close">
        <X size={16} />
      </button>
      <p>{routeHazards.length} unsafe stretch{routeHazards.length === 1 ? '' : 'es'} on this route</p>
      {routeHazards.map((h, i) => (
        <button key={h.id} className="hazard-list-item" onClick={() => onPreview(h)}>
          <span className="hazard-list-num">{i + 1}</span>
          <span className="hazard-list-note">{h.note || 'Reported as unsafe by a rider'}</span>
        </button>
      ))}
    </div>
  )
}

function RoutePeekBar({
  route,
  routeHazards,
  onStartRide,
  onToggleHazardList,
}: {
  route: RouteResult
  routeHazards: HazardSegment[]
  onStartRide: () => void
  onToggleHazardList: () => void
}) {
  return (
    <div className="mini-route">
      <div className="mini-route-info">
        <span className="mini-route-stat">
          <span className="mini-route-num">{route.distanceKm.toFixed(1)}</span> km
        </span>
        <span className="mini-route-sep" aria-hidden>·</span>
        <span className="mini-route-stat">
          <span className="mini-route-num">{Math.round(route.durationMin)}</span> min
        </span>
        {routeHazards.length > 0 && (
          <button className="hazard-flag" onClick={onToggleHazardList}>
            <AlertTriangle size={13} /> {routeHazards.length}
          </button>
        )}
      </div>
      <button className="start-ride start-ride--peek" onClick={onStartRide}>
        <Play size={18} fill="currentColor" /> Start
      </button>
    </div>
  )
}
