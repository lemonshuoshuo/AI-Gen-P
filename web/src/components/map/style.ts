import type { ExpressionSpecification, Map as MLMap, StyleSpecification } from 'maplibre-gl'
import type { SiteConfig } from '@/api/types'

/**
 * normal：纸色标准底图；satellite：卫星；dark：夜间（黛青）；
 * auto：随缩放变化——全国 / 省级为夜色（点亮中国的 3D 场景），放大到城市级时渐变为纸色底图（2.5D 足迹、照片）
 */
export type BaseKind = 'normal' | 'satellite' | 'dark' | 'auto'

const sub = (tpl: string) => [1, 2, 3, 4].map((i) => tpl.replace('{s}', String(i)))

export const defaultTiles: SiteConfig['map']['tiles'] = {
  normal: sub('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'),
  satellite: sub('https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}'),
  satellite_label: sub('https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}'),
}

/** 站点配置没有给出 map.attribution 时的底图版权；换了瓦片源或要显示审图号时由服务端配置 */
export const defaultAttribution = '© 高德地图'

// 夜间：亮度反转 + 色相旋转 + 降饱和，叠在黛青底色上，适合 3D 轨迹展示
const darkPaint = {
  'raster-brightness-min': 0.86,
  'raster-brightness-max': 0.05,
  'raster-hue-rotate': 180,
  'raster-saturation': -0.72,
  'raster-contrast': 0.1,
  'raster-opacity': 0.9,
}
// 标准：降饱和、略透出暖色底，像一张旧纸地图，让路线和标记成为主角
const normalPaint = {
  'raster-brightness-min': 0.03,
  'raster-brightness-max': 0.99,
  'raster-hue-rotate': 0,
  'raster-saturation': -0.58,
  'raster-contrast': -0.04,
  'raster-opacity': 0.86,
}

export const MAP_BG = { light: '#e8dfcf', dark: '#0c1314' }

/** auto 底图从夜色过渡到纸色的缩放区间（足迹地图进入城市级 2.5D 视图时完成过渡） */
export const AUTO_DAY_ZOOM: [number, number] = [8.2, 8.65]

type Win = readonly [number, number]
// 每张地图可以有自己的过渡区间（足迹地图按宽度调整：窄屏上同样的缩放级别看到的范围更小）
const autoWindows = new WeakMap<MLMap, Win>()
const winOf = (map?: MLMap): Win => (map && autoWindows.get(map)) || AUTO_DAY_ZOOM

/** 按缩放在夜色与纸色之间插值（auto 底图与叠加图层共用） */
export function dayNight<T extends string | number>(night: T, day: T, win: Win = AUTO_DAY_ZOOM): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], win[0], night, win[1], day] as ExpressionSpecification
}

type Paint = string | number | ExpressionSpecification

function bgFor(kind: BaseKind, win: Win = AUTO_DAY_ZOOM): Paint {
  return kind === 'dark' ? MAP_BG.dark : kind === 'auto' ? dayNight(MAP_BG.dark, MAP_BG.light, win) : MAP_BG.light
}

/** 瓦片加载失败时的兜底省界轮廓配色 */
export function atlasPaint(kind: BaseKind, map?: MLMap): { fill: Paint; line: Paint } {
  const win = winOf(map)
  if (kind === 'dark') return { fill: '#131d1f', line: '#2c3d40' }
  if (kind === 'auto') return { fill: dayNight('#131d1f', '#faf7f0', win), line: dayNight('#2c3d40', '#cdc3b1', win) }
  return { fill: '#faf7f0', line: '#cdc3b1' }
}

/** 主栅格图层（th-normal）的配色；auto 时它是夜色层，放大后淡出，下方的 th-normal-day 淡入 */
function normalLayerPaint(kind: BaseKind, win: Win = AUTO_DAY_ZOOM): Record<string, Paint> {
  if (kind === 'dark') return darkPaint
  if (kind === 'auto') return { ...darkPaint, 'raster-opacity': dayNight(darkPaint['raster-opacity'], 0, win) }
  return normalPaint
}
const dayLayerPaint = (win: Win = AUTO_DAY_ZOOM) => ({ ...normalPaint, 'raster-opacity': dayNight(0, normalPaint['raster-opacity'], win) })

export function buildStyle(
  tiles: SiteConfig['map']['tiles'],
  kind: BaseKind,
  attribution: string = defaultAttribution,
): StyleSpecification {
  return {
    version: 8,
    sources: {
      'th-normal': { type: 'raster', tiles: tiles.normal, tileSize: 256, maxzoom: 18, attribution },
      'th-sat': { type: 'raster', tiles: tiles.satellite, tileSize: 256, maxzoom: 18, attribution },
      'th-sat-label': { type: 'raster', tiles: tiles.satellite_label, tileSize: 256, maxzoom: 18 },
    },
    layers: [
      {
        id: 'th-bg',
        type: 'background',
        paint: { 'background-color': bgFor(kind) as string },
      },
      {
        id: 'th-normal',
        type: 'raster',
        source: 'th-normal',
        layout: { visibility: kind === 'satellite' ? 'none' : 'visible' },
        paint: { ...(normalLayerPaint(kind) as Record<string, number>), 'raster-fade-duration': 200 },
      },
      // auto 底图的纸色层：与 th-normal 共用同一个瓦片源（不会重复下载），按缩放淡入
      {
        id: 'th-normal-day',
        type: 'raster',
        source: 'th-normal',
        layout: { visibility: kind === 'auto' ? 'visible' : 'none' },
        paint: { ...(dayLayerPaint() as unknown as Record<string, number>), 'raster-fade-duration': 200 },
      },
      {
        id: 'th-sat',
        type: 'raster',
        source: 'th-sat',
        layout: { visibility: kind === 'satellite' ? 'visible' : 'none' },
      },
      {
        id: 'th-sat-label',
        type: 'raster',
        source: 'th-sat-label',
        layout: { visibility: kind === 'satellite' ? 'visible' : 'none' },
      },
    ],
    sky: skyFor(kind) as StyleSpecification['sky'],
  }
}

const skyDark = {
  'sky-color': '#0c1314',
  'horizon-color': '#1d2c2e',
  'fog-color': '#0c1314',
}
const skyLight = {
  'sky-color': '#dce3df',
  'horizon-color': '#efe9dd',
  'fog-color': '#f4f1ea',
}

function skyFor(kind: BaseKind, win: Win = AUTO_DAY_ZOOM) {
  if (kind === 'auto')
    return {
      'sky-color': dayNight(skyDark['sky-color'], skyLight['sky-color'], win),
      'horizon-color': dayNight(skyDark['horizon-color'], skyLight['horizon-color'], win),
      'fog-color': dayNight(skyDark['fog-color'], skyLight['fog-color'], win),
      'sky-horizon-blend': 0.5,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.25,
      'atmosphere-blend': 0.7,
    }
  return kind === 'dark'
    ? { ...skyDark, 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.2, 'atmosphere-blend': 0.6 }
    : { ...skyLight, 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.3, 'atmosphere-blend': 0.8 }
}

/** 设置 auto 底图从夜色过渡到纸色的缩放区间（只影响这张地图） */
export function setAutoDayZoom(map: MLMap, win: Win) {
  autoWindows.set(map, win)
  if (map.getLayer('th-normal-day') && map.getLayoutProperty('th-normal-day', 'visibility') === 'visible') setBaseKind(map, 'auto')
}

/** 切换底图风格，不重建样式（保留业务图层） */
export function setBaseKind(map: MLMap, kind: BaseKind) {
  if (!map.getLayer('th-normal')) return
  const win = winOf(map)
  const set = (layer: string, k: string, v: Paint) => (map.setPaintProperty as (l: string, k: string, v: unknown) => void).call(map, layer, k, v)
  map.setLayoutProperty('th-normal', 'visibility', kind === 'satellite' ? 'none' : 'visible')
  map.setLayoutProperty('th-sat', 'visibility', kind === 'satellite' ? 'visible' : 'none')
  map.setLayoutProperty('th-sat-label', 'visibility', kind === 'satellite' ? 'visible' : 'none')
  for (const [k, v] of Object.entries(normalLayerPaint(kind, win))) set('th-normal', k, v)
  if (map.getLayer('th-normal-day')) {
    map.setLayoutProperty('th-normal-day', 'visibility', kind === 'auto' ? 'visible' : 'none')
    if (kind === 'auto') set('th-normal-day', 'raster-opacity', dayLayerPaint(win)['raster-opacity'])
  }
  set('th-bg', 'background-color', bgFor(kind, win))
  if (map.getLayer('th-atlas-fill')) {
    const a = atlasPaint(kind, map)
    set('th-atlas-fill', 'fill-color', a.fill)
    set('th-atlas-line', 'line-color', a.line)
  }
  map.setSky(skyFor(kind, win) as Parameters<MLMap['setSky']>[0])
}
