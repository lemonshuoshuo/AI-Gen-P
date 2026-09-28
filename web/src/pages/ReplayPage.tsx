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
import { hexToRgb, useDeckOverlay } from '@/components/three/deck'
import { angleLerp, buildRoute, distanceAt, legBounds, pointAt, type PlacedStop, type ReplayStop, type RouteModel } from '@/components/three/replay'
import { ShareDialog } from '@/components/trip/ShareDialog'
import { Avatar, Empty, LoadError, PageLoader, VerdictBadge, buttonClass } from '@/components/ui'
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
}

const CAMERA_SIDE_ANGLE = 22
const FOLLOW_PITCH = 60
const OVERVIEW_PITCH = 45
const INTRO_HOLD = 1200 // 全程镜头停留（毫秒）

// 夜色 + 金 / 朱砂（情侣空间为玫瑰金 / 胭脂）：轨迹是金色，彗星头是朱砂
const THEMES: Record<Theme, { glow: RGB; trail: RGB; head: RGB; core: RGB; column: RGB; current: RGB; arcA: RGB; arcB: RGB }> = {
  sunset: {
    glow: [201, 168, 104],
    trail: [218, 190, 128],
    head: [224, 100, 66],
    core: [255, 240, 208],
    column: [214, 184, 122],
    current: [206, 88, 58],
    arcA: [201, 168, 104],
    arcB: [206, 88, 58],
  },
  love: {
    glow: [210, 161, 171],
    trail: [228, 190, 200],
    head: [196, 96, 126],
    core: [255, 234, 240],
    column: [222, 178, 188],
    current: [176, 82, 112],
    arcA: [163, 151, 191],
    arcB: [210, 161, 171],
  },
}

/** 金色里掺一点分类色（矿物色），光柱既统一又能分辨类别 */
function tint(base: RGB, hex: string, k = 0.35, alpha = 235): [number, number, number, number] {
  const c = hexToRgb(hex)
  return [base[0] * (1 - k) + c[0] * k, base[1] * (1 - k) + c[1] * k, base[2] * (1 - k) + c[2] * k, alpha]
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

function ReplayScene({ model, time, playing, theme, arcs, intro, onIntroDone }: SceneProps) {
  const map = useMap()
  const overlay = useDeckOverlay()
  const cam = useRef({ bearing: 0, zoom: 0, init: false, d: -1, last: 0 })
  const zoomCache = useRef(new Map<string, number>())
  const introDone = useRef(onIntroDone)
  introDone.current = onIntroDone
  const shownOnce = useRef(false)

  const { d, stop } = distanceAt(model, time)
  // 已到达的打卡点：buildRoute 保证 reach 单调不减，已到达的一定是前缀。
  // 只在到达新地点时才换一个数组（deck.gl 按引用比较 data，每帧新数组会让图层每帧重建全部属性）
  let reachedCount = 0
  while (reachedCount < model.stops.length && model.stops[reachedCount].reach <= d + 1) reachedCount++
  const reached = useMemo(() => model.stops.slice(0, reachedCount), [model, reachedCount])

  // 开场：全程俯瞰（倾斜约 45°）→ 停留 1.2 秒 → 飞到第一站开始跟随
  useEffect(() => {
    if (!map || !intro) return
    const ov = overviewView(map, model)
    const first = !shownOnce.current
    shownOnce.current = true
    if (first) map.jumpTo(ov)
    else map.easeTo({ ...ov, duration: 1100 })
    let done = false
    const finish = () => {
      if (done) return
      done = true
      introDone.current()
    }
    const t = window.setTimeout(
      () => {
        const f = followView(map, model, 0, zoomCache.current)
        const moving = f.ahead[0] !== f.behind[0] || f.ahead[1] !== f.behind[1]
        const brg = moving ? bearing(f.behind, f.ahead) + CAMERA_SIDE_ANGLE : 0
        const c = cam.current
        c.zoom = f.zoom
        c.bearing = brg
        c.init = true
        c.d = 0
        c.last = 0
        map.once('moveend', finish)
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
      },
      INTRO_HOLD + (first ? 0 : 1100),
    )
    return () => {
      window.clearTimeout(t)
      map.off('moveend', finish)
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
    o.setProps({
      layers: [
        ...(arcs?.length
          ? [
              new ArcLayer<{ from: LngLat; to: LngLat }>({
                id: 'arcs',
                data: arcs,
                getSourcePosition: (a) => a.from,
                getTargetPosition: (a) => a.to,
                getSourceColor: [...t.arcA, 150],
                getTargetColor: [...t.arcB, 150],
                getWidth: 1.5,
                getHeight: 0.6,
                greatCircle: false,
              }),
            ]
          : []),
        // 整条路线的淡金细线和还没到的地点（空心小圈）：开场俯瞰时就能看出路线的形状
        new PathLayer<RouteModel['parts'][number]>({
          id: 'ghost',
          data: trips,
          getPath: (x) => x.path,
          getColor: [...t.trail, 70],
          widthUnits: 'pixels',
          getWidth: 1.25,
          capRounded: true,
          jointRounded: true,
        }),
        new ScatterplotLayer<PlacedStop>({
          id: 'ghost-stops',
          data: model.stops,
          getPosition: (s) => [s.lng, s.lat],
          radiusUnits: 'pixels',
          getRadius: 3.5,
          filled: true,
          getFillColor: [12, 19, 20, 200],
          stroked: true,
          getLineColor: [...t.trail, 150],
          lineWidthUnits: 'pixels',
          getLineWidth: 1.25,
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
          getFillColor: (s) => hexToRgb(s.color, 45),
          getLineColor: (s) => tint(t.column, s.color, 0.5, 190),
          stroked: true,
          lineWidthMinPixels: 1.25,
          radiusMinPixels: 6,
          updateTriggers: { getRadius: [radius] },
        }),
        new ColumnLayer<PlacedStop>({
          id: 'stop-columns',
          data: reached,
          diskResolution: 24,
          radius,
          extruded: true,
          getPosition: (s) => [s.lng, s.lat],
          getFillColor: (s) => (stop === s.index ? [...t.current, 240] : tint(t.column, s.color)),
          getElevation: (s) => {
            const k = Math.min(1, (d - s.reach) / Math.max(1, model.total * 0.02) + (stop != null && s.index <= stop ? 1 : 0))
            return radius * 7 * (0.15 + 0.85 * Math.min(1, k))
          },
          material: { ambient: 0.62, diffuse: 0.55, shininess: 32 },
          updateTriggers: { getElevation: [d, stop, radius], getFillColor: [stop, theme] },
        }),
        // 彗星头：朱砂光晕 + 纸色内核
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
  }, [overlay, map, model, d, stop, theme, arcs, reached, time])

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
  const accent = love ? 'bg-[#dcb0bb]' : 'bg-gold'
  return (
    <div className="relative h-6 flex-1">
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/18" />
      <div className={cn('absolute top-1/2 left-0 h-[1.5px] -translate-y-1/2', accent)} style={{ width: `${k * 100}%` }} />
      {ticks.map((x, i) => (
        <span
          key={i}
          className={cn('absolute top-1/2 h-2 w-px -translate-y-1/2', i < reached ? accent : 'bg-white/30')}
          style={{ left: `${x * 100}%` }}
        />
      ))}
      <span
        className={cn('pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4', accent, love ? 'ring-[#dcb0bb]/20' : 'ring-gold/20')}
        style={{ left: `${k * 100}%` }}
      />
      <input
        type="range"
        min={0}
        max={model.duration}
        step={0.01}
        value={time}
        onChange={(e) => onSeek(Number(e.target.value))}
        className="absolute inset-0 w-full cursor-pointer opacity-0"
        aria-label="进度"
      />
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
    setTime(t)
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

  return (
    <div className="bg-night fixed inset-0 overflow-hidden text-paper">
      {/* 地图版权信息抬到底部控制条上方，不遮住倍速按钮 */}
      <BaseMap
        className="absolute inset-0 [&_.maplibregl-ctrl-bottom-right]:bottom-[calc(4.75rem+env(safe-area-inset-bottom))]"
        kind="dark"
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
        />
      </BaseMap>

      {/* 顶部 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-[#0c1314]/90 via-[#0c1314]/50 to-transparent px-4 pt-[max(env(safe-area-inset-top),1rem)] pb-14 sm:px-6">
        <div className="pointer-events-auto mx-auto flex max-w-6xl items-start gap-3">
          <div className="min-w-0 flex-1">
            {together && me && partner && (
              <div className="mb-2.5 flex items-center">
                <Avatar user={me} size={26} className="ring-1 ring-white/30" />
                <span className="font-num z-10 -mx-1 flex size-5 items-center justify-center rounded-full bg-[#4f3d62] text-[11px] text-white/85 italic ring-1 ring-white/25">
                  &amp;
                </span>
                <Avatar user={partner} size={26} className="ring-1 ring-white/30" />
              </div>
            )}
            <p className={cn('eyebrow', love ? '!text-[#dcb0bb]' : '!text-gold/90')}>{eyebrow}</p>
            <h1 className="mt-1.5 truncate text-[22px] leading-tight text-paper sm:text-[30px]">{title}</h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-white/55">
              {subtitle && <span className="font-num">{subtitle}</span>}
              {subtitle && <span className="text-white/25">·</span>}
              <span>
                <span className="font-num text-white/80">{formatKm(d / 1000).replace(' 公里', '')}</span>
                <span className="text-white/35"> / </span>
                <span className="font-num">{formatKm(model.total / 1000)}</span>
              </span>
              {plan && <span className="text-white/40">· 按计划顺序直线连接</span>}
              {data.planned && <span className="text-white/40">· 虚线为计划路线</span>}
            </p>
          </div>
          <Link
            to={backTo}
            onClick={goBack}
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-white/80 ring-1 ring-white/20 backdrop-blur transition-colors hover:bg-white/10 hover:text-white"
            aria-label={plan ? '退出预览' : '退出回放'}
          >
            <X className="size-[18px]" strokeWidth={1.6} />
          </Link>
        </div>
      </div>

      {/* 当前地点卡片 */}
      {current && !done && (
        <div
          key={current.key}
          className="glass-dark animate-slide-up absolute bottom-[calc(7rem+env(safe-area-inset-bottom))] left-1/2 w-[min(92vw,400px)] -translate-x-1/2 overflow-hidden rounded-xl ring-1 ring-white/12"
        >
          <div className="flex gap-3.5 p-3.5">
            {current.photo ? (
              <img src={current.photo} alt="" className="size-[5.25rem] shrink-0 rounded-md object-cover ring-1 ring-white/10" />
            ) : (
              <div className={cn('font-num w-12 shrink-0 pt-0.5 text-[2.1rem] leading-none font-light', love ? 'text-[#dcb0bb]' : 'text-gold')}>
                {String(current.index + 1).padStart(2, '0')}
              </div>
            )}
            <div className={cn('min-w-0 flex-1', !current.photo && 'border-l border-white/10 pl-3.5')}>
              <p className="eyebrow flex items-center gap-1.5 !text-white/45">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: current.color }} />
                {current.photo && <span className="font-num">No. {String(current.index + 1).padStart(2, '0')}</span>}
                {current.photo && <span className="text-white/25">·</span>}
                <span className="truncate normal-case">{current.tag ?? `第 ${current.index + 1} 站`}</span>
              </p>
              <h3 className="mt-1.5 truncate text-[18px] leading-snug text-paper">{current.name}</h3>
              {current.sub && <p className="mt-0.5 truncate text-xs text-white/55">{current.sub}</p>}
              {current.verdict && <VerdictBadge verdict={current.verdict as never} className="mt-1.5 !bg-white/5" />}
            </div>
          </div>
          {current.note && (
            <p className="line-clamp-2 border-t border-white/10 px-3.5 py-2.5 text-[13px] leading-relaxed text-white/70">{current.note}</p>
          )}
        </div>
      )}

      {/* 结束 */}
      {done && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0c1314]/55 p-6 backdrop-blur-[2px]">
          <div className="glass-dark animate-slide-up w-full max-w-sm rounded-xl p-6 text-center ring-1 ring-white/12">
            <p className={cn('eyebrow', love ? '!text-[#dcb0bb]' : '!text-gold/90')}>
              {plan ? 'Preview · 预览完毕' : together ? 'To be continued · 未完待续' : 'Fin · 回放结束'}
            </p>
            <h2 className="mt-2 text-[22px] text-paper">{plan ? '路线看完了' : together ? '我们的足迹还在继续' : '旅程回放结束'}</h2>
            <div className="mt-5 grid grid-cols-2 border-y border-white/10">
              <div className="py-4">
                <div className="font-num text-[2rem] leading-none font-medium">{model.stops.length}</div>
                <div className="mt-1.5 text-xs text-white/50">个地点</div>
              </div>
              <div className="border-l border-white/10 py-4">
                <div className="font-num text-[2rem] leading-none font-medium">{formatKm(model.total / 1000).replace(/ ?(公里|米)$/, '')}</div>
                <div className="mt-1.5 text-xs text-white/50">{model.total < 1000 ? '米' : '公里'}{plan && '（直线）'}</div>
              </div>
            </div>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={restart}
                className="flex h-10 items-center gap-1.5 rounded-lg bg-paper px-4 text-sm font-medium text-ink-900 transition-colors hover:bg-white"
              >
                <RotateCcw className="size-4" strokeWidth={1.75} />
                再看一次
              </button>
              {!together && !plan && trip && (
                <button
                  type="button"
                  onClick={() => setShare(true)}
                  className="flex h-10 items-center gap-1.5 rounded-lg px-4 text-sm font-medium text-white/85 ring-1 ring-white/25 transition-colors hover:bg-white/10"
                >
                  <Share2 className="size-4" strokeWidth={1.75} />
                  分享
                </button>
              )}
              {plan && trip?.can_edit ? (
                <Link
                  to={`/trips/${id}/edit`}
                  onClick={goBack}
                  className="flex h-10 items-center gap-1.5 rounded-lg px-4 text-sm font-medium text-white/85 ring-1 ring-white/25 transition-colors hover:bg-white/10"
                >
                  <PenLine className="size-4" strokeWidth={1.75} />
                  继续编辑
                </Link>
              ) : (
                <Link
                  to={backTo}
                  onClick={goBack}
                  className="flex h-10 items-center rounded-lg px-4 text-sm font-medium text-white/70 transition-colors hover:text-white"
                >
                  返回
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 控制条 */}
      <div className="pb-safe absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#0c1314]/90 via-[#0c1314]/55 to-transparent px-4 pt-12 sm:px-6">
        <div className="mx-auto flex max-w-2xl items-center gap-4 pb-5">
          <button
            type="button"
            onClick={togglePlay}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-paper text-ink-900 transition-colors hover:bg-white"
            aria-label={playing && !done ? '暂停' : '播放'}
          >
            {playing && !done ? <Pause className="size-[18px]" strokeWidth={1.75} /> : <Play className="ml-0.5 size-[18px]" strokeWidth={1.75} />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="mb-0.5 flex items-baseline gap-3 text-[11px] text-white/45">
              <span className="shrink-0">
                <span className="font-num text-[13px] text-white/85">{String(reachedCount).padStart(2, '0')}</span>
                <span className="font-num"> / {String(model.stops.length).padStart(2, '0')}</span>
              </span>
              <span className="min-w-0 flex-1 truncate">{intro ? '全程' : current ? current.name : '出发'}</span>
              <span className="font-num shrink-0">{formatKm(model.total / 1000)}</span>
            </div>
            <Scrubber model={model} time={time} onSeek={seek} reached={reachedCount} love={love} />
          </div>
          <button
            type="button"
            onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))}
            className="font-num h-8 w-11 shrink-0 rounded-lg text-[13px] text-white/85 ring-1 ring-white/20 transition-colors hover:bg-white/10"
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
