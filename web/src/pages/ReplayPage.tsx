import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArcLayer, PathLayer } from '@deck.gl/layers'
import { TripsLayer } from '@deck.gl/geo-layers'
import type { Map as MLMap } from 'maplibre-gl'
import { Pause, PenLine, Play, RotateCcw, Route, Share2, X } from 'lucide-react'
import { api, isNotFound, type Footprints, type TrackData, type TripDetail, type TripLegs, type Waypoint } from '@/api'
import { rememberedShareCode } from '@/api/client'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { LEG_MODE_ICONS, LEG_MODE_LABELS, RouteLines, cssColor, useThemeVersion } from '@/components/map/layers'
import { useDeckOverlay } from '@/components/three/deck'
import {
  angleLerp,
  buildLegRoute,
  buildRoute,
  distanceAt,
  legAt,
  legBounds,
  pointAt,
  routeLength,
  slicePath,
  travelledAt,
  type PlacedStop,
  type ReplayLeg,
  type ReplayStop,
  type RouteModel,
  type TrailPart,
} from '@/components/three/replay'
import { joinLegs, legInputs, planSequence, sequenceLabels, useReplayLegs } from '@/components/three/replayLegs'
import { ACCENTS, Anchor, AvatarStack, MapOverlay, ModeBadge, StopPin, TravellerMarker, type Accent, type PinState, type Traveller } from '@/components/three/ReplayOverlay'
import { isLodging } from '@/components/trip/plan'
import { ShareDialog } from '@/components/trip/ShareDialog'
import { Button, Empty, LoadError, PageLoader, Spinner, VerdictBadge, buttonClass } from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { dateRange, fmtDate, fmtMinutes } from '@/lib/format'
import { bearing, formatDistance, formatKm } from '@/lib/geo'
import { categoryOf } from '@/lib/meta'
import { replayTrackParts, visitedInOrder } from '@/lib/trip'
import { useAuth } from '@/stores/auth'
import { useThemeScope } from '@/theme'

type LngLat = [number, number]
type RGB = [number, number, number]

/** deck.gl 图层的颜色（从设计令牌解析：随主题变化） */
interface Palette {
  /** 强调色：轨迹、光晕（夜色里是金色，「我们」是玫瑰色） */
  accent: RGB
  /** 轨迹主线：强调色略提亮 */
  line: RGB
  /** 彗星头：接近象牙白 */
  head: RGB
}

interface SceneProps {
  model: RouteModel
  time: number
  playing: boolean
  palette: Palette
  accent: Accent
  travellers: Traveller[]
  avatarSize: number
  arcs?: { from: LngLat; to: LngLat }[]
  /** 开场镜头：先看全程，停一会儿再飞到第一站 */
  intro: boolean
  onIntroDone: () => void
  /** 全程镜头的瓦片加载好了，可以揭开画面 */
  onShown: () => void
}

const CAMERA_SIDE_ANGLE = 18
// 回放的夜色底图完全去色：公园、绿地和道路标牌不再是橄榄绿 / 青色的色块
// 同时略微压暗文字和整体不透明度，让画面沉进夜色里，字幕和轨迹更突出
const REPLAY_TONE = { 'raster-saturation': -1, 'raster-contrast': -0.04, 'raster-brightness-min': 0.74, 'raster-opacity': 0.86 }
const FOLLOW_PITCH = 52
const OVERVIEW_PITCH = 42
const INTRO_HOLD = 1200 // 全程镜头停留（毫秒）

// 前方路线的淡线：从头像往前到下一站，离得越远越淡（分几段画出渐隐）
const GHOST_STEPS = [110, 84, 60, 38, 18]

const FALLBACK: Palette = { accent: [216, 176, 106], line: [226, 196, 140], head: [245, 232, 206] }

const mix = (a: RGB, b: RGB, k: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k)) as RGB

/** 读取回放容器（强制深色的局部）里的设计令牌 */
function readPalette(el: HTMLElement, accent: Accent): Palette {
  const cs = getComputedStyle(el)
  const rgb = (name: string, fb: RGB): RGB => {
    const raw = cs.getPropertyValue(name).trim()
    const m = raw ? cssColor(raw, '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/) : null
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : fb
  }
  const a = rgb(accent.v, FALLBACK.accent)
  const ink = rgb('--color-ink-900', [242, 238, 230])
  return { accent: a, line: mix(a, ink, 0.18), head: mix(a, ink, 0.72) }
}

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

/** 当前路段（上一站 → 下一站）的里程范围 */
function legRange(model: RouteModel, d: number): [number, number] {
  const reaches = [0, ...model.stops.map((s) => s.reach), model.total]
  for (let i = 1; i < reaches.length; i++) if (d <= reaches[i]) return [reaches[i - 1], reaches[i]]
  return [0, model.total]
}

/**
 * 跟随镜头：以头像为中心，按当前路段自适应缩放；画面下方留出字幕的位置。
 * 朝向取头像前后一小段路（按路段长度），真实道路弯弯绕绕时镜头不会左右乱晃
 */
function followView(map: MLMap, model: RouteModel, d: number, cache: Map<string, number>) {
  const head = pointAt(model, d)
  const [la, lb] = legRange(model, d)
  const win = Math.min(4000, Math.max(30, (lb - la) * 0.2, model.total * 0.004))
  const ahead = pointAt(model, Math.min(model.total, d + win))
  const behind = pointAt(model, Math.max(0, d - win * 0.5))
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
      padding: { top: h * 0.16, bottom: Math.max(0, h * 0.44 - (tp.bottom ?? 0)), left: side, right: side },
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
    // 上方留出片名，下方留出控制条；标记与头像立在点的上方，上边距多留一些
    { padding: { top: h * 0.24, bottom: h * 0.24, left: side, right: side }, maxZoom: 15.5, pitch: 0, bearing: 0 },
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

/** 淡线的数据：从头像往前到下一站（最多约一屏的距离），透明度逐段递减 */
function ghostPaths(model: RouteModel, d: number, stop: number | null, intro: boolean, maxLen: number) {
  if (intro || d >= model.total) return []
  // 前方是按直线估算的路段：底线已经是虚线，不再画一条实线
  if (model.legs.find((l) => d >= l.start - 0.5 && d < l.end)?.estimated) return []
  const reaches = model.stops.map((s) => s.reach)
  const next = reaches.find((r) => r > d + 1) ?? model.total
  const prev = [...reaches].reverse().find((r) => r <= d + 1) ?? 0
  // 停在某一站时镜头框的是刚走过的路段：前方的淡线也只画这么长
  const leg = stop != null ? prev - ([...reaches].reverse().find((r) => r < prev - 1) ?? 0) : next - prev
  const end = Math.min(next, d + Math.min(maxLen, Math.max(300, leg)))
  const n = GHOST_STEPS.length
  return GHOST_STEPS.flatMap((a, i) => slicePath(model, d + ((end - d) * i) / n, d + ((end - d) * (i + 1)) / n).map((path) => ({ path, a })))
}

function ReplayScene({ model, time, playing, palette, accent, travellers, avatarSize, arcs, intro, onIntroDone, onShown }: SceneProps) {
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
  const leg = legAt(model, d, stop)
  // 已到达的打卡点：reach 单调不减，已到达的一定是前缀
  let reachedCount = 0
  while (reachedCount < model.stops.length && model.stops[reachedCount].reach <= d + 1) reachedCount++

  // 开场：全程俯瞰（倾斜约 42°）→ 瓦片加载完后揭开画面 → 停留 1.2 秒 → 飞到第一站，那里的瓦片加载完再开始播放
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

  // 相机：跟随头像，按路段长度自适应缩放，停留时缓慢环绕
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
      // 与刷新率无关：缩放约 1 秒、朝向约 1.5 秒跟上
      const kz = 1 - 0.96 ** (dt * 60)
      const kb = 1 - 0.975 ** (dt * 60)
      c.zoom += (f.zoom - c.zoom) * kz
      // 镜头从侧后方跟随（偏转一定角度），头像不挡住前方的路
      c.bearing = moving ? angleLerp(c.bearing, bearing(f.behind, f.ahead) + CAMERA_SIDE_ANGLE, kb) : c.bearing + 6 * dt
    }
    map.jumpTo({ center: f.head, zoom: c.zoom, bearing: c.bearing, pitch: FOLLOW_PITCH, padding: f.padding })
  }, [map, model, d, stop, playing, intro])

  // deck.gl 图层：整条路线的底线、前方的淡线、走过的轨迹（光晕 + 主线 + 彗星尾）
  useEffect(() => {
    const o = overlay.current
    if (!o || !map) return
    const { accent: A, line: L, head: H } = palette
    const zoom = map.getZoom()
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
                getSourceColor: [...A, 90],
                getTargetColor: [...A, 150],
                getWidth: 1.25,
                getHeight: 0.6,
                greatCircle: false,
                updateTriggers: { getSourceColor: [palette], getTargetColor: [palette] },
              }),
            ]
          : []),
        // 整条路线的底线（很淡）：开场俯瞰时看出全程的形状，跟随时知道还要往哪里走；估算的直线更淡
        new PathLayer<TrailPart>({
          id: 'route-base',
          data: model.trails,
          getPath: (x) => x.path,
          getColor: (x) => [...A, x.estimated ? (intro ? 90 : 50) : intro ? 170 : 80],
          widthUnits: 'pixels',
          getWidth: (x) => (x.estimated ? 1.5 : intro ? 2.5 : 2),
          capRounded: true,
          jointRounded: true,
          updateTriggers: { getColor: [palette, intro], getWidth: [intro] },
        }),
        new PathLayer<{ path: LngLat[]; a: number }>({
          id: 'ghost',
          data: ghost,
          getPath: (x) => x.path,
          getColor: (x) => [...L, x.a],
          widthUnits: 'pixels',
          getWidth: 2,
          capRounded: true,
          jointRounded: true,
          updateTriggers: { getColor: [palette] },
        }),
        new TripsLayer<TrailPart>({
          id: 'trail-glow',
          data: model.trails,
          getPath: (x) => x.path,
          getTimestamps: (x) => x.timestamps,
          getColor: (x) => [...A, x.estimated ? 24 : 52],
          widthUnits: 'pixels',
          getWidth: 14,
          capRounded: true,
          jointRounded: true,
          fadeTrail: false,
          trailLength: model.total + 1,
          currentTime: d,
          updateTriggers: { getColor: [palette] },
        }),
        new TripsLayer<TrailPart>({
          id: 'trail',
          data: model.trails,
          getPath: (x) => x.path,
          getTimestamps: (x) => x.timestamps,
          getColor: (x) => [...L, x.estimated ? 150 : 255],
          widthUnits: 'pixels',
          getWidth: (x) => (x.estimated ? 2.25 : 3.5),
          capRounded: true,
          jointRounded: true,
          fadeTrail: false,
          trailLength: model.total + 1,
          currentTime: d,
          updateTriggers: { getColor: [palette] },
        }),
        new TripsLayer<TrailPart>({
          id: 'comet',
          data: model.trails,
          getPath: (x) => x.path,
          getTimestamps: (x) => x.timestamps,
          getColor: [...H, 255],
          widthUnits: 'pixels',
          getWidth: 5,
          capRounded: true,
          fadeTrail: true,
          trailLength: Math.max(80, model.total * 0.035),
          currentTime: d,
          updateTriggers: { getColor: [palette] },
        }),
      ],
    })
  }, [overlay, map, model, d, stop, palette, arcs, intro])

  const head = pointAt(model, d)
  // 停在某一站（含开场与结束时）：头像让到一边，露出这一站的标记
  const atStop = intro || stop != null || model.stops.some((s) => Math.abs(s.reach - d) < 0.5)
  const pinState = (s: PlacedStop): PinState => (intro ? 'upcoming' : stop === s.index ? 'current' : s.index < reachedCount ? 'reached' : 'upcoming')
  return (
    <MapOverlay>
      {model.legs.map((l) =>
        l.mode ? (
          <Anchor
            key={`leg-${l.from}`}
            id={`leg-${l.from}`}
            // 正在走的这一段：图标在头像上
            at={leg === l ? null : l.mid}
            anchor="center"
            depth
            z={2}
            span={[pointAt(model, l.start), pointAt(model, l.end)]}
            minSpan={72}
          >
            <ModeBadge mode={l.mode} done={d >= l.end} accent={accent} />
          </Anchor>
        ) : null,
      )}
      {model.stops.map((s) => {
        const state = pinState(s)
        return (
          <Anchor key={s.key} id={`stop-${s.key}`} at={[s.lng, s.lat]} depth z={state === 'current' ? 30 : state === 'reached' ? 20 : 10}>
            <StopPin stop={s} state={state} accent={accent} />
          </Anchor>
        )
      })}
      <Anchor id="traveller" at={head} z={50}>
        <TravellerMarker users={travellers} mode={leg?.mode ?? null} accent={accent} size={avatarSize} aside={atStop} />
      </Anchor>
    </MapOverlay>
  )
}

/* ---------------- 数据 → 回放模型 ---------------- */
function travellersOf(trip: TripDetail): Traveller[] {
  const seen = new Set<number>()
  return [trip.author, ...(trip.members ?? [])].filter((u) => !!u && !seen.has(u.id) && !!seen.add(u.id))
}

function stopTag(w: Waypoint, byDay: boolean) {
  if (isLodging(w)) return w.day > 0 ? `第 ${w.day} 晚 · 住宿` : '出发前一晚 · 住宿'
  return byDay && w.day > 0 ? `第 ${w.day} 天` : undefined
}

/**
 * plan：路线预览（规划时用）——按计划的每天路线（前一晚住宿 → 当天游玩点 → 当晚住宿），不看打卡和 GPS 轨迹；
 * 回放：按实际打卡顺序（有 GPS 轨迹时沿轨迹）。两站之间是高德规划的真实路线，没有的按直线估算
 */
function tripToReplay(trip: TripDetail, trackData: TrackData | undefined, legs: TripLegs | undefined, compare: boolean, plan: boolean) {
  const planned = planSequence(trip)
  const visited = plan ? [] : visitedInOrder(trip.waypoints).map((w) => ({ w, ids: [w.id] }))
  const seq = plan || !visited.length ? planned : visited
  const labels = sequenceLabels(seq.map((x) => x.w))
  const byDay = seq.some((x) => x.w.day > 0 && !isLodging(x.w))
  const photoBy = new Map<number, string>()
  trip.photos.forEach((p) => p.waypoint_id && !photoBy.has(p.waypoint_id) && photoBy.set(p.waypoint_id, p.thumb_url || p.url))
  const stops: ReplayStop[] = seq.map(({ w }) => ({
    key: String(w.id),
    lng: w.lng,
    lat: w.lat,
    name: w.name,
    color: categoryOf(w.category).color,
    sub: [w.city, w.district].filter(Boolean).join(' · '),
    note: w.note,
    photo: photoBy.get(w.id),
    verdict: plan ? undefined : w.verdict,
    tag: stopTag(w, byDay),
    t: !plan && w.arrived_at ? Date.parse(w.arrived_at) : undefined,
    kind: isLodging(w) ? 'lodging' : 'stop',
    label: labels.get(w.id),
    // 住宿的颜色跟着它所在的那一天（出发前一晚算第 1 天）
    day: byDay ? (isLodging(w) ? Math.max(1, w.day) : w.day) : 0,
  }))
  const travel = trip.travel_mode ?? 'auto'
  const inputs = legInputs(seq, legs?.legs, travel)
  const track = plan ? [] : replayTrackParts(trackData)
  const model = track.length
    ? // 有 GPS 轨迹：沿轨迹回放，路段只提供出行方式（计划的用时不代表实际，不显示）
      buildRoute(
        track.map((s) => s.path),
        stops,
        { times: track.map((s) => s.times), legs: inputs.map((l) => ({ ...l, duration_s: 0 })) },
      )
    : buildLegRoute(stops, inputs)
  const plannedLine = compare && !plan && planned.length > 1 ? joinLegs(planned, legInputs(planned, legs?.legs, travel)) : undefined
  return { model, planned: plannedLine, track: track.length > 0 }
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
  const sparse = (step > 1 ? stops.filter((_, i) => i % step === 0) : stops).map((s, i) => ({ ...s, label: String(i + 1) }))
  return { model: buildRoute(parts, sparse, { dwell: 1.4 }), arcs }
}

/* ---------------- 进度条：细线轨道 + 每一站的刻度 ---------------- */
function Scrubber({
  model,
  time,
  onSeek,
  reached,
  accent,
}: {
  model: RouteModel
  time: number
  onSeek: (t: number) => void
  reached: number
  accent: Accent
}) {
  const ticks = useMemo(() => {
    const seen = new Set<number>()
    return model.timeline.filter((x) => x.stop != null && !seen.has(x.stop) && seen.add(x.stop)).map((x) => x.t / model.duration)
  }, [model])
  const k = Math.min(1, time / (model.duration || 1))
  return (
    <div className="relative h-10 flex-1">
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-ink-900/20" />
      <div className={cn('absolute top-1/2 left-0 h-px -translate-y-1/2', accent.bg)} style={{ width: `${k * 100}%` }} />
      {ticks.map((x, i) => (
        <span
          key={i}
          className={cn('absolute top-1/2 h-2.5 w-px -translate-y-1/2', i < reached ? accent.bg : 'bg-ink-900/30')}
          style={{ left: `${x * 100}%` }}
        />
      ))}
      <span
        className={cn('pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 ring-night', accent.bg)}
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
      <span className="pointer-events-none absolute inset-x-0 -inset-y-0.5 hidden rounded-sm ring-1 ring-ink-900/50 peer-focus-visible:block" />
    </div>
  )
}

/* ---------------- 字幕：到达一站（照片 + 地名）/ 在路上（出行方式、用时、路程） ---------------- */
function StopCaption({ stop, count }: { stop: PlacedStop; count: number }) {
  const lodging = stop.kind === 'lodging'
  return (
    <div className="flex items-end gap-4 sm:gap-5">
      {stop.photo && (
        <img src={stop.photo} alt="" className="h-24 w-[4.8rem] shrink-0 rounded-sm object-cover ring-1 ring-ink-900/15 sm:h-32 sm:w-[6.4rem] [@media(max-height:480px)]:hidden" />
      )}
      <div className="min-w-0 pb-0.5">
        <p className="eyebrow flex items-center gap-2">
          <span className="size-1.5 shrink-0 rounded-full bg-ink-700" />
          {lodging ? (
            <span className="truncate normal-case">{stop.tag ?? '住宿'}</span>
          ) : (
            <>
              <span className="font-num">No. {String(stop.label ?? stop.index + 1).padStart(2, '0')}</span>
              <span className="text-ink-400">·</span>
              <span className="truncate normal-case">{stop.tag ?? `共 ${count} 站`}</span>
            </>
          )}
        </p>
        <h2 className="font-display mt-1.5 line-clamp-2 text-[1.375rem] leading-[1.15] font-normal text-ink-900 sm:text-[1.875rem]">{stop.name}</h2>
        {stop.sub && <p className="mt-1.5 truncate text-[13px] text-ink-600">{stop.sub}</p>}
        {stop.verdict && <VerdictBadge verdict={stop.verdict as never} className="mt-2 [@media(max-height:480px)]:hidden" />}
        {stop.note && <p className="mt-1.5 line-clamp-2 max-w-md text-[13px] leading-relaxed text-ink-700 [@media(max-height:480px)]:hidden">{stop.note}</p>}
      </div>
    </div>
  )
}

function LegCaption({ leg, next, plan, accent }: { leg: ReplayLeg; next?: PlacedStop; plan: boolean; accent: Accent }) {
  const Icon = leg.mode ? LEG_MODE_ICONS[leg.mode] : Route
  const approx = leg.estimated ? '约 ' : ''
  // 预览里强调「推荐」：自动模式下每段用的就是推荐的方式；指定了方式但推荐的不同时另外提示
  const recommended = plan && leg.mode && leg.recommended === leg.mode
  const suggest = leg.recommended && leg.mode && leg.recommended !== leg.mode ? leg.recommended : null
  return (
    <div className="flex items-center gap-3.5">
      <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-full border-[1.5px] bg-night/60 backdrop-blur-sm', accent.border, accent.text)}>
        <Icon className="size-5" strokeWidth={1.5} />
      </span>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-ink-900">
          {recommended && (
            <span className={cn('rounded-full border px-1.5 py-px text-[11px] leading-4 tracking-wide', accent.border, accent.text)}>推荐</span>
          )}
          <span className="font-medium">{leg.mode ? LEG_MODE_LABELS[leg.mode] : '路程'}</span>
          {leg.duration_s > 0 && (
            <span className="font-num text-ink-800">
              {approx}
              {fmtMinutes(leg.duration_s)}
            </span>
          )}
          <span className="text-ink-400">·</span>
          <span className="font-num text-ink-800">
            {approx}
            {formatDistance(leg.distance_m)}
          </span>
        </p>
        <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-ink-600">
          {next && <span className="truncate">前往 {next.name}</span>}
          {suggest && <span className="text-ink-500">推荐{LEG_MODE_LABELS[suggest]}</span>}
          {leg.estimated && <span className="text-ink-500">按直线估算</span>}
        </p>
      </div>
    </div>
  )
}

/** 结束卡片上的统计：大号细字数字 + 小单位 */
function Stat({ label, value, unit, className }: { label: string; value: string | number; unit: string; className?: string }) {
  return (
    <div className={cn('pt-4', className)}>
      <div className="text-xs text-ink-500">{label}</div>
      <div className="mt-2.5 flex items-baseline justify-center gap-1">
        <span className="font-num text-[2rem] leading-[0.9] font-light text-ink-900 sm:text-[2.5rem]">{value}</span>
        <span className="text-xs text-ink-500">{unit}</span>
      </div>
    </div>
  )
}

const splitKm = (m: number) => {
  const s = formatKm(m / 1000)
  return { value: s.replace(/ ?(公里|米)$/, ''), unit: s.endsWith('米') && !s.endsWith('公里') ? '米' : '公里' }
}

const splitDuration = (s: number) => (s < 3600 ? { value: String(Math.max(1, Math.round(s / 60))), unit: '分钟' } : { value: (s / 3600).toFixed(1), unit: '小时' })

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
  // 回放是夜色里的电影画面：任何主题、任何模式下界面都用该主题的深色令牌
  const scope = useThemeScope('dark')
  const themeV = useThemeVersion()
  const small = useMediaQuery('(max-width: 639px)')

  const tripQ = useQuery({ queryKey: ['trip', id], queryFn: () => api.trips.get(id!), enabled: !together })
  const trip = tripQ.data
  const trackQ = useQuery({
    queryKey: ['track', Number(id)],
    queryFn: () => api.trips.track(Number(id)),
    enabled: !together && !plan && !!trip?.has_track,
  })
  const fpQ = useQuery({ queryKey: ['partner-footprints'], queryFn: api.partner.footprints, enabled: together })
  const partnerQ = useQuery({ queryKey: ['partner'], queryFn: api.partner.get, enabled: together })
  // 两站之间的真实路线（高德）；服务端还在算时最多等约 10 秒
  const legsQ = useReplayLegs(trip, !together)
  // 开始播放时用的路段：之后才算好的路段不在播放中替换（路线会突然跳变），「再看一次」时换成最新的
  const [legsSnap, setLegsSnap] = useState<{ v: TripLegs | undefined } | null>(null)
  useEffect(() => {
    if (!together && trip && legsQ.settled && !legsSnap) setLegsSnap({ v: legsQ.data })
  }, [together, trip, legsQ.settled, legsQ.data, legsSnap])

  const data = useMemo(() => {
    if (together) return fpQ.data ? { ...footprintsToReplay(fpQ.data), planned: undefined, track: false } : null
    if (!trip || (!plan && trip.has_track && !trackQ.data) || !legsSnap) return null
    return { ...tripToReplay(trip, plan ? undefined : trackQ.data, legsSnap.v, compare, plan), arcs: undefined }
  }, [together, fpQ.data, trip, trackQ.data, compare, plan, legsSnap])

  const partner = partnerQ.data?.partner
  const travellers = useMemo<Traveller[]>(
    () => (together ? [me, partner].filter((u): u is NonNullable<typeof u> => !!u) : trip ? travellersOf(trip) : []),
    [together, me, partner, trip],
  )
  const accent = together ? ACCENTS.love : ACCENTS.gold
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)
  const [palette, setPalette] = useState<Palette>(FALLBACK)
  // 令牌在强制深色的容器上解析（提交到 DOM 之后再读，主题切换时重新读）
  useLayoutEffect(() => {
    if (rootEl) setPalette(readPalette(rootEl, accent))
  }, [rootEl, accent, themeV, scope['data-theme']])

  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [intro, setIntro] = useState(true)
  // 开场的全程镜头瓦片加载完之前，画面盖一层夜色（只露出片名），不露出一块块还没加载的瓦片
  const [shown, setShown] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [share, setShare] = useState(false)
  const qc = useQueryClient()
  const last = useRef<number | null>(null)
  const pageTitle = together ? partnerQ.data?.title || '我们一起走过的地方' : trip?.title
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

  const loading = together ? fpQ.isLoading : tripQ.isLoading || (!plan && trip?.has_track && trackQ.isLoading)
  if (loading)
    return (
      <div {...scope} className="bg-night min-h-dvh">
        <PageLoader label={plan ? '正在准备路线预览…' : '正在准备 3D 回放…'} />
      </div>
    )
  const err = together ? fpQ.error : (tripQ.error ?? trackQ.error)
  // 全屏页面没有顶栏和底部导航，直接打开链接时也要能返回（nav(-1) 无处可退）；
  // 从编辑页、旅程页进来时返回原处
  const backTo = together ? '/together' : plan && trip?.can_edit ? `/trips/${id}/edit` : `/trips/${id}`
  const canGoBack = loc.key !== 'default'
  const goBack = (e: MouseEvent) => {
    if (!canGoBack) return
    e.preventDefault()
    nav(-1)
  }
  // 旅程已加载、还在等高德算路线：先把地图和片名放出来
  const waiting = !data && !together && !!trip && !legsSnap && !err
  // 后台刷新失败时继续播放已加载的数据，404 说明旅程已删除或不再可见
  if ((!data && !waiting) || isNotFound(err))
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
  if (data && !data.model.stops.length && data.model.coords.length < 3)
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

  const model = data?.model
  const { d, stop } = model ? distanceAt(model, time) : { d: 0, stop: null }
  let reachedCount = 0
  while (model && reachedCount < model.stops.length && model.stops[reachedCount].reach <= d + 1) reachedCount++
  const leg = model && !intro ? legAt(model, d, stop) : null
  const current = !model || intro ? undefined : stop != null ? model.stops[stop] : leg ? undefined : model.stops[reachedCount - 1]
  const done = !!model && time >= model.duration
  const stopCount = model ? model.stops.filter((s) => s.kind !== 'lodging').length : 0
  const title = together ? partnerQ.data?.title || '我们一起走过的地方' : trip?.title
  const subtitle = together ? undefined : trip && dateRange(trip.start_date, trip.end_date)
  const eyebrow = plan ? 'Route preview · 路线预览' : together ? 'Together · 我们的足迹' : 'Replay · 旅程回放'
  const names = travellers.map((u) => u.nickname || u.username)
  const travellerText = together ? names.join(' & ') : names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 人` : names.join('、')
  const estimatedLegs = model ? model.legs.filter((l) => l.estimated).length : 0
  const routeNote = !model
    ? undefined
    : data?.track
      ? '沿 GPS 轨迹'
      : !model.legs.length
        ? undefined
        : estimatedLegs === 0
          ? '真实路线 · 高德路径规划'
          : estimatedLegs === model.legs.length
            ? '路线按直线估算'
            : `${estimatedLegs} 段按直线估算`
  const firstPoint: LngLat | undefined = model?.coords[0] ?? (trip?.waypoints[0] ? [trip.waypoints[0].lng, trip.waypoints[0].lat] : undefined)

  const restart = () => {
    setTime(0)
    setIntro(true)
    setPlaying(true)
    // 播放期间才算好的路段：重播时用上
    if (!together && legsQ.data && legsQ.data !== legsSnap?.v) setLegsSnap({ v: legsQ.data })
  }
  const seek = (t: number) => {
    if (!model) return
    setIntro(false)
    // 进度条按 0.01 秒取整，拖到最右端时也要算作播放结束
    setTime(t >= model.duration - 0.02 ? model.duration : t)
    setPlaying(false)
  }
  const togglePlay = () => {
    if (!model) return
    if (done) return restart()
    // 开场镜头中按暂停：跳过开场，停在第一站
    if (intro) {
      setIntro(false)
      setPlaying(false)
      return
    }
    setPlaying((p) => !p)
  }

  // 已走过的路程与全程：有路段时是道路里程（与结束时的「里程」一致）
  const totalM = model ? routeLength(model) : 0
  const nowM = model ? travelledAt(model, d) : 0
  const kmTotal = formatKm(totalM / 1000)
  const kmNowFull = formatKm(nowM / 1000)
  const unitOf = (x: string) => x.replace(/^[\d.,\s]+/, '')
  // 当前里程与全程单位相同时只写数字（12.3 / 184 公里），不同时各写各的单位（587 米 / 184 公里）
  const kmNow = unitOf(kmNowFull) === unitOf(kmTotal) ? kmNowFull.replace(/ ?(公里|米)$/, '') : kmNowFull
  const legSeconds = model ? model.legs.reduce((a, l) => a + l.duration_s, 0) : 0
  const lodgingCount = model ? model.stops.length - stopCount : 0

  return (
    <div ref={setRootEl} {...scope} className="bg-night fixed inset-0 overflow-hidden text-ink-900">
      {/* 地图版权信息：桌面抬到底部控制条上方；手机上放到右上角关闭按钮下方，不压在字幕上 */}
      {firstPoint && (
        <BaseMap
          className="absolute inset-0 sm:[&_.maplibregl-ctrl-bottom-right]:bottom-[calc(5.25rem+env(safe-area-inset-bottom))] max-sm:[&_.maplibregl-ctrl-bottom-right]:top-[calc(max(env(safe-area-inset-top),1rem)+7rem)] max-sm:[&_.maplibregl-ctrl-bottom-right]:bottom-auto"
          kind="dark"
          rasterTone={REPLAY_TONE}
          navigation={false}
          center={firstPoint}
          zoom={12}
          pitch={OVERVIEW_PITCH}
          options={{ maxPitch: 85 }}
        >
          {data?.planned && data.planned.length > 1 && <RouteLines planned={data.planned} idPrefix="replay-plan" dark />}
          {model && (
            <ReplayScene
              model={model}
              time={time}
              playing={playing}
              palette={palette}
              accent={accent}
              travellers={travellers}
              avatarSize={small ? 30 : 36}
              arcs={data?.arcs}
              intro={intro}
              onIntroDone={() => setIntro(false)}
              onShown={() => setShown(true)}
            />
          )}
        </BaseMap>
      )}
      <div
        aria-hidden={!waiting}
        className={cn(
          'bg-night pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-1000 ease-out',
          shown || !intro ? 'opacity-0' : 'opacity-100',
        )}
      >
        {waiting && (
          <div className="animate-fade-in flex flex-col items-center gap-3 px-8 text-center" role="status">
            <Spinner className="size-6 text-ink-500" />
            <p className="text-[14px] text-ink-800">正在规划真实路线…</p>
            <p className="text-xs text-ink-500">
              {legsQ.pending > 0 ? `高德路径规划中，还有 ${legsQ.pending} 段` : '按高德路径规划计算每一段路，稍等几秒'}
            </p>
          </div>
        )}
      </div>

      {/* 上下两道暗角：让画面上的小字看得清 */}
      <div className="from-night/90 via-night/45 pointer-events-none absolute inset-x-0 top-0 h-44 bg-gradient-to-b to-transparent" />
      <div className="from-night/95 via-night/55 pointer-events-none absolute inset-x-0 bottom-0 h-[42vh] bg-gradient-to-t to-transparent" />

      {/* 顶部：片名 */}
      <div className="animate-fade-in absolute inset-x-0 top-0 px-4 pt-[max(env(safe-area-inset-top),1rem)] sm:px-8 sm:pt-7 [@media(max-height:480px)]:pt-3">
        <div className="flex items-start gap-4">
          {/* 片尾字幕出现时片名淡出，不在模糊的背景里重复出现 */}
          <div className={cn('min-w-0 flex-1 transition-opacity duration-500', done && 'opacity-0')}>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="eyebrow">{eyebrow}</span>
              {subtitle && <span className="font-num text-[13px] text-ink-500">{subtitle}</span>}
            </p>
            <h1 className="font-display mt-1.5 truncate text-[1.5rem] leading-[1.2] font-normal text-ink-900 sm:mt-2 sm:text-[2.125rem] [@media(max-height:480px)]:mt-1 [@media(max-height:480px)]:text-[1.25rem]">{title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-500 [@media(max-height:480px)]:mt-1">
              {travellers.length > 0 && (
                <span className="flex min-w-0 items-center gap-2 [@media(max-height:480px)]:hidden">
                  <AvatarStack users={travellers} size={20} ringClass="ring-night" />
                  <span className="truncate text-ink-700">{travellerText}</span>
                </span>
              )}
              {model && (
                <span>
                  <span className="font-num text-[13px] text-ink-900">{kmNow}</span>
                  <span className="text-ink-400"> / </span>
                  <span className="font-num text-[13px]">{kmTotal}</span>
                </span>
              )}
              {routeNote && <span className="[@media(max-height:480px)]:hidden">{routeNote}</span>}
              {data?.planned && <span className="[@media(max-height:480px)]:hidden">虚线为计划路线</span>}
            </div>
          </div>
          <Link
            to={backTo}
            onClick={goBack}
            className="glass flex size-10 shrink-0 items-center justify-center rounded-full border border-ink-900/15 text-ink-800 transition-colors hover:border-ink-900/40 hover:text-ink-900"
            aria-label={plan ? '退出预览' : '退出回放'}
          >
            <X className="size-[18px]" strokeWidth={1.4} />
          </Link>
        </div>
      </div>

      {/* 字幕：到达一站时是照片 + 地名，在路上时是这一段的出行方式、用时和路程 */}
      {model && !done && (current || leg) && (
        <div
          key={leg ? `leg-${leg.from}` : `stop-${current?.key}`}
          className="animate-slide-up pointer-events-none absolute inset-x-4 bottom-[calc(6.25rem+env(safe-area-inset-bottom))] sm:right-auto sm:bottom-[calc(7.25rem+env(safe-area-inset-bottom))] sm:left-8 sm:max-w-[34rem] [@media(max-height:480px)]:bottom-[calc(5.25rem+env(safe-area-inset-bottom))]"
        >
          {leg ? <LegCaption leg={leg} next={model.stops[leg.to]} plan={plan} accent={accent} /> : current && <StopCaption stop={current} count={stopCount} />}
        </div>
      )}

      {/* 结束：片尾字幕 */}
      {model && done && (
        <div className="animate-fade-in bg-night/75 absolute inset-0 flex items-center justify-center p-6 backdrop-blur-[3px]">
          <div className="animate-slide-up w-full max-w-xl text-center">
            <p className="eyebrow">{plan ? 'Preview · 预览完毕' : together ? 'To be continued · 未完待续' : 'Fin · 回放结束'}</p>
            <h2 className="text-display-lg mt-4 font-normal text-balance text-ink-900">{title}</h2>
            <p className="mt-2.5 text-[13px] text-ink-600">
              {plan ? (lodgingCount ? `路线看完了 · 住 ${lodgingCount} 晚` : '路线看完了') : together ? '我们的足迹还在继续' : '旅程回放结束'}
            </p>
            <div className={cn('mx-auto mt-9 grid max-w-md border-t border-ink-900/15 [@media(max-height:480px)]:mt-5', plan && legSeconds > 0 ? 'grid-cols-3' : 'grid-cols-2')}>
              <Stat label="地点" value={stopCount} unit="个" />
              <Stat
                label={estimatedLegs && estimatedLegs === model.legs.length ? '里程（估算）' : '里程'}
                {...splitKm(totalM)}
                className="border-l border-ink-900/15"
              />
              {plan && legSeconds > 0 && <Stat label="路上约" {...splitDuration(legSeconds)} className="border-l border-ink-900/15" />}
            </div>
            <div className="mt-10 flex flex-wrap justify-center gap-2 [@media(max-height:480px)]:mt-6">
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
      {model && (
        <div className="pb-safe absolute inset-x-0 bottom-0 px-4 sm:px-8">
          <div className="flex items-center gap-4 pb-4 sm:gap-6 sm:pb-6 [@media(max-height:480px)]:pb-3">
            <button
              type="button"
              onClick={togglePlay}
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-ink-900 text-paper transition-opacity hover:opacity-90"
              aria-label={playing && !done ? '暂停' : '播放'}
            >
              {playing && !done ? <Pause className="size-4 fill-current" strokeWidth={1.5} /> : <Play className="ml-0.5 size-4 fill-current" strokeWidth={1.5} />}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-3 text-[11px] text-ink-500">
                <span className="shrink-0">
                  <span className="font-num text-[13px] text-ink-900">{String(reachedCount).padStart(2, '0')}</span>
                  <span className="font-num"> / {String(model.stops.length).padStart(2, '0')}</span>
                </span>
                <span className="min-w-0 flex-1 truncate text-ink-600">
                  {intro ? '全程' : leg ? `前往 ${model.stops[leg.to]?.name ?? ''}` : current ? current.name : '出发'}
                </span>
                <span className="font-num shrink-0">{kmTotal}</span>
              </div>
              <Scrubber model={model} time={time} onSeek={seek} reached={reachedCount} accent={accent} />
            </div>
            <button
              type="button"
              onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))}
              className="font-num flex size-11 shrink-0 items-center justify-center rounded-full border border-ink-900/20 text-[15px] text-ink-800 transition-colors hover:border-ink-900/45 hover:text-ink-900"
              aria-label={`播放速度 ${speed} 倍`}
            >
              {speed}×
            </button>
          </div>
        </div>
      )}

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
