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
 * 足迹地图按缩放分三档（阈值以约 1000px 宽的地图为准，见 zoomShift）：
 * - 全国（< region）：去过的省份立体拔高（高度有上限），城市光柱立在省份顶面上；
 * - 省级（region – city）：省份压平淡出，点亮去过的地级市（半透明面 + 细边）和城市小光柱；
 * - 城市 / 街巷（≥ city）：底图转为石墨色、镜头倾斜成 2.5D，显示旅程路线和照片 / 印章标记。
 * 过渡全部用 MapLibre 的缩放插值完成，缩放时不需要重建图层。
 */
export const STAGE_ZOOM = { region: 5.5, city: 8.5 }
export type Stage = 'country' | 'region' | 'city'

/**
 * 同样的缩放级别，小地图上看到的范围更小：按地图尺寸（宽高的几何平均）平移各档阈值，
 * 让「一屏大约是一座城市（约 180 公里见方）」时进入城市级（桌面约 -0.3 级，手机约 -1.3 级）
 */
export function zoomShift(width: number, height = width) {
  const size = Math.sqrt(Math.max(width, 200) * Math.max(height, 200))
  return Math.max(-2, Math.min(0.5, Math.log2(size / 980)))
}
export const stageOf = (z: number, shift = 0): Stage =>
  z < STAGE_ZOOM.region + shift ? 'country' : z < STAGE_ZOOM.city + shift ? 'region' : 'city'
/** 夜色 → 石墨色的过渡区间（与 setAutoDayZoom 一起用） */
export const dayWindow = (shift = 0): [number, number] => [AUTO_DAY_ZOOM[0] + shift, AUTO_DAY_ZOOM[1] + shift]

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
  /** 路线：夜色（金）/ 城市级石墨底图（朱砂或胭脂） */
  routeNight: string
  routeDay: string
  /** 选中、强调 */
  accent: string
}

// 「夜航」：去过的省份是石墨色的石刻（打卡越多越亮，最亮也只到中灰，约 50% 明度），象牙白细线勾出省界；
// 城市光柱是金色、顶端一圈象牙白的细帽；城市级的实际路线是朱砂。
// 情侣空间的地面与足迹页相同（不做粉色大色块），胭脂色只留在光柱、路线和强调色上
const STONE = { low: '#3b3833', high: '#8c8474', line: '#e9dcbc' }
export const litPalettes: Record<LitTheme, LitPalette> = {
  sunset: {
    ...STONE,
    column: '#e2c27a',
    routeNight: '#d8bc7e',
    routeDay: '#de7c5d',
    accent: '#cf6041',
  },
  love: {
    ...STONE,
    column: '#d58f9f',
    routeNight: '#e0b6c0',
    routeDay: '#cf8a9b',
    accent: '#c47488',
  },
}
/** 光柱顶端的细帽（象牙白），让金色光柱在石墨色的省份上立得住 */
const COLUMN_CAP = '#f6ecd2'

/** 没去过的地方：夜色下为青灰细线，放大到城市级（石墨底图）后为暖灰细线 */
const IDLE_NIGHT = 'rgb(150,185,185)'
const IDLE_DAY = 'rgb(122,117,106)'

const Z = ['zoom'] as unknown as number
const lit = ['>', ['get', 'count'], 0] as ExpressionSpecification
type Expr = ExpressionSpecification

/** 按打卡数在 low → high 间取色；interpolate 的输入必须严格递增，最多只有 1 次时直接用 high */
function countColor(p: LitPalette, max: number): Expr | string {
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

const setPaint = (map: MLMap, layer: string, k: string, v: unknown) =>
  (map.setPaintProperty as (l: string, k: string, v: unknown) => void).call(map, layer, k, v)

function setOrAdd(map: MLMap, layer: Parameters<MLMap['addLayer']>[0], paint: Record<string, unknown>, before?: string) {
  if (!map.getLayer(layer.id)) map.addLayer({ ...layer, paint } as Parameters<MLMap['addLayer']>[0], before)
  else for (const [k, v] of Object.entries(paint)) setPaint(map, layer.id, k, v)
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
  shift = 0,
}: {
  counts: Record<string, number>
  theme?: LitTheme
  extrude?: boolean
  idPrefix?: string
  cities?: LitCity[]
  /** 插在这个图层下面（不存在时自动创建一个占位图层，见 ensureSlot） */
  beforeId?: string
  /** 各档缩放阈值的平移量（见 zoomShift） */
  shift?: number
}) {
  const map = useMap()
  const { data: atlas } = useQuery({ queryKey: ['atlas'], queryFn: loadAtlas, staleTime: Infinity })
  const P = idPrefix
  const pal = litPalettes[theme]

  useEffect(() => {
    if (!map || !atlas) return
    const z = (v: number) => v + shift
    const [D0, D1] = dayWindow(shift)
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
      'fill-color': ['case', lit, color, IDLE_NIGHT],
      'fill-opacity': ['interpolate', ['linear'], Z, z(4.8), ['case', lit, 0, 0.05], z(6.2), ['case', lit, 0.05, 0.04], D0, ['case', lit, 0.04, 0.03], D1, 0],
    }, before)
    // 省界：夜色下为青灰细线（去过的为象牙白），城市级为暖灰细线
    setOrAdd(map, { id: `${P}-line`, type: 'line', source: `${P}-prov` }, {
      'line-color': ['interpolate', ['linear'], Z, D0, ['case', lit, pal.line, IDLE_NIGHT], D1, ['case', lit, pal.routeDay, IDLE_DAY]],
      'line-opacity': ['interpolate', ['linear'], Z, z(3), ['case', lit, 0.85, 0.26], D0, ['case', lit, 0.7, 0.3], D1, ['case', lit, 0.35, 0.18]],
      'line-width': ['interpolate', ['linear'], Z, 3, ['case', lit, 1, 0.5], 8, ['case', lit, 1.4, 0.8]],
    }, before)
    // 立体省份：全国视图拔高，放大到省级时压平并淡出
    const height = ['interpolate', ['linear'], Z, z(4.6), ['get', 'h'], z(6.0), 0] as Expr
    const opacity = ['interpolate', ['linear'], Z, z(4.8), 0.9, z(6.0), 0] as Expr
    if (!map.getLayer(`${P}-ext`)) {
      map.addLayer(
        {
          id: `${P}-ext`,
          type: 'fill-extrusion',
          source: `${P}-prov`,
          filter: lit,
          paint: {
            'fill-extrusion-color': color,
            'fill-extrusion-opacity': opacity,
            'fill-extrusion-base': 0,
            'fill-extrusion-height': 0,
            'fill-extrusion-height-transition': { duration: 1200, delay: 0 },
          },
        },
        before,
      )
    } else {
      setPaint(map, `${P}-ext`, 'fill-extrusion-color', color)
      setPaint(map, `${P}-ext`, 'fill-extrusion-opacity', opacity)
    }
    // 下一帧再设置高度，触发升起动画
    const h = requestAnimationFrame(() => {
      if (map.getLayer(`${P}-ext`)) setPaint(map, `${P}-ext`, 'fill-extrusion-height', height)
    })
    return () => cancelAnimationFrame(h)
  }, [map, atlas, counts, pal, extrude, P, beforeId, shift])

  // 城市光柱（fill-extrusion，与立体省份共用深度，不会穿模）
  const provH = useMemo(() => (code: string) => (extrude ? provinceHeight(counts[code.slice(0, 2) + '0000'] ?? 0) : 0), [counts, extrude])
  useEffect(() => {
    if (!map || !cities || !atlas) return
    const z = (v: number) => v + shift
    const big: Feature<Polygon>[] = []
    const small: Feature<Polygon>[] = []
    for (const c of cities) {
      const base = provH(c.code)
      const top = base + columnHeight(c.count)
      const sTop = smallColumnHeight(c.count)
      // cap：光柱顶端一截（约 4% 高）换成象牙白
      big.push({ type: 'Feature', properties: { base, top, cap: top - Math.max(5_000, (top - base) * 0.045) }, geometry: circle(c.lng, c.lat, 11_000) })
      small.push({ type: 'Feature', properties: { top: sTop, cap: sTop - Math.max(500, sTop * 0.06) }, geometry: circle(c.lng, c.lat, 1_900, 16) })
    }
    upsertSource(map, `${P}-col-l`, fc(big))
    upsertSource(map, `${P}-col-s`, fc(small))
    const before = beforeId && ensureSlot(map, beforeId)
    const bigOpacity = ['interpolate', ['linear'], Z, z(4.9), 0.95, z(5.8), 0]
    setOrAdd(map, { id: `${P}-col-l`, type: 'fill-extrusion', source: `${P}-col-l` }, {
      'fill-extrusion-color': pal.column,
      'fill-extrusion-opacity': bigOpacity,
      'fill-extrusion-base': ['interpolate', ['linear'], Z, z(4.6), ['get', 'base'], z(6.0), 0],
      'fill-extrusion-height': ['interpolate', ['linear'], Z, z(4.6), ['get', 'cap'], z(6.0), 0],
    }, before)
    setOrAdd(map, { id: `${P}-col-l-cap`, type: 'fill-extrusion', source: `${P}-col-l` }, {
      'fill-extrusion-color': COLUMN_CAP,
      'fill-extrusion-opacity': bigOpacity,
      'fill-extrusion-base': ['interpolate', ['linear'], Z, z(4.6), ['get', 'cap'], z(6.0), 0],
      'fill-extrusion-height': ['interpolate', ['linear'], Z, z(4.6), ['get', 'top'], z(6.0), 0],
    }, before)
    // 进入石墨色过渡带（AUTO_DAY_ZOOM）之前就收起，城市级画面里不留残影
    const smallOpacity = ['interpolate', ['linear'], Z, z(5.3), 0, z(6.0), 0.92, z(7.6), 0.92, z(8.15), 0]
    setOrAdd(map, { id: `${P}-col-s`, type: 'fill-extrusion', source: `${P}-col-s` }, {
      'fill-extrusion-color': pal.column,
      'fill-extrusion-opacity': smallOpacity,
      'fill-extrusion-base': 0,
      'fill-extrusion-height': ['interpolate', ['linear'], Z, z(5.3), 0, z(6.2), ['get', 'cap'], z(7.6), ['get', 'cap'], z(8.2), 0],
    }, before)
    setOrAdd(map, { id: `${P}-col-s-cap`, type: 'fill-extrusion', source: `${P}-col-s` }, {
      'fill-extrusion-color': COLUMN_CAP,
      'fill-extrusion-opacity': smallOpacity,
      'fill-extrusion-base': ['interpolate', ['linear'], Z, z(5.3), 0, z(6.2), ['get', 'cap'], z(7.6), ['get', 'cap'], z(8.2), 0],
      'fill-extrusion-height': ['interpolate', ['linear'], Z, z(5.3), 0, z(6.2), ['get', 'top'], z(7.6), ['get', 'top'], z(8.2), 0],
    }, before)
  }, [map, atlas, cities, pal, provH, P, beforeId, shift])

  useEffect(
    () => () => {
      if (map)
        removeLayers(
          map,
          [`${P}-col-s-cap`, `${P}-col-s`, `${P}-col-l-cap`, `${P}-col-l`, `${P}-ext`, `${P}-line`, `${P}-fill`],
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
  shift = 0,
}: {
  cities: { code: string; count: number }[]
  theme?: LitTheme
  idPrefix?: string
  beforeId?: string
  shift?: number
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
    const z = (v: number) => v + shift
    const [D0, D1] = dayWindow(shift)
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
    setOrAdd(map, { id: `${P}-pref-fill`, type: 'fill', source: `${P}-pref`, filter: lit }, {
      'fill-color': ['interpolate', ['linear'], Z, D0, color, D1, pal.routeDay],
      'fill-opacity': ['interpolate', ['linear'], Z, z(5.0), 0, z(6.0), 0.36, z(7.6), 0.3, D0, 0.2, D1, 0.035, z(10.5), 0],
    }, before)
    // 去过的城市边界内侧一圈柔光，夜色下更像「点亮」
    setOrAdd(map, { id: `${P}-pref-glow`, type: 'line', source: `${P}-pref`, filter: lit }, {
      'line-color': pal.line,
      'line-width': ['interpolate', ['linear'], Z, 6, 5, 9, 10],
      'line-blur': ['interpolate', ['linear'], Z, 6, 5, 9, 10],
      'line-opacity': ['interpolate', ['linear'], Z, z(5.0), 0, z(6.0), 0.28, D0, 0.22, D1, 0],
    }, before)
    setOrAdd(map, { id: `${P}-pref-line`, type: 'line', source: `${P}-pref` }, {
      'line-color': ['interpolate', ['linear'], Z, D0, ['case', lit, pal.line, IDLE_NIGHT], D1, ['case', lit, pal.routeDay, IDLE_DAY]],
      'line-opacity': ['interpolate', ['linear'], Z, z(5.0), 0, z(6.0), ['case', lit, 0.9, 0.22], D1, ['case', lit, 0.55, 0.14], z(12), ['case', lit, 0.3, 0.08]],
      'line-width': ['interpolate', ['linear'], Z, 6, ['case', lit, 1.1, 0.5], 10, ['case', lit, 1.6, 0.7]],
    }, before)
  }, [map, prefs, cities, pal, P, beforeId, shift])

  useEffect(
    () => () => {
      if (map) removeLayers(map, [`${P}-pref-line`, `${P}-pref-glow`, `${P}-pref-fill`], [`${P}-pref`])
    },
    [map, P],
  )
  return null
}
