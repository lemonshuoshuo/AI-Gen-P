import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Play } from 'lucide-react'
import type { Map as MLMap } from 'maplibre-gl'
import type { Footprints } from '@/api/types'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { removeLayers, upsertSource } from '@/components/map/layers'
import { buttonClass, selectedClass } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useThemeScope } from '@/theme'
import { FootprintMap, mapGestureOptions } from './FootprintMap'
import { useLitPalette, type LitPalette, type LitTheme } from './palette'

type Mode = 'map' | 'globe' | 'list'

/** 地球上的颜色：夜色里的路线、光点（主题令牌，见 ./palette） */
const globePaint = (pal: LitPalette): Record<string, Record<string, unknown>> => ({
  'globe-paths': { 'line-color': pal.routeNight },
  'globe-glow': { 'circle-color': pal.column },
  'globe-points': { 'circle-color': pal.column, 'circle-stroke-color': pal.line },
})

/** 地球模式：原生图层（支持球面投影），缓慢自转 */
function GlobeLayers({ data, theme }: { data: Footprints; theme: LitTheme }) {
  const map = useMap()
  const pal = useLitPalette(theme)
  const palRef = useRef(pal)
  palRef.current = pal
  useEffect(() => {
    if (!map) return
    const paint = globePaint(palRef.current)
    upsertSource(map, 'globe-paths', {
      type: 'FeatureCollection',
      features: data.trips
        .filter((t) => t.path.length > 1)
        .map((t) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: t.path } })),
    })
    upsertSource(map, 'globe-points', {
      type: 'FeatureCollection',
      features: data.points.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })),
    })
    if (!map.getLayer('globe-paths')) {
      map.addLayer({
        id: 'globe-paths',
        type: 'line',
        source: 'globe-paths',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { ...paint['globe-paths'], 'line-width': 1.6, 'line-opacity': 0.85 },
      })
      map.addLayer({
        id: 'globe-glow',
        type: 'circle',
        source: 'globe-points',
        paint: { ...paint['globe-glow'], 'circle-radius': 10, 'circle-opacity': 0.16, 'circle-blur': 1 },
      })
      map.addLayer({
        id: 'globe-points',
        type: 'circle',
        source: 'globe-points',
        paint: { ...paint['globe-points'], 'circle-radius': 2.6, 'circle-stroke-width': 1 },
      })
    }
    let raf = 0
    let spinning = true
    const stop = () => (spinning = false)
    map.on('mousedown', stop)
    map.on('touchstart', stop)
    map.on('wheel', stop)
    const spin = () => {
      if (spinning) {
        const c = map.getCenter()
        map.setCenter([c.lng + 0.06, c.lat])
      }
      raf = requestAnimationFrame(spin)
    }
    raf = requestAnimationFrame(spin)
    return () => {
      cancelAnimationFrame(raf)
      map.off('mousedown', stop)
      map.off('touchstart', stop)
      map.off('wheel', stop)
      removeLayers(map, ['globe-points', 'globe-glow', 'globe-paths'], ['globe-points', 'globe-paths'])
    }
  }, [map, data])
  // 换主题 / 深浅色：只重设颜色，不打断自转
  useEffect(() => {
    if (!map) return
    const set = map.setPaintProperty as (l: string, k: string, v: unknown) => MLMap
    for (const [id, paint] of Object.entries(globePaint(pal)))
      if (map.getLayer(id)) for (const [k, v] of Object.entries(paint)) set.call(map, id, k, v)
  }, [map, pal])
  return null
}

/** 城市清单：一行一个省——左侧细小的序号和城市数，中间省名（区块标题的字号）与城市，右侧这个省的足迹数 */
function CityList({ data }: { data: Footprints }) {
  const byProvince = useMemo(() => {
    const m = new Map<string, Footprints['cities']>()
    data.cities.forEach((c) => m.set(c.province, [...(m.get(c.province) ?? []), c]))
    const provCount = new Map(data.provinces.map((p) => [p.name, p.count]))
    return [...m.entries()]
      .map(([prov, cities]) => ({ prov, cities, count: provCount.get(prov) ?? cities.reduce((s, c) => s + c.count, 0) }))
      .sort((a, b) => b.cities.length - a.cities.length || b.count - a.count)
  }, [data.cities, data.provinces])
  if (!byProvince.length) return <p className="py-10 text-center text-sm text-ink-400">还没有足迹</p>
  return (
    <div className="border-b border-ink-200">
      {byProvince.map(({ prov, cities, count }, i) => (
        <div
          key={prov}
          style={{ animationDelay: `${Math.min(i, 8) * 60}ms`, animationFillMode: 'backwards' }}
          className="animate-slide-up grid grid-cols-[1fr_auto] gap-x-6 gap-y-3 border-t border-ink-200 pt-3 pb-6 md:grid-cols-12 md:gap-x-8 md:pb-8"
        >
          <p className="col-span-2 flex items-baseline gap-3 text-xs text-ink-500 md:col-span-3 md:flex-col md:gap-1">
            <span className="font-num text-[13px] text-ink-900">{String(i + 1).padStart(2, '0')}</span>
            <span>
              <span className="font-num text-ink-700">{cities.length}</span> 座城市
            </span>
          </p>
          <div className="min-w-0 md:col-span-6">
            <p className="text-display-md text-ink-900">{prov.replace(/(省|市|自治区|壮族自治区|回族自治区|维吾尔自治区|特别行政区)$/, '') || prov}</p>
            <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-ink-700">
              {cities.map((c) => (
                <span key={c.code} className="inline-flex items-baseline gap-1.5">
                  {c.name}
                  <span className="font-num text-xs text-ink-400">{c.count}</span>
                </span>
              ))}
            </p>
          </div>
          {/* 右侧：这个省的足迹数（与省名同一档字号） */}
          <p className="flex flex-col items-end text-right md:col-span-3">
            <span className="font-num text-[length:var(--text-h2)] leading-none text-ink-900">{count}</span>
            <span className="caption mt-1.5 !text-xs">处足迹</span>
          </p>
        </div>
      ))}
    </div>
  )
}

const modes: { value: Mode; label: ReactNode }[] = [
  { value: 'map', label: <span><span className="hidden sm:inline">足迹</span>地图</span> },
  { value: 'globe', label: <span><span className="hidden sm:inline">足迹</span>地球</span> },
  { value: 'list', label: <span><span className="hidden sm:inline">城市</span>清单</span> },
]

export function FootprintsView({
  data,
  theme = 'sunset',
  replayTo,
  height = 'h-[52vh] min-h-80 sm:h-[62vh]',
  label = 'Atlas · 足迹地图',
  bleed,
}: {
  data: Footprints
  theme?: LitTheme
  replayTo?: string
  height?: string
  /** 标签行左侧的小标签 */
  label?: ReactNode
  /** 地图出血到页面边缘（页面容器是 px-4 md:px-8） */
  bleed?: boolean
}) {
  const [mode, setMode] = useState<Mode>('map')
  const love = theme === 'love'
  // 地球是夜景：任何模式下都用当前主题的深色令牌（说明文字、控件跟着变深）
  const night = useThemeScope('dark')
  // 标签随视图变化
  const labels: Record<Mode, ReactNode> = { map: label, globe: 'Globe · 足迹地球', list: 'Index · 城市清单' }
  return (
    <div>
      {/* 细线标签行：左侧标签 + 计数，右侧文字切换和回放 */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-ink-200 pt-2 pb-3 md:pb-4">
        <p className="flex min-w-0 items-baseline gap-3 py-2">
          <span className="eyebrow !text-ink-800">{labels[mode]}</span>
          <span className="text-[13px] text-ink-400">
            <span className="font-num">{data.stats.provinces}</span> 省 · <span className="font-num">{data.stats.cities}</span> 城
          </span>
        </p>
        <div className="flex items-center gap-x-4 gap-y-2 max-sm:w-full max-sm:justify-between">
          {/* 文字筛选用主题的 Tab 语言：选中项 600 字重 + 强调色下划线（山野、暮色是实心胶囊）；手机上 -ml-3 让文字与栅格边缘对齐 */}
          <div role="group" aria-label="足迹视图" className="flex items-center gap-1 max-sm:-ml-3">
            {modes.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={mode === o.value}
                onClick={() => setMode(o.value)}
                className={selectedClass(mode === o.value, 'filter', 'inline-flex h-10 items-center px-3 text-[13.5px] whitespace-nowrap md:h-9')}
              >
                {o.label}
              </button>
            ))}
          </div>
          {replayTo && data.trips.length > 0 && (
            <Link to={replayTo} className={buttonClass({ size: 'md', variant: 'outline', className: 'md:h-9' })}>
              <Play className={cn('size-3.5', love ? 'fill-pink-600 text-pink-600' : 'fill-current')} strokeWidth={1.4} />
              3D 回放
            </Link>
          )}
        </div>
      </div>

      <div className={cn(bleed && mode !== 'list' && '-mx-4 md:-mx-8')}>
        {mode === 'map' && <FootprintMap data={data} theme={theme} className={height} />}
        {mode === 'globe' && (
          <div {...night} className={cn('bg-night animate-fade-in relative overflow-hidden', height)}>
            <BaseMap className="absolute inset-0" kind="dark" globe center={[110, 30]} zoom={1.6} options={mapGestureOptions}>
              <GlobeLayers data={data} theme={theme} />
            </BaseMap>
            <div className="pointer-events-none absolute bottom-0 left-0 z-10 h-40 w-[min(100%,28rem)] bg-[radial-gradient(ellipse_at_bottom_left,color-mix(in_oklab,var(--color-night)_80%,transparent),transparent_70%)]" />
            <div className="pointer-events-none absolute bottom-4 left-4 z-10 md:bottom-6 md:left-8">
              <p className="eyebrow">Globe · 地球</p>
              <p className="mt-1.5 text-[13px] text-ink-700">
                <span className="font-num text-xl text-ink-900">{data.stats.trips}</span> 段旅程
                <span className="font-num ml-3 text-xl text-ink-900">{data.stats.waypoints}</span> 处足迹
              </p>
            </div>
          </div>
        )}
      </div>
      {mode === 'list' && <CityList data={data} />}
    </div>
  )
}
