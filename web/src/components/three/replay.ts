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
  stops: PlacedStop[]
  /** 时间轴：[时间(秒), 里程(米)] 的分段线性映射 */
  timeline: { t: number; d: number; stop?: number }[]
  duration: number
}

const DWELL = 1.6 // 每个打卡点停留秒数

export function buildRoute(path: LngLat[], stops: ReplayStop[], opts: { travelSeconds?: number } = {}): RouteModel {
  // 去除重复点
  const coords: LngLat[] = []
  for (const p of path) {
    const last = coords[coords.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) coords.push(p)
  }
  if (coords.length === 0 && stops.length) coords.push([stops[0].lng, stops[0].lat])
  if (coords.length === 1) coords.push([coords[0][0] + 1e-6, coords[0][1] + 1e-6])
  const cum = [0]
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]))
  const total = Math.max(cum[cum.length - 1], 1)

  // 打卡点投影到路线上（从上一个点之后开始找最近的顶点，保证单调）
  let from = 0
  const placed: PlacedStop[] = stops.map((s, index) => {
    let best = from
    let bestD = Infinity
    const lookahead = Math.min(coords.length, from + Math.max(400, Math.ceil(coords.length / 2)))
    for (let i = from; i < lookahead; i++) {
      const d = haversine(coords[i], [s.lng, s.lat])
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    from = best
    return { ...s, index, reach: cum[best] }
  })

  // 时间轴：路程时间与距离的平方根成正比（长距离不至于太慢），每个点停留 DWELL 秒
  const travelBudget = opts.travelSeconds ?? Math.min(70, Math.max(12, 8 + placed.length * 1.8))
  const marks = [0, ...placed.map((s) => s.reach), total]
  const gaps = marks.slice(1).map((m, i) => Math.sqrt(Math.max(0, m - marks[i])))
  const gapSum = gaps.reduce((a, b) => a + b, 0) || 1
  const timeline: RouteModel['timeline'] = [{ t: 0, d: 0 }]
  let t = 0.6
  timeline.push({ t, d: 0 })
  placed.forEach((s, i) => {
    t += Math.max(0.35, (gaps[i] / gapSum) * travelBudget)
    timeline.push({ t, d: s.reach, stop: i })
    t += DWELL
    timeline.push({ t, d: s.reach, stop: i })
  })
  t += Math.max(0.35, (gaps[gaps.length - 1] / gapSum) * travelBudget)
  timeline.push({ t, d: total })
  return { coords, cum, total, stops: placed, timeline, duration: t }
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
    a = Math.max(0, a - 300)
    b = Math.min(model.total, b + 300)
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
