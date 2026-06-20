import { amenityKindLabel, type Amenity } from '../services/amenities'

interface Props {
  parking: Amenity[]
  alongRoute: Amenity[]
  onFocus: (a: Amenity) => void
  parkingLimit?: number
  routeLimit?: number
}

export default function AmenitiesPanel({
  parking,
  alongRoute,
  onFocus,
  parkingLimit = 4,
  routeLimit = 5,
}: Props) {
  if (!parking.length && !alongRoute.length) {
    return <p className="amenity-empty">No cyclist amenities found on this route.</p>
  }

  return (
    <div className="amenities">
      {parking.length > 0 && (
        <div className="amenity-block">
          <h3 className="amenity-heading">Bike parking near destination</h3>
          <ul className="amenity-list">
            {parking.slice(0, parkingLimit).map((a) => (
              <li key={a.id}>
                <button type="button" className="amenity-item" onClick={() => onFocus(a)}>
                  <span className="amenity-icon amenity-icon--parking">P</span>
                  <span className="amenity-text">
                    <span className="amenity-row">
                      <span className="amenity-name">{a.name}</span>
                      <span className="amenity-kind">{amenityKindLabel(a.kind)}</span>
                    </span>
                    {(a.note || a.capacity) && (
                      <span className="amenity-note">
                        {[a.capacity ? `${a.capacity} spaces` : null, a.note].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {alongRoute.length > 0 && (
        <div className="amenity-block">
          <h3 className="amenity-heading">On your route</h3>
          <ul className="amenity-list amenity-list--compact">
            {alongRoute.slice(0, routeLimit).map((a) => (
              <li key={a.id}>
                <button type="button" className="amenity-item" onClick={() => onFocus(a)}>
                  <span className={`amenity-icon amenity-icon--${a.kind}`}>
                    {a.kind === 'pump' ? '⬤' : a.kind === 'repair' ? '✕' : '☕'}
                  </span>
                  <span className="amenity-row">
                    <span className="amenity-name">{a.name}</span>
                    <span className="amenity-kind">{amenityKindLabel(a.kind)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
