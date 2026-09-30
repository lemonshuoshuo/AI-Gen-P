// 3D 回放 / 路线预览的真实路线：GET /trips/:id/legs?geometry=1 的每段高德路线、出行方式，
// 以及回放顺序（预览：计划的每天路线；回放：实际打卡顺序）
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type LegMode, type TravelMode, type TripDetail, type TripLeg, type TripLegs, type Waypoint } from '@/api'
import { groupPlan, isLodging, stopLabels } from '@/components/trip/plan'
import { haversine } from '@/lib/geo'
import { bySeq } from '@/lib/trip'
import type { LegInput } from './replay'

type LngLat = [number, number]

/** 服务端还在算（pending > 0）时最多等这么久（加上打开页面、加载旅程约 10 秒）再开始播放，之后没算完的路段按直线估算 */
export const LEGS_WAIT_MS = 9_000
const LEGS_POLL_MS = 2_000
/** 开始播放后继续在后台取（服务端只在有人来取时接着算），「再看一次」用上：直到算完或连续几次没有进展 */
const LEGS_BACKGROUND_POLL_MS = 4_000
const LEGS_MAX_STALE = 3
/** 同一家住宿连住几晚（坐标相近）算一站：与服务端 legs 不给同一家酒店连住的两晚之间算路段的距离一致 */
const SAME_LODGING_M = 50
/** 估算的路段超过这个直线距离时不猜出行方式（多半是飞机、火车） */
const NO_MODE_BEYOND_M = 300_000

const pt = (w: Pick<Waypoint, 'lng' | 'lat'>): LngLat => [w.lng, w.lat]

/** 与服务端 recommended_mode 一致：直线 1.2 公里内步行、4 公里内骑行，更远驾车（旅程偏好公交时为公交） */
export function recommendMode(straight: number, travel: TravelMode): LegMode {
  if (straight <= 1200) return 'walking'
  if (straight <= 4000) return 'riding'
  return travel === 'transit' ? 'transit' : 'driving'
}

/** 与服务端一致：auto 用推荐的方式，其余按旅程偏好（公交下 1 公里内步行） */
export function modeFor(straight: number, travel: TravelMode): LegMode {
  if (travel === 'auto') return recommendMode(straight, travel)
  if (travel === 'transit' && straight <= 1000) return 'walking'
  return travel
}

/** 与服务端的估算一致：路程取直线的 1.3 倍（驾车 1.4 倍），按各方式的速度与固定耗时估算用时 */
export function estimateLeg(straight: number, mode: LegMode) {
  const distance_m = straight * (mode === 'driving' ? 1.4 : 1.3)
  const far = straight >= 50_000 && (mode === 'transit' || mode === 'driving')
  const duration_s = far
    ? distance_m / 20
    : mode === 'walking'
      ? distance_m / 1.2
      : mode === 'riding'
        ? distance_m / 4 + 120
        : mode === 'transit'
          ? distance_m / 6 + 600
          : distance_m / 8 + 180
  return { distance_m, duration_s }
}

/** 回放顺序里的一站；ids 为同一个地方连住几晚的各条住宿（路段按其中任意一条的 ID 相连） */
export interface SeqItem {
  w: Waypoint
  ids: number[]
}

/**
 * 路线预览的顺序（与行程页、服务端 legs 一致）：每天 前一晚住宿 → 当天计划游玩点（按 seq）→ 当晚住宿，按天连起来；
 * 相邻两天共用同一晚的住宿，同一家店连住几晚（坐标相同）只算一站。没有安排到某天的「想去」不在路线里；
 * 一个点都没有分天时按 seq 连「想去」的计划点
 */
export function planSequence(trip: Pick<TripDetail, 'waypoints' | 'days'>): SeqItem[] {
  const g = groupPlan(trip.waypoints, trip.days)
  if (!g.days.some((d) => d.stops.some((w) => w.planned))) return g.pool.filter((w) => w.planned).map((w) => ({ w, ids: [w.id] }))
  const out: SeqItem[] = []
  for (const d of g.days) {
    const stops = d.stops.filter((x) => x.planned)
    // 没有游玩点的一天只有「换酒店」这一段；同一家店连住的两晚在下面合并成一站，不产生路段
    if (!stops.length && !(d.start && d.end)) continue
    for (const w of [d.start, ...stops, d.end]) {
      if (!w) continue
      const last = out[out.length - 1]
      if (last && last.ids.includes(w.id)) continue
      if (last && isLodging(last.w) && isLodging(w) && haversine(pt(last.w), pt(w)) < SAME_LODGING_M) {
        last.ids.push(w.id)
        continue
      }
      out.push({ w, ids: [w.id] })
    }
  }
  return out
}

/**
 * 标记上的序号：与行程页相同（每天的游玩点按顺序各自从 1 编号，含计划外的打卡；「想去」也从 1 编号），这样回放里的
 * 「3 号」就是行程页上的「3 号」，哪怕实际先去了别的地方；行程页上没有编号的点再按回放的顺序补上。住宿不编号
 */
export function tripLabels(trip: Pick<TripDetail, 'waypoints' | 'days'>, seq: Waypoint[]): Map<number, string> {
  const page = stopLabels(groupPlan(trip.waypoints, trip.days))
  const rest = sequenceLabels(seq.filter((w) => !page.has(w.id)))
  const out = new Map<number, string>()
  for (const w of seq) {
    if (isLodging(w)) continue
    const l = page.get(w.id) ?? rest.get(w.id)
    if (l) out.set(w.id, l)
  }
  return out
}

/** 按顺序编号：分了天的旅程每天各自从 1 编号，否则按顺序编号；住宿不编号 */
export function sequenceLabels(seq: Waypoint[]): Map<number, string> {
  const byDay = seq.some((w) => w.day > 0 && !isLodging(w))
  const count = new Map<number, number>()
  const out = new Map<number, string>()
  for (const w of seq) {
    if (isLodging(w)) continue
    const k = byDay ? w.day : 0
    const n = (count.get(k) ?? 0) + 1
    count.set(k, n)
    out.set(w.id, String(n))
  }
  return out
}

/** 两站属于同一天的路线（住宿是第 N 天的终点，也是第 N+1 天的起点）；「想去」（day=0）的点之间也算 */
function sameRouteDay(a: Waypoint, b: Waypoint) {
  const days = (w: Waypoint) => (isLodging(w) ? [w.day, w.day + 1] : [w.day])
  const db = days(b)
  return days(a).some((d) => db.includes(d))
}

/**
 * 相邻两站之间的路段：legs 里有这一段（或反方向的一段）时用高德的路线，否则两点直线（按直线估算路程与用时，
 * 出行方式按距离推荐）。回放的打卡顺序可能与计划不同，也会有计划外的打卡点。
 * 不在同一天路线里的两站（前一天最后一站 → 后一天第一站，中间没有住宿）是转场（transfer）：没有推荐的方式，不计里程
 */
export function legInputs(seq: SeqItem[], legs: TripLeg[] | undefined, travel: TravelMode): LegInput[] {
  const idx = new Map<string, TripLeg>()
  for (const l of legs ?? []) idx.set(`${l.from_id}>${l.to_id}`, l)
  const find = (a: SeqItem, b: SeqItem) => {
    for (const x of a.ids) for (const y of b.ids) {
      const l = idx.get(`${x}>${y}`)
      if (l) return { l, reversed: false }
    }
    for (const x of a.ids) for (const y of b.ids) {
      const l = idx.get(`${y}>${x}`)
      if (l) return { l, reversed: true }
    }
    return null
  }
  const out: LegInput[] = []
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1]
    const b = seq[i]
    const straightPath: LngLat[] = [pt(a.w), pt(b.w)]
    const hit = find(a, b)
    if (hit) {
      const { l } = hit
      const poly = l.polyline && l.polyline.length > 1 ? (hit.reversed ? [...l.polyline].reverse() : l.polyline) : undefined
      out.push({
        path: poly ?? straightPath,
        mode: l.mode,
        recommended: l.recommended_mode,
        distance_m: l.distance_m,
        duration_s: l.duration_s,
        estimated: l.estimated || !poly,
      })
      continue
    }
    const straight = haversine(pt(a.w), pt(b.w))
    const transfer = !sameRouteDay(a.w, b.w)
    const known = straight <= NO_MODE_BEYOND_M
    const mode = known ? modeFor(straight, travel) : null
    out.push({
      path: straightPath,
      mode,
      recommended: known && !transfer ? recommendMode(straight, travel) : null,
      ...estimateLeg(straight, mode ?? 'driving'),
      estimated: true,
      transfer: transfer || undefined,
    })
  }
  return out
}

/** 把几段路拼成一条折线（对比用的计划路线） */
export function joinLegs(seq: SeqItem[], inputs: LegInput[]): LngLat[] {
  const out: LngLat[] = seq.length ? [pt(seq[0].w)] : []
  inputs.forEach((l, i) => {
    out.push(...l.path.slice(1, -1), pt(seq[i + 1].w))
  })
  return out
}

/**
 * 回放用的路段：与行程页相同的查询（共用缓存）；服务端还没算完（pending > 0）时每 2 秒再取一次，
 * 算完、出错或等了约 10 秒后 settled，页面据此开始播放（没算完的路段按直线）
 */
export function useReplayLegs(trip: TripDetail | undefined, enabled: boolean) {
  const planned = (trip?.waypoints ?? []).filter((w) => w.planned).sort(bySeq)
  // 与 useTripLegs（RouteLegs.tsx）的查询键一致：从行程页进来时直接用缓存
  const sig = planned.map((w) => `${w.id}:${w.kind === 'lodging' ? 'L' : ''}${w.day}:${w.lng.toFixed(5)},${w.lat.toFixed(5)}`).join('|')
  const on = enabled && !!trip && planned.length >= 2
  const since = useRef<number | null>(null)
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    if (!on) return
    since.current ??= Date.now()
    const left = LEGS_WAIT_MS - (Date.now() - since.current)
    const t = window.setTimeout(() => setTimedOut(true), Math.max(0, left))
    return () => window.clearTimeout(t)
  }, [on])
  // 等待期之后仍在后台接着取（服务端只在有人来取时接着算），直到算完或连续几次没有进展：「再看一次」用上
  const progress = useRef({ at: 0, last: Infinity, stale: 0 })
  const q = useQuery({
    queryKey: ['legs', trip?.id, trip?.travel_mode ?? '', true, sig],
    queryFn: ({ signal }) => api.trips.legs(trip!.id, trip!.travel_mode, signal, true),
    enabled: on,
    staleTime: 10 * 60_000,
    retry: false,
    refetchInterval: (query) => {
      const pending = (query.state.data as TripLegs | undefined)?.pending ?? 0
      if (!pending) return false
      const waited = since.current == null ? 0 : Date.now() - since.current
      if (waited < LEGS_WAIT_MS) return LEGS_POLL_MS
      const p = progress.current
      // 同一次结果只统计一次（这个函数可能被多次调用）
      if (p.at !== query.state.dataUpdatedAt) {
        p.stale = pending >= p.last ? p.stale + 1 : 0
        p.last = pending
        p.at = query.state.dataUpdatedAt
      }
      return p.stale >= LEGS_MAX_STALE ? false : LEGS_BACKGROUND_POLL_MS
    },
  })
  const pending = q.data?.pending ?? 0
  const settled = !on || q.isError || (!!q.data && pending === 0) || timedOut
  return { data: on ? q.data : undefined, settled, pending, total: q.data?.legs.length ?? 0 }
}
