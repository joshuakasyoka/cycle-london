// Rider-reported unsafe road stretches.
//
// Stored on-device for now (localStorage), but the shape and async function
// signatures are deliberately written as if they already hit an API — so a
// future shared backend can replace the bodies below without touching any
// call sites.

export interface HazardSegment {
  id: string
  points: [number, number][] // [lat, lon] — the road-snapped path of the unsafe stretch
  note: string
  createdAt: string // ISO timestamp
  upvotes: number
  downvotes: number
  myVote: 1 | -1 | 0 // this device's current vote
}

type StoredHazard = Omit<HazardSegment, 'myVote'>

const STORAGE_KEY = 'cycle-london:hazards'
const VOTES_KEY = 'cycle-london:hazard-votes'

function readAll(): StoredHazard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const segments: StoredHazard[] = raw ? JSON.parse(raw) : []
    // Older reports predate vote counts — default them to zero.
    return segments.map((h) => ({ ...h, upvotes: h.upvotes ?? 0, downvotes: h.downvotes ?? 0 }))
  } catch {
    return []
  }
}

function writeAll(segments: StoredHazard[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(segments))
}

function readVotes(): Record<string, 1 | -1> {
  try {
    const raw = localStorage.getItem(VOTES_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeVotes(votes: Record<string, 1 | -1>) {
  localStorage.setItem(VOTES_KEY, JSON.stringify(votes))
}

export async function listHazards(): Promise<HazardSegment[]> {
  const votes = readVotes()
  return readAll().map((h) => ({ ...h, myVote: votes[h.id] ?? 0 }))
}

export async function addHazard(points: [number, number][], note: string): Promise<HazardSegment> {
  const segment: StoredHazard = {
    id: crypto.randomUUID(),
    points,
    note: note.trim(),
    createdAt: new Date().toISOString(),
    upvotes: 0,
    downvotes: 0,
  }
  writeAll([...readAll(), segment])
  return { ...segment, myVote: 0 }
}

export async function removeHazard(id: string): Promise<void> {
  writeAll(readAll().filter((h) => h.id !== id))
  const votes = readVotes()
  delete votes[id]
  writeVotes(votes)
}

// Cast a vote on a hazard. Voting the same direction again retracts the vote.
export async function voteHazard(id: string, vote: 1 | -1): Promise<HazardSegment | null> {
  const all = readAll()
  const idx = all.findIndex((h) => h.id === id)
  if (idx === -1) return null

  const votes = readVotes()
  const current = votes[id] ?? 0
  const h = { ...all[idx] }

  if (current === 1) h.upvotes--
  if (current === -1) h.downvotes--

  let next: 1 | -1 | 0
  if (current === vote) {
    next = 0
  } else {
    next = vote
    if (vote === 1) h.upvotes++
    else h.downvotes++
  }

  all[idx] = h
  writeAll(all)

  if (next === 0) delete votes[id]
  else votes[id] = next
  writeVotes(votes)

  return { ...h, myVote: next }
}
