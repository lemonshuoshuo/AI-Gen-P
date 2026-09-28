import type { Map as MLMap, StyleSpecification } from 'maplibre-gl'
import type { SiteConfig } from '@/api/types'

export type BaseKind = 'normal' | 'satellite' | 'dark'

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
        paint: { 'background-color': kind === 'dark' ? MAP_BG.dark : MAP_BG.light },
      },
      {
        id: 'th-normal',
        type: 'raster',
        source: 'th-normal',
        layout: { visibility: kind === 'satellite' ? 'none' : 'visible' },
        paint: { ...(kind === 'dark' ? darkPaint : normalPaint), 'raster-fade-duration': 200 },
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
    sky: skyFor(kind),
  }
}

function skyFor(kind: BaseKind) {
  return kind === 'dark'
    ? {
        'sky-color': '#0c1314',
        'horizon-color': '#1d2c2e',
        'fog-color': '#0c1314',
        'sky-horizon-blend': 0.6,
        'horizon-fog-blend': 0.6,
        'fog-ground-blend': 0.2,
        'atmosphere-blend': 0.6,
      }
    : {
        'sky-color': '#dce3df',
        'horizon-color': '#efe9dd',
        'fog-color': '#f4f1ea',
        'sky-horizon-blend': 0.5,
        'horizon-fog-blend': 0.6,
        'fog-ground-blend': 0.3,
        'atmosphere-blend': 0.8,
      }
}

/** 切换底图风格，不重建样式（保留业务图层） */
export function setBaseKind(map: MLMap, kind: BaseKind) {
  if (!map.getLayer('th-normal')) return
  map.setLayoutProperty('th-normal', 'visibility', kind === 'satellite' ? 'none' : 'visible')
  map.setLayoutProperty('th-sat', 'visibility', kind === 'satellite' ? 'visible' : 'none')
  map.setLayoutProperty('th-sat-label', 'visibility', kind === 'satellite' ? 'visible' : 'none')
  const paint = kind === 'dark' ? darkPaint : normalPaint
  for (const [k, v] of Object.entries(paint)) map.setPaintProperty('th-normal', k as 'raster-contrast', v)
  map.setPaintProperty('th-bg', 'background-color', kind === 'dark' ? MAP_BG.dark : MAP_BG.light)
  if (map.getLayer('th-atlas-fill')) {
    map.setPaintProperty('th-atlas-fill', 'fill-color', kind === 'dark' ? '#131d1f' : '#faf7f0')
    map.setPaintProperty('th-atlas-line', 'line-color', kind === 'dark' ? '#2c3d40' : '#cdc3b1')
  }
  map.setSky(skyFor(kind))
}

