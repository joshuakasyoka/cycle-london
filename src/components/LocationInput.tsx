import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { searchPlaces, type Place } from '../services/geocode'

interface Props {
  icon: ReactNode
  placeholder: string
  value: Place | null
  onChange: (place: Place | null) => void
}

export default function LocationInput({ icon, placeholder, value, onChange }: Props) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // Keep the text field in sync when a place is set/cleared from outside (e.g. swap).
  useEffect(() => {
    if (value) setText(value.short)
  }, [value])

  // Debounced geocoding as the user types.
  useEffect(() => {
    if (value && text === value.short) return
    const q = text.trim()
    if (q.length < 3) {
      setResults([])
      return
    }
    const controller = new AbortController()
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const r = await searchPlaces(q, controller.signal)
        setResults(r)
        setOpen(true)
      } catch {
        /* aborted or network error — ignore */
      } finally {
        setLoading(false)
      }
    }, 350)
    return () => {
      clearTimeout(t)
      controller.abort()
    }
  }, [text, value])

  // Close the dropdown when clicking elsewhere.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  function pick(place: Place) {
    onChange(place)
    setText(place.short)
    setOpen(false)
  }

  return (
    <div className="loc" ref={boxRef}>
      <span className="loc-icon" aria-hidden>
        {icon}
      </span>
      <input
        className="loc-input"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (value) onChange(null)
        }}
        onFocus={() => results.length && setOpen(true)}
      />
      {text && (
        <button
          className="loc-clear"
          aria-label="Clear"
          onClick={() => {
            setText('')
            setResults([])
            onChange(null)
          }}
        >
          <X size={14} />
        </button>
      )}
      {open && (results.length > 0 || loading) && (
        <ul className="loc-list">
          {loading && <li className="loc-hint">Searching London…</li>}
          {results.map((r, i) => (
            <li key={i}>
              <button className="loc-item" onClick={() => pick(r)}>
                <span className="loc-item-name">{r.short}</span>
                <span className="loc-item-detail">{r.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
