// 3D 回放的路线模型：把路线点、打卡点、停留时间换算成统一的时间轴
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
}

export interface PlacedStop extends ReplayStop {
  /** 沿路线到达该点时的里程（米） */
  reach: number
  index: number
}

export interface RouteModel {
  coords: LngLat[]
  cum: number[]
  total: number
  /** 分段路线（两次记录之间、同行成员各自的轨迹、不同旅程之间不连线）；timestamps 为沿路线的里程（米） */
  parts: { path: LngLat[]; timestamps: number[] }[]
  stops: PlacedStop[]
  /** 时间轴：[时间(秒), 里程(米)] 的分段线性映射 */
  timeline: { t: number; d: number; stop?: number }[]
  duration: number
}

const DWELL = 1.6 // 每个打卡点停留秒数
const JUMP = 1 // 段间跳转只记 1 米：不连线、不计里程
const FLIGHT = 1.5 // 跨段时镜头飞行秒数
const TIME_WINDOW_MS = 15 * 60_000 // 按到达时间对齐：只看到达时刻前后 15 分钟的轨迹点
const TIME_MAX_SNAP_M = 500 // 时间窗口内最近的轨迹点也超过这个距离时，改为按位置找

/**
 * parts：按顺序排列的各段路线，段与段之间不连线、跳转不计里程（只有一段时与普通折线相同）
 * times：与 parts 一一对应的轨迹时间（毫秒时间戳），用于按到达时间对齐打卡点
 */
export function buildRoute(
  parts: LngLat[][],
  stops: ReplayStop[],
  opts: { travelSeconds?: number; times?: number[][] } = {},
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
  // 一段路线首尾坐标完全相同（如从酒店出发又回到同一家酒店）时，deck.gl 的 PathLayer / TripsLayer 会把它当成闭合环：
  // 多出 2 个顶点、首段失效，与逐点的 timestamps 对不上，第一段会倒着出现。把终点挪开约 1 cm，保持开放路径。
  // 替换成新的坐标，不改原数组里的点（可能是 React Query 缓存里的数据）
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

  // 时间轴：路程时间与距离的平方根成正比（长距离不至于太慢），每个点停留 DWELL 秒
  const travelBudget = opts.travelSeconds ?? Math.min(70, Math.max(12, 8 + placed.length * 1.8))
  const marks = [0, ...placed.map((s) => s.reach), total]
  const gaps = marks.slice(1).map((m, i) => Math.sqrt(Math.max(0, m - marks[i])))
  const gapSum = gaps.reduce((a, b) => a + b, 0) || 1
  // 经过段与段之间的跳转时多留一点时间，镜头从一处飞到另一处
  const bounds = segs.slice(1).map((p) => p.timestamps[0])
  const crosses = (i: number) => bounds.some((b) => b > marks[i] && b <= marks[i + 1])
  const timeline: RouteModel['timeline'] = [{ t: 0, d: 0 }]
  let t = 0.6
  timeline.push({ t, d: 0 })
  placed.forEach((s, i) => {
    t += Math.max(0.35, (gaps[i] / gapSum) * travelBudget) + (crosses(i) ? FLIGHT : 0)
    timeline.push({ t, d: s.reach, stop: i })
    t += DWELL
    timeline.push({ t, d: s.reach, stop: i })
  })
  t += Math.max(0.35, (gaps[gaps.length - 1] / gapSum) * travelBudget) + (crosses(gaps.length - 1) ? FLIGHT : 0)
  timeline.push({ t, d: total })
  return { coords, cum, total, parts: segs, stops: placed, timeline, duration: t }
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

/** 里程 → 坐标 */
export function pointAt(model: RouteModel, d: number): LngLat {
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
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const steps = 12
  for (let i = 0; i <= steps; i++) {
    const [x, y] = pointAt(model, a + ((b - a) * i) / steps)
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
