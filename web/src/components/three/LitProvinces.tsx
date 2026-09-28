import { useEffect, useMemo } from 'react'
import type { ExpressionSpecification, Map as MLMap } from 'maplibre-gl'
import { useQuery } from '@tanstack/react-query'
import type { Feature, Polygon } from 'geojson'
import { useMap } from '@/components/map/BaseMap'
import { fc, removeLayers, upsertSource } from '@/components/map/layers'
import { AUTO_DAY_ZOOM } from '@/components/map/style'
import { loadAtlas, loadPrefectures } from '@/lib/atlas'

export type LitTheme = 'sunset' | 'love'

/**
 * 足迹地图按缩放分三档：
 * - 全国（< region）：去过的省份立体拔高（高度有上限），城市光柱立在省份顶面上；
 * - 省级（region – city）：省份压平淡出，点亮去过的地级市（半透明面 + 细边）和城市小光柱；
 * - 城市 / 街巷（≥ city）：底图转为纸色、镜头倾斜成 2.5D，显示旅程路线和照片 / 印章标记。
 * 过渡全部用 MapLibre 的缩放插值完成，缩放时不需要重建图层。
 */
export const STAGE_ZOOM = { region: 5.5, city: 8.5 }
export type Stage = 'country' | 'region' | 'city'
export const stageOf = (z: number): Stage => (z < STAGE_ZOOM.region ? 'country' : z < STAGE_ZOOM.city ? 'region' : 'city')

/** 省份拔高（米）：按打卡数的平方根增长，30–120 km；不按「最多的省」归一化，只去过一个省也只是一块矮台 */
export const PROV_BASE_H = 30_000
export const PROV_SPAN_H = 90_000
const PROV_FULL = 50
export const provinceHeight = (count: number, _max?: number) =>
  count > 0 ? Math.round(PROV_BASE_H + PROV_SPAN_H * Math.sqrt(Math.min(count, PROV_FULL) / PROV_FULL)) : 0

/** 全国视图下城市光柱的高度（米，立在省份顶面上） */
export const columnHeight = (count: number) => Math.round(60_000 + 180_000 * Math.sqrt(Math.min(count, 40) / 40))
/** 省级视图下城市小光柱的高度（米） */
export const smallColumnHeight = (count: number) => Math.round(5_000 + 17_000 * Math.sqrt(Math.min(count, 40) / 40))

export interface LitPalette {
  /** 去过的省份 / 城市：打卡少 → 多 */
  low: string
  high: string
  /** 夜色下去过的省界 */
  line: string
  /** 光柱 */
  column: string
  /** 路线：夜色（金）/ 纸色（朱砂或胭脂） */
  routeNight: string
  routeDay: string
  /** 选中、强调 */
  accent: string
}

export const litPalettes: Record<LitTheme, LitPalette> = {
  sunset: {
    low: '#c9a868',
    high: '#c4573b',
    line: '#e6d3a3',
    column: '#f3e2b6',
    routeNight: '#d8bc7e',
    routeDay: '#bd462b',
    accent: '#bd462b',
  },
  love: {
    low: '#d2a1ab',
    high: '#a45a78',
    line: '#eecdd4',
    column: '#f6e0e5',
    routeNight: '#dcb0bb',
    routeDay: '#9d4a5f',
    accent: '#9d4a5f',
  },
}

const [D0, D1] = AUTO_DAY_ZOOM
const Z = ['zoom'] as unknown as number
const lit = ['>', ['get', 'count'], 0] as ExpressionSpecification

/** 按打卡数在 low → high 间取色；interpolate 的输入必须严格递增，最多只有 1 次时直接用 high */
function countColor(p: LitPalette, max: number): ExpressionSpecification | string {
  return max > 1 ? ['interpolate', ['linear'], ['get', 'count'], 1, p.low, max, p.high] : p.high
}

/** 以经纬度为圆心、半径 r 米的多边形（光柱的底面） */
function circle(lng: number, lat: number, r: number, n = 20): Polygon {
  const dLat = r / 111_320
  const dLng = r / (111_320 * Math.cos((lat * Math.PI) / 180))
  const ring: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    ring.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)])
  }
  return { type: 'Polygon', coordinates: [ring] }
}

export interface LitCity {
  code: string
  count: number
  lng: number
  lat: number
}

/**
 * 占位图层：点亮省份 / 城市的图层都插在它下面，调用方自己的图层（路线、足迹点）加在它上面。
 * 边界数据是异步加载的，晚于调用方图层到达时也不会盖住它们
 */
export function ensureSlot(map: MLMap, id: string) {
  if (!map.getLayer(id)) map.addLayer({ id, type: 'background', layout: { visibility: 'none' } })
  return id
}

function setOrAdd(map: MLMap, layer: Parameters<MLMap['addLayer']>[0], paint: Record<string, unknown>, before?: string) {
  if (!map.getLayer(layer.id)) map.addLayer({ ...layer, paint } as Parameters<MLMap['addLayer']>[0], before)
  else for (const [k, v] of Object.entries(paint)) (map.setPaintProperty as (l: string, k: string, v: unknown) => void).call(map, layer.id, k, v)
}

/**
 * 点亮去过的省份：全国视图下立体拔高（高度有上限、放大到省级时压平淡出），没去过的省份只画细线轮廓。
 * cities 给出时，同时画城市光柱（全国视图立在省份顶面上，省级视图换成细小的光柱）
 */
export function LitProvinces({
  counts,
  theme = 'sunset',
  extrude = true,
  idPrefix = 'lit',
  cities,
  beforeId,
}: {
  counts: Record<string, number>
  theme?: LitTheme
  extrude?: boolean
  idPrefix?: string
  cities?: LitCity[]
  /** 插在这个图层下面（不存在时自动创建一个占位图层，见 ensureSlot） */
  beforeId?: string
}) {
  const map = useMap()
  const { data: atlas } = useQuery({ queryKey: ['atlas'], queryFn: loadAtlas, staleTime: Infinity })
  const P = idPrefix
  const pal = litPalettes[theme]

  useEffect(() => {
    if (!map || !atlas) return
    const max = Math.max(1, ...Object.values(counts))
    const features = atlas.provinces.features.map((f) => {
      const count = counts[f.properties.id] ?? 0
      return { ...f, properties: { ...f.properties, count, h: extrude ? provinceHeight(count) : 0 } }
    })
    upsertSource(map, `${P}-prov`, fc(features))
    const color = countColor(pal, max)
    const before = beforeId && ensureSlot(map, beforeId)

    // 平面填充：没去过的省份一层极淡的底色；去过的省份在拔高部分淡出后（省级视图）留一层淡淡的颜色
    setOrAdd(map, { id: `${P}-fill`, type: 'fill', source: `${P}-prov` }, {
      'fill-color': ['case', lit, color, 'rgb(150,185,185)'],
      'fill-opacity': ['interpolate', ['linear'], Z, 4.8, ['case', lit, 0, 0.05], 6.2, ['case', lit, 0.05, 0.04], D0, ['case', lit, 0.04, 0.03], D1, 0],
    }, before)
    // 省界：夜色下为青灰细线（去过的为浅金），纸色下为墨色细线
    setOrAdd(map, { id: `${P}-line`, type: 'line', source: `${P}-prov` }, {
      'line-color': ['interpolate', ['linear'], Z, D0, ['case', lit, pal.line, 'rgb(150,185,185)'], D1, ['case', lit, pal.routeDay, 'rgb(27,26,23)']],
      'line-opacity': ['interpolate', ['linear'], Z, 3, ['case', lit, 0.85, 0.26], D0, ['case', lit, 0.7, 0.3], D1, ['case', lit, 0.35, 0.18]],
      'line-width': ['interpolate', ['linear'], Z, 3, ['case', lit, 1, 0.5], 8, ['case', lit, 1.4, 0.8]],
    }, before)
    // 立体省份：全国视图拔高，放大到省级时压平并淡出
    const height = ['interpolate', ['linear'], Z, 4.6, ['get', 'h'], 6.0, 0] as ExpressionSpecification
    if (!map.getLayer(`${P}-ext`)) {
      map.addLayer({
        id: `${P}-ext`,
        type: 'fill-extrusion',
        source: `${P}-prov`,
        filter: lit,
        paint: {
          'fill-extrusion-color': color,
          'fill-extrusion-opacity': ['interpolate', ['linear'], Z, 4.8, 0.9, 6.0, 0],
          'fill-extrusion-base': 0,
          'fill-extrusion-height': 0,
          'fill-extrusion-height-transition': { duration: 1200, delay: 0 },
        },
      }, before)
    } else map.setPaintProperty(`${P}-ext`, 'fill-extrusion-color', color)
    // 下一帧再设置高度，触发升起动画
    const h = requestAnimationFrame(() => {
      if (map.getLayer(`${P}-ext`)) map.setPaintProperty(`${P}-ext`, 'fill-extrusion-height', height)
    })
    return () => cancelAnimationFrame(h)
  }, [map, atlas, counts, pal, extrude, P, beforeId])

  // 城市光柱（fill-extrusion，与立体省份共用深度，不会穿模）
  const provH = useMemo(() => (code: string) => (extrude ? provinceHeight(counts[code.slice(0, 2) + '0000'] ?? 0) : 0), [counts, extrude])
  useEffect(() => {
    if (!map || !cities || !atlas) return
    const big: Feature<Polygon>[] = []
    const small: Feature<Polygon>[] = []
    for (const c of cities) {
      const base = provH(c.code)
      big.push({ type: 'Feature', properties: { base, top: base + columnHeight(c.count) }, geometry: circle(c.lng, c.lat, 11_000) })
      small.push({ type: 'Feature', properties: { top: smallColumnHeight(c.count) }, geometry: circle(c.lng, c.lat, 1_900, 16) })
    }
    upsertSource(map, `${P}-col-l`, fc(big))
    upsertSource(map, `${P}-col-s`, fc(small))
    const before = beforeId && ensureSlot(map, beforeId)
    setOrAdd(map, { id: `${P}-col-l`, type: 'fill-extrusion', source: `${P}-col-l` }, {
      'fill-extrusion-color': pal.column,
      'fill-extrusion-opacity': ['interpolate', ['linear'], Z, 4.9, 0.95, 5.8, 0],
      'fill-extrusion-base': ['interpolate', ['linear'], Z, 4.6, ['get', 'base'], 6.0, 0],
      'fill-extrusion-height': ['interpolate', ['linear'], Z, 4.6, ['get', 'top'], 6.0, 0],
    }, before)
    setOrAdd(map, { id: `${P}-col-s`, type: 'fill-extrusion', source: `${P}-col-s` }, {
      'fill-extrusion-color': pal.column,
      'fill-extrusion-opacity': ['interpolate', ['linear'], Z, 5.3, 0, 6.0, 0.92, 8.1, 0.92, 8.8, 0],
      'fill-extrusion-base': 0,
      'fill-extrusion-height': ['interpolate', ['linear'], Z, 5.3, 0, 6.2, ['get', 'top'], 8.1, ['get', 'top'], 9.0, 0],
    }, before)
  }, [map, atlas, cities, pal, provH, P, beforeId])

  useEffect(
    () => () => {
      if (map)
        removeLayers(
          map,
          [`${P}-col-s`, `${P}-col-l`, `${P}-ext`, `${P}-line`, `${P}-fill`],
          [`${P}-col-s`, `${P}-col-l`, `${P}-prov`],
        )
    },
    [map, P],
  )
  return null
}

/**
 * 点亮去过的地级市（省级视图）：去过的城市半透明填色 + 细边，同省其他城市只画极细的边界。
 * 进入城市级后淡出为一条细边，标出城市范围
 */
export function LitPrefectures({
  cities,
  theme = 'sunset',
  idPrefix = 'lit',
  beforeId,
}: {
  cities: { code: string; count: number }[]
  theme?: LitTheme
  idPrefix?: string
  beforeId?: string
}) {
  const map = useMap()
  const P = idPrefix
  const pal = litPalettes[theme]
  const provinces = useMemo(() => [...new Set(cities.map((c) => c.code.slice(0, 2) + '0000'))].sort(), [cities])
  const { data: prefs } = useQuery({
    queryKey: ['atlas-prefectures', provinces.join()],
    queryFn: () => loadPrefectures(provinces),
    staleTime: Infinity,
    enabled: provinces.length > 0,
  })

  useEffect(() => {
    if (!map || !prefs) return
    const counts = new Map(cities.map((c) => [c.code, c.count]))
    const max = Math.max(1, ...cities.map((c) => c.count))
    upsertSource(
      map,
      `${P}-pref`,
      fc(prefs.features.map((f) => ({ ...f, properties: { ...f.properties, count: counts.get(f.properties.id) ?? 0 } }))),
    )
    const color = countColor(pal, max)
    // 放在立体省份下面：全国视图时被省份盖住，省级视图时省份已淡出
    const before = map.getLayer(`${P}-ext`) ? `${P}-ext` : beforeId && ensureSlot(map, beforeId)
    if (!map.getLayer(`${P}-pref-fill`)) {
      map.addLayer(
        {
          id: `${P}-pref-fill`,
          type: 'fill',
          source: `${P}-pref`,
          filter: lit,
          paint: {
            'fill-color': ['interpolate', ['linear'], Z, D0, color, D1, pal.routeDay] as ExpressionSpecification,
            'fill-opacity': ['interpolate', ['linear'], Z, 5.0, 0, 6.0, 0.46, 7.6, 0.4, D0, 0.3, D1, 0.07, 10.5, 0],
          },
        },
        before,
      )
      map.addLayer(
        {
          id: `${P}-pref-line`,
          type: 'line',
          source: `${P}-pref`,
          paint: {
            'line-color': ['interpolate', ['linear'], Z, D0, ['case', lit, pal.line, 'rgb(150,185,185)'], D1, ['case', lit, pal.routeDay, 'rgb(27,26,23)']],
            'line-opacity': ['interpolate', ['linear'], Z, 5.0, 0, 6.0, ['case', lit, 0.9, 0.22], D1, ['case', lit, 0.55, 0.14], 12, ['case', lit, 0.3, 0.08]],
            'line-width': ['interpolate', ['linear'], Z, 6, ['case', lit, 1.1, 0.5], 10, ['case', lit, 1.6, 0.7]],
          },
        },
        before,
      )
    } else map.setPaintProperty(`${P}-pref-fill`, 'fill-color', ['interpolate', ['linear'], Z, D0, color, D1, pal.routeDay])
  }, [map, prefs, cities, pal, P, beforeId])

  useEffect(
    () => () => {
      if (map) removeLayers(map, [`${P}-pref-line`, `${P}-pref-fill`], [`${P}-pref`])
    },
    [map, P],
  )
  return null
}
