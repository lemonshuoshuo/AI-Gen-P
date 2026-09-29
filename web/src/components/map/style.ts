import type { ExpressionSpecification, Map as MLMap, StyleSpecification } from 'maplibre-gl'
import type { SiteConfig } from '@/api/types'
import { THEME_EVENT, getResolvedTheme } from '@/theme/runtime'
import type { Mode, ThemeId } from '@/theme/themes'

/**
 * 底图随主题变化：每个主题 × 模式有自己的栅格调色、底色、天空和兜底省界配色（数值来自主题方案）。
 * normal：当前模式的底图（浅色模式是纸色地图，深色模式是夜色地图）；satellite：卫星；
 * dark：夜间（3D 场景，任何模式下都是该主题的夜色）；
 * auto：随缩放变化——全国 / 省级为夜色（点亮中国的 3D 场景），放大到城市级时渐变为当前模式的底图（2.5D 足迹、照片）
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

type RasterKey = 'raster-saturation' | 'raster-contrast' | 'raster-brightness-min' | 'raster-brightness-max' | 'raster-hue-rotate' | 'raster-opacity'

export interface MapPalette {
  /** 地图底色（瓦片之下） */
  bg: string
  /** 主栅格图层（th-normal）的调色 */
  paint: Record<RasterKey, number>
  /** 3D 倾斜时的天空 */
  sky: { sky: string; horizon: string; fog: string }
  /** 瓦片加载失败时的兜底省界轮廓 */
  atlas: { fill: string; line: string }
  /** 路线：实际（打卡连线）/ 计划（虚线）/ GPS 轨迹 */
  routes: { actual: string; planned: string; track: string }
}

// 浅色：去饱和、压低对比，叠在纸色底上；深色：亮度反转 + 色相旋转，叠在夜色底上
const PALETTES: Record<ThemeId, Record<Mode, MapPalette>> = {
  journal: {
    light: {
      bg: '#eadcbf',
      paint: { 'raster-saturation': -0.85, 'raster-contrast': -0.12, 'raster-brightness-min': 0.16, 'raster-brightness-max': 1.0, 'raster-hue-rotate': 0, 'raster-opacity': 0.64 },
      sky: { sky: '#fffcf5', horizon: '#eadcbf', fog: '#eadcbf' },
      atlas: { fill: '#f4ecdb', line: '#b6aaa0' },
      routes: { actual: '#9e380a', planned: '#406f8d', track: '#9280aa' },
    },
    dark: {
      bg: '#211a14',
      paint: { 'raster-saturation': -0.9, 'raster-contrast': 0.06, 'raster-brightness-min': 0.86, 'raster-brightness-max': 0.08, 'raster-hue-rotate': 180, 'raster-opacity': 0.62 },
      sky: { sky: '#141110', horizon: '#2b2520', fog: '#211a14' },
      atlas: { fill: '#2b2520', line: '#554f49' },
      routes: { actual: '#e88356', planned: '#739eba', track: '#86739e' },
    },
  },
  camp: {
    light: {
      bg: '#ebe6cc',
      paint: { 'raster-saturation': -0.35, 'raster-contrast': -0.06, 'raster-brightness-min': 0.12, 'raster-brightness-max': 1.0, 'raster-hue-rotate': 0, 'raster-opacity': 0.8 },
      sky: { sky: '#fffdf6', horizon: '#ebe6cc', fog: '#ebe6cc' },
      atlas: { fill: '#f2eedc', line: '#aeaea5' },
      routes: { actual: '#076935', planned: '#2d7197', track: '#dd5a14' },
    },
    dark: {
      bg: '#101610',
      paint: { 'raster-saturation': -0.7, 'raster-contrast': 0.05, 'raster-brightness-min': 0.84, 'raster-brightness-max': 0.1, 'raster-hue-rotate': 180, 'raster-opacity': 0.72 },
      sky: { sky: '#0c110d', horizon: '#212821', fog: '#101610' },
      atlas: { fill: '#212821', line: '#4d5048' },
      routes: { actual: '#61ac75', planned: '#669ebf', track: '#f2b53a' },
    },
  },
  coast: {
    light: {
      bg: '#e9eef0',
      paint: { 'raster-saturation': -0.45, 'raster-contrast': -0.05, 'raster-brightness-min': 0.08, 'raster-brightness-max': 1.0, 'raster-hue-rotate': -6, 'raster-opacity': 0.88 },
      sky: { sky: '#ffffff', horizon: '#e9eef0', fog: '#e9eef0' },
      atlas: { fill: '#f0efe9', line: '#a6aebb' },
      routes: { actual: '#0259b3', planned: '#167585', track: '#e06a42' },
    },
    dark: {
      bg: '#0c1520',
      paint: { 'raster-saturation': -0.62, 'raster-contrast': 0.08, 'raster-brightness-min': 0.84, 'raster-brightness-max': 0.1, 'raster-hue-rotate': 180, 'raster-opacity': 0.7 },
      sky: { sky: '#0a111b', horizon: '#1a2536', fog: '#0c1520' },
      atlas: { fill: '#1a2536', line: '#47505a' },
      routes: { actual: '#6a9ee5', planned: '#58a2b0', track: '#f08a66' },
    },
  },
  dusk: {
    light: {
      bg: '#ecd6cc',
      paint: { 'raster-saturation': -0.9, 'raster-contrast': -0.1, 'raster-brightness-min': 0.14, 'raster-brightness-max': 1.0, 'raster-hue-rotate': 0, 'raster-opacity': 0.66 },
      sky: { sky: '#fcf8f5', horizon: '#ecd6cc', fog: '#ecd6cc' },
      atlas: { fill: '#efe3db', line: '#b3a49b' },
      routes: { actual: '#923456', planned: '#386c86', track: '#b98a45' },
    },
    dark: {
      bg: '#24150f',
      paint: { 'raster-saturation': -0.92, 'raster-contrast': 0.06, 'raster-brightness-min': 0.84, 'raster-brightness-max': 0.08, 'raster-hue-rotate': 180, 'raster-opacity': 0.6 },
      sky: { sky: '#150e0c', horizon: '#30231e', fog: '#24150f' },
      atlas: { fill: '#30231e', line: '#5a4c47' },
      routes: { actual: '#d0889c', planned: '#729db4', track: '#d9b27a' },
    },
  },
  voyage: {
    light: {
      bg: '#ebe9e4',
      paint: { 'raster-saturation': -1, 'raster-contrast': -0.05, 'raster-brightness-min': 0.08, 'raster-brightness-max': 0.98, 'raster-hue-rotate': 0, 'raster-opacity': 0.82 },
      sky: { sky: '#faf9f6', horizon: '#ebe9e4', fog: '#ebe9e4' },
      atlas: { fill: '#ebe8e1', line: '#aaa8a5' },
      routes: { actual: '#9e3114', planned: '#396e7b', track: '#a77d38' },
    },
    dark: {
      bg: '#121210',
      paint: { 'raster-saturation': -0.9, 'raster-contrast': 0.08, 'raster-brightness-min': 0.9, 'raster-brightness-max': 0.07, 'raster-hue-rotate': 180, 'raster-opacity': 0.94 },
      sky: { sky: '#0b0b0a', horizon: '#181816', fog: '#121210' },
      atlas: { fill: '#181816', line: '#4f4c46' },
      routes: { actual: '#c9a868', planned: '#7aa1ab', track: '#b8893f' },
    },
  },
}

/** 地图配色：默认为当前主题、当前模式 */
export function mapPalette(mode?: Mode, theme?: ThemeId): MapPalette {
  const r = getResolvedTheme()
  return PALETTES[theme ?? r.theme][mode ?? r.mode]
}

/** 某种底图上的路线颜色（夜色底图用深色模式的路线色）；画 MapLibre 线图层时用，主题切换后重新读取 */
export function routeColors(kind: BaseKind = 'normal'): MapPalette['routes'] {
  return mapPalette(kind === 'dark' ? 'dark' : undefined).routes
}

/** 兼容旧名：light 为标准底图（当前模式）的底色，dark 为夜间底色 */
export const MAP_BG = {
  get light() {
    return mapPalette().bg
  },
  get dark() {
    return mapPalette('dark').bg
  },
}

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
  const day = mapPalette()
  const night = mapPalette('dark')
  return kind === 'dark' ? night.bg : kind === 'auto' ? dayNight(night.bg, day.bg, win) : day.bg
}

/** 瓦片加载失败时的兜底省界轮廓配色 */
export function atlasPaint(kind: BaseKind, map?: MLMap): { fill: Paint; line: Paint } {
  const win = winOf(map)
  const day = mapPalette().atlas
  const night = mapPalette('dark').atlas
  if (kind === 'dark') return { ...night }
  if (kind === 'auto') return { fill: dayNight(night.fill, day.fill, win), line: dayNight(night.line, day.line, win) }
  return { ...day }
}

/** 主栅格图层（th-normal）的配色；auto 时它是夜色层，放大后淡出，下方的 th-normal-day 淡入 */
function normalLayerPaint(kind: BaseKind, win: Win = AUTO_DAY_ZOOM): Record<string, Paint> {
  if (kind === 'dark') return { ...mapPalette('dark').paint }
  if (kind === 'auto') {
    const night = mapPalette('dark').paint
    return { ...night, 'raster-opacity': dayNight(night['raster-opacity'], 0, win) }
  }
  return { ...mapPalette().paint }
}
const dayLayerPaint = (win: Win = AUTO_DAY_ZOOM): Record<string, Paint> => {
  const day = mapPalette().paint
  return { ...day, 'raster-opacity': dayNight(0, day['raster-opacity'], win) }
}

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

const skyBlendDark = { 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.2, 'atmosphere-blend': 0.6 }
const skyBlendDay = { 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.3, 'atmosphere-blend': 0.8 }

function skyFor(kind: BaseKind, win: Win = AUTO_DAY_ZOOM) {
  const day = mapPalette().sky
  const night = mapPalette('dark').sky
  if (kind === 'auto')
    return {
      'sky-color': dayNight(night.sky, day.sky, win),
      'horizon-color': dayNight(night.horizon, day.horizon, win),
      'fog-color': dayNight(night.fog, day.fog, win),
      'sky-horizon-blend': 0.5,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.25,
      'atmosphere-blend': 0.7,
    }
  const s = kind === 'dark' ? night : day
  const dark = kind === 'dark' || getResolvedTheme().mode === 'dark'
  return { 'sky-color': s.sky, 'horizon-color': s.horizon, 'fog-color': s.fog, ...(dark ? skyBlendDark : skyBlendDay) }
}

/** 设置 auto 底图从夜色过渡到纸色的缩放区间（只影响这张地图） */
export function setAutoDayZoom(map: MLMap, win: Win) {
  autoWindows.set(map, win)
  if (map.getLayer('th-normal-day') && map.getLayoutProperty('th-normal-day', 'visibility') === 'visible') setBaseKind(map, 'auto')
}

/* ---------------- 主题切换时重新套用底图配色 ---------------- */
const mapKinds = new WeakMap<MLMap, BaseKind>()
/** 我们最后一次写到 th-normal 上的调色（JSON）：用来识别 BaseMap 的 rasterTone 等外部覆盖 */
const appliedPaint = new WeakMap<MLMap, Record<string, string>>()
const watched = new WeakSet<MLMap>()

function watchTheme(map: MLMap) {
  if (watched.has(map) || typeof window === 'undefined') return
  watched.add(map)
  const onTheme = () => applyThemeToMap(map)
  window.addEventListener(THEME_EVENT, onTheme)
  map.once('remove', () => window.removeEventListener(THEME_EVENT, onTheme))
}

function applyBase(map: MLMap, kind: BaseKind, keepOverrides: boolean) {
  if (!map.getLayer('th-normal')) return
  const win = winOf(map)
  const set = (layer: string, k: string, v: Paint) => (map.setPaintProperty as (l: string, k: string, v: unknown) => void).call(map, layer, k, v)
  map.setLayoutProperty('th-normal', 'visibility', kind === 'satellite' ? 'none' : 'visible')
  map.setLayoutProperty('th-sat', 'visibility', kind === 'satellite' ? 'visible' : 'none')
  map.setLayoutProperty('th-sat-label', 'visibility', kind === 'satellite' ? 'visible' : 'none')
  const prev = appliedPaint.get(map)
  const record: Record<string, string> = {}
  for (const [k, v] of Object.entries(normalLayerPaint(kind, win))) {
    // 页面在 setBaseKind 之后自己改过的调色（如回放页完全去色）：主题切换时保留
    if (keepOverrides && prev && k in prev && JSON.stringify(map.getPaintProperty('th-normal', k as 'raster-opacity')) !== prev[k]) {
      record[k] = prev[k]
      continue
    }
    set('th-normal', k, v)
    record[k] = JSON.stringify(v)
  }
  appliedPaint.set(map, record)
  if (map.getLayer('th-normal-day')) {
    map.setLayoutProperty('th-normal-day', 'visibility', kind === 'auto' ? 'visible' : 'none')
    if (kind === 'auto') for (const [k, v] of Object.entries(dayLayerPaint(win))) set('th-normal-day', k, v)
  }
  set('th-bg', 'background-color', bgFor(kind, win))
  if (map.getLayer('th-atlas-fill')) {
    const a = atlasPaint(kind, map)
    set('th-atlas-fill', 'fill-color', a.fill)
    set('th-atlas-line', 'line-color', a.line)
  }
  map.setSky(skyFor(kind, win) as Parameters<MLMap['setSky']>[0])
}

/** 切换底图风格，不重建样式（保留业务图层）；同时让这张地图跟随之后的主题切换 */
export function setBaseKind(map: MLMap, kind: BaseKind) {
  if (!map.getLayer('th-normal')) return
  mapKinds.set(map, kind)
  watchTheme(map)
  applyBase(map, kind, false)
}

/**
 * 按当前主题重新套用底图配色（底色、栅格调色、天空、兜底省界）。
 * 用过 setBaseKind 的地图会在 'triphub:theme' 事件时自动调用；也可以手动调用。
 * BaseMap 通过 rasterTone 覆盖过的调色保持不变。
 */
export function applyThemeToMap(map: MLMap) {
  applyBase(map, mapKinds.get(map) ?? 'normal', true)
}
