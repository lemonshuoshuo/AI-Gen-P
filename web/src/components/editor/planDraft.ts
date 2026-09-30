/**
 * 编辑页的本地草稿（纯函数，不发请求）。
 *
 * 草稿就是一份 TripDetail：已保存的地点用服务端的 ID，新加的地点用负数 ID（保存时 client_key 为 tmp<n>）。
 * - 修改：加 / 删 / 排序 / 换天 / 住宿 / 天数 / 出行方式 / 一键排路线的结果 / 旅程信息，都只改草稿，立即生效
 * - diffPlan：两份计划之间给人看的差异（「未保存的修改 N 处」、冲突时双方各改了什么）
 * - merge3：三方合并（草稿所基于的版本、草稿、服务端的新版本），本地改过的字段优先。
 *   用于把立即生效的修改（打卡、照片、删除打卡记录…）和同行的人的打卡进度合进草稿，不打扰正在编辑的人
 * - planPayload：PUT /trips/:id/plan 的请求体（API.md「协同编辑」）
 */
import type {
  ArrangeResult,
  PlanItemInput,
  PlanSaveInput,
  TravelMode,
  TripDetail,
  TripInput,
  Waypoint,
  WaypointInput,
} from '@/api/types'
import { canonicalOrder, groupPlan, isLodging, type PlanGroups } from '@/components/trip/plan'
import { dayjs } from '@/lib/format'
import { haversine } from '@/lib/geo'
import { phases, visibilities } from '@/lib/meta'
import { bySeq } from '@/lib/trip'

export type DraftWaypoint = Waypoint & {
  /** 新加的点：名称交给服务端按地址 / 位置自动生成（离线的城市结果、直接用坐标选的点），保存时不提交 name */
  auto_name?: boolean
}

/** 还没保存的新地点 */
export const isNew = (w: Pick<Waypoint, 'id'>) => w.id < 0
/** PUT /plan 每一项的 client_key：新点 tmp<n>，已有的 w<id> */
export const clientKey = (w: Pick<Waypoint, 'id'>) => (w.id < 0 ? `tmp${-w.id}` : `w${w.id}`)

/** 草稿里可以改的旅程字段（其余如照片、成员、统计以服务端为准） */
export const TRIP_FIELDS = [
  'title',
  'summary',
  'content',
  'start_date',
  'end_date',
  'days',
  'travel_mode',
  'phase',
  'visibility',
  'live_share',
  'tags',
] as const
export type TripField = (typeof TRIP_FIELDS)[number]

/** 草稿里可以改的地点字段（status / arrived_at 等打卡记录不属于计划，保存计划时服务端忽略） */
export const WP_FIELDS = [
  'name',
  'kind',
  'day',
  'lng',
  'lat',
  'address',
  'category',
  'note',
  'verdict',
  'rating',
  'cost',
  'planned_at',
  'amap_id',
] as const
export type WpField = (typeof WP_FIELDS)[number]

/** 旅行中给打卡写的体验（同行的人在旅行模式里写的评价）：别人改了、自己没动时直接合并 */
const REVIEW_FIELDS: readonly WpField[] = ['note', 'verdict', 'rating', 'cost']

/** 服务端把地点挪远了会清空地址重新逆地理（与 server handler relocateRadius 一致） */
export const RELOCATE_RADIUS_M = 500

function same(f: string, a: unknown, b: unknown): boolean {
  switch (f) {
    case 'lng':
    case 'lat':
      return Math.abs(Number(a) - Number(b)) < 1e-6
    case 'cost':
      return Math.round(Number(a || 0) * 100) === Math.round(Number(b || 0) * 100)
    case 'rating':
    case 'day':
      return Number(a || 0) === Number(b || 0)
    case 'planned_at':
      return (a ? Date.parse(a as string) : null) === (b ? Date.parse(b as string) : null)
    case 'tags':
      return JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
    case 'start_date':
    case 'end_date':
      return (a || null) === (b || null)
    default:
      return (a ?? '') === (b ?? '')
  }
}

const get = <T extends object>(o: T, f: string) => (o as Record<string, unknown>)[f]

export function changedFields(a: Waypoint, b: Waypoint, fields: readonly WpField[] = WP_FIELDS): WpField[] {
  return fields.filter((f) => !same(f, a[f], b[f]))
}

const byId = <T extends { id: number }>(list: T[]) => new Map(list.map((x) => [x.id, x]))

/** 有打卡记录的点（计划外的打卡、已到达、关联了照片）：删除立即生效（保存计划不会删除它们，见 API.md） */
export function hasHistory(t: Pick<TripDetail, 'photos'>, w: Waypoint) {
  return !w.planned || w.status === 'visited' || t.photos.some((p) => p.waypoint_id === w.id)
}

/** 同一家住宿（与服务端 SameLodging 一致） */
function sameLodging(a: Waypoint, b: Waypoint) {
  if (a.amap_id && a.amap_id === b.amap_id) return true
  if (a.place_id != null && a.place_id === b.place_id) return true
  return a.name.trim().toLowerCase() === b.name.trim().toLowerCase() && haversine([a.lng, a.lat], [b.lng, b.lat]) <= 100
}

/* ---------------- 修改（都返回新的 TripDetail） ---------------- */

/** 把「那一天」（0：想去）的游玩点排成 orderedIds 的顺序，再按规范顺序给全部地点重新编号 seq */
export function renumber(wps: Waypoint[], days: number, day?: number, orderedIds?: number[]): Waypoint[] {
  const g = groupPlan(wps, days)
  if (day != null && orderedIds) {
    const list = day === 0 ? g.pool : g.days.find((d) => d.day === day)?.stops
    if (list) {
      const pos = new Map(orderedIds.map((id, i) => [id, i]))
      list.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9))
    }
  }
  const seq = new Map(canonicalOrder(g).map((w, i) => [w.id, i]))
  return wps.map((w) => (seq.get(w.id) === w.seq ? w : { ...w, seq: seq.get(w.id) ?? w.seq }))
}

/** 把游玩点 id 放到第 day 天（0：「想去」）的第 index 个位置（缺省最后），并重新编号 */
export function placeInDay(t: TripDetail, id: number, day: number, index?: number): TripDetail {
  const moved = t.waypoints.map((x) => (x.id === id ? { ...x, day } : x))
  const g = groupPlan(moved, t.days)
  const list = (day === 0 ? g.pool : (g.days.find((d) => d.day === day)?.stops ?? [])).filter((x) => x.id !== id).map((x) => x.id)
  list.splice(index ?? list.length, 0, id)
  return { ...t, waypoints: renumber(moved, t.days, day, list) }
}

/** 新地点（还没有 ID）：字段来自搜索结果、地图选点或表单 */
export function newWaypoint(t: TripDetail, id: number, input: WaypointInput, day: number, kind: 'stop' | 'lodging'): DraftWaypoint {
  const now = new Date().toISOString()
  const name = (input.name ?? '').trim()
  return {
    id,
    trip_id: t.id,
    seq: t.waypoints.length,
    day,
    kind,
    planned: true,
    status: 'todo',
    planned_at: input.planned_at ?? null,
    // 没有名称时先显示地址，保存后服务端按地址 / 位置命名
    name: name || (input.address ?? '').trim(),
    auto_name: name ? undefined : true,
    address: input.address ?? '',
    province: input.province ?? '',
    city: input.city ?? '',
    district: input.district ?? '',
    lng: input.lng ?? 0,
    lat: input.lat ?? 0,
    category: input.category ?? (kind === 'lodging' ? 'hotel' : 'other'),
    arrived_at: null,
    note: input.note ?? '',
    verdict: input.verdict ?? '',
    rating: input.rating ?? 0,
    cost: input.cost ?? 0,
    amap_id: input.amap_id ?? '',
    place_id: null,
    created_at: now,
    updated_at: now,
  }
}

/** 加一个游玩点：放在第 day 天（0：「想去」）的最后 */
export function addStop(t: TripDetail, w: DraftWaypoint): TripDetail {
  return placeInDay({ ...t, waypoints: [...t.waypoints, w] }, w.id, w.day)
}

export function removeWaypoint(t: TripDetail, id: number): TripDetail {
  return { ...t, waypoints: t.waypoints.filter((w) => w.id !== id) }
}

/** 撤销删除：按原来的 seq 放回去（同一 seq 按 ID 排），再整理编号 */
export function restoreWaypoint(t: TripDetail, w: Waypoint): TripDetail {
  if (t.waypoints.some((x) => x.id === w.id)) return t
  const wps = [...t.waypoints.map((x) => (x.seq >= w.seq ? { ...x, seq: x.seq + 1 } : x)), w]
  return { ...t, waypoints: renumber(wps, t.days) }
}

/** 地点的计划字段（表单、拖动标记）；挪远了的点清空地址，保存后服务端按新位置补全（同服务端） */
export function patchWaypoint(t: TripDetail, id: number, p: WaypointInput): TripDetail {
  return {
    ...t,
    waypoints: t.waypoints.map((w) => {
      if (w.id !== id) return w
      const next: DraftWaypoint = { ...w }
      if (p.name !== undefined) {
        next.name = p.name.trim()
        next.auto_name = undefined
      }
      if (p.lng !== undefined && p.lat !== undefined && (!same('lng', p.lng, w.lng) || !same('lat', p.lat, w.lat))) {
        const far = haversine([w.lng, w.lat], [p.lng, p.lat]) > RELOCATE_RADIUS_M
        next.lng = p.lng
        next.lat = p.lat
        if (far) {
          if (p.address === undefined) next.address = ''
          if (p.amap_id === undefined) next.amap_id = ''
          next.district = ''
        }
      }
      if (p.address !== undefined) next.address = p.address
      if (p.category !== undefined) next.category = p.category
      if (p.note !== undefined) next.note = p.note
      if (p.verdict !== undefined) next.verdict = p.verdict
      if (p.rating !== undefined) next.rating = p.rating
      if (p.cost !== undefined) next.cost = p.cost
      if (p.planned_at !== undefined) next.planned_at = p.planned_at
      if (p.amap_id !== undefined) next.amap_id = p.amap_id
      if (p.kind !== undefined) next.kind = p.kind
      return next
    }),
  }
}

/** 同一家住宿的字段（「同前一晚」「沿用想去里的酒店」，与服务端 copy_from 一致） */
export function lodgingInputFrom(w: Waypoint): WaypointInput {
  return {
    name: w.name,
    address: w.address,
    lng: w.lng,
    lat: w.lat,
    amap_id: w.amap_id || undefined,
    province: w.province || undefined,
    city: w.city || undefined,
    district: w.district || undefined,
    category: w.category,
    note: isLodging(w) ? w.note : undefined,
    cost: isLodging(w) ? w.cost : undefined,
  }
}

/** 某一晚已有的住宿让位：有打卡记录的改为当天的游玩点（同服务端），其余从草稿里去掉 */
function vacateNight(t: TripDetail, wps: Waypoint[], night: number, except?: number): Waypoint[] {
  let out = wps
  for (const old of wps.filter((w) => isLodging(w) && w.day === night && w.id !== except)) {
    out = hasHistory(t, old) ? out.map((w) => (w.id === old.id ? { ...w, kind: 'stop' as const } : w)) : out.filter((w) => w.id !== old.id)
  }
  return out
}

/** 从第 night 晚（0 为出发前一晚）起连住 nights 晚：每晚一条住宿，替换这几晚原来的住宿 */
export function setLodging(t: TripDetail, night: number, input: WaypointInput, nights: number, nextId: () => number): TripDetail {
  let wps = [...t.waypoints]
  for (let k = night; k < night + Math.max(1, nights); k++) {
    wps = vacateNight(t, wps, k)
    wps.push(newWaypoint(t, nextId(), { ...input, category: input.category ?? 'hotel' }, k, 'lodging'))
  }
  const days = Math.max(t.days, night + Math.max(1, nights) - 1, 1)
  return { ...t, days, waypoints: renumber(wps, days) }
}

/** 把一个游玩点（如「想去」里的酒店）改成第 night 晚的住宿 */
export function makeLodging(t: TripDetail, id: number, night: number): TripDetail {
  let wps = vacateNight(t, t.waypoints, night, id)
  wps = wps.map((w) => (w.id === id ? { ...w, kind: 'lodging' as const, day: night } : w))
  return { ...t, waypoints: renumber(wps, t.days) }
}

/** 住宿换到另一晚：那一晚已有住宿时返回 null（同服务端的 409） */
export function moveLodging(t: TripDetail, id: number, night: number): TripDetail | null {
  if (t.waypoints.some((w) => isLodging(w) && w.day === night && w.id !== id)) return null
  const wps = t.waypoints.map((w) => (w.id === id ? { ...w, day: night } : w))
  return { ...t, waypoints: renumber(wps, t.days) }
}

/**
 * 规划的天数（有开始日期时同时改结束日期）。减少时与服务端 ShrinkDays 一致：被去掉的那几天的游玩点移到「想去」；
 * 多出来的那几晚的住宿，同一家还住别的晚上时去掉，否则放回「想去」。改成 0 天（不再分天）时出发前一晚的住宿也一样：
 * 没有哪一天从那里出发，留着的话列表里看不到它，地图上却还有
 */
export function setDays(t: TripDetail, n: number): TripDetail {
  let wps = t.waypoints.map((w) => (!isLodging(w) && w.day > n ? { ...w, day: 0 } : w))
  const cutNight = (w: Waypoint) => w.day > n || n === 0
  const kept = wps.filter((w) => isLodging(w) && !cutNight(w))
  const cut = wps.filter((w) => isLodging(w) && cutNight(w)).sort((a, b) => a.day - b.day || a.seq - b.seq)
  for (const w of cut) {
    if (kept.some((k) => sameLodging(w, k))) wps = wps.filter((x) => x.id !== w.id)
    else {
      wps = wps.map((x) => (x.id === w.id ? { ...x, kind: 'stop' as const, day: 0 } : x))
      kept.push(w)
    }
  }
  const end_date = t.start_date && n > 0 ? dayjs(t.start_date).add(n - 1, 'day').format('YYYY-MM-DD') : t.end_date
  return { ...t, days: n, end_date, waypoints: renumber(wps, n) }
}

/** 旅程信息（标题、日期、状态…）：改了起止日期时天数跟着日期走 */
export function setTripFields(t: TripDetail, patch: Partial<Pick<TripDetail, TripField>>): TripDetail {
  let next: TripDetail = { ...t, ...patch }
  if (('start_date' in patch || 'end_date' in patch) && next.start_date && next.end_date) {
    const span = dayjs(next.end_date).diff(dayjs(next.start_date), 'day') + 1
    if (span >= 1 && span <= 366 && span !== next.days) next = span < next.days ? setDays(next, span) : { ...next, days: span }
  }
  return next
}

/**
 * 一键排路线的方案（服务端按已保存的计划算出的 apply=false 预览）套到草稿上。只改地点的天和顺序：方案里「怎么走」只是估算路程用的，
 * 不改旅程的出行方式（同服务端 apply=true）
 */
export function applyArrangement(t: TripDetail, r: ArrangeResult): TripDetail {
  const pos = new Map(r.items.map((i) => [i.id, i]))
  const wps = t.waypoints.map((w) => {
    const p = pos.get(w.id)
    return p ? { ...w, day: p.day, seq: p.seq } : w
  })
  // 没有日期的旅程天数不足时设为方案的天数（同服务端 apply=true）
  const days = t.start_date && t.end_date ? t.days : Math.max(t.days, r.days)
  return { ...t, days, waypoints: wps }
}

/* ---------------- 差异（给人看） ---------------- */

export interface PlanChange {
  key: string
  kind: 'trip' | 'add' | 'remove' | 'move' | 'rename' | 'edit' | 'order' | 'lodging'
  text: string
  /** 涉及的地点：判断双方是否改了同一个地点 */
  id?: number
  /** 涉及的旅程字段或某一天的顺序（order:<day>）：判断双方是否改了同一处 */
  field?: string
  /** 打卡进度一类的修改（同行的人打卡、写评价、旅程开始…）：可以直接合并，不算和计划冲突 */
  soft?: boolean
}

const nm = (w: Pick<Waypoint, 'name' | 'address'>) => `「${w.name || w.address || '未命名地点'}」`
const nightName = (n: number) => (n === 0 ? '出发前一晚' : `第 ${n} 晚`)
const md = (d: string | null) => (d ? dayjs(d).format('M月D日') : '')

const MODE_LABEL: Record<TravelMode, string> = { auto: '自动', walking: '步行', riding: '骑行', transit: '公交', driving: '自驾' }
const FIELD_LABEL: Partial<Record<WpField, string>> = {
  address: '地址',
  category: '分类',
  note: '备注',
  verdict: '评价',
  rating: '评分',
  cost: '人均',
  planned_at: '计划时间',
}

function tripChanges(a: TripDetail, b: TripDetail): PlanChange[] {
  const out: PlanChange[] = []
  const add = (field: string, text: string, soft?: boolean) => out.push({ key: `trip:${field}`, kind: 'trip', field, text, soft })
  if (!same('title', a.title, b.title)) add('title', `标题改为「${b.title.trim() || '（空）'}」`)
  const datesChanged = !same('start_date', a.start_date, b.start_date) || !same('end_date', a.end_date, b.end_date)
  if (datesChanged)
    add('dates', b.start_date || b.end_date ? `日期改为 ${md(b.start_date) || '?'} – ${md(b.end_date) || '?'}` : '清除了日期')
  if (!same('days', a.days, b.days) && !(datesChanged && b.start_date && b.end_date)) add('days', `天数 ${a.days} → ${b.days} 天`)
  if (!same('travel_mode', a.travel_mode || 'auto', b.travel_mode || 'auto'))
    add('travel_mode', `出行方式改为「${MODE_LABEL[b.travel_mode || 'auto']}」`)
  if (!same('phase', a.phase, b.phase)) add('phase', `状态改为「${phases[b.phase].label}」`, true)
  if (!same('visibility', a.visibility, b.visibility)) add('visibility', `可见范围改为「${visibilities[b.visibility].label}」`)
  if (!same('live_share', a.live_share, b.live_share)) add('live_share', b.live_share ? '开启了旅行中实时公开' : '关闭了旅行中实时公开')
  if (!same('summary', a.summary, b.summary)) add('summary', '修改了一句话简介')
  if (!same('content', a.content, b.content)) add('content', '修改了游记正文')
  if (!same('tags', a.tags, b.tags)) add('tags', b.tags.length ? `标签改为 ${b.tags.map((x) => `#${x}`).join(' ')}` : '清空了标签')
  return out
}

/** 每一天（0：想去）的游玩点顺序 */
function dayOrders(g: PlanGroups): Map<number, number[]> {
  const m = new Map<number, number[]>()
  for (const d of g.days) m.set(d.day, d.stops.map((w) => w.id))
  m.set(0, g.pool.map((w) => w.id))
  return m
}

/**
 * 从 a 到 b 改了什么：每条是一句话（如「新增「石塘半岛」· 第 2 天」「第 1 晚住宿「A」→「B」」「调整了第 2 天的顺序」）。
 * poolName：day=0 的叫法（规划中是「想去的地方」）
 */
export function diffPlan(a: TripDetail, b: TripDetail, poolName = '想去的地方'): PlanChange[] {
  const out = tripChanges(a, b)
  const dayName = (d: number) => (d === 0 ? `「${poolName}」` : `第 ${d} 天`)
  const am = byId(a.waypoints)
  const bm = byId(b.waypoints)
  const photosB = (id: number) => b.photos.some((p) => p.waypoint_id === id)
  const replaced = new Set<number>()

  // 住宿：同一晚换了一家算一条
  for (const y of b.waypoints) {
    if (!isLodging(y) || (am.get(y.id) && isLodging(am.get(y.id)!))) continue
    const x = a.waypoints.find((w) => isLodging(w) && w.day === y.day && !(bm.get(w.id) && isLodging(bm.get(w.id)!) && bm.get(w.id)!.day === y.day))
    if (x && !bm.has(x.id)) {
      replaced.add(x.id)
      out.push({ key: `lodge:${y.id}`, kind: 'lodging', id: y.id, field: `night:${y.day}`, text: `${nightName(y.day)}的住宿${nm(x)} → ${nm(y)}` })
    } else if (am.has(y.id))
      out.push({ key: `lodge:${y.id}`, kind: 'lodging', id: y.id, field: `night:${y.day}`, text: `${nm(y)}设为${nightName(y.day)}的住宿` })
    else out.push({ key: `lodge:${y.id}`, kind: 'lodging', id: y.id, field: `night:${y.day}`, text: `${nightName(y.day)}住${nm(y)}` })
  }

  for (const x of a.waypoints) {
    const y = bm.get(x.id)
    if (!y) {
      if (replaced.has(x.id)) continue
      // 删除打卡记录（计划外的打卡、已到达、有照片的点，住宿也一样）：立即生效，保存计划不会、也不应该把它恢复
      const soft = hasHistory(a, x)
      out.push(
        isLodging(x)
          ? { key: `rm:${x.id}`, kind: 'lodging', id: x.id, field: `night:${x.day}`, text: `清除了${nightName(x.day)}的住宿${nm(x)}`, soft }
          : { key: `rm:${x.id}`, kind: 'remove', id: x.id, text: `删除了${nm(x)}`, soft },
      )
      continue
    }
    if (isLodging(y) && !isLodging(x)) continue // 已在上面「设为住宿」
    if (isLodging(x) && !isLodging(y)) {
      out.push({ key: `kind:${x.id}`, kind: 'lodging', id: x.id, field: `night:${x.day}`, text: `住宿${nm(x)}改为${dayName(y.day)}的游玩点` })
      continue
    }
    const fields = changedFields(x, y)
    if (!fields.length) continue
    if (fields.includes('day'))
      out.push(
        isLodging(x)
          ? { key: `mv:${x.id}`, kind: 'lodging', id: x.id, field: `night:${y.day}`, text: `住宿${nm(y)}${nightName(x.day)} → ${nightName(y.day)}` }
          : { key: `mv:${x.id}`, kind: 'move', id: x.id, text: `${nm(y)}${dayName(x.day)} → ${dayName(y.day)}` },
      )
    if (fields.includes('name') && x.name !== y.name)
      out.push({ key: `rn:${x.id}`, kind: 'rename', id: x.id, text: y.name ? `${nm(x)}改名为${nm(y)}` : `${nm(x)}的名称改回自动命名` })
    const rest = fields.filter((f) => f !== 'day' && f !== 'name' && f !== 'kind' && f !== 'lat' && f !== 'amap_id')
    const labels = [...(fields.includes('lng') || fields.includes('lat') ? ['位置'] : []), ...rest.filter((f) => f !== 'lng').map((f) => FIELD_LABEL[f] ?? f)]
    if (labels.length) {
      const moved = fields.includes('lng') || fields.includes('lat')
      const soft = !moved && rest.every((f) => REVIEW_FIELDS.includes(f)) && (!y.planned || y.status === 'visited' || photosB(y.id))
      out.push({ key: `ed:${x.id}`, kind: 'edit', id: x.id, text: `${nm(y)}改了${[...new Set(labels)].join('、')}`, soft })
    }
  }

  for (const y of b.waypoints) {
    if (am.has(y.id) || isLodging(y)) continue
    out.push(
      y.planned
        ? { key: `add:${y.id}`, kind: 'add', id: y.id, text: `新增${nm(y)} · ${dayName(y.day)}` }
        : { key: `add:${y.id}`, kind: 'add', id: y.id, text: `新的打卡${nm(y)}（计划外）`, soft: true },
    )
  }

  // 顺序：每天两边都有、且都在这天的地点，前后顺序变了
  const oa = dayOrders(groupPlan(a.waypoints, a.days))
  const ob = dayOrders(groupPlan(b.waypoints, b.days))
  for (const [day, ids] of ob) {
    const before = (oa.get(day) ?? []).filter((id) => ids.includes(id))
    const after = ids.filter((id) => before.includes(id))
    if (before.join() !== after.join())
      out.push({ key: `order:${day}`, kind: 'order', field: `order:${day}`, text: `调整了${dayName(day)}的顺序` })
  }
  return out
}

/** 双方都改了的地方：同一个地点、同一个旅程字段、同一天的顺序或同一晚的住宿 */
export function overlapping(mine: PlanChange[], theirs: PlanChange[]) {
  const ids = new Set(mine.flatMap((c) => (c.id != null ? [c.id] : [])))
  const fields = new Set(mine.flatMap((c) => (c.field ? [c.field] : [])))
  return new Set(theirs.filter((c) => (c.id != null && ids.has(c.id)) || (c.field != null && fields.has(c.field))).map((c) => c.key))
}

/** 服务端的新版本里有没有需要问用户的修改（打卡进度一类的、且没和本地改到同一处的可以直接合并） */
export function blockingChanges(mine: PlanChange[], theirs: PlanChange[]) {
  const both = overlapping(mine, theirs)
  return theirs.filter((c) => !c.soft || both.has(c.key))
}

/* ---------------- 三方合并 ---------------- */

/**
 * B：草稿所基于的版本，L：草稿，R：服务端的新版本。旅程与地点的计划字段本地改过的用本地的，其余用服务端的（照片、成员、
 * 打卡状态等只看服务端）；服务端已删掉的点去掉；服务端新加的点（别人的打卡、照片生成的点）放在服务端顺序里它前面那个点之后；
 * 本地删掉、服务端上又有了打卡记录的点保留（保存计划也不会删掉它）
 */
export function merge3(B: TripDetail, L: TripDetail, R: TripDetail): TripDetail {
  const trip: TripDetail = { ...R }
  for (const f of TRIP_FIELDS) if (!same(f, get(L, f), get(B, f))) (trip as unknown as Record<string, unknown>)[f] = get(L, f)
  const bm = byId(B.waypoints)
  const lm = byId(L.waypoints)
  const rm = byId(R.waypoints)
  const out: Waypoint[] = []
  for (const l of [...L.waypoints].sort(bySeq)) {
    if (isNew(l)) {
      out.push(l)
      continue
    }
    const r = rm.get(l.id)
    if (!r) continue
    const b = bm.get(l.id)
    if (!b) {
      out.push(r)
      continue
    }
    const m: Waypoint = { ...r }
    for (const f of WP_FIELDS) if (!same(f, l[f], b[f])) (m as unknown as Record<string, unknown>)[f] = l[f]
    out.push(m)
  }
  const rOrder = [...R.waypoints].sort(bySeq)
  const have = new Set(out.map((w) => w.id))
  rOrder.forEach((r, i) => {
    if (have.has(r.id)) return
    if (bm.has(r.id) && !lm.has(r.id) && !hasHistory(R, r)) return // 本地删掉了
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.findIndex((w) => w.id === rOrder[j].id)
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    out.splice(at, 0, r)
    have.add(r.id)
  })
  return { ...trip, waypoints: out.map((w, i) => (w.seq === i ? w : { ...w, seq: i })) }
}

/** 保存后把草稿里新点的临时 ID 换成服务端的 ID */
export function remapIds(t: TripDetail, idMap: Map<number, number>): TripDetail {
  if (!idMap.size) return t
  return { ...t, waypoints: t.waypoints.map((w) => (idMap.has(w.id) ? { ...w, id: idMap.get(w.id)!, auto_name: undefined } : w)) }
}

/* ---------------- 保存的请求体 ---------------- */

/** 新建（或覆盖时重新创建）一项需要的全部字段 */
function fullItem(w: DraftWaypoint): PlanItemInput {
  const it: PlanItemInput = { client_key: clientKey(w), kind: w.kind, day: w.day, lng: w.lng, lat: w.lat, category: w.category }
  if (w.id > 0) it.id = w.id
  if (!(isNew(w) && w.auto_name) && w.name) it.name = w.name
  if (w.address) it.address = w.address
  if (w.amap_id) it.amap_id = w.amap_id
  if (w.province) it.province = w.province
  if (w.city) it.city = w.city
  if (w.district) it.district = w.district
  if (w.note) it.note = w.note
  if (w.verdict) it.verdict = w.verdict
  if (w.rating) it.rating = w.rating
  if (w.cost) it.cost = w.cost
  if (w.planned_at) it.planned_at = w.planned_at
  return it
}

/**
 * PUT /trips/:id/plan 的请求体：完整的列表（规划中按规范顺序，其它阶段按草稿的顺序），每项只带与 ref 不同的字段。
 * 平时 ref 是草稿所基于的版本；覆盖（force）时 ref 是服务端的最新版本，这样对方改过的字段也改回草稿的样子，
 * 对方删掉的计划点按草稿的字段重新创建——但对方删掉的打卡记录（计划外的打卡、已到达、有照片的点）不重新创建：
 * 服务端只能把它建成待前往的计划点，到达记录已经没了，删除打卡记录本来也不属于计划。
 * 没改过、位置也没变的计划外打卡点不放进列表（服务端保持不变，排在原来前面的那个点之后）：打卡很多的旅程请求也不会太大
 */
export function planPayload(
  ref: TripDetail,
  draft: TripDetail,
  opts: { force?: boolean; baseRevision: number; isOwner: boolean; base: TripDetail },
): { body: PlanSaveInput; order: Waypoint[] } {
  const all = draft.phase === 'planning' ? canonicalOrder(groupPlan(draft.waypoints, draft.days)) : [...draft.waypoints].sort(bySeq)
  const rm = byId(ref.waypoints)
  // 服务端现在的顺序里每个点前面的那个点（没有列出的点跟着它）
  const refOrder = [...ref.waypoints].sort(bySeq)
  const prevInRef = new Map(refOrder.map((w, i) => [w.id, i > 0 ? refOrder[i - 1].id : 0]))
  const order = all.filter((w, i) => {
    if (isNew(w)) return true
    const r = rm.get(w.id)
    if (!r) return !(opts.force && hasHistory(opts.base, w))
    // 计划外的打卡点：内容没改、前面还是同一个点时省略
    return w.planned || changedFields(w, r).length > 0 || prevInRef.get(w.id) !== (i > 0 ? all[i - 1].id : 0)
  })
  const waypoints = order.map((w): PlanItemInput => {
    const r = rm.get(w.id)
    // 覆盖时每项都带齐字段：对方刚删掉的点（取到最新版本之后又删的也一样）能按草稿重新创建
    const it: PlanItemInput = isNew(w) || !r || opts.force ? fullItem(w) : { id: w.id, client_key: clientKey(w) }
    if (r && !isNew(w)) for (const f of WP_FIELDS) if (!same(f, w[f], r[f])) (it as Record<string, unknown>)[f] = w[f]
    return it
  })
  const trip: TripInput = {}
  for (const f of TRIP_FIELDS) {
    if (same(f, get(draft, f), get(ref, f))) continue
    // 可见性、实时公开只有作者能改；覆盖时不撤销对方开始 / 结束旅行（除非自己也改了状态）
    if ((f === 'visibility' || f === 'live_share') && !opts.isOwner) continue
    if (f === 'phase' && same('phase', draft.phase, opts.base.phase)) continue
    ;(trip as Record<string, unknown>)[f] = get(draft, f)
  }
  if ('title' in trip) trip.title = (trip.title ?? '').trim()
  // 起止日期都有时天数跟着日期走：不再另给天数（避免「天数与起止日期不一致」）
  if (('start_date' in trip || 'end_date' in trip) && draft.start_date && draft.end_date) delete trip.days
  const body: PlanSaveInput = { base_revision: opts.baseRevision, waypoints }
  if (opts.force) body.force = true
  if (Object.keys(trip).length) body.trip = trip
  return { body, order }
}

/* ---------------- 本机暂存（页面意外关闭后恢复） ---------------- */

export interface StoredDraft {
  v: 1
  savedAt: number
  base: TripDetail
  draft: TripDetail
  nextTemp: number
}

const storeKey = (uid: number, tid: number) => `triphub.plan-draft.${uid}.${tid}`
// 照片不属于计划、可能很多：不存，恢复时用服务端的
const lean = (t: TripDetail): TripDetail => ({ ...t, photos: [] })

export function loadStoredDraft(uid: number, tid: number): StoredDraft | null {
  try {
    const raw = localStorage.getItem(storeKey(uid, tid))
    if (!raw) return null
    const d = JSON.parse(raw) as StoredDraft
    return d?.v === 1 && d.base?.id === tid && d.draft?.id === tid ? d : null
  } catch {
    return null
  }
}

export function storeDraft(uid: number, tid: number, d: { base: TripDetail; draft: TripDetail; nextTemp: number }) {
  try {
    const v: StoredDraft = { v: 1, savedAt: Date.now(), base: lean(d.base), draft: lean(d.draft), nextTemp: d.nextTemp }
    localStorage.setItem(storeKey(uid, tid), JSON.stringify(v))
  } catch {
    /* 隐私模式、空间不足：只是不能在意外关闭后恢复 */
  }
}

export function clearStoredDraft(uid: number, tid: number) {
  try {
    localStorage.removeItem(storeKey(uid, tid))
  } catch {
    /* 忽略 */
  }
}
