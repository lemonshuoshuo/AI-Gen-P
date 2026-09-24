import type { Photo, TrackData, Waypoint } from '@/api/types'

type LngLat = [number, number]

export const bySeq = (a: Waypoint, b: Waypoint) => a.seq - b.seq || a.id - b.id

export function plannedPath(wps: Waypoint[]): LngLat[] {
  return wps.filter((w) => w.planned).sort(bySeq).map((w) => [w.lng, w.lat])
}

/** 实际到达顺序：按到达时间，缺失时按 seq */
export function visitedInOrder(wps: Waypoint[]) {
  return wps
    .filter((w) => w.status === 'visited')
    .sort((a, b) => {
      if (a.arrived_at && b.arrived_at) return a.arrived_at.localeCompare(b.arrived_at) || a.seq - b.seq
      return a.seq - b.seq
    })
}

export function actualPath(wps: Waypoint[]): LngLat[] {
  return visitedInOrder(wps).map((w) => [w.lng, w.lat])
}

export function trackSegments(t: TrackData | undefined): LngLat[][] {
  return (t?.segments ?? []).map((s) => s.map((p) => [p[0], p[1]] as LngLat))
}

export function groupByDay(wps: Waypoint[]) {
  const map = new Map<number, Waypoint[]>()
  for (const w of [...wps].sort(bySeq)) {
    const list = map.get(w.day) ?? []
    list.push(w)
    map.set(w.day, list)
  }
  return [...map.entries()].sort((a, b) => (a[0] || 999) - (b[0] || 999))
}

export function photosByWaypoint(photos: Photo[]) {
  const map = new Map<number, Photo[]>()
  for (const p of photos) {
    if (!p.waypoint_id) continue
    const list = map.get(p.waypoint_id) ?? []
    list.push(p)
    map.set(p.waypoint_id, list)
  }
  return map
}

export function allPoints(wps: Waypoint[], track?: LngLat[][]): LngLat[] {
  const pts: LngLat[] = wps.map((w) => [w.lng, w.lat])
  track?.forEach((s) => s.forEach((p, i) => i % 10 === 0 && pts.push(p)))
  return pts
}
