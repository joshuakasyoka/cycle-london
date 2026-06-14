// Rider-reported unsafe road stretches.
//
// Stored on-device for now (localStorage), but the shape and async function
// signatures are deliberately written as if they already hit an API — so a
// future shared backend can replace the bodies below without touching any
// call sites.

export interface HazardSegment {
  id: string
  points: [number, number][] // [lat, lon] — the two ends of the unsafe stretch
  note: string
  createdAt: string // ISO timestamp
}

const STORAGE_KEY = 'cycle-london:hazards'

function readAll(): HazardSegment[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function writeAll(segments: HazardSegment[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(segments))
}

export async function listHazards(): Promise<HazardSegment[]> {
  return readAll()
}

export async function addHazard(points: [number, number][], note: string): Promise<HazardSegment> {
  const segment: HazardSegment = {
    id: crypto.randomUUID(),
    points,
    note: note.trim(),
    createdAt: new Date().toISOString(),
  }
  writeAll([...readAll(), segment])
  return segment
}

export async function removeHazard(id: string): Promise<void> {
  writeAll(readAll().filter((h) => h.id !== id))
}
