// Junctions and stretches that show up repeatedly in TfL collision data and
// cycling safety reports as London's highest-risk spots for cyclists —
// mostly large gyratories and multi-lane junctions with heavy HGV/bus flow.
// This is a curated list for awareness, not a live feed of current data.

export interface DangerZone {
  name: string
  lat: number
  lon: number
  note: string
  radiusM: number
}

export const DANGER_ZONES: DangerZone[] = [
  { name: 'Bank junction', lat: 51.5133, lon: -0.0886, note: 'Busy multi-road junction with heavy bus traffic.', radiusM: 130 },
  { name: 'Holborn Circus', lat: 51.5180, lon: -0.1095, note: 'Complex gyratory with high HGV volumes.', radiusM: 130 },
  { name: 'Elephant & Castle', lat: 51.4943, lon: -0.1001, note: 'Large roundabout/gyratory, multiple merging lanes.', radiusM: 160 },
  { name: 'Old Street roundabout', lat: 51.5258, lon: -0.0876, note: 'High-traffic roundabout, poor sightlines.', radiusM: 140 },
  { name: 'Vauxhall Cross', lat: 51.4860, lon: -0.1235, note: 'Major gyratory with bus station traffic.', radiusM: 150 },
  { name: 'Stockwell gyratory', lat: 51.4720, lon: -0.1230, note: 'Fast-moving multi-lane gyratory.', radiusM: 140 },
  { name: 'Aldgate', lat: 51.5143, lon: -0.0755, note: 'Busy junction linking the City to the East End.', radiusM: 130 },
  { name: 'King\'s Cross gyratory', lat: 51.5310, lon: -0.1235, note: 'Pentonville Road / York Way — heavy traffic and turning HGVs.', radiusM: 150 },
  { name: 'Archway gyratory', lat: 51.5654, lon: -0.1353, note: 'Fast multi-lane gyratory around the tower.', radiusM: 140 },
  { name: 'Swiss Cottage gyratory', lat: 51.5434, lon: -0.1746, note: 'Wide, fast gyratory with multiple slip lanes.', radiusM: 140 },
  { name: 'Hyde Park Corner', lat: 51.5027, lon: -0.1527, note: 'Very large, high-speed roundabout.', radiusM: 170 },
  { name: 'Lambeth Bridge / Millbank', lat: 51.4910, lon: -0.1245, note: 'Roundabout with fast-moving traffic off the bridge.', radiusM: 130 },
]
