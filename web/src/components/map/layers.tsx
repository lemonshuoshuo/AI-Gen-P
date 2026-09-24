import { useEffect, useRef } from 'react'
import { LngLatBounds, Marker, type GeoJSONSource, type Map as MLMap } from 'maplibre-gl'
import type { Feature, FeatureCollection, LineString } from 'geojson'
import type { Waypoint } from '@/api/types'
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

/* ---------------- 路线：计划（虚线）/ 实际（实线）/ GPS 轨迹 ---------------- */
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
        paint: { 'line-color': '#0ea5e9', 'line-width': 3, 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.9 },
      })
      map.addLayer({
        id: `${P}-track`,
        type: 'line',
        source: `${P}-track`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#8b5cf6', 'line-width': 3.5, 'line-opacity': 0.85 },
      })
      map.addLayer({
        id: `${P}-actual-casing`,
        type: 'line',
        source: `${P}-actual`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': dark ? '#000' : '#fff', 'line-width': 7, 'line-opacity': 0.8 },
      })
      map.addLayer({
        id: `${P}-actual`,
        type: 'line',
        source: `${P}-actual`,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': 4,
          'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#ff5a5f', 1, '#ff9a44'],
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

/* ---------------- 打卡点标记 ---------------- */
function markerHtml(w: Waypoint, label: string, selected: boolean) {
  const c = categoryOf(w.category).color
  const todo = w.planned && w.status === 'todo'
  const skipped = w.status === 'skipped'
  const color = skipped ? '#9895a5' : c
  // anchor: 'bottom' 已经把元素底边（针尖）放在坐标上，内层不能再上移，否则标记会浮在路线顶点上方
  return `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center">
      <div style="
        min-width:${selected ? 34 : 28}px;height:${selected ? 34 : 28}px;padding:0 6px;border-radius:999px;
        display:flex;align-items:center;justify-content:center;
        font:700 ${selected ? 14 : 12}px/1 system-ui,sans-serif;
        color:${todo ? color : '#fff'};background:${todo ? '#fff' : color};
        border:2.5px ${todo ? 'dashed' : 'solid'} ${todo ? color : '#fff'};
        box-shadow:0 2px 8px rgba(0,0,0,.25);
        ${selected ? 'outline:3px solid rgba(255,90,95,.45);' : ''}
        opacity:${skipped ? 0.7 : 1};transition:all .15s">${label}</div>
      ${w.verdict === 'avoid' ? '<div style="position:absolute;top:-6px;right:-8px;font-size:13px">⚠️</div>' : ''}
      <div style="width:2px;height:8px;background:${color};margin-top:-1px;border-radius:1px"></div>
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
        <span class="animate-pulse-ring" style="position:absolute;inset:0;border-radius:999px;background:rgba(14,165,233,.45)"></span>
        <span style="position:absolute;inset:2px;border-radius:999px;background:#0ea5e9;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.3)"></span>
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
