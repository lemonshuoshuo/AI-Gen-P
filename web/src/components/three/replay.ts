// 3D 回放的路线模型：把路线点、打卡点、停留时间换算成统一的时间轴
import type { LegMode } from '@/api/types'
import { haversine } from '@/lib/geo'

type LngLat = [number, number]

export interface ReplayStop {
  key: string
  lng: number
  lat: number
  name: string
  color: string
  /** 附加信息（卡片展示用） */
  sub?: string
  note?: string
  photo?: string
  verdict?: string
  tag?: string
  /** 到达时间（毫秒时间戳），有轨迹时间时用于把打卡点对齐到轨迹 */
  t?: number
  /** stop：游玩点（缺省）；lodging：住宿（标记是一张床，不编号） */
  kind?: 'stop' | 'lodging'
  /** 标记上的序号（住宿没有） */
  label?: string
  /** 第几天（标记外圈的颜色）；0 / 缺省为不分天 */
  day?: number
  /** 住宿：同一家连住几晚合成的这一站有几晚（缺省 1） */
  nights?: number
}

export interface PlacedStop extends ReplayStop {
  /** 沿路线到达该点时的里程（米） */
  reach: number
  index: number
}

/** 相邻两站之间的一段路（出行方式、路程、用时）；输入给 buildLegRoute 时带上这段路的折线 */
export interface LegInfo {
  /** 出行方式；无从判断（如上千公里的估算）时为 null，不显示图标 */
  mode: LegMode | null
  /** 推荐的方式（与 mode 不同时在字幕里提示） */
  recommended: LegMode | null
  distance_m: number
  /** 0 表示不显示用时（GPS 轨迹回放：计划的用时不代表实际） */
  duration_s: number
  /** 按直线估算：路线是两点直线，画得淡一些 */
  estimated: boolean
  /**
   * 跨天的转场（路线预览里前一天最后一站 → 后一天第一站，中间没有住宿；服务端没有这一段）：
   * 不是计划里的路，不提示「推荐」，不计入里程和路上用时
   */
  transfer?: boolean
}

export interface LegInput extends LegInfo {
  /** 这段路的折线（GCJ-02，起点 → 终点）；不足两个点时画直线 */
  path: LngLat[]
}

export interface ReplayLeg extends LegInfo {
  /** 起止打卡点在 stops 里的下标 */
  from: number
  to: number
  /** 沿路线的里程范围（米） */
  start: number
  end: number
  /** 路段中点（出行方式图标的位置） */
  mid: LngLat
}

export interface TrailPart {
  path: LngLat[]
  /** 沿路线的里程（米），与 path 一一对应 */
  timestamps: number[]
  estimated: boolean
}

export interface RouteModel {
  coords: LngLat[]
  cum: number[]
  total: number
  /** 分段路线（两次记录之间、同行成员各自的轨迹、不同旅程之间不连线）；timestamps 为沿路线的里程（米） */
  parts: { path: LngLat[]; timestamps: number[] }[]
  /** 画轨迹用的分段：有路段时按路段切开（估算的路段画得淡一些），否则同 parts */
  trails: TrailPart[]
  stops: PlacedStop[]
  /** 相邻两站之间的路段（没有路段信息时为空） */
  legs: ReplayLeg[]
  /** 时间轴：[时间(秒), 里程(米)] 的分段线性映射 */
  timeline: { t: number; d: number; stop?: number }[]
  duration: number
}

const DWELL = 2 // 每个打卡点停留秒数（够读完字幕）
const DASHES = 36 // 按直线估算的路段画成虚线：每段这么多短划（跟随时这一段大致占满画面，短划的屏幕长度差不多）
const ESTIMATED_WEIGHT = 0.6 // 估算的路段（多半是跨天的长距离转场）在时间轴上少占一些时间
const MIN_TRAVEL = 1.1 // 每段路至少走这么久：短短一段步行也看得见头像在走
const JUMP = 1 // 段间跳转只记 1 米：不连线、不计里程
const FLIGHT = 1.5 // 跨段时镜头飞行秒数
const TIME_WINDOW_MS = 15 * 60_000 // 按到达时间对齐：只看到达时刻前后 15 分钟的轨迹点
const TIME_MAX_SNAP_M = 500 // 时间窗口内最近的轨迹点也超过这个距离时，改为按位置找

export interface TimelineOpts {
  /** 路上总时长（秒），缺省按地点数 */
  travelSeconds?: number
  /** 每个点停留的秒数 */
  dwell?: number
}

/**
 * 时间轴：路程时间与距离的平方根成正比（长距离不至于太慢），每个点停留 dwell 秒；
 * jumps 为段间跳转处的里程（经过时多留一点时间，镜头从一处飞到另一处）；
 * weight(i)：第 i 段路（marks[i] → marks[i+1]）的时间权重（按直线估算的路段少占一些时间）
 */
function buildTimeline(reaches: number[], total: number, jumps: number[], opts: TimelineOpts, weight?: (i: number) => number) {
  const dwell = opts.dwell ?? DWELL
  const travelBudget = opts.travelSeconds ?? Math.min(70, Math.max(12, 8 + reaches.length * 1.8))
  const marks = [0, ...reaches, total]
  // 1 米以内算作原地（一站的路线、同一处的两站、垫出来的 1 米终点）：不分走路的时间
  const moves = (i: number) => marks[i + 1] - marks[i] > 1
  const gaps = marks.slice(1).map((m, i) => (moves(i) ? Math.sqrt(m - marks[i]) * (weight?.(i) ?? 1) : 0))
  const gapSum = gaps.reduce((a, b) => a + b, 0) || 1
  const crosses = (i: number) => jumps.some((b) => b > marks[i] && b <= marks[i + 1])
  const last = gaps.length - 1
  // 没有路程的一段：出发点就是第一站、两站在同一处时只留一点点时间；最后一站之后没有路时直接结束
  const travel = (i: number) =>
    (moves(i) ? Math.max(MIN_TRAVEL, (gaps[i] / gapSum) * travelBudget) : i === last && reaches.length ? 0 : 0.35) + (crosses(i) ? FLIGHT : 0)
  const timeline: RouteModel['timeline'] = [{ t: 0, d: 0 }]
  let t = 0.6
  timeline.push({ t, d: 0 })
  reaches.forEach((reach, i) => {
    t += travel(i)
    timeline.push({ t, d: reach, stop: i })
    t += dwell
    timeline.push({ t, d: reach, stop: i })
  })
  t += travel(gaps.length - 1)
  timeline.push({ t, d: total })
  return { timeline, duration: t }
}

/** 一段路线首尾坐标完全相同时，deck.gl 的 PathLayer / TripsLayer 会把它当成闭合环（多出顶点、首段失效、倒着出现）：把终点挪开约 1 cm */
function openPath(path: LngLat[]) {
  const head = path[0]
  const tail = path[path.length - 1]
  if (path.length >= 3 && head[0] === tail[0] && head[1] === tail[1]) path[path.length - 1] = [tail[0] + 1e-7, tail[1]]
}

/** 路线上 [a, b] 里程之间的路段中点 */
function legMid(model: Pick<RouteModel, 'coords' | 'cum'>, a: number, b: number) {
  return pointAt(model, (a + b) / 2)
}

/**
 * parts：按顺序排列的各段路线，段与段之间不连线、跳转不计里程（只有一段时与普通折线相同）
 * times：与 parts 一一对应的轨迹时间（毫秒时间戳），用于按到达时间对齐打卡点
 * legs：相邻两站之间路段的信息（出行方式等，与 stops 相邻两两对应），路线本身仍是 parts
 */
export function buildRoute(
  parts: LngLat[][],
  stops: ReplayStop[],
  opts: TimelineOpts & { times?: number[][]; legs?: (LegInfo | null)[] } = {},
): RouteModel {
  const times =
    opts.times && opts.times.length === parts.length && opts.times.every((t, k) => t.length === parts[k].length) ? opts.times : undefined
  // 去除重复点（时间同步保留），记下每段在 coords 里的起点
  const coords: LngLat[] = []
  const ts: number[] = []
  const starts: number[] = []
  parts.forEach((part, k) => {
    const s = coords.length
    part.forEach((p, i) => {
      const last = coords[coords.length - 1]
      if (coords.length === s || last[0] !== p[0] || last[1] !== p[1]) {
        coords.push(p)
        if (times) ts.push(times[k][i])
      }
    })
    if (coords.length > s) starts.push(s)
  })
  if (coords.length === 0 && stops.length) {
    coords.push([stops[0].lng, stops[0].lat])
    starts.push(0)
  }
  if (coords.length === 1) coords.push([coords[0][0] + 1e-6, coords[0][1] + 1e-6])
  if (!starts.length) starts.push(0)
  // 从酒店出发又回到同一家酒店时首尾相同：替换成新的坐标，不改原数组里的点（可能是 React Query 缓存里的数据）
  starts.forEach((s, k) => {
    const e = (k + 1 < starts.length ? starts[k + 1] : coords.length) - 1
    const head = coords[s]
    const tail = coords[e]
    if (e - s >= 2 && head[0] === tail[0] && head[1] === tail[1]) coords[e] = [tail[0] + 1e-7, tail[1]]
  })
  const isStart = new Set(starts)
  const cum = [0]
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + (isStart.has(i) ? JUMP : haversine(coords[i - 1], coords[i])))
  const total = Math.max(cum[cum.length - 1], 1)
  const segs = starts.map((s, k) => {
    const e = k + 1 < starts.length ? starts[k + 1] : coords.length
    return { path: coords.slice(s, e), timestamps: cum.slice(s, e) }
  })

  // 打卡点投影到路线上（从上一个点之后开始找，保证单调）：
  // 1. 有轨迹时间和到达时间时，在到达时刻前后的轨迹点里找最近的；
  // 2. 否则在剩余的整条路线里找：取与最近距离相差无几的最早一段，再沿路线走到这一段离打卡点最近的顶点，
  //    避免对到之后再次经过同一地方的轨迹上（那样会把后面的打卡点都挤到终点）
  const timed = !!times && ts.length === coords.length
  let from = 0
  const placed: PlacedStop[] = stops.map((s, index) => {
    const target: LngLat = [s.lng, s.lat]
    let best = -1
    if (timed && s.t != null) {
      let bestD = Infinity
      for (let i = from; i < coords.length; i++) {
        if (Math.abs(ts[i] - s.t) > TIME_WINDOW_MS) continue
        const d = haversine(coords[i], target)
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (bestD > TIME_MAX_SNAP_M) best = -1
    }
    if (best < 0) {
      const ds = coords.slice(from).map((c) => haversine(c, target))
      const dmin = ds.reduce((a, b) => Math.min(a, b), Infinity)
      let j = ds.findIndex((d) => d <= dmin + Math.max(30, dmin * 0.2))
      while (j + 1 < ds.length && ds[j + 1] < ds[j]) j++
      best = from + j
    }
    from = best
    return { ...s, index, reach: cum[best] }
  })

  const legs: ReplayLeg[] = []
  if (opts.legs)
    placed.forEach((b, i) => {
      const a = placed[i - 1]
      const info = opts.legs?.[i - 1]
      // 轨迹上两站之间的里程就是这段路（不计段间跳转）
      if (!a || !info || b.reach - a.reach < 1) return
      legs.push({ ...info, distance_m: b.reach - a.reach, from: i - 1, to: i, start: a.reach, end: b.reach, mid: legMid({ coords, cum }, a.reach, b.reach) })
    })

  const jumps = segs.slice(1).map((p) => p.timestamps[0])
  const { timeline, duration } = buildTimeline(
    placed.map((s) => s.reach),
    total,
    jumps,
    opts,
  )
  return { coords, cum, total, parts: segs, trails: segs.map((s) => ({ ...s, estimated: false })), stops: placed, legs, timeline, duration }
}

/**
 * 沿真实路线（GET /trips/:id/legs 的 polyline）的回放：legs[i] 是 stops[i] → stops[i+1] 的一段。
 * 每一站正好落在路段的交界处（不需要按距离投影），轨迹按路段切开，估算的路段（两点直线）单独着色
 */
export function buildLegRoute(stops: ReplayStop[], legs: LegInput[], opts: TimelineOpts = {}): RouteModel {
  const coords: LngLat[] = []
  const cum: number[] = []
  const push = (p: LngLat) => {
    const last = coords[coords.length - 1]
    if (last && last[0] === p[0] && last[1] === p[1]) return
    cum.push(last ? cum[cum.length - 1] + haversine(last, p) : 0)
    coords.push(p)
  }
  if (stops.length) push([stops[0].lng, stops[0].lat])
  const reaches: number[] = stops.length ? [0] : []
  const ranges: [number, number][] = []
  for (let i = 1; i < stops.length; i++) {
    const leg = legs[i - 1]
    const a = coords.length - 1
    // 折线的首尾就是两站的坐标（5 位小数）：中间的顶点照用，首尾换成打卡点本身的坐标
    const path = leg?.path ?? []
    for (let k = 1; k < path.length - 1; k++) push(path[k])
    push([stops[i].lng, stops[i].lat])
    ranges.push([a, coords.length - 1])
    reaches.push(cum[cum.length - 1])
  }
  if (!coords.length) coords.push([0, 0])
  if (coords.length === 1) {
    coords.push([coords[0][0] + 1e-6, coords[0][1] + 1e-6])
    cum.length = 0
    cum.push(0, 0)
  }
  const total = Math.max(cum[cum.length - 1], 1)
  const whole = { path: coords.slice(), timestamps: cum.slice() }
  openPath(whole.path)

  const placed: PlacedStop[] = stops.map((s, index) => ({ ...s, index, reach: reaches[index] ?? 0 }))
  const trails: TrailPart[] = []
  const out: ReplayLeg[] = []
  ranges.forEach(([a, b], i) => {
    const leg = legs[i]
    if (b <= a) return // 两站在同一个地方
    const estimated = !!leg?.estimated
    const start = cum[a]
    const end = cum[b]
    if (estimated) {
      // 估算的路段是两点直线：画成虚线（与行程页的点线一致），不像一条真实的路；每一短划各自带里程，走到时才出现
      const n = Math.max(4, Math.min(DASHES, Math.round((end - start) / 12)))
      const step = (end - start) / n
      for (let k = 0; k < n; k++) {
        const s0 = start + step * k
        const s1 = s0 + step * 0.55
        trails.push({ path: [pointAt({ coords, cum }, s0), pointAt({ coords, cum }, s1)], timestamps: [s0, s1], estimated })
      }
    } else {
      const path = coords.slice(a, b + 1)
      openPath(path)
      trails.push({ path, timestamps: cum.slice(a, b + 1), estimated })
    }
    out.push({
      mode: leg?.mode ?? null,
      recommended: leg?.recommended ?? null,
      distance_m: leg?.distance_m ?? end - start,
      duration_s: leg?.duration_s ?? 0,
      estimated,
      transfer: leg?.transfer,
      from: i,
      to: i + 1,
      start,
      end,
      mid: legMid({ coords, cum }, start, end),
    })
  })
  if (!trails.length) trails.push({ ...whole, estimated: false })
  // 时间轴的第 i 段是 marks[i] → marks[i+1]（marks = [0, ...reaches, total]）：第 i 段对应 legs[i - 1]
  const { timeline, duration } = buildTimeline(reaches, total, [], opts, (i) => (legs[i - 1]?.estimated ? ESTIMATED_WEIGHT : 1))
  return { coords, cum, total, parts: [whole], trails, stops: placed, legs: out, timeline, duration }
}

const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2)

/** 时间 → 里程，以及当前停留的打卡点 */
export function distanceAt(model: RouteModel, time: number): { d: number; stop: number | null } {
  const tl = model.timeline
  if (time <= 0) return { d: 0, stop: null }
  for (let i = 1; i < tl.length; i++) {
    const a = tl[i - 1]
    const b = tl[i]
    if (time <= b.t) {
      if (a.d === b.d) return { d: a.d, stop: a.stop ?? null }
      const k = ease((time - a.t) / (b.t - a.t || 1))
      return { d: a.d + (b.d - a.d) * k, stop: null }
    }
  }
  return { d: model.total, stop: null }
}

/** 正在走的路段（停在某一站时为 null） */
export function legAt(model: RouteModel, d: number, stop: number | null): ReplayLeg | null {
  if (stop != null) return null
  return model.legs.find((l) => d > l.start && d < l.end) ?? null
}

/** 只有一个点（或几站在同一处）的路线：为了能画出来垫了 1 米，实际没有路程 */
const noRoute = (model: RouteModel) => !model.legs.length && model.total <= 1

/**
 * 已经走过的路程（米）：有路段信息时按路段的路程（道路 / 估算的里程）累计，与结束时的「里程」一致（跨天的转场不算）；
 * 否则就是沿路线的几何长度
 */
export function travelledAt(model: RouteModel, d: number) {
  if (noRoute(model)) return 0
  if (!model.legs.length) return d
  let sum = 0
  for (const l of model.legs) {
    if (l.transfer) continue
    if (d >= l.end) sum += l.distance_m
    else if (d > l.start) sum += (l.distance_m * (d - l.start)) / (l.end - l.start || 1)
  }
  return sum
}

/** 全程的路程（米）：同 travelledAt */
export function routeLength(model: RouteModel) {
  if (noRoute(model)) return 0
  return model.legs.length ? model.legs.reduce((a, l) => a + (l.transfer ? 0 : l.distance_m), 0) : model.total
}

/** 里程 → 坐标 */
export function pointAt(model: Pick<RouteModel, 'coords' | 'cum'>, d: number): LngLat {
  const { coords, cum } = model
  if (d <= 0) return coords[0]
  if (d >= cum[cum.length - 1]) return coords[coords.length - 1]
  let lo = 0
  let hi = cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] < d) lo = mid
    else hi = mid
  }
  const k = (d - cum[lo]) / (cum[hi] - cum[lo] || 1)
  return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * k, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * k]
}

/** 第一个里程 ≥ d 的顶点 */
function vertexAt(cum: number[], d: number) {
  let i = 0
  let j = cum.length
  while (i < j) {
    const mid = (i + j) >> 1
    if (cum[mid] < d) i = mid + 1
    else j = mid
  }
  return i
}

/** 当前路段（上一个点 → 下一个点）的包围盒，用于自适应缩放 */
export function legBounds(model: RouteModel, d: number): [LngLat, LngLat] {
  const reaches = [0, ...model.stops.map((s) => s.reach), model.total]
  let a = 0
  let b = model.total
  for (let i = 1; i < reaches.length; i++) {
    if (d <= reaches[i]) {
      a = reaches[i - 1]
      b = reaches[i]
      break
    }
  }
  if (b - a < 300) {
    // 只在两端所在的分段内扩展：否则挨着段间跳转的短路段会把镜头拉远到能同时看到两段
    const range = (x: number) => model.parts.find((p) => x >= p.timestamps[0] && x <= p.timestamps[p.timestamps.length - 1])?.timestamps
    const ra = range(a)
    const rb = range(b)
    a = Math.max(ra ? ra[0] : 0, a - 300)
    b = Math.min(rb ? rb[rb.length - 1] : model.total, b + 300)
  }
  // 两端 + 中间的全部顶点（真实道路的弯路也框进去）
  const pts: LngLat[] = [pointAt(model, a), pointAt(model, b)]
  const i0 = vertexAt(model.cum, a)
  const i1 = vertexAt(model.cum, b)
  const step = Math.max(1, Math.floor((i1 - i0) / 400))
  for (let i = i0; i < i1; i += step) pts.push(model.coords[i])
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of pts) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return [
    [minX, minY],
    [maxX, maxY],
  ]
}

export function angleLerp(a: number, b: number, k: number) {
  const diff = ((((b - a) % 360) + 540) % 360) - 180
  return a + diff * k
}

/** 分段内里程 x 处的坐标（x 在这一段的里程范围内） */
function partPoint(p: RouteModel['parts'][number], x: number): LngLat {
  const ts = p.timestamps
  let lo = 0
  let hi = ts.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ts[mid] < x) lo = mid
    else hi = mid
  }
  const k = Math.max(0, Math.min(1, (x - ts[lo]) / (ts[hi] - ts[lo] || 1)))
  return [p.path[lo][0] + (p.path[hi][0] - p.path[lo][0]) * k, p.path[lo][1] + (p.path[hi][1] - p.path[lo][1]) * k]
}

/** 路线上里程 a → b 之间的一段；跨过分段（两次记录、两段旅程之间）时断开，返回多条折线 */
export function slicePath(model: RouteModel, a: number, b: number): LngLat[][] {
  const out: LngLat[][] = []
  if (b <= a) return out
  for (const p of model.parts) {
    const ts = p.timestamps
    if (ts.length < 2 || ts[ts.length - 1] <= a || ts[0] >= b) continue
    const lo = Math.max(a, ts[0])
    const hi = Math.min(b, ts[ts.length - 1])
    const seg: LngLat[] = [partPoint(p, lo)]
    // 第一个里程大于 lo 的顶点
    let i = 0
    let j = ts.length
    while (i < j) {
      const mid = (i + j) >> 1
      if (ts[mid] <= lo) i = mid + 1
      else j = mid
    }
    for (; i < ts.length && ts[i] < hi; i++) seg.push(p.path[i])
    seg.push(partPoint(p, hi))
    out.push(seg)
  }
  return out
}
