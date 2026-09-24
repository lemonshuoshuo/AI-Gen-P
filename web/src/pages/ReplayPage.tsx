import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArcLayer, ColumnLayer, ScatterplotLayer } from '@deck.gl/layers'
import { TripsLayer } from '@deck.gl/geo-layers'
import { Heart, Pause, Play, RotateCcw, Share2, X } from 'lucide-react'
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
import { plannedPath, replayTrackParts, visitedInOrder } from '@/lib/trip'
import { useAuth } from '@/stores/auth'

type LngLat = [number, number]

interface SceneProps {
  model: RouteModel
  time: number
  playing: boolean
  theme: 'sunset' | 'love'
  arcs?: { from: LngLat; to: LngLat }[]
}

const CAMERA_SIDE_ANGLE = 22

const THEMES = {
  sunset: { trail: [255, 110, 90] as const, head: [255, 236, 170] as const },
  love: { trail: [255, 110, 180] as const, head: [255, 220, 245] as const },
}

function ReplayScene({ model, time, playing, theme, arcs }: SceneProps) {
  const map = useMap()
  const overlay = useDeckOverlay()
  const cam = useRef({ bearing: 0, zoom: 0, init: false, d: -1, last: 0 })
  const zoomCache = useRef(new Map<string, number>())

  const { d, stop } = distanceAt(model, time)
  // 已到达的打卡点：buildRoute 保证 reach 单调不减，已到达的一定是前缀。
  // 只在到达新地点时才换一个数组（deck.gl 按引用比较 data，每帧新数组会让图层每帧重建全部属性）
  let reachedCount = 0
  while (reachedCount < model.stops.length && model.stops[reachedCount].reach <= d + 1) reachedCount++
  const reached = useMemo(() => model.stops.slice(0, reachedCount), [model, reachedCount])

  // 相机：跟随轨迹前端，按路段长度自适应缩放，停留时缓慢环绕
  useEffect(() => {
    if (!map) return
    const c = cam.current
    // 暂停时只在进度变化（拖动进度条）时移动镜头；刚按暂停时不动，方便用户自由查看
    if (!playing && c.init && c.d === d) return
    c.d = d
    const now = performance.now()
    const dt = playing && c.last ? Math.min(0.05, (now - c.last) / 1000) : 0
    c.last = playing ? now : 0
    const head = pointAt(model, d)
    const ahead = pointAt(model, Math.min(model.total, d + Math.max(60, model.total * 0.01)))
    const behind = pointAt(model, Math.max(0, d - Math.max(30, model.total * 0.005)))
    const moving = stop == null && (ahead[0] !== behind[0] || ahead[1] !== behind[1])
    const b = legBounds(model, d)
    const el = map.getContainer()
    const w = el.clientWidth
    const h = el.clientHeight
    // 缓存按画面尺寸区分：旋转屏幕后重新计算
    const key = `${w}x${h}|${b[0].join()}|${b[1].join()}`
    let targetZoom = zoomCache.current.get(key)
    if (targetZoom == null) {
      // jumpTo 设置的 bottom=h*0.2 会被 cameraForBounds 再叠加一次：扣掉它，留给路段的高度始终约为 0.42h（不会变成负数）
      const tp = map.getPadding()
      const side = Math.min(60, w * 0.1)
      const fit = map.cameraForBounds(b, {
        padding: { top: h * 0.14, bottom: Math.max(0, h * 0.44 - (tp.bottom ?? 0)), left: side, right: side },
      })
      targetZoom = Math.min(16.2, Math.max(3.5, (fit?.zoom ?? 12) - 0.2))
      zoomCache.current.set(key, targetZoom)
    }
    if (!c.init || !playing) {
      c.zoom = targetZoom // 首帧 / 暂停时拖动进度条：直接到位，不缓动
      if (!c.init) c.bearing = moving ? bearing(behind, ahead) + CAMERA_SIDE_ANGLE : 0
      c.init = true
    } else {
      const k = 1 - 0.96 ** (dt * 60) // 与刷新率无关，60Hz 时等同每帧 0.04
      c.zoom += (targetZoom - c.zoom) * k
      // 镜头从侧后方跟随（偏转一定角度），避免轨迹与光柱在画面上重叠
      c.bearing = moving ? angleLerp(c.bearing, bearing(behind, ahead) + CAMERA_SIDE_ANGLE, k) : c.bearing + 7.2 * dt
    }
    map.jumpTo({ center: head, zoom: c.zoom, bearing: c.bearing, pitch: 60, padding: { top: 0, bottom: h * 0.2, left: 0, right: 0 } })
  }, [map, model, d, stop, playing])

  // deck.gl 图层
  useEffect(() => {
    const o = overlay.current
    if (!o || !map) return
    const t = THEMES[theme]
    const zoom = map.getZoom()
    const radius = Math.max(6, 12 * 2 ** (15 - zoom))
    // 各段分开画（段与段之间不连线）；引用不变，deck.gl 不必每帧重建路径数据
    const trips = model.parts
    o.setProps({
      layers: [
        ...(arcs?.length
          ? [
              new ArcLayer<{ from: LngLat; to: LngLat }>({
                id: 'arcs',
                data: arcs,
                getSourcePosition: (a) => a.from,
                getTargetPosition: (a) => a.to,
                getSourceColor: [255, 142, 199, 160],
                getTargetColor: [155, 92, 255, 160],
                getWidth: 2,
                getHeight: 0.6,
                greatCircle: false,
              }),
            ]
          : []),
        new TripsLayer({
          id: 'trail-glow',
          data: trips,
          getPath: (x) => x.path,
          getTimestamps: (x) => x.timestamps,
          getColor: [...t.trail, 70],
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
          widthMinPixels: 4,
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
          trailLength: Math.max(80, model.total * 0.03),
          currentTime: d,
        }),
        new ScatterplotLayer<PlacedStop>({
          id: 'stop-rings',
          data: reached,
          getPosition: (s) => [s.lng, s.lat],
          getRadius: radius * 2.2,
          getFillColor: (s) => hexToRgb(s.color, 60),
          getLineColor: (s) => hexToRgb(s.color, 200),
          stroked: true,
          lineWidthMinPixels: 1.5,
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
          getFillColor: (s) => hexToRgb(s.color, 235),
          getElevation: (s) => {
            const k = Math.min(1, (d - s.reach) / Math.max(1, model.total * 0.02) + (stop != null && s.index <= stop ? 1 : 0))
            return radius * 7 * (0.15 + 0.85 * Math.min(1, k))
          },
          material: { ambient: 0.6, diffuse: 0.6, shininess: 40 },
          updateTriggers: { getElevation: [d, stop, radius] },
        }),
      ],
    })
  }, [overlay, map, model, d, stop, theme, arcs, reached])

  return null
}

/* ---------------- 数据 → 回放模型 ---------------- */
function tripToReplay(trip: TripDetail, trackData: TrackData | undefined, compare: boolean) {
  const visited = visitedInOrder(trip.waypoints)
  const list = visited.length ? visited : [...trip.waypoints].filter((w) => w.planned).sort((a, b) => a.seq - b.seq)
  const photoBy = new Map<number, string>()
  trip.photos.forEach((p) => p.waypoint_id && !photoBy.has(p.waypoint_id) && photoBy.set(p.waypoint_id, p.thumb_url))
  // 轨迹按记录分段（两次记录之间、同行成员各自的轨迹不连线）；带上时间，打卡点按到达时间对齐到轨迹
  const track = replayTrackParts(trackData)
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
    verdict: w.verdict,
    tag: w.day ? `第 ${w.day} 天` : undefined,
    t: w.arrived_at ? Date.parse(w.arrived_at) : undefined,
  }))
  return { model: buildRoute(parts, stops, { times }), planned: compare ? plannedPath(trip.waypoints) : undefined }
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
        color: pt ? categoryOf(pt.category).color : '#ff6bb0',
        sub: pt ? [pt.city, fmtDate(pt.date)].filter(Boolean).join(' · ') : undefined,
        tag: t.title,
        photo: i === 0 ? t.cover_thumb_url || t.cover_url || undefined : undefined,
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

/* ---------------- 页面 ---------------- */
export default function ReplayPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const loc = useLocation()
  const me = useAuth((s) => s.user)
  const together = loc.pathname.startsWith('/together')
  const compare = params.get('compare') === '1'

  const tripQ = useQuery({ queryKey: ['trip', id], queryFn: () => api.trips.get(id!), enabled: !together })
  const trackQ = useQuery({
    queryKey: ['track', Number(id)],
    queryFn: () => api.trips.track(Number(id)),
    enabled: !together && !!tripQ.data?.has_track,
  })
  const fpQ = useQuery({ queryKey: ['partner-footprints'], queryFn: api.partner.footprints, enabled: together })
  const partnerQ = useQuery({ queryKey: ['partner'], queryFn: api.partner.get, enabled: together })

  const data = useMemo(() => {
    if (together) return fpQ.data ? { ...footprintsToReplay(fpQ.data), planned: undefined } : null
    if (!tripQ.data || (tripQ.data.has_track && !trackQ.data)) return null
    return { ...tripToReplay(tripQ.data, trackQ.data, compare), arcs: undefined }
  }, [together, fpQ.data, tripQ.data, trackQ.data, compare])

  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [share, setShare] = useState(false)
  const qc = useQueryClient()
  const last = useRef<number | null>(null)
  const pageTitle = together ? partnerQ.data?.title || '我们一起走过的地方' : tripQ.data?.title
  useDocumentTitle(pageTitle && `${pageTitle} · 3D 回放`)

  useEffect(() => {
    if (!playing || !data) return
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
  }, [playing, data, speed])

  const loading = together ? fpQ.isLoading : tripQ.isLoading || (tripQ.data?.has_track && trackQ.isLoading)
  if (loading) return <div className="bg-night min-h-dvh"><PageLoader label="正在准备 3D 回放…" /></div>
  const err = together ? fpQ.error : (tripQ.error ?? trackQ.error)
  // 全屏页面没有顶栏和底部导航，直接打开链接时也要能返回（nav(-1) 无处可退）；
  // 后台刷新失败时继续播放已加载的数据，404 说明旅程已删除或不再可见
  const backTo = together ? '/together' : `/trips/${id}`
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
        title={together ? '还没有一起的足迹' : '这段旅程还没有路线'}
        desc={together ? '创建旅程时选择「和 TA 一起」，打卡后就能回放啦' : '添加打卡点或记录轨迹后再来回放'}
        action={
          <Link to={backTo} className={buttonClass({ variant: 'outline' })}>
            返回
          </Link>
        }
      />
    )

  const { model } = data
  const { d, stop } = distanceAt(model, time)
  const reachedStops = model.stops.filter((s) => s.reach <= d + 1)
  const current = stop != null ? model.stops[stop] : reachedStops[reachedStops.length - 1]
  const done = time >= model.duration
  const trip = tripQ.data
  const partner = partnerQ.data?.partner
  const title = together ? partnerQ.data?.title || '我们一起走过的地方' : trip?.title
  const subtitle = together ? undefined : trip && dateRange(trip.start_date, trip.end_date)

  const restart = () => {
    setTime(0)
    setPlaying(true)
  }

  return (
    <div className="bg-night fixed inset-0 overflow-hidden text-white">
      {/* 地图版权信息抬到底部控制条上方，不遮住倍速按钮 */}
      <BaseMap
        className="absolute inset-0 [&_.maplibregl-ctrl-bottom-right]:bottom-[calc(3.75rem+env(safe-area-inset-bottom))]"
        kind="dark"
        navigation={false}
        center={model.coords[0]}
        zoom={13}
        pitch={62}
        options={{ maxPitch: 85 }}
      >
        {data.planned && data.planned.length > 1 && <RouteLines planned={data.planned} idPrefix="replay-plan" dark />}
        <ReplayScene model={model} time={time} playing={playing} theme={together ? 'love' : 'sunset'} arcs={data.arcs} />
      </BaseMap>

      {/* 顶部 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent px-4 pt-[max(env(safe-area-inset-top),1rem)] pb-10">
        <div className="pointer-events-auto flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {together && me && partner ? (
              <div className="mb-1 flex items-center gap-1.5">
                <Avatar user={me} size={26} ring />
                <Heart className="size-4 fill-pink-400 text-pink-400" />
                <Avatar user={partner} size={26} ring />
              </div>
            ) : null}
            <h1 className="truncate text-lg font-bold drop-shadow md:text-2xl">{title}</h1>
            <p className="text-xs text-white/60">
              {subtitle && `${subtitle} · `}
              {formatKm(d / 1000)} / {formatKm(model.total / 1000)} · {reachedStops.length}/{model.stops.length} 个地点
              {data.planned && ' · 虚线为计划路线'}
            </p>
          </div>
          <Link
            to={together ? '/together' : `/trips/${id}`}
            className="rounded-full bg-white/10 p-2 backdrop-blur hover:bg-white/20"
            aria-label="退出回放"
          >
            <X className="size-5" />
          </Link>
        </div>
      </div>

      {/* 当前地点卡片 */}
      {current && !done && (
        <div
          key={current.key}
          className="glass-dark animate-slide-up absolute bottom-[calc(7rem+env(safe-area-inset-bottom))] left-1/2 w-[min(92vw,380px)] -translate-x-1/2 overflow-hidden rounded-3xl ring-1 ring-white/10"
        >
          <div className="flex gap-3 p-3">
            {current.photo && <img src={current.photo} alt="" className="size-20 shrink-0 rounded-2xl object-cover" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs text-white/50">
                <span className="size-2 rounded-full" style={{ background: current.color }} />
                {current.tag ?? `第 ${current.index + 1} 站`}
              </div>
              <div className="mt-0.5 truncate font-bold">{current.name}</div>
              {current.sub && <div className="truncate text-xs text-white/60">{current.sub}</div>}
              {current.verdict && <VerdictBadge verdict={current.verdict as never} className="mt-1 !ring-0" />}
            </div>
          </div>
          {current.note && <p className="line-clamp-2 px-3 pb-3 text-xs leading-relaxed text-white/70">{current.note}</p>}
        </div>
      )}

      {/* 结束 */}
      {done && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm">
          <div className="animate-slide-up w-full max-w-sm rounded-3xl bg-white/10 p-6 text-center ring-1 ring-white/15 backdrop-blur-xl">
            {together && <Heart className="mx-auto mb-2 size-10 fill-pink-400 text-pink-400" />}
            <h2 className="text-xl font-bold">{together ? '我们的足迹还在继续' : '旅程回放结束'}</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-white/10 p-3">
                <div className="text-2xl font-extrabold">{model.stops.length}</div>
                <div className="text-xs text-white/60">个地点</div>
              </div>
              <div className="rounded-2xl bg-white/10 p-3">
                <div className="text-2xl font-extrabold">{formatKm(model.total / 1000)}</div>
                <div className="text-xs text-white/60">里程</div>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <button type="button" onClick={restart} className="flex items-center gap-1.5 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-ink-900">
                <RotateCcw className="size-4" />
                再看一次
              </button>
              {!together && trip && (
                <button
                  type="button"
                  onClick={() => setShare(true)}
                  className="flex items-center gap-1.5 rounded-full bg-white/15 px-5 py-2.5 text-sm font-semibold"
                >
                  <Share2 className="size-4" />
                  分享
                </button>
              )}
              <Link to={together ? '/together' : `/trips/${id}`} className="rounded-full bg-white/15 px-5 py-2.5 text-sm font-semibold">
                返回
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* 控制条 */}
      <div className="pb-safe absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 pt-10">
        <div className="mx-auto flex max-w-2xl items-center gap-3 pb-4">
          <button
            type="button"
            onClick={() => (done ? restart() : setPlaying((p) => !p))}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-white text-ink-900 shadow-lg"
            aria-label={playing ? '暂停' : '播放'}
          >
            {playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
          </button>
          <input
            type="range"
            min={0}
            max={model.duration}
            step={0.01}
            value={time}
            onChange={(e) => {
              setTime(Number(e.target.value))
              setPlaying(false)
            }}
            className={cn('h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-white/20', together ? 'accent-pink-400' : 'accent-brand-400')}
            aria-label="进度"
          />
          <button
            type="button"
            onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))}
            className="w-12 shrink-0 rounded-full bg-white/15 py-1.5 text-xs font-bold tabular-nums"
          >
            {speed}x
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
