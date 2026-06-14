import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpDown, Bike, Eye, MapPin, Play, X } from 'lucide-react'
import LocationInput from './components/LocationInput'
import MapView from './components/MapView'
import NavOverlay, { type GpsStatus } from './components/NavOverlay'
import { reverseGeocode, type Place } from './services/geocode'
import { addHazard, listHazards, removeHazard, voteHazard, type HazardSegment } from './services/hazards'
import { fetchRoute, snapToRoad, type RouteResult } from './services/route'
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
const OFF_ROUTE_THRESHOLD = 40 // metres — beyond this we warn the rider

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

  // Keep mutedRef in sync so speak() doesn't close over stale state
  useEffect(() => { mutedRef.current = muted }, [muted])
  // Keep hazardsRef in sync so callbacks don't close over stale state
  useEffect(() => { hazardsRef.current = hazards }, [hazards])

  // Load any hazards reported on this device
  useEffect(() => { listHazards().then(setHazards) }, [])

  // ── Voice ──────────────────────────────────────────────────────────────────
  const speak = useCallback((text: string) => {
    if (mutedRef.current) return
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    try {
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.rate = 1.05
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

  // ── GPS position handler ───────────────────────────────────────────────────
  const onGpsFix = useCallback((pos: GeolocationPosition) => {
    const nav = navRouteRef.current
    if (!nav) return

    gpsActiveRef.current = true
    const acc = pos.coords.accuracy
    setGpsAccuracy(acc)

    const proj = projectOntoRoute(nav, pos.coords.latitude, pos.coords.longitude)
    const isOffRoute = proj.offRouteMeters > OFF_ROUTE_THRESHOLD

    setGpsStatus(isOffRoute ? 'off-route' : 'live')

    // Use the snapped distance to drive nav
    distRef.current = proj.dist
    setNavDist(proj.dist)

    if (proj.dist >= nav.total - 5) {
      markArrived()
    } else {
      maybeAnnounce(nav, proj.dist)
      maybeAnnounceHazard(nav, proj.dist)
    }
  }, [markArrived, maybeAnnounce, maybeAnnounceHazard])

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
    setNavDist(0)
    setArrived(false)
    setNavigating(true)

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
    ? (gpsStatus === 'live' || gpsStatus === 'off-route' || gpsStatus === 'acquiring')
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

  function previewHazard(h: HazardSegment) {
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

      {!navigating && !reporting && showHazardList && routeHazards.length > 0 && (
        <div className="hazard-list">
          <button className="hazard-list-close" onClick={() => setShowHazardList(false)} aria-label="Close">
            <X size={16} />
          </button>
          <p>{routeHazards.length} unsafe stretch{routeHazards.length === 1 ? '' : 'es'} on this route</p>
          {routeHazards.map((h, i) => (
            <button key={h.id} className="hazard-list-item" onClick={() => previewHazard(h)}>
              <span className="hazard-list-num">{i + 1}</span>
              <span className="hazard-list-note">{h.note || 'Reported as unsafe by a rider'}</span>
            </button>
          ))}
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
        />
      ) : reporting ? null : collapsed && route ? (
        <div className="sheet sheet--route-mini" onClick={() => setCollapsed(false)}>
          <button
            className="sheet-handle"
            onClick={(e) => { e.stopPropagation(); setCollapsed(false) }}
            aria-label="Expand panel"
          />
          <div className="mini-route">
            <div className="mini-route-info">
              <span>{route.distanceKm.toFixed(1)} km</span>
              <span className="mini-route-sep">·</span>
              <span>{Math.round(route.durationMin)} min</span>
              {routeHazards.length > 0 && (
                <button
                  className="hazard-flag"
                  onClick={(e) => { e.stopPropagation(); setShowHazardList((s) => !s) }}
                >
                  <AlertTriangle size={13} /> {routeHazards.length}
                </button>
              )}
            </div>
            <button className="start-ride" onClick={(e) => { e.stopPropagation(); startRide() }}>
              <Play size={20} fill="currentColor" /> Start ride
            </button>
          </div>
        </div>
      ) : (
        <div className="sheet">
          <button
            className="sheet-handle"
            onClick={() => setCollapsed(c => !c)}
            aria-label="Toggle panel"
          />

          <header className="brand">
            <span className="brand-mark"><Bike size={20} /></span>
            <div>
              <h1>Cycle London</h1>
              <p>Bike-friendly routes from open map data</p>
            </div>
          </header>

          <div className="inputs">
            <LocationInput
              icon={<MapPin size={15} color="#16a34a" />}
              placeholder="Start — e.g. King's Cross"
              value={start}
              onChange={setStart}
              onLocate={useMyLocation}
              locating={locating}
            />
            <button className="swap" onClick={swap} aria-label="Swap start and end" title="Swap">
              <ArrowUpDown size={16} />
            </button>
            <LocationInput
              icon={<MapPin size={15} color="#ef4444" />}
              placeholder="Destination — e.g. London Bridge"
              value={end}
              onChange={setEnd}
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
                <Stat value={`${Math.round(route.ascentM)} m`} label="Climb" />
              </div>
              <div className="result-actions">
                <div className="start-ride-row">
                  <button className="start-ride" onClick={startRide}>
                    <Play size={20} fill="currentColor" /> Start ride
                  </button>
                  {routeHazards.length > 0 && (
                    <button className="hazard-flag" onClick={() => setShowHazardList((s) => !s)}>
                      <AlertTriangle size={14} /> {routeHazards.length}
                    </button>
                  )}
                </div>
                <button className="trace" onClick={() => setTraceToken(t => t + 1)}>
                  <Eye size={14} /> Preview route
                </button>
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
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  )
}
