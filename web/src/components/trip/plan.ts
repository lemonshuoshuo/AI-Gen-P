// 按天规划的数据模型（与服务端 service.PlanOrder / PendingPlanAt、docs/API.md「Waypoint.kind」一致）：
// 每天从前一晚的住宿出发 → 当天的游玩点 → 当晚的住宿；day=0 的游玩点是「想去」的地点池，day=0 的住宿是出发前一晚。
import type { TripLeg, Waypoint } from '@/api/types'
import { bySeq } from '@/lib/trip'

type LngLat = [number, number]

export const isLodging = (w: Pick<Waypoint, 'kind'>) => w.kind === 'lodging'

/** 天数：服务端的 days（日期跨度或设置的天数）与打卡点最大 day 中较大者 */
export function planDayCount(tripDays: number, wps: Pick<Waypoint, 'day'>[]) {
  let n = Math.max(0, tripDays || 0)
  for (const w of wps) if (w.day > n) n = w.day
  return n
}

export interface DayPlan {
  day: number
  /** 当天的游玩点（含计划外的打卡），按 seq */
  stops: Waypoint[]
  /** 出发的住宿：前一晚（第 1 天为出发前一晚 day=0） */
  start: Waypoint | null
  /** 当晚的住宿 */
  end: Waypoint | null
}

export interface PlanGroups {
  dayCount: number
  /** 第 1…dayCount 天 */
  days: DayPlan[]
  /** 「想去」：没有安排到某天的游玩点（day=0） */
  pool: Waypoint[]
  /** 每晚的住宿（0 为出发前一晚） */
  lodging: Map<number, Waypoint>
  /** 同一晚多出来的住宿（旧数据）：放在那一天的列表里，照常可以删除 */
  extraLodging: Waypoint[]
}

export function groupPlan(wps: Waypoint[], tripDays: number): PlanGroups {
  const sorted = [...wps].sort(bySeq)
  const dayCount = planDayCount(tripDays, sorted)
  const lodging = new Map<number, Waypoint>()
  const extraLodging: Waypoint[] = []
  const stopsByDay = new Map<number, Waypoint[]>()
  const pool: Waypoint[] = []
  for (const w of sorted) {
    if (isLodging(w)) {
      if (lodging.has(w.day)) extraLodging.push(w)
      else lodging.set(w.day, w)
    } else if (w.day > 0) {
      const list = stopsByDay.get(w.day) ?? []
      list.push(w)
      stopsByDay.set(w.day, list)
    } else pool.push(w)
  }
  const days: DayPlan[] = []
  for (let d = 1; d <= dayCount; d++)
    days.push({ day: d, stops: stopsByDay.get(d) ?? [], start: lodging.get(d - 1) ?? null, end: lodging.get(d) ?? null })
  return { dayCount, days, pool, lodging, extraLodging }
}

/**
 * 规范顺序（与服务端「一键规划」保存时的编号一致）：出发前一晚的住宿在最前；每天依次为当天的游玩点、当晚住宿；
 * 最后是「想去」的点。新增、移动地点时按它计算插入位置，服务端的计划路线、下一站推荐都按这个顺序走
 */
export function canonicalOrder(g: PlanGroups): Waypoint[] {
  const out: Waypoint[] = []
  const eve = g.lodging.get(0)
  if (eve) out.push(eve)
  const extra = (night: number) => g.extraLodging.filter((w) => w.day === night)
  out.push(...extra(0))
  for (const d of g.days) {
    out.push(...d.stops)
    if (d.end) out.push(d.end)
    out.push(...extra(d.day))
  }
  out.push(...g.pool)
  // 天数之外的住宿（不应出现，保险起见放在最后）
  const seen = new Set(out.map((w) => w.id))
  for (const w of [...g.lodging.values(), ...g.extraLodging]) if (!seen.has(w.id)) out.push(w)
  return out
}

/** 每天各自编号的游玩点序号（1…k）；「想去」也从 1 编号；住宿不编号 */
export function stopLabels(g: PlanGroups): Map<number, string> {
  const m = new Map<number, string>()
  for (const d of g.days) d.stops.forEach((w, i) => m.set(w.id, String(i + 1)))
  g.pool.forEach((w, i) => m.set(w.id, String(i + 1)))
  return m
}

/* ---------------- 每天的颜色（路线与标记上的提示色） ---------------- */

export interface Tone {
  /** CSS 变量名：地图（WebGL）按当前主题解析 */
  v: string
  bg: string
  text: string
  border: string
}

// 类名要原样写在这里，Tailwind 才会生成对应的主题变量（--color-sky-600 等）
const DAY_TONES: Tone[] = [
  { v: '--color-sky-600', bg: 'bg-sky-600', text: 'text-sky-600', border: 'border-sky-600' },
  { v: '--color-amber-600', bg: 'bg-amber-600', text: 'text-amber-600', border: 'border-amber-600' },
  { v: '--color-emerald-600', bg: 'bg-emerald-600', text: 'text-emerald-600', border: 'border-emerald-600' },
  { v: '--color-violet-600', bg: 'bg-violet-600', text: 'text-violet-600', border: 'border-violet-600' },
  { v: '--color-pink-600', bg: 'bg-pink-600', text: 'text-pink-600', border: 'border-pink-600' },
]
export const POOL_TONE: Tone = { v: '--color-ink-500', bg: 'bg-ink-500', text: 'text-ink-500', border: 'border-ink-500' }
/** 实际走过的路线：朱砂 */
export const ACTUAL_TONE: Tone = { v: '--color-brand-500', bg: 'bg-brand-500', text: 'text-brand-500', border: 'border-brand-500' }

export const dayTone = (day: number): Tone => (day > 0 ? DAY_TONES[(day - 1) % DAY_TONES.length] : POOL_TONE)

/* ---------------- 路线顺序与下一站（与服务端 PlanOrder / PendingPlanAt 一致） ---------------- */

/** 计划的顺序：游玩点按 seq；每晚的住宿排在当天（或之前最近一个有游玩点的那天）最后一个游玩点之后 */
export function planOrder(wps: Waypoint[]): Waypoint[] {
  const stops = wps.filter((w) => w.planned && !isLodging(w)).sort(bySeq)
  const lodging = wps
    .filter((w) => w.planned && isLodging(w))
    .sort((a, b) => a.day - b.day || a.seq - b.seq || a.id - b.id)
  if (!lodging.length) return stops
  const before = (night: number) => {
    let after = -1
    stops.forEach((s, i) => {
      if (s.day >= 1 && s.day <= night) after = i
    })
    if (after >= 0) return after + 1
    const i = stops.findIndex((s) => s.day > night)
    return i >= 0 ? i : stops.length
  }
  const out: Waypoint[] = []
  let li = 0
  for (let i = 0; i <= stops.length; i++) {
    while (li < lodging.length && before(lodging[li].day) <= i) out.push(lodging[li++])
    if (i < stops.length) out.push(stops[i])
  }
  return out
}

/** 旅程的第几天（按北京时间的今天；没有开始日期或不在旅程期间为 0） */
export function tripDayToday(startDate: string | null): number {
  if (!startDate) return 0
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const d = Math.round((Date.parse(today) - Date.parse(startDate)) / 86_400_000) + 1
  return d >= 1 && d <= 366 ? d : 0
}

/**
 * 下一站：计划顺序中最后一个已到达的点之后的第一个待前往的点（可以是今晚的住宿）；之后没有时取之前漏掉的游玩点。
 * 已经过去的那些晚（今天之前）的住宿不再作为下一站
 */
export function nextInPlan(wps: Waypoint[], today = 0): Waypoint | null {
  const order = planOrder(wps)
  let last = -1
  order.forEach((w, i) => {
    if (w.status === 'visited') last = i
  })
  const pending = (w: Waypoint) => w.status === 'todo' && !(isLodging(w) && today > 0 && w.day < today)
  return order.find((w, i) => i > last && pending(w)) ?? order.find((w) => pending(w) && !isLodging(w)) ?? null
}

/* ---------------- 地图上的路线段 ---------------- */

export interface PlanSegment {
  id: string
  path: LngLat[]
  kind: 'planned' | 'actual'
  /** CSS 变量名或颜色 */
  color: string
  estimated?: boolean
  dim?: boolean
  /** 路段中点的出行方式图标 */
  mode?: TripLeg['mode']
}

const pairKey = (a: number, b: number) => `${a}>${b}`

export function legIndex(legs: TripLeg[] | undefined) {
  const m = new Map<string, TripLeg>()
  for (const l of legs ?? []) m.set(pairKey(l.from_id, l.to_id), l)
  return m
}

export const legBetween = (idx: Map<string, TripLeg>, a: Waypoint, b: Waypoint) => idx.get(pairKey(a.id, b.id))

const pt = (w: Waypoint): LngLat => [w.lng, w.lat]

/** 两点之间的一段：有高德路线用路线，否则是直线（估算） */
function segment(idx: Map<string, TripLeg>, a: Waypoint, b: Waypoint, base: Omit<PlanSegment, 'id' | 'path' | 'estimated' | 'mode'>, withMode: boolean): PlanSegment {
  const l = idx.get(pairKey(a.id, b.id))
  const path = l?.polyline && l.polyline.length > 1 ? l.polyline : [pt(a), pt(b)]
  return {
    ...base,
    id: `${base.kind}-${a.id}-${b.id}`,
    path,
    estimated: !l || l.estimated || !l.polyline,
    mode: withMode && l ? l.mode : undefined,
  }
}

/**
 * 计划路线的各段（虚线，每天一种颜色）：每天 前一晚住宿 → 当天计划游玩点 → 当晚住宿；
 * focus 为某一天时其余几天变淡。没有分天的旅程（全在 day=0）按顺序连成一条
 */
export function plannedSegments(
  g: PlanGroups,
  legs: TripLeg[] | undefined,
  opts: { focus?: number | 'pool' | null; icons?: boolean; dimAll?: boolean } = {},
): PlanSegment[] {
  const idx = legIndex(legs)
  const out: PlanSegment[] = []
  const icons = opts.icons ?? true
  for (const d of g.days) {
    const seq = [d.start, ...d.stops.filter((w) => w.planned), d.end].filter((w): w is Waypoint => !!w)
    const dim = opts.dimAll || (opts.focus != null && opts.focus !== d.day)
    for (let i = 1; i < seq.length; i++) {
      if (seq[i - 1].id === seq[i].id) continue
      out.push(segment(idx, seq[i - 1], seq[i], { kind: 'planned', color: dayTone(d.day).v, dim }, icons && !dim))
    }
  }
  // 没有分天：「想去」的点就是整条路线
  if (g.dayCount === 0) {
    const seq = g.pool.filter((w) => w.planned)
    for (let i = 1; i < seq.length; i++)
      out.push(segment(idx, seq[i - 1], seq[i], { kind: 'planned', color: dayTone(1).v, dim: !!opts.dimAll }, icons && !opts.dimAll))
  }
  return out
}

/** 实际走过的路线（实线）：相邻两个到达点正好是计划里的一段时沿用那段的真实道路，否则为直线 */
export function actualSegments(visited: Waypoint[], legs: TripLeg[] | undefined, color = ACTUAL_TONE.v): PlanSegment[] {
  const idx = legIndex(legs)
  const out: PlanSegment[] = []
  for (let i = 1; i < visited.length; i++) out.push(segment(idx, visited[i - 1], visited[i], { kind: 'actual', color }, false))
  return out
}
