import { useEffect } from 'react'
import type { ExpressionSpecification } from 'maplibre-gl'
import { useQuery } from '@tanstack/react-query'
import { useMap } from '@/components/map/BaseMap'
import { removeLayers, upsertSource } from '@/components/map/layers'
import { loadAtlas } from '@/lib/atlas'

export type LitTheme = 'sunset' | 'love'

/** 去过的省份拔高：基础高度 + 按打卡数占比增加的高度（米）。城市光柱等 deck.gl 图层要立在省份顶面上，共用这组数 */
export const PROV_BASE_H = 40000
export const PROV_SPAN_H = 160000
export const provinceHeight = (count: number, max: number) => (count > 0 ? PROV_BASE_H + PROV_SPAN_H * (count / max) : 0)

const themes: Record<LitTheme, { low: string; high: string; line: string }> = {
  sunset: { low: '#ff9a44', high: '#ff3d6e', line: '#ffd2b8' },
  love: { low: '#ff8ec7', high: '#9b5cff', line: '#ffd1ec' },
}

/**
 * 点亮去过的省份：去过的省份按打卡数拔高（3D），没去过的省份以暗色轮廓显示
 */
export function LitProvinces({
  counts,
  theme = 'sunset',
  extrude = true,
  idPrefix = 'lit',
}: {
  counts: Record<string, number>
  theme?: LitTheme
  extrude?: boolean
  idPrefix?: string
}) {
  const map = useMap()
  const { data: atlas } = useQuery({ queryKey: ['atlas'], queryFn: loadAtlas, staleTime: Infinity })

  useEffect(() => {
    if (!map || !atlas) return
    const max = Math.max(1, ...Object.values(counts))
    const features = atlas.provinces.features.map((f) => ({
      ...f,
      properties: { ...f.properties, count: counts[f.properties.id] ?? 0 },
    }))
    const P = idPrefix
    upsertSource(map, `${P}-prov`, { type: 'FeatureCollection', features })
    const t = themes[theme]
    // interpolate 的输入值必须严格递增：max 为 1（每个省都只打卡过一次）时整个图层会被拒绝，直接用最亮的颜色
    const lit: ExpressionSpecification | string =
      max > 1 ? ['interpolate', ['linear'], ['get', 'count'], 1, t.low, max, t.high] : t.high
    const color: ExpressionSpecification = ['case', ['>', ['get', 'count'], 0], lit, 'rgba(120,130,170,0.18)']
    if (!map.getLayer(`${P}-fill`)) {
      map.addLayer({
        id: `${P}-fill`,
        type: 'fill-extrusion',
        source: `${P}-prov`,
        paint: {
          'fill-extrusion-color': color,
          'fill-extrusion-opacity': 0.85,
          'fill-extrusion-base': 0,
          'fill-extrusion-height': 0,
          'fill-extrusion-height-transition': { duration: 1200, delay: 0 },
        },
      })
    } else {
      map.setPaintProperty(`${P}-fill`, 'fill-extrusion-color', color)
    }
    if (!map.getLayer(`${P}-line`)) {
      map.addLayer({
        id: `${P}-line`,
        type: 'line',
        source: `${P}-prov`,
        paint: {
          'line-color': ['case', ['>', ['get', 'count'], 0], t.line, 'rgba(160,170,210,0.35)'],
          'line-width': ['case', ['>', ['get', 'count'], 0], 1.2, 0.6],
        },
      })
    }
    // 下一帧再设置高度，触发升起动画
    const h = requestAnimationFrame(() => {
      if (!map.getLayer(`${P}-fill`)) return
      map.setPaintProperty(
        `${P}-fill`,
        'fill-extrusion-height',
        extrude
          ? ['case', ['>', ['get', 'count'], 0], ['+', PROV_BASE_H, ['*', PROV_SPAN_H, ['/', ['get', 'count'], max]]], 0]
          : 0,
      )
    })
    return () => cancelAnimationFrame(h)
  }, [map, atlas, counts, theme, extrude, idPrefix])

  useEffect(
    () => () => {
      if (map) removeLayers(map, [`${idPrefix}-fill`, `${idPrefix}-line`], [`${idPrefix}-prov`])
    },
    [map, idPrefix],
  )
  return null
}
