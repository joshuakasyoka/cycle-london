import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpDown, Bike, Eye, MapPin, Play } from 'lucide-react'
import LocationInput from './components/LocationInput'
import MapView from './components/MapView'
import NavOverlay, { type GpsStatus } from './components/NavOverlay'
import { reverseGeocode, type Place } from './services/geocode'
import {
  fetchRoute,
  ROUTE_MODES,
  type BikeProfile,
  type RouteResult,
} from './services/route'
import {
  buildNavRoute,
  formatDistance,
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
  const [profile, setProfile] = useState<BikeProfile>('safety')
  const [route, setRoute]     = useState<RouteResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [traceToken, setTraceToken] = useState(0)
  const [collapsed, setCollapsed]   = useState(false)
  const [locating, setLocating]     = useState(false)

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

  // Keep mutedRef in sync so speak() doesn't close over stale state
  useEffect(() => { mutedRef.current = muted }, [muted])

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

  // ── Mark arrival ───────────────────────────────────────────────────────────
  const markArrived = useCallback(() => {
    if (!announcedRef.current.has(-1)) {
      announcedRef.current.add(-1)
      speak('You have arrived at your destination.')
    }
    setArrived(true)
  }, [speak])

  // ── Planner ────────────────────────────────────────────────────────────────
  async function findRoute(p: BikeProfile = profile) {
    if (!start || !end) return
    setLoading(true)
    setError(null)
    try {
      const r = await fetchRoute(start, end, p)
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

  function pickProfile(p: BikeProfile) {
    setProfile(p)
    if (start && end) findRoute(p)
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
    }
  }, [markArrived, maybeAnnounce])

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
    }

    simIntervalRef.current = window.setInterval(tick, TICK_MS)
    return () => {
      if (simIntervalRef.current !== null) window.clearInterval(simIntervalRef.current)
      simIntervalRef.current = null
    }
  }, [navigating, markArrived, maybeAnnounce])

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

  return (
    <div className="app">
      <MapView
        start={start}
        end={end}
        route={route}
        traceToken={traceToken}
        navigating={navigating}
        navPosition={navPosition}
      />

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
          onToggleMute={() => setMuted(m => !m)}
          onEnd={endRide}
        />
      ) : (
        <div className={`sheet ${collapsed ? 'sheet--mini' : ''}`}>
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
              icon={<MapPin size={15} color="#5cf27a" />}
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
              icon={<MapPin size={15} color="#ff6b6b" />}
              placeholder="Destination — e.g. London Bridge"
              value={end}
              onChange={setEnd}
            />
          </div>

          <div className="modes">
            {ROUTE_MODES.map(m => (
              <button
                key={m.id}
                className={`mode ${profile === m.id ? 'mode--on' : ''}`}
                onClick={() => pickProfile(m.id)}
              >
                <span className="mode-label">{m.label}</span>
                <span className="mode-blurb">{m.blurb}</span>
              </button>
            ))}
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
                <button className="start-ride" onClick={startRide}>
                  <Play size={20} fill="currentColor" /> Start ride
                </button>
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
