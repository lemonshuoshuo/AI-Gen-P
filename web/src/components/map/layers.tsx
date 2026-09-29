import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LngLatBounds, Marker, type GeoJSONSource, type Map as MLMap } from 'maplibre-gl'
import type { Feature, FeatureCollection, LineString } from 'geojson'
import { Bike, Bus, Car, Footprints, type LucideIcon } from 'lucide-react'
import type { LegMode, Waypoint } from '@/api/types'
import { cn } from '@/lib/cn'
import { haversine } from '@/lib/geo'
import { categoryOf } from '@/lib/meta'
import { useMap } from './BaseMap'

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

/* ---------------- 路线：计划（黛青虚线）/ 实际（朱砂实线，夜间为金色）/ GPS 轨迹（赭黄） ---------------- */
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
  dark?: boolean
}) {
  const map = useMap()
  useEffect(() => {
    if (!map) return
    const P = idPrefix
    upsertSource(map, `${P}-planned`, fc(planned && planned.length > 1 ? [lineFeature(planned)] : []))
    upsertSource(map, `${P}-actual`, fc(actual && actual.length > 1 ? [lineFeature(actual)] : []), { lineMetrics: true })
    upsertSource(map, `${P}-track`, fc((track ?? []).filter((s) => s.length > 1).map((s) => lineFeature(s))))
    if (!map.getLayer(`${P}-planned`)) {
      map.addLayer({
        id: `${P}-planned`,
        type: 'line',
        source: `${P}-planned`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': dark ? '#88a8b0' : '#7aa1ab', 'line-width': 2, 'line-dasharray': [2, 2.2], 'line-opacity': 0.85 },
      })
      map.addLayer({
        id: `${P}-track`,
        type: 'line',
        source: `${P}-track`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#cfa35e', 'line-width': 2.5, 'line-opacity': 0.8 },
      })
      map.addLayer({
        id: `${P}-actual-casing`,
        type: 'line',
        source: `${P}-actual`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': dark ? '#0b1112' : '#0b0b0a', 'line-width': 6.5, 'line-opacity': 0.85 },
      })
      map.addLayer({
        id: `${P}-actual`,
        type: 'line',
        source: `${P}-actual`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': 3.25,
          'line-gradient': dark
            ? ['interpolate', ['linear'], ['line-progress'], 0, '#c9a868', 1, '#e8cf94']
            : ['interpolate', ['linear'], ['line-progress'], 0, '#c4583c', 1, '#e58a6d'],
        },
      })
    }
  }, [map, planned, actual, track, idPrefix, dark])

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

/** 主题变化（<html> 的 class / data-theme / data-mode / style，或系统深浅色）时加一：地图（WebGL）上的颜色要按新主题重新解析 */
export function useThemeVersion() {
  const [v, setV] = useState(0)
  useEffect(() => {
    const bump = () => setV((x) => x + 1)
    const mo = new MutationObserver(bump)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-mode', 'style'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', bump)
    return () => {
      mo.disconnect()
      mq.removeEventListener('change', bump)
    }
  }, [])
  return v
}

const colorCache = new Map<string, string>()
let colorProbe: CanvasRenderingContext2D | null = null
const PROBE_SENTINEL = '#010203'

/**
 * 设计令牌（CSS 变量名，如 --color-sky-600）或任意 CSS 颜色 → WebGL 能用的 rgba()。
 * 用 1×1 画布读回像素：主题里写成 oklch() 等新格式的颜色也能用；解析不了时返回 fallback
 */
export function cssColor(v: string, fallback = 'rgba(148, 142, 132, 1)'): string {
  const raw = v.startsWith('--') ? getComputedStyle(document.documentElement).getPropertyValue(v).trim() : v
  if (!raw) return fallback
  const hit = colorCache.get(raw)
  if (hit) return hit
  let out = fallback
  try {
    colorProbe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    const ctx = colorProbe
    if (ctx) {
      ctx.fillStyle = PROBE_SENTINEL
      ctx.fillStyle = raw
      // 无效的颜色不会改变 fillStyle
      if (ctx.fillStyle !== PROBE_SENTINEL || raw.toLowerCase() === PROBE_SENTINEL) {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
        out = `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
      }
    }
  } catch {
    /* 忽略：用 fallback */
  }
  colorCache.set(raw, out)
  return out
}

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
      className={cn('flex size-[22px] items-center justify-center rounded-full border bg-paper shadow-card', dim && 'opacity-40')}
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
 * 按路段画路线（GET /trips/:id/legs?geometry=1 的 polyline）：计划为虚线、估算的路段为点线，实际走过的为带暗色描边的实线；
 * 颜色取自设计令牌，主题切换时重新解析。icons：在路段中点显示出行方式
 */
export function RouteSegments({ segments, idPrefix = 'seg', icons = true }: { segments: RouteSegment[]; idPrefix?: string; icons?: boolean }) {
  const map = useMap()
  const theme = useThemeVersion()
  useEffect(() => {
    if (!map) return
    const P = idPrefix
    const feats = (pred: (s: RouteSegment) => boolean) =>
      fc(segments.filter((s) => s.path.length > 1 && pred(s)).map((s) => lineFeature(s.path, { color: cssColor(s.color), dim: !!s.dim })))
    upsertSource(map, `${P}-planned`, feats((s) => s.kind === 'planned' && !s.estimated))
    upsertSource(map, `${P}-planned-est`, feats((s) => s.kind === 'planned' && !!s.estimated))
    upsertSource(map, `${P}-actual`, feats((s) => s.kind === 'actual'))
    const casing = cssColor('--color-paper', 'rgba(11, 11, 10, 1)')
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
  }, [map, segments, idPrefix, theme])

  useEffect(() => {
    return () => {
      if (!map) return
      const P = idPrefix
      removeLayers(map, [`${P}-actual`, `${P}-actual-casing`, `${P}-planned`, `${P}-planned-est`], [`${P}-planned`, `${P}-planned-est`, `${P}-actual`])
    }
  }, [map, idPrefix])
  return icons ? <ModeIcons segments={segments} /> : null
}

/* ---------------- 打卡点标记 ---------------- */
// 深色底图上反过来：已到达为象牙白实心，计划中为黑底虚线
const INK = '#f2eee6'
const PAPER = '#0b0b0a'
const VERMILION = '#cf6041'

/**
 * 印章式标记：已到达为墨色实心，计划中为虚线空心，跳过为淡灰；右下角小圆点是分类色，
 * 踩雷在右上角加朱砂记号。数字用 Cormorant。
 */
export function markerHtml(w: Pick<Waypoint, 'category' | 'planned' | 'status' | 'verdict'>, label: string, selected: boolean) {
  const cat = categoryOf(w.category).color
  const todo = w.planned && w.status === 'todo'
  const skipped = w.status === 'skipped'
  const size = selected ? 32 : 26
  const bg = skipped ? '#2a2926' : todo ? PAPER : selected ? VERMILION : INK
  const fg = skipped ? '#6b665e' : todo ? (selected ? VERMILION : INK) : PAPER
  const border = skipped ? '1.5px solid #4f4c46' : todo ? `1.5px dashed ${selected ? VERMILION : INK}` : `1.5px solid ${PAPER}`
  // anchor: 'bottom' 已经把元素底边（针尖）放在坐标上，内层不能再上移，否则标记会浮在路线顶点上方
  return `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center">
      <div style="
        position:relative;min-width:${size}px;height:${size}px;padding:0 6px;border-radius:999px;
        display:flex;align-items:center;justify-content:center;
        font:500 ${selected ? 15 : 13}px/1 'Cormorant Garamond Variable',Georgia,serif;font-variant-numeric:lining-nums;
        color:${fg};background:${bg};border:${border};
        box-shadow:0 1px 2px rgba(0,0,0,.4),0 6px 14px -4px rgba(0,0,0,.6);transition:all .15s">${label}
        ${skipped ? '' : `<span style="position:absolute;right:-2px;bottom:-2px;width:8px;height:8px;border-radius:999px;background:${cat};box-shadow:0 0 0 1.5px ${PAPER}"></span>`}
      </div>
      ${w.verdict === 'avoid' ? `<div style="position:absolute;top:-5px;right:-6px;width:14px;height:14px;border-radius:999px;background:${VERMILION};color:${PAPER};font:600 9px/14px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 1.5px ${PAPER}">✕</div>` : ''}
      <div style="width:1.5px;height:7px;background:${skipped ? '#4f4c46' : INK};opacity:.7"></div>
    </div>`
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

/* ---------------- 当前位置 ---------------- */
export function UserDot({ position, accuracy }: { position: LngLat | null; accuracy?: number }) {
  const map = useMap()
  const marker = useRef<Marker | null>(null)
  useEffect(() => {
    if (!map || !position) return
    if (!marker.current) {
      const el = document.createElement('div')
      el.innerHTML = `<div style="position:relative;width:18px;height:18px">
        <span class="animate-pulse-ring" style="position:absolute;inset:0;border-radius:999px;background:rgba(63,105,117,.4)"></span>
        <span style="position:absolute;inset:2px;border-radius:999px;background:#7aa1ab;border:3px solid #0b0b0a;box-shadow:0 0 0 1px rgba(242,238,230,.5),0 1px 6px rgba(0,0,0,.5)"></span>
      </div>`
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
