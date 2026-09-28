// 自适应足迹地图：默认镜头框住全部足迹；全国 → 省级 → 城市 / 街巷三档按缩放自动切换（见 LitProvinces 的 STAGE_ZOOM）
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { LngLatBounds, Marker, type ExpressionSpecification, type Map as MLMap, type MapMouseEvent } from 'maplibre-gl'
import type { Feature, LineString, Point } from 'geojson'
import { ArrowRight, Maximize2, Scan, X } from 'lucide-react'
import type { FootprintPoint, Footprints } from '@/api/types'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { fc, markerHtml, removeLayers, upsertSource } from '@/components/map/layers'
import { setAutoDayZoom } from '@/components/map/style'
import { VerdictBadge } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fmtDate } from '@/lib/format'
import { CHINA_CENTER } from '@/lib/geo'
import { categoryOf } from '@/lib/meta'
import { LitPrefectures, LitProvinces, dayWindow, ensureSlot, litPalettes, stageOf, zoomShift, type LitPalette, type LitTheme, type Stage } from './LitProvinces'

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

  useEffect(() => {
    if (!map) return
    const z = (v: number) => v + shift
    const [D0, D1] = dayWindow(shift)
    ensureSlot(map, SLOT)
    // 光源偏暖、从西南方向打来，立体省份的顶面更亮、侧面更深
    map.setLight({ anchor: 'map', position: [1.3, 200, 38], color: '#fff4e2', intensity: 0.42 })
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
              properties: { i, color: categoryOf(p.category).color, photo: p.photo_thumb_url ? 1 : 0 },
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
        'line-color': pal.line,
        'line-width': 1.2,
        'line-dasharray': [1.5, 2.5],
        'line-opacity': ['interpolate', ['linear'], Z, z(3), 0.7, z(5.2), 0.55, z(6.2), 0],
      },
    })
    // 旅程路线：省级为细金线，城市级为纸色描边 + 朱砂实线
    add({
      id: `${P}-trips-casing`,
      type: 'line',
      source: `${P}-trips`,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#fffdf9',
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
        'line-color': ['interpolate', ['linear'], Z, D0, pal.routeNight, D1, pal.routeDay] as ExpressionSpecification,
        'line-width': ['interpolate', ['linear'], Z, 5, 0.8, 8, 1.4, 10, 2.6, 14, 3.4],
        'line-opacity': ['interpolate', ['linear'], Z, z(5.2), 0, z(6.2), 0.6, D0, 0.75, D1, 0.95],
      },
    })
    // 足迹点：夜色下为金色小光点，纸色下为带纸色描边的分类色圆点（城市级时大部分被照片 / 印章标记盖住）
    add({
      id: `${P}-pts-glow`,
      type: 'circle',
      source: `${P}-pts`,
      paint: {
        'circle-color': pal.column,
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
        'circle-color': ['interpolate', ['linear'], Z, D0, pal.column, D1, ['get', 'color']] as ExpressionSpecification,
        'circle-radius': ['interpolate', ['linear'], Z, 6, 1.6, 8.5, 3, 13, 4.5],
        'circle-stroke-color': ['interpolate', ['linear'], Z, D0, 'rgba(12,19,20,0.5)', D1, '#fffdf9'] as ExpressionSpecification,
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
      paint: { 'circle-radius': 14, 'circle-color': '#000', 'circle-opacity': 0 },
    })
    return () => {
      removeLayers(map, [`${P}-pts-hit`, `${P}-pts`, `${P}-pts-glow`, `${P}-trips`, `${P}-trips-casing`, `${P}-arcs`], [
        `${P}-pts`,
        `${P}-trips`,
        `${P}-arcs`,
      ])
    }
  }, [map, data, pal, shift])

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

const PAPER = '#fffdf9'
const INK = '#1b1a17'

function badgeHtml(n: number) {
  return n > 0
    ? `<span style="position:absolute;top:-7px;right:-9px;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:${INK};color:${PAPER};font:500 11px/18px 'Fraunces Variable',Georgia,serif;font-variant-numeric:lining-nums;text-align:center;box-shadow:0 0 0 1.5px ${PAPER}">+${n}</span>`
    : ''
}

/** 相框式照片标记：纸色细边框 + 下方小尖角，选中时边框为强调色 */
function photoPinHtml(url: string, selected: boolean, n: number, accent: string) {
  const frame = selected ? accent : PAPER
  const s = selected ? 54 : 46
  return `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center">
      <div style="position:relative;width:${s}px;height:${s}px;padding:2.5px;background:${frame};border-radius:7px;
        box-shadow:0 0 0 1px rgba(27,26,23,.14),0 8px 18px -6px rgba(27,26,23,.5);transition:all .15s">
        <img src="${url}" alt="" loading="lazy" decoding="async" draggable="false"
          style="display:block;width:100%;height:100%;object-fit:cover;border-radius:4.5px;background:#ece7dd"/>
        ${badgeHtml(n)}
      </div>
      <div style="width:0;height:0;margin-top:-1px;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid ${frame};filter:drop-shadow(0 1px 0 rgba(27,26,23,.12))"></div>
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
        (i) => (points[i].photo_thumb_url ? [52, 58] : [30, 34]),
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

/** 省级视图：去过的城市名 + 打卡数（DOM 标签，互不重叠） */
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
        el.innerHTML = `<div style="margin-top:6px;white-space:nowrap;font:600 12px/1 'Noto Serif SC','Songti SC',serif;letter-spacing:.06em;color:#f4f1ea;text-shadow:0 1px 3px rgba(12,19,20,.9),0 0 8px rgba(12,19,20,.7)">${name}<span style="margin-left:4px;font:500 11px/1 'Fraunces Variable',Georgia,serif;font-variant-numeric:lining-nums;color:${color}">${c.count}</span></div>`
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

/* ---------------- 选中足迹的小卡片 ---------------- */
function PointCard({ p, label, onClose, dark }: { p: FootprintPoint; label: string; onClose: () => void; dark: boolean }) {
  const cat = categoryOf(p.category)
  return (
    <div
      className={cn(
        'animate-slide-up absolute inset-x-3 bottom-3 z-20 overflow-hidden rounded-xl sm:right-auto sm:w-[22rem]',
        dark ? 'glass-dark text-paper ring-1 ring-white/12' : 'bg-white text-ink-900 shadow-float',
      )}
    >
      <div className="flex gap-3 p-3">
        {p.photo_thumb_url ? (
          <img src={p.photo_thumb_url} alt="" className="size-[4.5rem] shrink-0 rounded-md object-cover" loading="lazy" />
        ) : (
          <div className={cn('flex size-[4.5rem] shrink-0 items-center justify-center rounded-md border', dark ? 'border-white/12' : 'border-ink-200')}>
            <cat.icon className="size-6" style={{ color: cat.color }} strokeWidth={1.5} />
          </div>
        )}
        <div className="min-w-0 flex-1 pr-5">
          <p className={cn('eyebrow truncate', dark && '!text-white/50')}>
            <span className="font-num">No. {label.padStart(2, '0')}</span>
            {p.city && ` · ${p.city}`}
          </p>
          <h3 className="mt-1 truncate text-[16px] leading-snug">{p.name}</h3>
          <p className={cn('mt-0.5 truncate text-[13px]', dark ? 'text-white/60' : 'text-ink-500')}>{p.trip_title}</p>
          <div className="mt-1.5 flex items-center gap-2">
            {p.date && <span className={cn('font-num text-xs', dark ? 'text-white/55' : 'text-ink-400')}>{fmtDate(p.date)}</span>}
            {p.verdict && <VerdictBadge verdict={p.verdict} className="!py-0" />}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className={cn('absolute top-2 right-2 rounded-md p-1.5', dark ? 'text-white/60 hover:text-white' : 'text-ink-400 hover:text-ink-900')}
        >
          <X className="size-4" strokeWidth={1.6} />
        </button>
      </div>
      <Link
        to={`/trips/${p.trip_id}`}
        className={cn(
          'flex items-center justify-between border-t px-3 py-2.5 text-[13px] tracking-wide transition-colors',
          dark ? 'border-white/10 text-white/80 hover:text-white' : 'border-ink-200 text-ink-700 hover:text-ink-900',
        )}
      >
        查看这段旅程
        <ArrowRight className="size-4" strokeWidth={1.6} />
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
  const pal = litPalettes[theme]
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

  const chip = cn(
    'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium tracking-wide backdrop-blur transition-colors',
    night
      ? 'bg-[#0c1314]/60 text-white/80 ring-1 ring-white/12 hover:text-white'
      : 'border border-ink-900/10 bg-white/90 text-ink-700 shadow-card hover:border-ink-900/25 hover:text-ink-900',
  )
  const photos = useMemo(() => data.points.filter((p) => p.photo_thumb_url).length, [data.points])
  const sel = picked != null ? data.points[picked] : null

  return (
    <div
      ref={boxRef}
      className={cn('relative overflow-hidden rounded-xl transition-colors duration-700', night ? 'bg-night' : 'bg-paper shadow-card', className)}
    >
      {shift != null && (
        <BaseMap
          className={cn('absolute inset-0', night && 'th-map-dark')}
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
          {stage === 'region' && <CityLabels cities={data.cities} color={pal.line} />}
          {stage === 'city' && <FootprintPins points={data.points} labels={labels} selected={picked} onPick={setPicked} accent={pal.accent} />}
        </BaseMap>
      )}

      <div className="absolute top-3 right-3 z-10 flex gap-2">
        <button type="button" onClick={showChina} className={chip} title="看全国">
          <Maximize2 className="size-3.5" strokeWidth={1.6} />
          全国
        </button>
        <button type="button" onClick={fitAll} className={chip} title="回到全部足迹">
          <Scan className="size-3.5" strokeWidth={1.6} />
          全部足迹
        </button>
      </div>

      {sel ? (
        <PointCard p={sel} label={labels[picked!]} dark={night} onClose={() => setPicked(null)} />
      ) : (
        <div
          className={cn(
            'pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-3 rounded-lg px-3 py-2 text-xs tracking-wide backdrop-blur',
            night ? 'bg-[#0c1314]/55 text-white/65 ring-1 ring-white/10' : 'bg-white/88 text-ink-500 shadow-card',
          )}
        >
          <span className={cn('eyebrow !tracking-[0.14em]', night && '!text-white/45')}>
            {stage === 'country' ? 'China · 全国' : stage === 'region' ? 'Region · 省域' : 'Street · 街巷'}
          </span>
          <span className={cn('h-3 w-px', night ? 'bg-white/15' : 'bg-ink-200')} />
          <span>
            <b className={cn('font-num text-[13px] font-medium', night ? 'text-gold' : 'text-ink-900')}>{data.stats.provinces}</b> 省
            <b className={cn('font-num ml-2 text-[13px] font-medium', night ? 'text-gold' : 'text-ink-900')}>{data.stats.cities}</b> 城
            {stage === 'city' && photos > 0 && (
              <>
                <b className="font-num ml-2 text-[13px] font-medium text-ink-900">{photos}</b> 张照片
              </>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

