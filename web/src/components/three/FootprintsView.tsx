import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Play } from 'lucide-react'
import type { Footprints } from '@/api/types'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { removeLayers, upsertSource } from '@/components/map/layers'
import { buttonClass } from '@/components/ui'
import { cn } from '@/lib/cn'
import { FootprintMap, mapGestureOptions } from './FootprintMap'
import { litPalettes, type LitTheme } from './LitProvinces'

type Mode = 'map' | 'globe' | 'list'

/** 地球模式：原生图层（支持球面投影），缓慢自转 */
function GlobeLayers({ data, theme }: { data: Footprints; theme: LitTheme }) {
  const map = useMap()
  useEffect(() => {
    if (!map) return
    const pal = litPalettes[theme]
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
        paint: { 'line-color': pal.routeNight, 'line-width': 1.6, 'line-opacity': 0.85 },
      })
      map.addLayer({
        id: 'globe-glow',
        type: 'circle',
        source: 'globe-points',
        paint: { 'circle-radius': 10, 'circle-color': pal.column, 'circle-opacity': 0.16, 'circle-blur': 1 },
      })
      map.addLayer({
        id: 'globe-points',
        type: 'circle',
        source: 'globe-points',
        paint: { 'circle-radius': 2.6, 'circle-color': pal.column, 'circle-stroke-color': pal.high, 'circle-stroke-width': 1 },
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
  }, [map, data, theme])
  return null
}

/** 城市清单：像字体样张那样一行一个省——左侧细小的序号和计数，右侧大号宋体省名，下面一行城市 */
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
          className="animate-slide-up grid gap-x-8 gap-y-3 border-t border-ink-200 pt-3 pb-7 md:grid-cols-12 md:pb-9"
        >
          <p className="flex items-baseline gap-3 text-xs text-ink-500 md:col-span-3 md:flex-col md:gap-1">
            <span className="font-num text-[13px] text-ink-900">{String(i + 1).padStart(2, '0')}</span>
            <span>
              <span className="font-num text-ink-700">{cities.length}</span> 座城市 · <span className="font-num text-ink-700">{count}</span> 处足迹
            </span>
          </p>
          <div className="min-w-0 md:col-span-9">
            <p className="font-display text-[2.5rem] leading-none text-ink-900 md:text-[3.75rem]">{prov.replace(/(省|市|自治区|壮族自治区|回族自治区|维吾尔自治区|特别行政区)$/, '') || prov}</p>
            <p className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-ink-700">
              {cities.map((c) => (
                <span key={c.code} className="inline-flex items-baseline gap-1.5">
                  {c.name}
                  <span className="font-num text-xs text-ink-400">{c.count}</span>
                </span>
              ))}
            </p>
          </div>
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
  return (
    <div>
      {/* 细线标签行：左侧标签 + 计数，右侧文字切换和回放 */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-ink-200 pt-2 pb-3 md:pb-4">
        <p className="flex min-w-0 items-baseline gap-3 py-2">
          <span className="eyebrow !text-ink-800">{label}</span>
          <span className="text-[13px] text-ink-400">
            <span className="font-num">{data.stats.provinces}</span> 省 · <span className="font-num">{data.stats.cities}</span> 城
          </span>
        </p>
        <div className="flex items-center gap-x-4 gap-y-2 max-sm:w-full max-sm:justify-between">
          <div role="group" aria-label="足迹视图" className="flex items-center text-[13px]">
            {modes.map((o, i) => (
              <Fragment key={o.value}>
                {i > 0 && (
                  <span aria-hidden className="text-ink-300">
                    /
                  </span>
                )}
                <button
                  type="button"
                  aria-pressed={mode === o.value}
                  onClick={() => setMode(o.value)}
                  className={cn(
                    'inline-flex h-10 items-center px-2.5 tracking-wide whitespace-nowrap transition-colors duration-300 md:h-9',
                    mode === o.value ? 'text-ink-900 underline decoration-1 underline-offset-[7px]' : 'text-ink-400 hover:text-ink-900',
                  )}
                >
                  {o.label}
                </button>
              </Fragment>
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
          <div className={cn('bg-night animate-fade-in relative overflow-hidden', height)}>
            <BaseMap className="absolute inset-0" kind="dark" globe center={[110, 30]} zoom={1.6} options={mapGestureOptions}>
              <GlobeLayers data={data} theme={theme} />
            </BaseMap>
            <div className="pointer-events-none absolute bottom-0 left-0 z-10 h-40 w-[min(100%,28rem)] bg-[radial-gradient(ellipse_at_bottom_left,rgb(0_0_0/0.6),transparent_70%)]" />
            <div className="pointer-events-none absolute bottom-4 left-4 z-10 md:bottom-6 md:left-8">
              <p className="eyebrow !text-white/50">Globe · 地球</p>
              <p className="mt-1.5 text-[13px] text-white/70">
                <span className="font-num text-xl font-light text-white">{data.stats.trips}</span> 段旅程
                <span className="font-num ml-3 text-xl font-light text-white">{data.stats.waypoints}</span> 处足迹
              </p>
            </div>
          </div>
        )}
      </div>
      {mode === 'list' && <CityList data={data} />}
    </div>
  )
}
