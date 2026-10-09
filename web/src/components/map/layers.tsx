import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LngLatBounds, Marker, type GeoJSONSource, type Map as MLMap } from 'maplibre-gl'
import type { Feature, FeatureCollection, LineString } from 'geojson'
import { Bike, Bus, Car, Footprints, type LucideIcon } from 'lucide-react'
import type { LegMode, Waypoint } from '@/api/types'
import { cn } from '@/lib/cn'
import { cssColor } from '@/lib/color'
import { haversine } from '@/lib/geo'
import { categoryOf } from '@/lib/meta'
import { onThemeChange } from '@/theme/runtime'
import { BASE_KIND_EVENT, useMap } from './BaseMap'
import { mapPalette, routeColors } from './style'

// 旧的引入路径（ReplayPage 等）：颜色解析已移到 @/lib/color，地图以外也能用
export { cssColor }

type LngLat = [number, number]

export function fitTo(map: MLMap, points: LngLat[], opts: { padding?: number; maxZoom?: number; duration?: number } = {}) {
  const pts = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
  if (!pts.length) return
  const { padding = 60, maxZoom = 15, duration = 800 } = opts
  if (pts.length === 1) {
    map.easeTo({ center: pts[0], zoom: Math.min(maxZoom, 14), duration })
    return
  }
  const b = new LngLatBounds(pts[0], pts[0])
  pts.forEach((p) => b.extend(p))
  const w = map.getContainer().clientWidth
  const pad = Math.min(padding, Math.max(16, w / 8))
  map.fitBounds(b, { padding: pad, maxZoom, duration })
}

export function lineFeature(path: LngLat[], props: Record<string, unknown> = {}): Feature<LineString> {
  return { type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: path } }
}

export function fc<T extends Feature>(features: T[]): FeatureCollection {
  return { type: 'FeatureCollection', features }
}

/** 创建或更新 GeoJSON 数据源 */
export function upsertSource(map: MLMap, id: string, data: FeatureCollection | Feature, extra: Record<string, unknown> = {}) {
  const src = map.getSource(id) as GeoJSONSource | undefined
  if (src) src.setData(data)
  else map.addSource(id, { type: 'geojson', data, ...extra })
}

export function removeLayers(map: MLMap, layers: string[], sources: string[] = []) {
  if (!map.getStyle()) return
  layers.forEach((l) => map.getLayer(l) && map.removeLayer(l))
  sources.forEach((s) => map.getSource(s) && map.removeSource(s))
}

/* ---------------- 主题：WebGL 里的颜色要在主题变化后重新解析 ---------------- */

/** 主题或深浅色变化时加一（'triphub:theme' 事件）：地图（WebGL）、画布上的颜色要按新主题重新解析 */
export function useThemeVersion() {
  const [v, setV] = useState(0)
  useEffect(() => onThemeChange(() => setV((x) => x + 1)), [])
  return v
}

/**
 * 这张地图上的 WebGL 颜色要重新解析的时刻：换了主题 / 深浅色，或换了底图
 * （夜色底图的容器是深色局部主题，令牌按容器读取）。放进画图层的 effect 依赖里
 */
export function useMapPaintKey(map: MLMap | null) {
  const theme = useThemeVersion()
  const [kind, setKind] = useState(0)
  useEffect(() => {
    if (!map) return
    const el = map.getContainer()
    const bump = () => setKind((x) => x + 1)
    el.addEventListener(BASE_KIND_EVENT, bump)
    return () => el.removeEventListener(BASE_KIND_EVENT, bump)
  }, [map])
  return `${theme}:${kind}`
}

/** 在地图容器上读设计令牌（夜色底图的容器是深色局部主题）→ WebGL 用的 rgba() */
const mapColor = (map: MLMap, token: string, fallback?: string) => cssColor(token, fallback, map.getContainer())

/* ---------------- 路线：实际（强调色实线，带纸色描边）/ 计划（计划色虚线）/ GPS 轨迹（主题的轨迹色） ---------------- */
function routePaint(map: MLMap, dark?: boolean) {
  // 夜色底图（3D 回放）：该主题夜色的路线色，任何模式下都一样
  if (dark) return { ...routeColors('dark'), casing: mapPalette('dark').bg }
  const r = routeColors()
  return {
    actual: mapColor(map, '--route-actual', r.actual),
    planned: mapColor(map, '--route-planned', r.planned),
    track: mapColor(map, '--route-track', r.track),
    casing: mapColor(map, '--color-paper', mapPalette().bg),
  }
}

export function RouteLines({
  planned,
  actual,
  track,
  idPrefix = 'route',
  dark,
}: {
  planned?: LngLat[]
  actual?: LngLat[]
  track?: LngLat[][]
  idPrefix?: string
  /** 画在夜色底图上（用该主题的夜色路线色） */
  dark?: boolean
}) {
  const map = useMap()
  const paintKey = useMapPaintKey(map)
  useEffect(() => {
    if (!map) return
    const P = idPrefix
    upsertSource(map, `${P}-planned`, fc(planned && planned.length > 1 ? [lineFeature(planned)] : []))
    upsertSource(map, `${P}-actual`, fc(actual && actual.length > 1 ? [lineFeature(actual)] : []))
    upsertSource(map, `${P}-track`, fc((track ?? []).filter((s) => s.length > 1).map((s) => lineFeature(s))))
    if (!map.getLayer(`${P}-planned`)) {
      map.addLayer({
        id: `${P}-planned`,
        type: 'line',
        source: `${P}-planned`,
        layout: { 'line-join': 'round' },
        paint: { 'line-width': 2.5, 'line-dasharray': [1.2, 1.6], 'line-opacity': 0.9 },
      })
      map.addLayer({
        id: `${P}-track`,
        type: 'line',
        source: `${P}-track`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-width': 2, 'line-opacity': 0.9 },
      })
      map.addLayer({
        id: `${P}-actual-casing`,
        type: 'line',
        source: `${P}-actual`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-width': 6.5, 'line-opacity': 0.8 },
      })
      map.addLayer({
        id: `${P}-actual`,
        type: 'line',
        source: `${P}-actual`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-width': 3.5 },
      })
    }
    // 颜色每次按当前主题重设（新建图层、换主题、换底图）
    const c = routePaint(map, dark)
    map.setPaintProperty(`${P}-planned`, 'line-color', c.planned)
    map.setPaintProperty(`${P}-track`, 'line-color', c.track)
    map.setPaintProperty(`${P}-actual-casing`, 'line-color', c.casing)
    map.setPaintProperty(`${P}-actual`, 'line-color', c.actual)
  }, [map, planned, actual, track, idPrefix, dark, paintKey])

  useEffect(() => {
    return () => {
      if (!map) return
      const P = idPrefix
      removeLayers(map, [`${P}-actual`, `${P}-actual-casing`, `${P}-track`, `${P}-planned`], [
        `${P}-planned`,
        `${P}-actual`,
        `${P}-track`,
      ])
    }
  }, [map, idPrefix])
  return null
}

/* ---------------- 真实道路路线：按路段画，计划虚线 / 实际实线，每段自己的颜色，中点是出行方式图标 ---------------- */

/** 出行方式的图标与名称（路段中点、行程里的路段说明共用） */
export const LEG_MODE_ICONS: Record<LegMode, LucideIcon> = {
  walking: Footprints,
  riding: Bike,
  transit: Bus,
  driving: Car,
}
export const LEG_MODE_LABELS: Record<LegMode, string> = { walking: '步行', riding: '骑行', transit: '公交', driving: '驾车' }

/** 折线按长度的中点（放出行方式图标） */
function midpoint(path: LngLat[]): LngLat {
  if (path.length < 3) {
    const [a, b] = [path[0], path[path.length - 1]]
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  }
  const lens: number[] = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const d = haversine(path[i - 1], path[i])
    lens.push(d)
    total += d
  }
  let half = total / 2
  for (let i = 0; i < lens.length; i++) {
    if (half <= lens[i]) {
      const t = lens[i] ? half / lens[i] : 0
      const [a, b] = [path[i], path[i + 1]]
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
    half -= lens[i]
  }
  return path[path.length - 1]
}

export interface RouteSegment {
  /** 稳定的键 */
  id: string
  /** [[lng, lat], …]：高德的真实道路，估算的路段是起终点直线 */
  path: LngLat[]
  /** planned：计划（虚线）；actual：实际走过（实线） */
  kind: 'planned' | 'actual'
  /** 设计令牌（CSS 变量名）或 CSS 颜色：每天一种颜色 */
  color: string
  /** 按直线估算：点线 */
  estimated?: boolean
  /** 不是当前查看的那一天：变淡 */
  dim?: boolean
  /** 路段中点显示的出行方式图标 */
  mode?: LegMode
}

/** 出行方式小圆章：放在路段中点，屏幕上太短的路段不显示 */
function ModeBadge({ mode, color, dim }: { mode: LegMode; color: string; dim?: boolean }) {
  const Icon = LEG_MODE_ICONS[mode]
  const c = color.startsWith('--') ? `var(${color})` : color
  return (
    <span
      title={LEG_MODE_LABELS[mode]}
      className={cn('flex size-[22px] items-center justify-center rounded-full border bg-surface shadow-card', dim && 'opacity-40')}
      style={{ borderColor: c }}
    >
      <Icon className="size-3" strokeWidth={1.75} style={{ color: c }} />
    </span>
  )
}

function ModeIcons({ segments }: { segments: RouteSegment[] }) {
  const map = useMap()
  const withMode = useMemo(() => segments.filter((s) => s.mode && s.path.length > 1), [segments])
  const [slots, setSlots] = useState<{ el: HTMLDivElement; s: RouteSegment }[]>([])
  useEffect(() => {
    if (!map) return
    const list = withMode.map((s) => {
      const el = document.createElement('div')
      // 在打卡点标记之下，也不挡住地图点击（选点）
      el.style.zIndex = '0'
      el.style.pointerEvents = 'none'
      const m = new Marker({ element: el, anchor: 'center' }).setLngLat(midpoint(s.path)).addTo(map)
      return { el, s, m }
    })
    const fit = () => {
      for (const x of list) {
        const a = map.project(x.s.path[0])
        const b = map.project(x.s.path[x.s.path.length - 1])
        x.el.style.visibility = Math.hypot(a.x - b.x, a.y - b.y) < 60 ? 'hidden' : ''
      }
    }
    fit()
    map.on('zoomend', fit)
    setSlots(list)
    return () => {
      map.off('zoomend', fit)
      list.forEach((x) => x.m.remove())
    }
  }, [map, withMode])
  return <>{slots.map(({ el, s }) => createPortal(<ModeBadge mode={s.mode!} color={s.color} dim={s.dim} />, el, s.id))}</>
}

/**
 * 按路段画路线（GET /trips/:id/legs?geometry=1 的 polyline）：计划为虚线、估算的路段为点线，实际走过的为带纸色描边的实线；
 * 颜色取自设计令牌，换主题、换底图时重新解析。icons：在路段中点显示出行方式
 */
export function RouteSegments({ segments, idPrefix = 'seg', icons = true }: { segments: RouteSegment[]; idPrefix?: string; icons?: boolean }) {
  const map = useMap()
  const paintKey = useMapPaintKey(map)
  useEffect(() => {
    if (!map) return
    const P = idPrefix
    const feats = (pred: (s: RouteSegment) => boolean) =>
      fc(segments.filter((s) => s.path.length > 1 && pred(s)).map((s) => lineFeature(s.path, { color: mapColor(map, s.color), dim: !!s.dim })))
    upsertSource(map, `${P}-planned`, feats((s) => s.kind === 'planned' && !s.estimated))
    upsertSource(map, `${P}-planned-est`, feats((s) => s.kind === 'planned' && !!s.estimated))
    upsertSource(map, `${P}-actual`, feats((s) => s.kind === 'actual'))
    const casing = mapColor(map, '--color-paper', mapPalette().bg)
    if (!map.getLayer(`${P}-planned`)) {
      map.addLayer({
        id: `${P}-planned-est`,
        type: 'line',
        source: `${P}-planned-est`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['get', 'dim'], 2, 2.75],
          'line-dasharray': [0.1, 2],
          'line-opacity': ['case', ['get', 'dim'], 0.3, 0.9],
        },
      })
      map.addLayer({
        id: `${P}-planned`,
        type: 'line',
        source: `${P}-planned`,
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['get', 'dim'], 2, 3],
          'line-dasharray': [2.2, 1.4],
          'line-opacity': ['case', ['get', 'dim'], 0.32, 0.95],
        },
      })
      map.addLayer({
        id: `${P}-actual-casing`,
        type: 'line',
        source: `${P}-actual`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': casing, 'line-width': 6.5, 'line-opacity': 0.8 },
      })
      map.addLayer({
        id: `${P}-actual`,
        type: 'line',
        source: `${P}-actual`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 3.25, 'line-opacity': ['case', ['get', 'dim'], 0.4, 1] },
      })
    } else map.setPaintProperty(`${P}-actual-casing`, 'line-color', casing)
  }, [map, segments, idPrefix, paintKey])

  useEffect(() => {
    return () => {
      if (!map) return
      const P = idPrefix
      removeLayers(map, [`${P}-actual`, `${P}-actual-casing`, `${P}-planned`, `${P}-planned-est`], [`${P}-planned`, `${P}-planned-est`, `${P}-actual`])
    }
  }, [map, idPrefix])
  return icons ? <ModeIcons segments={segments} /> : null
}

/* ---------------- 打卡点标记 ----------------
 * 样式在 maplibre.css 的 .th-pin：颜色是主题的 --marker-* 令牌，形状每个主题一套
 * （手帐砖红邮戳、山野金色旗形胶囊、晴海白色浮标、暮色腮红圆点、夜航反色印章），切换主题时不用重建标记。
 * 已到达为实心，计划中为纸色底 + 虚线计划色圈，跳过为淡灰；右下角小圆点是分类色，踩雷在右上角加红色记号；
 * 选中：放大 + 外圈描边 + 浮起阴影。
 */
export type PinState = 'done' | 'todo' | 'skipped'

export const pinState = (w: Pick<Waypoint, 'planned' | 'status'>): PinState =>
  w.status === 'skipped' ? 'skipped' : w.planned && w.status === 'todo' ? 'todo' : 'done'

/** 标记外层的类名（MarkerFace / markerHtml 共用）；tone：带那一天颜色的细环（配合 --pin-tone） */
export function pinClass(state: PinState, o: { selected?: boolean; dim?: boolean; tone?: boolean } = {}) {
  return ['th-pin', state !== 'done' && `is-${state}`, o.selected && 'is-sel', o.dim && 'is-dim', o.tone && 'has-tone'].filter(Boolean).join(' ')
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/** 标记的 HTML（给 new Marker({ element }) 用；anchor: 'bottom' 时针尖正好在坐标上） */
export function markerHtml(w: Pick<Waypoint, 'category' | 'planned' | 'status' | 'verdict'>, label: string, selected: boolean) {
  const state = pinState(w)
  const cat = state === 'skipped' ? '' : `<span class="th-pin-cat" style="background:${categoryOf(w.category).css}"></span>`
  const avoid = w.verdict === 'avoid' ? '<span class="th-pin-avoid" aria-hidden="true">✕</span>' : ''
  return `<div class="${pinClass(state, { selected })}"><div class="th-pin-face">${escapeHtml(label)}${cat}${avoid}</div><div class="th-pin-tail"></div></div>`
}

/**
 * 同一套标记的 React 版本（放进 createPortal 渲染的标记元素里）。
 * tone：那一天的颜色（CSS 变量名或颜色），画成外圈细环；dim：不是当前查看的那一天
 */
export function MarkerFace({
  w,
  label,
  selected,
  dim,
  tone,
  title,
}: {
  w: Pick<Waypoint, 'category' | 'planned' | 'status' | 'verdict'>
  label: ReactNode
  selected?: boolean
  dim?: boolean
  tone?: string
  title?: string
}) {
  const state = pinState(w)
  const style = tone ? ({ '--pin-tone': tone.startsWith('--') ? `var(${tone})` : tone } as CSSProperties) : undefined
  return (
    <div className={pinClass(state, { selected, dim, tone: !!tone })} style={style} title={title}>
      <div className="th-pin-face">
        {label}
        {state !== 'skipped' && <span aria-hidden className="th-pin-cat" style={{ background: categoryOf(w.category).css }} />}
        {w.verdict === 'avoid' && (
          <span aria-hidden className="th-pin-avoid">
            ✕
          </span>
        )}
      </div>
      <div className="th-pin-tail" />
    </div>
  )
}

interface MarkerEntry {
  m: Marker
  el: HTMLDivElement
  w: Waypoint
  label: string
  sel: boolean
}

export function WaypointMarkers({
  waypoints,
  selectedId,
  onSelect,
  labels,
}: {
  waypoints: Waypoint[]
  selectedId?: number | null
  onSelect?: (w: Waypoint) => void
  /** 自定义标签（默认序号） */
  labels?: Record<number, string>
}) {
  const map = useMap()
  const markers = useRef<MarkerEntry[]>([])
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  // 选中状态通过 ref 读取：切换选中时只重绘前后两个标记，不必重建全部标记
  const selRef = useRef(selectedId)
  selRef.current = selectedId

  useEffect(() => {
    if (!map) return
    markers.current = waypoints.map((w, i) => {
      const label = labels?.[w.id] ?? String(i + 1)
      const sel = w.id === selRef.current
      const el = document.createElement('div')
      el.className = 'th-wp-marker'
      el.style.cursor = 'pointer'
      el.style.zIndex = sel ? '1' : ''
      el.innerHTML = markerHtml(w, label, sel)
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        onSelectRef.current?.(w)
      })
      const m = new Marker({ element: el, anchor: 'bottom' }).setLngLat([w.lng, w.lat]).addTo(map)
      return { m, el, w, label, sel }
    })
    return () => {
      markers.current.forEach((x) => x.m.remove())
      markers.current = []
    }
  }, [map, waypoints, labels])

  useEffect(() => {
    for (const x of markers.current) {
      const sel = x.w.id === selectedId
      if (x.sel === sel) continue
      x.sel = sel
      x.el.innerHTML = markerHtml(x.w, x.label, sel)
      x.el.style.zIndex = sel ? '1' : ''
    }
  }, [selectedId])
  return null
}

/* ---------------- 当前位置：主题的「当前」色圆点 + 脉冲（maplibre.css 的 .th-user-dot） ---------------- */
export function UserDot({ position, accuracy }: { position: LngLat | null; accuracy?: number }) {
  const map = useMap()
  const marker = useRef<Marker | null>(null)
  useEffect(() => {
    if (!map || !position) return
    if (!marker.current) {
      const el = document.createElement('div')
      el.innerHTML = '<div class="th-user-dot"><span class="th-user-dot-pulse animate-pulse-ring"></span><span class="th-user-dot-core"></span></div>'
      el.title = accuracy ? `精度约 ${Math.round(accuracy)} 米` : '当前位置'
      marker.current = new Marker({ element: el }).setLngLat(position).addTo(map)
    } else marker.current.setLngLat(position)
  }, [map, position, accuracy])
  useEffect(
    () => () => {
      marker.current?.remove()
      marker.current = null
    },
    [map],
  )
  return null
}

/** 自动缩放到给定点位（仅在 key 变化时触发） */
export function FitOnce({ points, fitKey, padding, maxZoom }: { points: LngLat[]; fitKey: string; padding?: number; maxZoom?: number }) {
  const map = useMap()
  const last = useRef<string>('')
  useEffect(() => {
    if (!map || !points.length || last.current === fitKey) return
    last.current = fitKey
    fitTo(map, points, { padding, maxZoom, duration: 0 })
  }, [map, points, fitKey, padding, maxZoom])
  return null
}
