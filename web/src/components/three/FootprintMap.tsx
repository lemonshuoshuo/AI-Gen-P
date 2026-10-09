// 自适应足迹地图：默认镜头框住全部足迹；全国 → 省级 → 城市 / 街巷三档按缩放自动切换（见 LitProvinces 的 STAGE_ZOOM）
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { LngLatBounds, Marker, type ExpressionSpecification, type Map as MLMap, type MapMouseEvent } from 'maplibre-gl'
import type { Feature, LineString, Point } from 'geojson'
import { ArrowRight, Maximize2, Scan, X } from 'lucide-react'
import type { FootprintPoint, Footprints } from '@/api/types'
import { BaseMap, mapChipClass, useMap } from '@/components/map/BaseMap'
import { fc, markerHtml, removeLayers, upsertSource } from '@/components/map/layers'
import { setAutoDayZoom } from '@/components/map/style'
import { VerdictBadge } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fmtDate } from '@/lib/format'
import { CHINA_CENTER } from '@/lib/geo'
import { categoryOf } from '@/lib/meta'
import { useTheme, useThemeScope } from '@/theme'
import { LitPrefectures, LitProvinces, dayWindow, ensureSlot, stageOf, zoomShift, type Stage } from './LitProvinces'
import { CATEGORY_TOKENS, categoryToken, litVars, useLitPalette, withAlpha, type LitPalette, type LitTheme } from './palette'

type LngLat = [number, number]
const P = 'fp'
const SLOT = 'fp-slot'
const Z = ['zoom'] as unknown as number
const pinned = ['boolean', ['feature-state', 'pinned'], false] as ExpressionSpecification

/** 各档的镜头俯仰角：全国看立体省份，城市级为 2.5D 街景 */
const PITCH: Record<Stage, number> = { country: 40, region: 32, city: 50 }

// 触屏上单指滑动用来滚动页面（地图很高，否则很难滑到下面的内容），双指才拖动地图
const coarsePointer = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
export const mapGestureOptions = {
  cooperativeGestures: coarsePointer,
  locale: {
    'CooperativeGesturesHandler.MobileHelpText': '双指拖动可移动地图',
    'CooperativeGesturesHandler.WindowsHelpText': '按住 Ctrl 并滚动鼠标可缩放地图',
    'CooperativeGesturesHandler.MacHelpText': '按住 ⌘ 并滚动鼠标可缩放地图',
  },
}

/** 中国东西跨约 62 个经度：按容器宽度算出能放下全国的缩放级别 */
export function chinaZoom(map: MLMap) {
  const w = map.getContainer().clientWidth
  return Math.min(3.4, Math.log2(((w - 24) * 360) / (64 * 512)))
}

/** 框住全部足迹的镜头：只有一个地点时街道级（12 级）；跨省时自然缩到全国 */
function footprintCamera(map: MLMap, pts: LngLat[]) {
  if (!pts.length) return { center: CHINA_CENTER, zoom: chinaZoom(map) }
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
  if (maxX - minX < 0.004 && maxY - minY < 0.004) return { center: [(minX + maxX) / 2, (minY + maxY) / 2] as LngLat, zoom: 12 }
  const el = map.getContainer()
  const pad = Math.max(28, Math.min(72, el.clientWidth / 9))
  const cam = map.cameraForBounds(new LngLatBounds([minX, minY], [maxX, maxY]), {
    padding: { top: pad + 24, bottom: pad + 28, left: pad, right: pad },
    maxZoom: 13.5,
    pitch: 0,
    bearing: 0,
  })
  const zoom = Math.max(chinaZoom(map), cam?.zoom ?? 4)
  const c = cam?.center ? (cam.center as { lng: number; lat: number }) : { lng: (minX + maxX) / 2, lat: (minY + maxY) / 2 }
  return { center: [c.lng, c.lat] as LngLat, zoom }
}

function viewFor(map: MLMap, pts: LngLat[], shift: number) {
  const cam = footprintCamera(map, pts)
  // 倾斜后画面下半部分会放大，略微退后一点，避免边缘的点被裁掉
  let zoom = cam.zoom - (stageOf(cam.zoom, shift) === 'city' ? 0.25 : 0.1)
  // 不停在夜色与纸色的过渡带里：离纸色一侧很近时放大一点点（留白足够，点不会出画面），否则退到夜色一侧
  const [D0, D1] = dayWindow(shift)
  if (zoom > D0 && zoom < D1) zoom = D1 - zoom <= 0.25 ? D1 + 0.02 : D0 - 0.02
  const stage = stageOf(zoom, shift)
  return { ...cam, zoom, pitch: PITCH[stage], bearing: stage === 'country' ? -6 : 0 }
}

/** 两点之间一条向一侧弯曲的弧线（地面上的「航线」） */
function curve(a: LngLat, b: LngLat, n = 32): LngLat[] {
  const mx = (a[0] + b[0]) / 2
  const my = (a[1] + b[1]) / 2
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const cx = mx - dy * 0.22
  const cy = my + dx * 0.22
  const out: LngLat[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]])
  }
  return out
}

/* ---------------- 路线、弧线、足迹点（原生图层，缩放时由插值过渡） ---------------- */
const setPaint = (map: MLMap, layer: string, k: string, v: unknown) =>
  (map.setPaintProperty as (l: string, k: string, v: unknown) => void).call(map, layer, k, v)

/**
 * 路线、弧线、足迹点的颜色（主题令牌，见 ./palette）：夜色里是主题的路线色，城市级是当前模式底图上的路线色 + 纸色描边、
 * 分类色的点。主题变化时只重设这些颜色，不重建图层（照片标记下面那些点的 pinned 状态保留）
 */
function overlayPaint(pal: LitPalette, shift: number): Record<string, Record<string, unknown>> {
  const [D0, D1] = dayWindow(shift)
  const cat = ['match', ['get', 'cat'], ...Object.entries(pal.categories).flat(), pal.categories.other]
  return {
    [`${P}-arcs`]: { 'line-color': pal.line },
    [`${P}-trips-casing`]: { 'line-color': pal.casing },
    [`${P}-trips`]: { 'line-color': ['interpolate', ['linear'], Z, D0, pal.routeNight, D1, pal.routeDay] },
    [`${P}-pts-glow`]: { 'circle-color': pal.column },
    [`${P}-pts`]: {
      'circle-color': ['interpolate', ['linear'], Z, D0, pal.column, D1, cat],
      'circle-stroke-color': ['interpolate', ['linear'], Z, D0, withAlpha(pal.night, 0.5), D1, pal.casing],
    },
    [`${P}-pts-hit`]: { 'circle-color': pal.column },
  }
}

function FootprintOverlay({
  data,
  pal,
  shift,
  onStage,
  onPick,
  onFocus,
}: {
  data: Footprints
  pal: LitPalette
  shift: number
  onStage: (s: Stage) => void
  onPick: (i: number | null) => void
  onFocus: (pts: LngLat[], maxZoom: number) => void
}) {
  const map = useMap()
  const cb = useRef({ onStage, onPick, onFocus })
  cb.current = { onStage, onPick, onFocus }
  const palRef = useRef(pal)
  palRef.current = pal

  useEffect(() => {
    if (!map) return
    const z = (v: number) => v + shift
    const [D0, D1] = dayWindow(shift)
    const paint = overlayPaint(palRef.current, shift)
    ensureSlot(map, SLOT)
    const trips = [...data.trips].filter((t) => t.path.length).sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))
    const arcs: Feature<LineString>[] = []
    for (let i = 1; i < trips.length; i++) {
      const a = trips[i - 1].path[trips[i - 1].path.length - 1]
      const b = trips[i].path[0]
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.3) continue
      arcs.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: curve(a, b) } })
    }
    upsertSource(map, `${P}-arcs`, fc(arcs))
    upsertSource(
      map,
      `${P}-trips`,
      fc(
        trips
          .filter((t) => t.path.length > 1)
          .map((t) => ({ type: 'Feature', properties: { id: t.id }, geometry: { type: 'LineString', coordinates: t.path } }) as Feature<LineString>),
      ),
    )
    upsertSource(
      map,
      `${P}-pts`,
      fc(
        data.points.map(
          (p, i) =>
            ({
              type: 'Feature',
              id: i,
              properties: { i, cat: p.category in CATEGORY_TOKENS ? p.category : 'other', photo: p.photo_thumb_url ? 1 : 0 },
              geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
            }) as Feature<Point>,
        ),
      ),
    )
    const add = (layer: Parameters<MLMap['addLayer']>[0]) => {
      if (map.getLayer(layer.id)) map.removeLayer(layer.id)
      map.addLayer(layer)
    }
    // 旅程之间按时间先后连一条虚线弧（只在全国视图）
    add({
      id: `${P}-arcs`,
      type: 'line',
      source: `${P}-arcs`,
      layout: { 'line-cap': 'round' },
      paint: {
        ...paint[`${P}-arcs`],
        'line-width': 1.2,
        'line-dasharray': [1.5, 2.5],
        'line-opacity': ['interpolate', ['linear'], Z, z(3), 0.7, z(5.2), 0.55, z(6.2), 0],
      },
    })
    // 旅程路线：省级为主题路线色的细线，城市级为纸色描边 + 路线色实线
    add({
      id: `${P}-trips-casing`,
      type: 'line',
      source: `${P}-trips`,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        ...paint[`${P}-trips-casing`],
        'line-width': ['interpolate', ['linear'], Z, D0, 1, 12, 7],
        'line-opacity': ['interpolate', ['linear'], Z, D0, 0, D1, 0.9],
      },
    })
    add({
      id: `${P}-trips`,
      type: 'line',
      source: `${P}-trips`,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        ...paint[`${P}-trips`],
        'line-width': ['interpolate', ['linear'], Z, 5, 0.8, 8, 1.4, 10, 2.6, 14, 3.4],
        'line-opacity': ['interpolate', ['linear'], Z, z(5.2), 0, z(6.2), 0.6, D0, 0.75, D1, 0.95],
      },
    })
    // 足迹点：夜色下为路线色的小光点，城市级为带纸色描边的分类色圆点（大部分被照片 / 印章标记盖住）
    add({
      id: `${P}-pts-glow`,
      type: 'circle',
      source: `${P}-pts`,
      paint: {
        ...paint[`${P}-pts-glow`],
        'circle-radius': ['interpolate', ['linear'], Z, 6, 5, 8.5, 9],
        'circle-blur': 1,
        'circle-opacity': ['interpolate', ['linear'], Z, z(5.4), 0, z(6.4), 0.35, D0, 0.3, D1, 0],
      },
    })
    add({
      id: `${P}-pts`,
      type: 'circle',
      source: `${P}-pts`,
      paint: {
        ...paint[`${P}-pts`],
        'circle-radius': ['interpolate', ['linear'], Z, 6, 1.6, 8.5, 3, 13, 4.5],
        'circle-stroke-width': ['interpolate', ['linear'], Z, z(6), 0, z(8.5), 1.5],
        // 已经画成 DOM 标记的点（feature-state pinned）不再重复显示圆点
        'circle-opacity': ['interpolate', ['linear'], Z, z(5.4), 0, z(6.3), ['case', pinned, 0, 0.95]],
        'circle-stroke-opacity': ['interpolate', ['linear'], Z, z(5.4), 0, z(6.3), ['case', pinned, 0, 1]],
      },
    })
    // 透明的大圆，方便手指点中
    add({
      id: `${P}-pts-hit`,
      type: 'circle',
      source: `${P}-pts`,
      minzoom: z(6),
      paint: { ...paint[`${P}-pts-hit`], 'circle-radius': 14, 'circle-opacity': 0 },
    } as Parameters<MLMap['addLayer']>[0])
    return () => {
      removeLayers(map, [`${P}-pts-hit`, `${P}-pts`, `${P}-pts-glow`, `${P}-trips`, `${P}-trips-casing`, `${P}-arcs`], [
        `${P}-pts`,
        `${P}-trips`,
        `${P}-arcs`,
      ])
    }
  }, [map, data, shift])

  // 主题变化：只重设颜色（光源偏暖、从西南方向打来，立体省份的顶面更亮、侧面更深；颜色是主题的象牙白）
  useEffect(() => {
    if (!map) return
    for (const [id, paint] of Object.entries(overlayPaint(pal, shift)))
      if (map.getLayer(id)) for (const [k, v] of Object.entries(paint)) setPaint(map, id, k, v)
    map.setLight({ anchor: 'map', position: [1.3, 200, 38], color: pal.light, intensity: 0.42 })
  }, [map, pal, shift])

  // 缩放档位、自动俯仰、点击
  useEffect(() => {
    if (!map) return
    let stage = stageOf(map.getZoom(), shift)
    let pitched = stage
    let userPitched = false
    const onZoom = () => {
      const s = stageOf(map.getZoom(), shift)
      if (s !== stage) {
        stage = s
        cb.current.onStage(s)
      }
    }
    const [D0, D1] = dayWindow(shift)
    const onZoomEnd = () => {
      // 停在夜色与纸色的过渡带里时画面发灰：轻轻吸附到较近的一侧
      const z = map.getZoom()
      if (z > D0 && z < D1) {
        const target = z - D0 < D1 - z ? D0 - 0.02 : D1 + 0.02
        const s = stageOf(target, shift)
        if (!userPitched) pitched = s
        map.easeTo({ zoom: target, ...(userPitched ? {} : { pitch: PITCH[s] }), duration: 450 })
        return
      }
      if (userPitched || stage === pitched) return
      pitched = stage
      map.easeTo({ pitch: PITCH[stage], duration: 700 })
    }
    const onPitchStart = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) userPitched = true
    }
    // 点所在城市 / 省份：足迹点本身没有行政区编码，按城市名、省名对应到 cities / provinces 的编码
    const cityCode = new Map(data.cities.map((c) => [`${c.province}|${c.name}`, c.code]))
    const provCode = new Map(data.provinces.map((p) => [p.name, p.code]))
    const cityOfPoint = new Map(data.points.map((p) => [p, cityCode.get(`${p.province}|${p.city}`) ?? '']))
    const provinceOfPoint = new Map(data.points.map((p) => [p, provCode.get(p.province) ?? '']))
    const layers = () => [`${P}-pts-hit`, `${P}-pref-fill`, `${P}-ext`].filter((l) => map.getLayer(l))
    const onClick = (e: MapMouseEvent) => {
      const hit = map.queryRenderedFeatures(e.point, { layers: layers() })
      const pt = hit.find((f) => f.layer.id === `${P}-pts-hit`)
      if (pt && stage !== 'country') return cb.current.onPick(Number(pt.properties.i))
      cb.current.onPick(null)
      // 全国视图点省份、省级视图点城市：飞到这里的足迹
      const region = hit.find((f) => (f.layer.id === `${P}-pref-fill` && stage === 'region') || (f.layer.id === `${P}-ext` && stage === 'country'))
      if (!region) return
      const code = String(region.properties.id ?? '')
      const isProv = region.layer.id === `${P}-ext`
      const inside = data.points.filter((p) => {
        const c = (isProv ? provinceOfPoint : cityOfPoint).get(p)
        return c === code
      })
      if (inside.length) cb.current.onFocus(inside.map((p) => [p.lng, p.lat]), isProv ? 9.5 : 12)
    }
    let hovering = false
    const onMove = (e: MapMouseEvent) => {
      const f = map.queryRenderedFeatures(e.point, { layers: layers() })
      const h = f.some(
        (x) =>
          (x.layer.id === `${P}-pts-hit` && stage !== 'country') ||
          (x.layer.id === `${P}-pref-fill` && stage === 'region') ||
          (x.layer.id === `${P}-ext` && stage === 'country'),
      )
      if (h !== hovering) {
        hovering = h
        map.getCanvas().style.cursor = h ? 'pointer' : ''
      }
    }
    map.on('zoom', onZoom)
    map.on('zoomend', onZoomEnd)
    map.on('pitchstart', onPitchStart)
    map.on('click', onClick)
    if (!coarsePointer) map.on('mousemove', onMove)
    return () => {
      map.off('zoom', onZoom)
      map.off('zoomend', onZoomEnd)
      map.off('pitchstart', onPitchStart)
      map.off('click', onClick)
      map.off('mousemove', onMove)
    }
  }, [map, data, shift])
  return null
}

/* ---------------- DOM 标记：只画视口内、互不重叠的一部分 ---------------- */
interface Placed {
  i: number
  x: number
  y: number
  w: number
  h: number
  n: number
}

/**
 * 按优先级在屏幕上放置标记：与已放置的标记重叠就并入它（计数 +1），最多 cap 个。
 * 用网格加速，几千个点也只需几毫秒；只在移动结束时计算一次
 */
function declutter(map: MLMap, order: number[], pos: (i: number) => LngLat, size: (i: number) => [number, number], cap: number) {
  const el = map.getContainer()
  const W = el.clientWidth
  const H = el.clientHeight
  const cell = 64
  const grid = new Map<number, Placed[]>()
  const out: Placed[] = []
  for (const i of order) {
    const p = map.project(pos(i))
    if (p.x < -30 || p.x > W + 30 || p.y < -10 || p.y > H + 60) continue
    const [w, h] = size(i)
    const cx = Math.floor(p.x / cell)
    const cy = Math.floor(p.y / cell)
    let hit: Placed | null = null
    for (let gx = cx - 1; gx <= cx + 1 && !hit; gx++)
      for (let gy = cy - 1; gy <= cy + 1 && !hit; gy++)
        for (const q of grid.get(gx * 100_000 + gy) ?? [])
          if (Math.abs(q.x - p.x) < (q.w + w) / 2 && Math.abs(q.y - p.y) < (q.h + h) / 2) {
            hit = q
            break
          }
    if (hit) {
      hit.n++
      continue
    }
    if (out.length >= cap) continue
    const placed = { i, x: p.x, y: p.y, w, h, n: 0 }
    out.push(placed)
    const k = cx * 100_000 + cy
    grid.set(k, [...(grid.get(k) ?? []), placed])
  }
  return out
}

/*
 * DOM 标记的颜色、字体都写成主题的 CSS 变量：随地图外框上的主题作用域解析（城市级是当前模式，夜色里是深色），
 * 换主题时浏览器自动重算，不用重建标记
 */
const INK_A = (k: number) => `color-mix(in oklab,var(--color-ink-900) ${k}%,transparent)`
const SHADOW = '0 10px 22px -8px color-mix(in oklab,var(--color-night) 70%,transparent)'

function badgeHtml(n: number) {
  return n > 0
    ? `<span style="position:absolute;top:-7px;right:-9px;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--color-ink-900);color:var(--color-paper);font-family:var(--font-num);font-size:11px;line-height:18px;font-weight:500;font-variant-numeric:lining-nums;text-align:center;box-shadow:0 0 0 1.5px var(--color-paper)">+${n}</span>`
    : ''
}

/** 相框式照片标记：纸色细边框（像一张相纸）+ 下方细针，选中时边框为强调色 */
function photoPinHtml(url: string, selected: boolean, n: number, accent: string) {
  const frame = selected ? accent : 'var(--color-surface)'
  const s = selected ? 56 : 46
  return `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center">
      <div style="position:relative;width:${s}px;height:${Math.round(s * 1.2)}px;padding:2px;background:${frame};border-radius:3px;
        box-shadow:0 0 0 1px ${INK_A(selected ? 0 : 18)},${SHADOW};transition:all .2s">
        <img src="${url}" alt="" loading="lazy" decoding="async" draggable="false"
          style="display:block;width:100%;height:100%;object-fit:cover;border-radius:1.5px;background:var(--color-surface-2)"/>
        ${badgeHtml(n)}
      </div>
      <div style="width:1px;height:8px;background:${selected ? accent : INK_A(55)}"></div>
    </div>`
}

function sealPinHtml(p: FootprintPoint, label: string, selected: boolean, n: number) {
  return `<div style="position:relative">${markerHtml({ category: p.category, planned: false, status: 'visited', verdict: p.verdict }, label, selected)}${
    n > 0 ? `<div style="position:absolute;top:-4px;right:-4px">${badgeHtml(n).replace('top:-7px;right:-9px', 'top:-6px;right:-10px')}</div>` : ''
  }</div>`
}

function FootprintPins({
  points,
  labels,
  selected,
  onPick,
  accent,
}: {
  points: FootprintPoint[]
  labels: string[]
  selected: number | null
  onPick: (i: number) => void
  accent: string
}) {
  const map = useMap()
  const markers = useRef(new Map<number, { m: Marker; el: HTMLDivElement; n: number; sel: boolean }>())
  const selRef = useRef(selected)
  selRef.current = selected
  const pickRef = useRef(onPick)
  pickRef.current = onPick

  const html = (i: number, sel: boolean, n: number) => {
    const p = points[i]
    return p.photo_thumb_url ? photoPinHtml(p.photo_thumb_url, sel, n, accent) : sealPinHtml(p, labels[i], sel, n)
  }
  const htmlRef = useRef(html)
  htmlRef.current = html

  useEffect(() => {
    if (!map) return
    const all = markers.current
    // 优先级：选中的 > 有照片的 > 日期新的
    const order = points
      .map((_, i) => i)
      .sort((a, b) => {
        const pa = points[a]
        const pb = points[b]
        return (pb.photo_thumb_url ? 1 : 0) - (pa.photo_thumb_url ? 1 : 0) || (pb.date ?? '').localeCompare(pa.date ?? '')
      })
    const setPinned = (i: number, v: boolean) => {
      if (map.getSource(`${P}-pts`)) map.setFeatureState({ source: `${P}-pts`, id: i }, { pinned: v })
    }
    const update = () => {
      const sel = selRef.current
      const b = map.getBounds()
      const visible = order.filter((i) => b.contains([points[i].lng, points[i].lat]))
      if (sel != null && visible.includes(sel)) visible.unshift(...visible.splice(visible.indexOf(sel), 1))
      const placed = declutter(
        map,
        visible,
        (i) => [points[i].lng, points[i].lat],
        (i) => (points[i].photo_thumb_url ? [52, 66] : [30, 34]),
        coarsePointer ? 120 : 200,
      )
      const want = new Map(placed.map((p) => [p.i, p.n]))
      for (const [i, e] of all)
        if (!want.has(i)) {
          e.m.remove()
          all.delete(i)
          setPinned(i, false)
        }
      for (const [i, n] of want) {
        const s = i === sel
        const e = all.get(i)
        if (e) {
          if (e.n !== n || e.sel !== s) {
            e.el.innerHTML = htmlRef.current(i, s, n)
            e.n = n
            e.sel = s
          }
          continue
        }
        const el = document.createElement('div')
        el.style.cursor = 'pointer'
        el.style.zIndex = s ? '2' : ''
        el.innerHTML = htmlRef.current(i, s, n)
        el.addEventListener('click', (ev) => {
          ev.stopPropagation()
          pickRef.current(i)
        })
        const m = new Marker({ element: el, anchor: 'bottom' }).setLngLat([points[i].lng, points[i].lat]).addTo(map)
        all.set(i, { m, el, n, sel: s })
        setPinned(i, true)
      }
    }
    update()
    map.on('moveend', update)
    return () => {
      map.off('moveend', update)
      all.forEach((e, i) => {
        e.m.remove()
        setPinned(i, false)
      })
      all.clear()
    }
  }, [map, points, labels])

  useEffect(() => {
    for (const [i, e] of markers.current) {
      const s = i === selected
      if (s === e.sel) continue
      e.sel = s
      e.el.innerHTML = htmlRef.current(i, s, e.n)
      e.el.style.zIndex = s ? '2' : ''
    }
  }, [selected])
  return null
}

/** 省级视图（夜色）：去过的城市名 + 打卡数（DOM 标签，互不重叠）；color 是打卡数的颜色（CSS 变量） */
function CityLabels({ cities, color }: { cities: Footprints['cities']; color: string }) {
  const map = useMap()
  useEffect(() => {
    if (!map) return
    const all = new Map<string, Marker>()
    const list = [...cities].sort((a, b) => b.count - a.count).slice(0, 80)
    const update = () => {
      const placed = declutter(
        map,
        list.map((_, i) => i),
        (i) => [list[i].lng, list[i].lat],
        (i) => [list[i].name.length * 13 + 26, 22],
        60,
      )
      const want = new Set(placed.map((p) => list[p.i].code))
      for (const [k, m] of all)
        if (!want.has(k)) {
          m.remove()
          all.delete(k)
        }
      for (const p of placed) {
        const c = list[p.i]
        if (all.has(c.code)) continue
        const el = document.createElement('div')
        el.style.pointerEvents = 'none'
        const name = c.name.length > 2 ? c.name.replace(/(市|地区)$/, '') : c.name
        el.innerHTML = `<div style="margin-top:6px;white-space:nowrap;font-family:var(--font-display);font-size:12px;line-height:1;letter-spacing:.06em;color:var(--color-ink-900);text-shadow:0 1px 3px color-mix(in oklab,var(--color-night) 90%,transparent),0 0 8px color-mix(in oklab,var(--color-night) 70%,transparent)">${name}<span style="margin-left:4px;font-family:var(--font-num);font-size:11px;font-weight:500;font-variant-numeric:lining-nums;color:${color}">${c.count}</span></div>`
        all.set(c.code, new Marker({ element: el, anchor: 'top' }).setLngLat([c.lng, c.lat]).addTo(map))
      }
    }
    update()
    map.on('moveend', update)
    return () => {
      map.off('moveend', update)
      all.forEach((m) => m.remove())
    }
  }, [map, cities, color])
  return null
}

/* ---------------- 选中足迹的小卡片：照片 + 两行说明（地点亮、旅程与日期灰） ---------------- */
function PointCard({ p, label, onClose }: { p: FootprintPoint; label: string; onClose: () => void }) {
  const cat = categoryOf(p.category)
  return (
    // 手机上卡片压在地图控件上：用不透明底色（地图控件同时隐藏，见 FootprintMap），桌面仍是玻璃。
    // 颜色随地图外框上的主题作用域（夜色里是深色玻璃，城市级跟随当前模式）
    <div className="glass animate-slide-up absolute inset-x-3 bottom-3 z-20 overflow-hidden rounded-card border border-line text-ink-900 shadow-float max-sm:bg-surface max-sm:backdrop-blur-none sm:right-auto sm:bottom-6 sm:left-6 sm:w-[24rem]">
      <div className="flex gap-4 p-3 pr-12">
        {p.photo_thumb_url ? (
          <img src={p.photo_thumb_url} alt="" className="h-[5.5rem] w-[4.4rem] shrink-0 rounded-image object-cover" loading="lazy" />
        ) : (
          <div className="flex h-[5.5rem] w-[4.4rem] shrink-0 items-center justify-center rounded-image border border-line">
            <cat.icon className="size-5" style={{ color: `var(${categoryToken(p.category)})` }} strokeWidth={1.4} />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col py-0.5">
          <p className="eyebrow truncate">
            <span className="font-num">No. {label.padStart(2, '0')}</span>
            {p.city && ` · ${p.city}`}
          </p>
          <h3 className="font-display mt-1.5 truncate text-[length:var(--text-card)] leading-tight font-normal">{p.name}</h3>
          <p className="caption mt-auto truncate">
            {p.trip_title}
            {p.date && <span className="font-num"> · {fmtDate(p.date)}</span>}
          </p>
          {p.verdict && <VerdictBadge verdict={p.verdict} className="mt-1.5 self-start !py-0" />}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭"
        className="absolute top-1 right-1 flex size-10 items-center justify-center rounded-full text-ink-500 transition-colors hover:text-ink-900"
      >
        <X className="size-4" strokeWidth={1.5} />
      </button>
      <Link
        to={`/trips/${p.trip_id}`}
        className="flex min-h-11 items-center justify-between border-t border-line px-3 text-[13px] tracking-wide text-ink-700 transition-colors hover:text-ink-900"
      >
        查看这段旅程
        <ArrowRight className="size-4" strokeWidth={1.4} />
      </Link>
    </div>
  )
}

/* ---------------- 足迹地图 ---------------- */
export function FootprintMap({
  data,
  theme = 'sunset',
  className,
}: {
  data: Footprints
  theme?: LitTheme
  className?: string
}) {
  // WebGL 图层的颜色：主题令牌解析成 rgba()，换主题 / 深浅色时重新读取；DOM 标记直接用 CSS 变量
  const pal = useLitPalette(theme)
  const vars = litVars(theme)
  const [stage, setStage] = useState<Stage>('country')
  const [picked, setPicked] = useState<number | null>(null)
  const mapRef = useRef<MLMap | null>(null)
  // 按容器尺寸平移各档阈值（在创建地图前量好，之后不变：旋转屏幕等只影响阈值的精确位置）
  const boxRef = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = boxRef.current
    setShift(zoomShift(el?.clientWidth ?? 1000, el?.clientHeight ?? 600))
  }, [])
  const counts = useMemo(() => Object.fromEntries(data.provinces.map((p) => [p.code, p.count])), [data.provinces])
  const pts = useMemo(() => data.points.map((p) => [p.lng, p.lat] as LngLat), [data.points])
  // 每段旅程内的序号（印章上的数字）
  const labels = useMemo(() => {
    const seen = new Map<number, number>()
    return data.points.map((p) => {
      const n = (seen.get(p.trip_id) ?? 0) + 1
      seen.set(p.trip_id, n)
      return String(n)
    })
  }, [data.points])
  const night = stage !== 'city'
  // 地图外框的主题作用域：夜色（全国 / 省级）里是深色令牌，城市级跟随当前模式（浅色模式是纸色地图）。
  // 胶囊、说明文字、足迹卡片、DOM 标记都在里面，颜色随之切换
  const { mode } = useTheme()
  const scope = useThemeScope(night ? 'dark' : mode)
  // 足迹数据刷新后序号可能对应到别的点：关掉卡片
  useEffect(() => setPicked(null), [data.points])

  const fly = (to: { center: LngLat; zoom: number; pitch: number; bearing: number }) =>
    mapRef.current?.flyTo({ ...to, duration: 1400, essential: true })
  const sh = shift ?? 0
  const fitAll = () => mapRef.current && fly(viewFor(mapRef.current, pts, sh))
  const showChina = () => mapRef.current && fly({ center: CHINA_CENTER, zoom: chinaZoom(mapRef.current), pitch: PITCH.country, bearing: -6 })
  const focus = (p: LngLat[], maxZoom: number) => {
    const m = mapRef.current
    if (!m) return
    const v = viewFor(m, p, sh)
    const zoom = Math.min(maxZoom, v.zoom)
    fly({ ...v, zoom, pitch: PITCH[stageOf(zoom, sh)] })
  }

  // 地图上的控件：与其他地图一致的玻璃底 + 细线胶囊（在外框的主题作用域里：夜色里是深色玻璃）
  const chip = mapChipClass
  const photos = useMemo(() => data.points.filter((p) => p.photo_thumb_url).length, [data.points])
  const sel = picked != null ? data.points[picked] : null

  return (
    <div
      ref={boxRef}
      data-fp-map
      {...scope}
      className={cn('relative overflow-hidden transition-colors duration-700', night ? 'bg-night' : 'bg-[var(--map-bg)]', className)}
    >
      {shift != null && (
        <BaseMap
          // 手机上打开足迹卡片时，右下角的缩放按钮和版权信息会从卡片后面透出来：先收起
          className={cn('absolute inset-0', night && 'th-map-dark', sel && 'max-sm:[&_.maplibregl-ctrl-bottom-right]:hidden')}
          kind="auto"
          center={CHINA_CENTER}
          zoom={3.2}
          options={{ ...mapGestureOptions, minZoom: 2, maxPitch: 70 }}
          onReady={(m) => {
            mapRef.current = m
            setAutoDayZoom(m, dayWindow(shift))
            const v = viewFor(m, pts, shift)
            m.jumpTo(v)
            setStage(stageOf(v.zoom, shift))
          }}
        >
          <LitProvinces counts={counts} theme={theme} cities={data.cities} idPrefix={P} beforeId={SLOT} shift={shift} />
          <LitPrefectures cities={data.cities} theme={theme} idPrefix={P} beforeId={SLOT} shift={shift} />
          <FootprintOverlay data={data} pal={pal} shift={shift} onStage={setStage} onPick={setPicked} onFocus={focus} />
          {stage === 'region' && <CityLabels cities={data.cities} color={vars.column} />}
          {stage === 'city' && <FootprintPins points={data.points} labels={labels} selected={picked} onPick={setPicked} accent={vars.accent} />}
        </BaseMap>
      )}

      <div className="absolute top-3 right-3 z-10 flex gap-2 md:top-5 md:right-6">
        <button type="button" onClick={showChina} className={chip} title="看全国">
          <Maximize2 className="size-3.5" strokeWidth={1.4} />
          全国
        </button>
        <button type="button" onClick={fitAll} className={chip} title="回到全部足迹">
          <Scan className="size-3.5" strokeWidth={1.4} />
          全部足迹
        </button>
      </div>

      {/* 左下角的说明文字：纸色（夜色里是深色）的暗角托底，保证在亮色的立体省份、浅色底图上都看得清 */}
      <div className="pointer-events-none absolute bottom-0 left-0 z-[5] h-44 w-[min(100%,30rem)] bg-[radial-gradient(ellipse_at_bottom_left,color-mix(in_oklab,var(--color-paper)_80%,transparent),transparent_70%)]" />
      {sel ? (
        <PointCard p={sel} label={labels[picked!]} onClose={() => setPicked(null)} />
      ) : (
        <div key={stage} className="animate-fade-in pointer-events-none absolute bottom-4 left-4 z-10 md:bottom-6 md:left-8">
          <p className="eyebrow">{stage === 'country' ? 'China · 全国' : stage === 'region' ? 'Region · 省域' : 'Street · 街巷'}</p>
          <p className="mt-1.5 text-[13px] text-ink-700">
            <span className="font-num text-xl text-ink-900">{data.stats.provinces}</span> 省
            <span className="font-num ml-3 text-xl text-ink-900">{data.stats.cities}</span> 城
            {stage === 'city' && photos > 0 && (
              <>
                <span className="font-num ml-3 text-xl text-ink-900">{photos}</span> 张照片
              </>
            )}
          </p>
        </div>
      )}
    </div>
  )
}

