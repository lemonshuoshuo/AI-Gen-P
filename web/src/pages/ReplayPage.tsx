import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArcLayer, ColumnLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers'
import { TripsLayer } from '@deck.gl/geo-layers'
import type { Map as MLMap } from 'maplibre-gl'
import { Pause, PenLine, Play, RotateCcw, Share2, X } from 'lucide-react'
import { api, isNotFound, type Footprints, type TrackData, type TripDetail } from '@/api'
import { rememberedShareCode } from '@/api/client'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { RouteLines } from '@/components/map/layers'
import { useDeckOverlay } from '@/components/three/deck'
import { angleLerp, buildRoute, distanceAt, legBounds, pointAt, slicePath, type PlacedStop, type ReplayStop, type RouteModel } from '@/components/three/replay'
import { ShareDialog } from '@/components/trip/ShareDialog'
import { Avatar, Button, Empty, LoadError, PageLoader, VerdictBadge, buttonClass } from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { dateRange, fmtDate } from '@/lib/format'
import { bearing, formatKm } from '@/lib/geo'
import { categoryOf } from '@/lib/meta'
import { bySeq, plannedPath, replayTrackParts, visitedInOrder } from '@/lib/trip'
import { useAuth } from '@/stores/auth'

type LngLat = [number, number]
type RGB = [number, number, number]
type Theme = 'sunset' | 'love'

interface SceneProps {
  model: RouteModel
  time: number
  playing: boolean
  theme: Theme
  arcs?: { from: LngLat; to: LngLat }[]
  /** 开场镜头：先看全程，停一会儿再飞到第一站 */
  intro: boolean
  onIntroDone: () => void
  /** 全程镜头的瓦片加载好了，可以揭开画面 */
  onShown: () => void
}

const CAMERA_SIDE_ANGLE = 22
// 回放的夜色底图完全去色：公园、绿地和道路标牌不再是橄榄绿 / 青色的色块
// 同时略微压暗文字和整体不透明度，让画面沉进夜色里，字幕和轨迹更突出
const REPLAY_TONE = { 'raster-saturation': -1, 'raster-contrast': -0.04, 'raster-brightness-min': 0.74, 'raster-opacity': 0.86 }
const FOLLOW_PITCH = 60
const OVERVIEW_PITCH = 45
const INTRO_HOLD = 1200 // 全程镜头停留（毫秒）

// 一帧画面只有一种强调色：夜色里轨迹、彗星头、当前地点的光柱都是金色（情侣空间为玫瑰色），
// 其余光柱是中性的石色，不再按分类着色
const THEMES: Record<Theme, { glow: RGB; trail: RGB; head: RGB; core: RGB; column: RGB; current: RGB; arc: RGB }> = {
  sunset: {
    glow: [201, 168, 104],
    trail: [218, 190, 128],
    head: [238, 206, 138],
    core: [255, 244, 222],
    column: [178, 171, 158],
    current: [226, 194, 122],
    arc: [201, 168, 104],
  },
  love: {
    glow: [210, 161, 171],
    trail: [228, 190, 200],
    head: [236, 178, 192],
    core: [255, 238, 242],
    column: [178, 171, 158],
    current: [213, 143, 159],
    arc: [210, 161, 171],
  },
}

// 前方路线的淡线：从彗星头往前到下一站，离得越远越淡（分几段画出渐隐）
const GHOST_STEPS = [64, 50, 36, 22, 10]

/** 等当前画面的瓦片加载完（最多 max 毫秒）再继续：开场不露出还没加载的黑块 */
function whenTilesLoaded(map: MLMap, max: number, cb: () => void) {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    window.clearTimeout(t)
    map.off('idle', finish)
    cb()
  }
  const t = window.setTimeout(finish, max)
  map.on('idle', finish)
  return () => {
    done = true
    window.clearTimeout(t)
    map.off('idle', finish)
  }
}

/** 跟随镜头：以轨迹前端为中心，按当前路段自适应缩放；画面下方留出卡片位置 */
function followView(map: MLMap, model: RouteModel, d: number, cache: Map<string, number>) {
  const head = pointAt(model, d)
  const ahead = pointAt(model, Math.min(model.total, d + Math.max(60, model.total * 0.01)))
  const behind = pointAt(model, Math.max(0, d - Math.max(30, model.total * 0.005)))
  const b = legBounds(model, d)
  const el = map.getContainer()
  const w = el.clientWidth
  const h = el.clientHeight
  // 缓存按画面尺寸区分：旋转屏幕后重新计算
  const key = `${w}x${h}|${b[0].join()}|${b[1].join()}`
  let zoom = cache.get(key)
  if (zoom == null) {
    // jumpTo 设置的 bottom=h*0.2 会被 cameraForBounds 再叠加一次：扣掉它，留给路段的高度始终约为 0.42h（不会变成负数）
    const tp = map.getPadding()
    const side = Math.min(60, w * 0.1)
    const fit = map.cameraForBounds(b, {
      padding: { top: h * 0.14, bottom: Math.max(0, h * 0.44 - (tp.bottom ?? 0)), left: side, right: side },
    })
    zoom = Math.min(16.2, Math.max(3.5, (fit?.zoom ?? 12) - 0.2))
    cache.set(key, zoom)
  }
  return { head, ahead, behind, zoom, padding: { top: 0, bottom: h * 0.2, left: 0, right: 0 } }
}

/** 全程镜头：框住整条路线（一座城市内的旅程停在城市 / 街道级，不会拉到全国） */
function overviewView(map: MLMap, model: RouteModel) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of [...model.coords, ...model.stops.map((s) => [s.lng, s.lat] as LngLat)]) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const el = map.getContainer()
  const w = el.clientWidth
  const h = el.clientHeight
  const side = Math.min(72, w * 0.12)
  const fit = map.cameraForBounds(
    [
      [minX, minY],
      [maxX, maxY],
    ],
    { padding: { top: h * 0.2, bottom: h * 0.26, left: side, right: side }, maxZoom: 15.5, pitch: 0, bearing: 0 },
  )
  const c = fit?.center as { lng: number; lat: number } | undefined
  return {
    center: (c ? [c.lng, c.lat] : [(minX + maxX) / 2, (minY + maxY) / 2]) as LngLat,
    // 倾斜后画面下半部分会放大：略微退后，保证整条路线都在画面里
    zoom: Math.max(2.5, (fit?.zoom ?? 12) - 0.35),
    pitch: OVERVIEW_PITCH,
    bearing: -12,
    padding: { top: 0, bottom: 0, left: 0, right: 0 },
  }
}

/** 淡线的数据：开场时是整条路线，之后是前方到下一站（最多约一个路段长）的几段、透明度逐段递减 */
function ghostPaths(model: RouteModel, d: number, stop: number | null, intro: boolean, maxLen: number) {
  if (intro) return model.parts.map((p) => ({ path: p.path, a: GHOST_STEPS[0] - 8 }))
  if (d >= model.total) return []
  const reaches = model.stops.map((s) => s.reach)
  const next = reaches.find((r) => r > d + 1) ?? model.total
  const prev = [...reaches].reverse().find((r) => r <= d + 1) ?? 0
  // 停在某一站时镜头框的是刚走过的路段：前方的淡线也只画这么长
  const leg = stop != null ? prev - ([...reaches].reverse().find((r) => r < prev - 1) ?? 0) : next - prev
  // 也不超过大约一屏的距离：镜头还没拉远时，长路段的淡线不会一直伸到画面顶端
  const end = Math.min(next, d + Math.min(maxLen, Math.max(300, leg)))
  const n = GHOST_STEPS.length
  return GHOST_STEPS.flatMap((a, i) => slicePath(model, d + ((end - d) * i) / n, d + ((end - d) * (i + 1)) / n).map((path) => ({ path, a })))
}

function ReplayScene({ model, time, playing, theme, arcs, intro, onIntroDone, onShown }: SceneProps) {
  const map = useMap()
  const overlay = useDeckOverlay()
  const cam = useRef({ bearing: 0, zoom: 0, init: false, d: -1, last: 0 })
  const zoomCache = useRef(new Map<string, number>())
  const introDone = useRef(onIntroDone)
  introDone.current = onIntroDone
  const shownCb = useRef(onShown)
  shownCb.current = onShown
  const shownOnce = useRef(false)
  // 画面已经揭开（第一次全程镜头的瓦片加载完）
  const revealed = useRef(false)

  const { d, stop } = distanceAt(model, time)
  // 已到达的打卡点：buildRoute 保证 reach 单调不减，已到达的一定是前缀。
  // 只在到达新地点时才换一个数组（deck.gl 按引用比较 data，每帧新数组会让图层每帧重建全部属性）
  let reachedCount = 0
  while (reachedCount < model.stops.length && model.stops[reachedCount].reach <= d + 1) reachedCount++
  const reached = useMemo(() => model.stops.slice(0, reachedCount), [model, reachedCount])

  // 开场：全程俯瞰（倾斜约 45°）→ 瓦片加载完后揭开画面 → 停留 1.2 秒 → 飞到第一站，那里的瓦片加载完再开始播放
  useEffect(() => {
    if (!map || !intro) return
    const ov = overviewView(map, model)
    const first = !shownOnce.current
    shownOnce.current = true
    if (first) map.jumpTo(ov)
    else map.easeTo({ ...ov, duration: 1100 })
    let done = false
    let t = 0
    let cancelWait = () => {}
    const finish = () => {
      if (done) return
      done = true
      introDone.current()
    }
    const onArrive = () => {
      cancelWait = whenTilesLoaded(map, 2500, finish)
    }
    const fly = () => {
      const f = followView(map, model, 0, zoomCache.current)
      const moving = f.ahead[0] !== f.behind[0] || f.ahead[1] !== f.behind[1]
      const brg = moving ? bearing(f.behind, f.ahead) + CAMERA_SIDE_ANGLE : 0
      const c = cam.current
      c.zoom = f.zoom
      c.bearing = brg
      c.init = true
      c.d = 0
      c.last = 0
      map.once('moveend', onArrive)
      map.flyTo({
        center: f.head,
        zoom: f.zoom,
        bearing: brg,
        pitch: FOLLOW_PITCH,
        padding: f.padding,
        // 不许飞行弧线拉得比全程镜头还远（一座城市内的旅程不会先拉到全国）
        minZoom: Math.min(ov.zoom, f.zoom),
        speed: 0.9,
        curve: 1.3,
        maxDuration: 3200,
        essential: true,
      })
    }
    const hold = () => {
      t = window.setTimeout(fly, INTRO_HOLD + (first ? 0 : 1100))
    }
    if (revealed.current) hold()
    else
      cancelWait = whenTilesLoaded(map, 5000, () => {
        revealed.current = true
        shownCb.current()
        hold()
      })
    return () => {
      window.clearTimeout(t)
      cancelWait()
      map.off('moveend', onArrive)
      if (!done) map.stop()
    }
  }, [map, model, intro])

  // 相机：跟随轨迹前端，按路段长度自适应缩放，停留时缓慢环绕
  useEffect(() => {
    if (!map || intro) return
    const c = cam.current
    // 暂停时只在进度变化（拖动进度条）时移动镜头；刚按暂停时不动，方便用户自由查看
    if (!playing && c.init && c.d === d) return
    c.d = d
    const now = performance.now()
    const dt = playing && c.last ? Math.min(0.05, (now - c.last) / 1000) : 0
    c.last = playing ? now : 0
    const f = followView(map, model, d, zoomCache.current)
    const moving = stop == null && (f.ahead[0] !== f.behind[0] || f.ahead[1] !== f.behind[1])
    if (!c.init || !playing) {
      c.zoom = f.zoom // 首帧 / 暂停时拖动进度条：直接到位，不缓动
      if (!c.init) c.bearing = moving ? bearing(f.behind, f.ahead) + CAMERA_SIDE_ANGLE : 0
      c.init = true
    } else {
      const k = 1 - 0.96 ** (dt * 60) // 与刷新率无关，60Hz 时等同每帧 0.04
      c.zoom += (f.zoom - c.zoom) * k
      // 镜头从侧后方跟随（偏转一定角度），避免轨迹与光柱在画面上重叠
      c.bearing = moving ? angleLerp(c.bearing, bearing(f.behind, f.ahead) + CAMERA_SIDE_ANGLE, k) : c.bearing + 7.2 * dt
    }
    map.jumpTo({ center: f.head, zoom: c.zoom, bearing: c.bearing, pitch: FOLLOW_PITCH, padding: f.padding })
  }, [map, model, d, stop, playing, intro])

  // deck.gl 图层
  useEffect(() => {
    const o = overlay.current
    if (!o || !map) return
    const t = THEMES[theme]
    const zoom = map.getZoom()
    const radius = Math.max(6, 12 * 2 ** (15 - zoom))
    // 各段分开画（段与段之间不连线）；引用不变，deck.gl 不必每帧重建路径数据
    const trips = model.parts
    const head = pointAt(model, d)
    const showHead = time > 0 && d < model.total
    // 一屏高度大约对应的地面距离（米）
    const c = map.getCenter()
    const screenM = ((156543.03 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** zoom) * map.getContainer().clientHeight
    const ghost = ghostPaths(model, d, stop, intro, screenM * 0.6)
    o.setProps({
      layers: [
        ...(arcs?.length
          ? [
              new ArcLayer<{ from: LngLat; to: LngLat }>({
                id: 'arcs',
                data: arcs,
                getSourcePosition: (a) => a.from,
                getTargetPosition: (a) => a.to,
                getSourceColor: [...t.arc, 90],
                getTargetColor: [...t.arc, 150],
                getWidth: 1.25,
                getHeight: 0.6,
                greatCircle: false,
              }),
            ]
          : []),
        // 路线的淡线：开场俯瞰时画整条路线（看出形状）；跟随时只画前方到下一站的一小段，越远越淡，不会一直伸到天边
        new PathLayer<{ path: LngLat[]; a: number }>({
          id: 'ghost',
          data: ghost,
          getPath: (x) => x.path,
          getColor: (x) => [...t.trail, x.a],
          widthUnits: 'pixels',
          getWidth: 1.25,
          capRounded: true,
          jointRounded: true,
        }),
        new TripsLayer({
          id: 'trail-glow',
          data: trips,
          getPath: (x) => x.path,
          getTimestamps: (x) => x.timestamps,
          getColor: [...t.glow, 55],
          widthMinPixels: 14,
          capRounded: true,
          jointRounded: true,
          fadeTrail: false,
          trailLength: model.total + 1,
          currentTime: d,
        }),
        new TripsLayer({
          id: 'trail',
          data: trips,
          getPath: (x) => x.path,
          getTimestamps: (x) => x.timestamps,
          getColor: [...t.trail, 255],
          widthMinPixels: 3.5,
          capRounded: true,
          jointRounded: true,
          fadeTrail: false,
          trailLength: model.total + 1,
          currentTime: d,
        }),
        new TripsLayer({
          id: 'comet',
          data: trips,
          getPath: (x) => x.path,
          getTimestamps: (x) => x.timestamps,
          getColor: [...t.head, 255],
          widthMinPixels: 6,
          capRounded: true,
          fadeTrail: true,
          trailLength: Math.max(80, model.total * 0.035),
          currentTime: d,
        }),
        new ScatterplotLayer<PlacedStop>({
          id: 'stop-rings',
          data: reached,
          getPosition: (s) => [s.lng, s.lat],
          getRadius: radius * 2.2,
          getFillColor: [...t.column, 26],
          getLineColor: (s) => (stop === s.index ? [...t.current, 200] : [...t.column, 130]),
          stroked: true,
          lineWidthMinPixels: 1,
          radiusMinPixels: 6,
          updateTriggers: { getRadius: [radius], getLineColor: [stop, theme] },
        }),
        new ColumnLayer<PlacedStop>({
          id: 'stop-columns',
          data: reached,
          diskResolution: 24,
          radius,
          extruded: true,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: (s) => (stop === s.index ? [...t.current, 245] : [...t.column, 225]),
          getElevation: (s) => {
            const k = Math.min(1, (d - s.reach) / Math.max(1, model.total * 0.02) + (stop != null && s.index <= stop ? 1 : 0))
            return radius * 7 * (0.15 + 0.85 * Math.min(1, k))
          },
          material: { ambient: 0.62, diffuse: 0.55, shininess: 32 },
          updateTriggers: { getElevation: [d, stop, radius], getFillColor: [stop, theme] },
        }),
        // 彗星头：金色光晕 + 象牙白内核
        new ScatterplotLayer<LngLat>({
          id: 'head',
          data: showHead ? [head] : [],
          getPosition: (p) => p,
          radiusUnits: 'pixels',
          getRadius: 15,
          getFillColor: [...t.head, 60],
          stroked: false,
        }),
        new ScatterplotLayer<LngLat>({
          id: 'head-core',
          data: showHead ? [head] : [],
          getPosition: (p) => p,
          radiusUnits: 'pixels',
          getRadius: 4.5,
          getFillColor: [...t.core, 255],
          getLineColor: [...t.head, 255],
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          stroked: true,
        }),
      ],
    })
  }, [overlay, map, model, d, stop, theme, arcs, reached, time, intro])

  return null
}

/* ---------------- 数据 → 回放模型 ---------------- */
/**
 * plan：路线预览（规划时用）——始终按计划地点的顺序（seq）连线，不看打卡和 GPS 轨迹
 */
function tripToReplay(trip: TripDetail, trackData: TrackData | undefined, compare: boolean, plan: boolean) {
  const planned = trip.waypoints.filter((w) => w.planned).sort(bySeq)
  const visited = plan ? [] : visitedInOrder(trip.waypoints)
  const list = plan ? planned : visited.length ? visited : planned
  const photoBy = new Map<number, string>()
  trip.photos.forEach((p) => p.waypoint_id && !photoBy.has(p.waypoint_id) && photoBy.set(p.waypoint_id, p.thumb_url || p.url))
  // 轨迹按记录分段（两次记录之间、同行成员各自的轨迹不连线）；带上时间，打卡点按到达时间对齐到轨迹
  const track = plan ? [] : replayTrackParts(trackData)
  const parts = track.length ? track.map((s) => s.path) : [list.map((w) => [w.lng, w.lat] as LngLat)]
  const times = track.length ? track.map((s) => s.times) : undefined
  const stops: ReplayStop[] = list.map((w) => ({
    key: String(w.id),
    lng: w.lng,
    lat: w.lat,
    name: w.name,
    color: categoryOf(w.category).color,
    sub: [w.city, w.district].filter(Boolean).join(' · '),
    note: w.note,
    photo: photoBy.get(w.id),
    verdict: plan ? undefined : w.verdict,
    tag: w.day ? `第 ${w.day} 天` : undefined,
    t: !plan && w.arrived_at ? Date.parse(w.arrived_at) : undefined,
  }))
  return { model: buildRoute(parts, stops, { times }), planned: compare && !plan ? plannedPath(trip.waypoints) : undefined }
}

function footprintsToReplay(fp: Footprints) {
  const trips = [...fp.trips].filter((t) => t.path.length).sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))
  // 每段旅程单独成段：旅程之间只画弧线，不在地面上连线，也不计入里程
  const parts: LngLat[][] = []
  const stops: ReplayStop[] = []
  const arcs: { from: LngLat; to: LngLat }[] = []
  let prevEnd: LngLat | null = null
  for (const t of trips) {
    if (prevEnd) arcs.push({ from: prevEnd, to: t.path[0] })
    const pts = fp.points.filter((p) => p.trip_id === t.id)
    parts.push(t.path)
    t.path.forEach((c, i) => {
      const pt = pts.find((p) => Math.abs(p.lng - c[0]) < 1e-5 && Math.abs(p.lat - c[1]) < 1e-5)
      stops.push({
        key: `${t.id}-${i}`,
        lng: c[0],
        lat: c[1],
        name: pt?.name ?? t.title,
        color: pt ? categoryOf(pt.category).color : '#9d4a5f',
        sub: pt ? [pt.city, fmtDate(pt.date)].filter(Boolean).join(' · ') : undefined,
        tag: t.title,
        photo: pt?.photo_thumb_url || (i === 0 ? t.cover_thumb_url || t.cover_url || undefined : undefined),
        verdict: pt?.verdict,
      })
    })
    prevEnd = t.path[t.path.length - 1]
  }
  // 足迹太多时抽稀停留点，保证回放节奏
  const maxStops = 60
  const step = Math.ceil(stops.length / maxStops)
  const sparse = step > 1 ? stops.filter((_, i) => i % step === 0) : stops
  return { model: buildRoute(parts, sparse), arcs }
}

/* ---------------- 进度条：细线轨道 + 每一站的刻度 ---------------- */
function Scrubber({
  model,
  time,
  onSeek,
  reached,
  love,
}: {
  model: RouteModel
  time: number
  onSeek: (t: number) => void
  reached: number
  love: boolean
}) {
  const ticks = useMemo(() => {
    const seen = new Set<number>()
    return model.timeline.filter((x) => x.stop != null && !seen.has(x.stop) && seen.add(x.stop)).map((x) => x.t / model.duration)
  }, [model])
  const k = Math.min(1, time / (model.duration || 1))
  const accent = love ? 'bg-[#e0b6c0]' : 'bg-gold'
  return (
    <div className="relative h-10 flex-1">
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/15" />
      <div className={cn('absolute top-1/2 left-0 h-px -translate-y-1/2', accent)} style={{ width: `${k * 100}%` }} />
      {ticks.map((x, i) => (
        <span
          key={i}
          className={cn('absolute top-1/2 h-2.5 w-px -translate-y-1/2', i < reached ? accent : 'bg-white/25')}
          style={{ left: `${x * 100}%` }}
        />
      ))}
      <span
        className={cn('pointer-events-none absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-[6px]', accent, love ? 'ring-[#e0b6c0]/15' : 'ring-gold/15')}
        style={{ left: `${k * 100}%` }}
      />
      <input
        type="range"
        min={0}
        max={model.duration}
        step={0.01}
        value={time}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="peer absolute inset-0 w-full cursor-pointer opacity-0"
        aria-label="进度"
      />
      <span className="pointer-events-none absolute inset-x-0 -inset-y-0.5 hidden rounded-sm ring-1 ring-white/40 peer-focus-visible:block" />
    </div>
  )
}

/* ---------------- 页面 ---------------- */
export default function ReplayPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const loc = useLocation()
  const nav = useNavigate()
  const me = useAuth((s) => s.user)
  const together = loc.pathname.startsWith('/together')
  const plan = !together && params.get('plan') === '1'
  const compare = !plan && params.get('compare') === '1'

  const tripQ = useQuery({ queryKey: ['trip', id], queryFn: () => api.trips.get(id!), enabled: !together })
  const trackQ = useQuery({
    queryKey: ['track', Number(id)],
    queryFn: () => api.trips.track(Number(id)),
    enabled: !together && !plan && !!tripQ.data?.has_track,
  })
  const fpQ = useQuery({ queryKey: ['partner-footprints'], queryFn: api.partner.footprints, enabled: together })
  const partnerQ = useQuery({ queryKey: ['partner'], queryFn: api.partner.get, enabled: together })

  const data = useMemo(() => {
    if (together) return fpQ.data ? { ...footprintsToReplay(fpQ.data), planned: undefined } : null
    if (!tripQ.data || (!plan && tripQ.data.has_track && !trackQ.data)) return null
    return { ...tripToReplay(tripQ.data, plan ? undefined : trackQ.data, compare, plan), arcs: undefined }
  }, [together, fpQ.data, tripQ.data, trackQ.data, compare, plan])

  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [intro, setIntro] = useState(true)
  // 开场的全程镜头瓦片加载完之前，画面盖一层夜色（只露出片名），不露出一块块还没加载的瓦片
  const [shown, setShown] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [share, setShare] = useState(false)
  const qc = useQueryClient()
  const last = useRef<number | null>(null)
  const pageTitle = together ? partnerQ.data?.title || '我们一起走过的地方' : tripQ.data?.title
  useDocumentTitle(pageTitle && `${pageTitle} · ${plan ? '路线预览' : '3D 回放'}`)

  useEffect(() => {
    if (!playing || intro || !data) return
    let raf = 0
    const tick = (now: number) => {
      const dt = last.current == null ? 0 : (now - last.current) / 1000
      last.current = now
      setTime((t) => {
        const n = t + dt * speed
        if (n >= data.model.duration) {
          setPlaying(false)
          return data.model.duration
        }
        return n
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      last.current = null
    }
  }, [playing, intro, data, speed])

  const loading = together ? fpQ.isLoading : tripQ.isLoading || (!plan && tripQ.data?.has_track && trackQ.isLoading)
  if (loading)
    return (
      <div className="bg-night min-h-dvh">
        <PageLoader label={plan ? '正在准备路线预览…' : '正在准备 3D 回放…'} />
      </div>
    )
  const err = together ? fpQ.error : (tripQ.error ?? trackQ.error)
  const trip = tripQ.data
  // 全屏页面没有顶栏和底部导航，直接打开链接时也要能返回（nav(-1) 无处可退）；
  // 从编辑页、旅程页进来时返回原处
  const backTo = together ? '/together' : plan && trip?.can_edit ? `/trips/${id}/edit` : `/trips/${id}`
  const canGoBack = loc.key !== 'default'
  const goBack = (e: MouseEvent) => {
    if (!canGoBack) return
    e.preventDefault()
    nav(-1)
  }
  // 后台刷新失败时继续播放已加载的数据，404 说明旅程已删除或不再可见
  if (!data || isNotFound(err))
    return (
      <LoadError
        className="min-h-dvh"
        error={err}
        title="无法回放"
        desc={err ? undefined : '请检查网络连接'}
        notFoundTitle="旅程不存在或无权查看"
        onRetry={() => (together ? fpQ.refetch() : tripQ.error ? tripQ.refetch() : trackQ.refetch())}
        back={
          <Link to={isNotFound(err) && !together ? '/' : backTo} className={buttonClass({ variant: 'outline' })}>
            返回
          </Link>
        }
      />
    )
  if (!data.model.stops.length && data.model.coords.length < 3)
    return (
      <Empty
        className="min-h-dvh"
        title={together ? '还没有一起的足迹' : plan ? '还没有计划的地点' : '这段旅程还没有路线'}
        desc={
          together ? '创建旅程时选择「和 TA 一起」，打卡后就能回放' : plan ? '在编辑页添加地点后，再来预览路线' : '添加打卡点或记录轨迹后再来回放'
        }
        action={
          <Link to={backTo} onClick={goBack} className={buttonClass({ variant: 'outline' })}>
            返回
          </Link>
        }
      />
    )

  const { model } = data
  const { d, stop } = distanceAt(model, time)
  let reachedCount = 0
  while (reachedCount < model.stops.length && model.stops[reachedCount].reach <= d + 1) reachedCount++
  const current = intro ? undefined : stop != null ? model.stops[stop] : model.stops[reachedCount - 1]
  const done = time >= model.duration
  const partner = partnerQ.data?.partner
  const title = together ? partnerQ.data?.title || '我们一起走过的地方' : trip?.title
  const subtitle = together ? undefined : trip && dateRange(trip.start_date, trip.end_date)
  const love = together
  const eyebrow = plan ? 'Route preview · 路线预览' : together ? 'Together · 我们的足迹' : 'Replay · 旅程回放'

  const restart = () => {
    setTime(0)
    setIntro(true)
    setPlaying(true)
  }
  const seek = (t: number) => {
    setIntro(false)
    // 进度条按 0.01 秒取整，拖到最右端时也要算作播放结束
    setTime(t >= model.duration - 0.02 ? model.duration : t)
    setPlaying(false)
  }
  const togglePlay = () => {
    if (done) return restart()
    // 开场镜头中按暂停：跳过开场，停在第一站
    if (intro) {
      setIntro(false)
      setPlaying(false)
      return
    }
    setPlaying((p) => !p)
  }

  // 当前里程与全程单位相同时只写数字（12.3 / 184 公里），不同时各写各的单位（587 米 / 184 公里）
  const kmTotal = formatKm(model.total / 1000)
  const kmNowFull = formatKm(d / 1000)
  const unitOf = (x: string) => x.replace(/^[\d.,\s]+/, '')
  const kmNow = unitOf(kmNowFull) === unitOf(kmTotal) ? kmNowFull.replace(/ ?(公里|米)$/, '') : kmNowFull

  return (
    <div className="bg-night fixed inset-0 overflow-hidden text-white">
      {/* 地图版权信息：桌面抬到底部控制条上方；手机上放到右上角关闭按钮下方，不压在地点字幕上 */}
      <BaseMap
        className="absolute inset-0 sm:[&_.maplibregl-ctrl-bottom-right]:bottom-[calc(5.25rem+env(safe-area-inset-bottom))] max-sm:[&_.maplibregl-ctrl-bottom-right]:top-[calc(max(env(safe-area-inset-top),1rem)+6.5rem)] max-sm:[&_.maplibregl-ctrl-bottom-right]:bottom-auto"
        kind="dark"
        rasterTone={REPLAY_TONE}
        navigation={false}
        center={model.coords[0]}
        zoom={12}
        pitch={OVERVIEW_PITCH}
        options={{ maxPitch: 85 }}
      >
        {data.planned && data.planned.length > 1 && <RouteLines planned={data.planned} idPrefix="replay-plan" dark />}
        <ReplayScene
          model={model}
          time={time}
          playing={playing}
          theme={love ? 'love' : 'sunset'}
          arcs={data.arcs}
          intro={intro}
          onIntroDone={() => setIntro(false)}
          onShown={() => setShown(true)}
        />
      </BaseMap>
      <div
        aria-hidden
        className={cn(
          'bg-night pointer-events-none absolute inset-0 transition-opacity duration-1000 ease-out',
          shown || !intro ? 'opacity-0' : 'opacity-100',
        )}
      />

      {/* 上下两道暗角：让照片般的画面上的小字看得清 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-[#0b1112]/90 via-[#0b1112]/45 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[46vh] bg-gradient-to-t from-[#0b1112]/95 via-[#0b1112]/55 to-transparent" />

      {/* 顶部：片名 */}
      <div className="animate-fade-in absolute inset-x-0 top-0 px-4 pt-[max(env(safe-area-inset-top),1rem)] sm:px-8 sm:pt-7">
        <div className="flex items-start gap-4">
          {/* 片尾字幕出现时片名淡出，不在模糊的背景里重复出现 */}
          <div className={cn('min-w-0 flex-1 transition-opacity duration-500', done && 'opacity-0')}>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {together && me && partner && (
                <span className="flex items-center gap-1.5">
                  <Avatar user={me} size={22} className="ring-1 ring-white/25" />
                  <span className="font-display text-[15px] leading-none text-white/60 italic">&amp;</span>
                  <Avatar user={partner} size={22} className="ring-1 ring-white/25" />
                </span>
              )}
              <span className="eyebrow !text-white/55">{eyebrow}</span>
              {subtitle && <span className="font-num text-[13px] text-white/50">{subtitle}</span>}
            </p>
            <h1 className="font-display mt-2 truncate text-[1.75rem] leading-[1.1] font-normal text-white sm:mt-3 sm:text-[2.75rem]">{title}</h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-white/50">
              <span>
                <span className="font-num text-[13px] text-white/85">{kmNow}</span>
                <span className="text-white/30"> / </span>
                <span className="font-num text-[13px]">{kmTotal}</span>
              </span>
              {plan && <span>按计划顺序直线连接</span>}
              {data.planned && <span>虚线为计划路线</span>}
            </p>
          </div>
          <Link
            to={backTo}
            onClick={goBack}
            className="glass flex size-10 shrink-0 items-center justify-center rounded-full border border-white/15 text-white/80 transition-colors hover:border-white/40 hover:text-white"
            aria-label={plan ? '退出预览' : '退出回放'}
          >
            <X className="size-[18px]" strokeWidth={1.4} />
          </Link>
        </div>
      </div>

      {/* 当前地点：照片 + 说明文字对（片中字幕式，不装进卡片） */}
      {current && !done && (
        <div
          key={current.key}
          className="animate-slide-up pointer-events-none absolute inset-x-4 bottom-[calc(6.25rem+env(safe-area-inset-bottom))] flex items-end gap-4 sm:right-auto sm:bottom-[calc(7.5rem+env(safe-area-inset-bottom))] sm:left-8 sm:max-w-[36rem] sm:gap-5"
        >
          {current.photo && (
            <img
              src={current.photo}
              alt=""
              className="h-28 w-[5.6rem] shrink-0 rounded-sm object-cover ring-1 ring-white/12 sm:h-40 sm:w-32"
            />
          )}
          <div className="min-w-0 pb-0.5">
            <p className="eyebrow flex items-center gap-2 !text-white/55">
              <span className="size-1.5 shrink-0 rounded-full bg-white/70" />
              <span className="font-num">No. {String(current.index + 1).padStart(2, '0')}</span>
              <span className="text-white/25">·</span>
              <span className="truncate normal-case">{current.tag ?? `第 ${current.index + 1} 站`}</span>
            </p>
            <h2 className="font-display mt-2 line-clamp-2 text-[2rem] leading-[1.05] font-normal text-white sm:text-[3.25rem]">{current.name}</h2>
            {current.sub && <p className="mt-2 truncate text-[13px] text-white/60">{current.sub}</p>}
            {current.verdict && <VerdictBadge verdict={current.verdict as never} className="mt-2 !bg-black/30" />}
            {current.note && <p className="mt-2 line-clamp-2 max-w-md text-[13px] leading-relaxed text-white/70">{current.note}</p>}
          </div>
        </div>
      )}

      {/* 结束：片尾字幕 */}
      {done && (
        <div className="animate-fade-in absolute inset-0 flex items-center justify-center bg-[#0b1112]/72 p-6 backdrop-blur-[3px]">
          <div className="animate-slide-up w-full max-w-xl text-center">
            <p className="eyebrow !text-white/55">
              {plan ? 'Preview · 预览完毕' : together ? 'To be continued · 未完待续' : 'Fin · 回放结束'}
            </p>
            <h2 className="text-display-lg mt-5 font-normal text-balance text-white">{title}</h2>
            <p className="mt-3 text-[13px] text-white/55">{plan ? '路线看完了' : together ? '我们的足迹还在继续' : '旅程回放结束'}</p>
            <div className="mx-auto mt-10 grid max-w-sm grid-cols-2 border-t border-white/12">
              <div className="pt-4">
                <div className="text-xs text-white/50">地点</div>
                <div className="mt-3 flex items-baseline justify-center gap-1">
                  <span className="font-num text-6xl leading-[0.85] font-light text-white">{model.stops.length}</span>
                  <span className="text-xs text-white/45">个</span>
                </div>
              </div>
              <div className="border-l border-white/12 pt-4">
                <div className="text-xs text-white/50">里程{plan && '（直线）'}</div>
                <div className="mt-3 flex items-baseline justify-center gap-1">
                  <span className="font-num text-6xl leading-[0.85] font-light text-white">{formatKm(model.total / 1000).replace(/ ?(公里|米)$/, '')}</span>
                  <span className="text-xs text-white/45">{model.total < 1000 ? '米' : '公里'}</span>
                </div>
              </div>
            </div>
            <div className="mt-12 flex flex-wrap justify-center gap-2">
              <Button icon={<RotateCcw className="size-4" strokeWidth={1.5} />} onClick={restart}>
                再看一次
              </Button>
              {!together && !plan && trip && (
                <Button variant="outline" icon={<Share2 className="size-4" strokeWidth={1.5} />} onClick={() => setShare(true)}>
                  分享
                </Button>
              )}
              {plan && trip?.can_edit ? (
                <Link to={`/trips/${id}/edit`} onClick={goBack} className={buttonClass({ variant: 'outline' })}>
                  <PenLine className="size-4" strokeWidth={1.5} />
                  继续编辑
                </Link>
              ) : (
                <Link to={backTo} onClick={goBack} className={buttonClass({ variant: 'ghost' })}>
                  返回
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 控制条：播放、进度（每一站一道刻度）、倍速 */}
      <div className="pb-safe absolute inset-x-0 bottom-0 px-4 sm:px-8">
        <div className="flex items-center gap-4 pb-4 sm:gap-6 sm:pb-6">
          <button
            type="button"
            onClick={togglePlay}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink-900 text-paper transition-colors hover:bg-white"
            aria-label={playing && !done ? '暂停' : '播放'}
          >
            {playing && !done ? <Pause className="size-4 fill-current" strokeWidth={1.5} /> : <Play className="ml-0.5 size-4 fill-current" strokeWidth={1.5} />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-3 text-[11px] text-white/45">
              <span className="shrink-0">
                <span className="font-num text-[13px] text-white/90">{String(reachedCount).padStart(2, '0')}</span>
                <span className="font-num"> / {String(model.stops.length).padStart(2, '0')}</span>
              </span>
              <span className="min-w-0 flex-1 truncate text-white/60">{intro ? '全程' : current ? current.name : '出发'}</span>
              <span className="font-num shrink-0">{kmTotal}</span>
            </div>
            <Scrubber model={model} time={time} onSeek={seek} reached={reachedCount} love={love} />
          </div>
          <button
            type="button"
            onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))}
            className="font-num flex size-11 shrink-0 items-center justify-center rounded-full border border-white/15 text-[15px] text-white/85 transition-colors hover:border-white/40 hover:text-white"
            aria-label="播放速度"
          >
            {speed}×
          </button>
        </div>
      </div>

      {!together && trip && (
        <ShareDialog
          trip={trip}
          shareCode={rememberedShareCode(trip.id)}
          open={share}
          onClose={() => setShare(false)}
          onUpdated={(t) => {
            qc.setQueryData(['trip', id], t)
            invalidateTripLists(qc)
          }}
        />
      )}
    </div>
  )
}
