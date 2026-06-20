import {
  AlertTriangle,
  ArrowUp,
  ArrowUpRight,
  ArrowUpLeft,
  ArrowRight,
  ArrowLeft,
  ArrowDownRight,
  ArrowDownLeft,
  Bike,
  Flag,
  MapPin,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from 'lucide-react'
import AmenitiesPanel from './AmenitiesPanel'
import type { RouteAmenities, Amenity } from '../services/amenities'
import type { Maneuver, ManeuverType } from '../services/navigation'
import { formatDistance } from '../services/navigation'

export type GpsStatus = 'acquiring' | 'live' | 'off-route' | 'rerouting' | 'denied' | 'sim'

interface Props {
  next: Maneuver
  then: Maneuver | null
  distanceToNext: number
  remainingDistance: number
  remainingMin: number
  arrived: boolean
  muted: boolean
  gpsStatus: GpsStatus
  gpsAccuracy: number | null // metres
  hazardAhead: boolean
  onToggleMute: () => void
  onEnd: () => void
  amenities: RouteAmenities
  showAmenities: boolean
  onToggleAmenities: () => void
  onFocusAmenity: (a: Amenity) => void
}

const GPS_LABELS: Record<GpsStatus, { label: string; color: string }> = {
  acquiring: { label: 'Acquiring GPS…', color: '#888888' },
  live:      { label: 'Live GPS',       color: '#1a1a1a' },
  'off-route': { label: 'Off route',    color: '#888888' },
  rerouting: { label: 'Recalculating…', color: '#1a1a1a' },
  denied:    { label: 'GPS denied',     color: '#888888' },
  sim:       { label: 'Demo ride',      color: '#888888' },
}

const MANEUVER_ICONS: Record<ManeuverType, LucideIcon> = {
  depart: Bike,
  arrive: Flag,
  straight: ArrowUp,
  'slight-right': ArrowUpRight,
  right: ArrowRight,
  'sharp-right': ArrowDownRight,
  'slight-left': ArrowUpLeft,
  left: ArrowLeft,
  'sharp-left': ArrowDownLeft,
}

function ManeuverIcon({ type, size }: { type: ManeuverType; size: number }) {
  const Icon = MANEUVER_ICONS[type]
  return <Icon size={size} strokeWidth={2.5} />
}

export default function NavOverlay({
  next,
  then,
  distanceToNext,
  remainingDistance,
  remainingMin,
  arrived,
  muted,
  gpsStatus,
  gpsAccuracy,
  hazardAhead,
  onToggleMute,
  onEnd,
  amenities,
  showAmenities,
  onToggleAmenities,
  onFocusAmenity,
}: Props) {
  const arrival = new Date(Date.now() + remainingMin * 60000)
  const arrivalText = arrival.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const gps = GPS_LABELS[gpsStatus]
  const amenityCount = amenities.parking.length + amenities.alongRoute.length

  return (
    <>
      <div className={`nav-banner ${arrived ? 'nav-banner--done' : ''}`}>
        <div className="nav-arrow-badge">
          <ManeuverIcon type={next.type} size={30} />
        </div>

        <div className="nav-banner-text">
          {!arrived && next.type !== 'depart' && (
            <span className="nav-dist">{formatDistance(distanceToNext)}</span>
          )}
          <span className="nav-instruction">{next.text}</span>
          {then && !arrived && (
            <span className="nav-then">
              then <span className="nav-then-icon"><ManeuverIcon type={then.type} size={13} /></span> {then.text}
            </span>
          )}
          {hazardAhead && !arrived && (
            <span className="nav-hazard">
              <AlertTriangle size={13} /> Riders have reported this stretch as less safe
            </span>
          )}
        </div>

        <div className="nav-top-right">
          <button className="nav-mute" onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <div className="nav-gps-pill" style={{ '--gps-color': gps.color } as React.CSSProperties}>
            <span className="nav-gps-dot" />
            <span className="nav-gps-label">
              {gps.label}
              {gpsStatus === 'live' && gpsAccuracy !== null && ` ±${Math.round(gpsAccuracy)}m`}
            </span>
          </div>
        </div>
      </div>

      <div className={`nav-footer ${showAmenities ? 'nav-footer--amenities' : ''}`}>
        <div className="nav-amenities" aria-hidden={!showAmenities}>
          <div className="nav-amenities-inner">
            <div className="nav-amenities-head">
              <span>Cyclist amenities</span>
              <button
                type="button"
                className="nav-amenities-close"
                onClick={onToggleAmenities}
                aria-label="Close amenities"
              >
                <X size={16} />
              </button>
            </div>
            <div className="nav-amenities-scroll">
              <AmenitiesPanel
                parking={amenities.parking}
                alongRoute={amenities.alongRoute}
                onFocus={onFocusAmenity}
              />
            </div>
          </div>
        </div>

        <div className="nav-status">
          <div className="nav-status-stats">
            <strong>{remainingMin < 1 ? '<1' : Math.round(remainingMin)} min</strong>
            <span>
              {formatDistance(remainingDistance)} · arrive {arrivalText}
            </span>
          </div>
          {amenityCount > 0 && (
            <button
              type="button"
              className={`nav-stops ${showAmenities ? 'nav-stops--active' : ''}`}
              onClick={onToggleAmenities}
              aria-expanded={showAmenities}
              aria-label={showAmenities ? 'Hide cyclist amenities' : 'Show cyclist amenities'}
            >
              <MapPin size={14} />
              {amenityCount}
            </button>
          )}
          <button className="nav-end" onClick={onEnd}>
            {arrived ? 'Done' : 'End'}
          </button>
        </div>
      </div>
    </>
  )
}
