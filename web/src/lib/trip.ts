import type { Photo, TrackData, Waypoint } from '@/api/types'

type LngLat = [number, number]

export const bySeq = (a: Waypoint, b: Waypoint) => a.seq - b.seq || a.id - b.id

/**
 * 下一站（与服务端 PendingPlan、推荐接口的 next_planned 一致）：按 seq 排序，最后一个已到达的计划点之后的第一个待前往计划点；
 * 后面没有时取前面路过没打卡的最早一个；计划外和跳过的点不影响进度。没有待前往的计划点时为 null
 */
export function nextPlanned(wps: Waypoint[]): Waypoint | null {
  const sorted = [...wps].sort(bySeq)
  let last = -1
  sorted.forEach((w, i) => {
    if (w.planned && w.status === 'visited') last = i
  })
  const todo = (w: Waypoint) => w.planned && w.status === 'todo'
  return sorted.find((w, i) => i > last && todo(w)) ?? sorted.find(todo) ?? null
}

export function plannedPath(wps: Waypoint[]): LngLat[] {
  return wps.filter((w) => w.planned).sort(bySeq).map((w) => [w.lng, w.lat])
}

/** 实际路线顺序（与服务端 ActualRoute、docs/API.md 一致）：全部已到达点都有 arrived_at 时按时间（同一时间按 seq），否则整体按 seq */
export function visitedInOrder(wps: Waypoint[]) {
  const visited = wps.filter((w) => w.status === 'visited')
  if (visited.every((w) => w.arrived_at)) {
    return visited.sort((a, b) => Date.parse(a.arrived_at!) - Date.parse(b.arrived_at!) || bySeq(a, b))
  }
  return visited.sort(bySeq)
}

export function actualPath(wps: Waypoint[]): LngLat[] {
  return visitedInOrder(wps).map((w) => [w.lng, w.lat])
}

export function trackSegments(t: TrackData | undefined): LngLat[][] {
  return (t?.segments ?? []).map((s) => s.map((p) => [p[0], p[1]] as LngLat))
}

/**
 * 3D 回放用的轨迹分段（带每个点的时间，毫秒）：按开始时间排序；
 * 与已选分段在时间上重叠过半的分段（同行成员 / 另一台设备同时记录的同一段路）不参与回放
 */
export function replayTrackParts(t: TrackData | undefined): { path: LngLat[]; times: number[] }[] {
  const segs = (t?.segments ?? []).filter((s) => s.length > 1)
  const dur = (s: (typeof segs)[number]) => s[s.length - 1][3] - s[0][3]
  const kept: typeof segs = []
  for (const s of [...segs].sort((a, b) => dur(b) - dur(a))) {
    const overlap = kept.reduce((o, k) => o + Math.max(0, Math.min(s[s.length - 1][3], k[k.length - 1][3]) - Math.max(s[0][3], k[0][3])), 0)
    if (overlap <= dur(s) * 0.5) kept.push(s)
  }
  return kept
    .sort((a, b) => a[0][3] - b[0][3])
    .map((s) => ({ path: s.map((p) => [p[0], p[1]] as LngLat), times: s.map((p) => p[3]) }))
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
