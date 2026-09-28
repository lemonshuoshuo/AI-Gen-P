import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Globe2, List, Map as MapIcon, Play } from 'lucide-react'
import type { Footprints } from '@/api/types'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { removeLayers, upsertSource } from '@/components/map/layers'
import { Segmented, buttonClass } from '@/components/ui'
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
    <div className="divide-y divide-ink-200 border-y border-ink-200">
      {byProvince.map(({ prov, cities, count }, i) => (
        <div key={prov} className="grid gap-x-6 gap-y-2 py-4 sm:grid-cols-[12rem_1fr]">
          <div className="flex items-baseline gap-3">
            <span className="font-num w-6 text-xs text-ink-300">{String(i + 1).padStart(2, '0')}</span>
            <span className="font-display text-[17px] text-ink-900">{prov}</span>
            <span className="text-xs text-ink-400">
              <span className="font-num text-ink-600">{cities.length}</span> 城 · <span className="font-num text-ink-600">{count}</span> 处
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 pl-9 sm:pl-0">
            {cities.map((c) => (
              <span key={c.code} className="inline-flex items-center gap-1.5 rounded-sm border border-ink-200 px-2 py-0.5 text-[13px] text-ink-700">
                {c.name}
                <span className="font-num text-xs text-ink-400">{c.count}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function FootprintsView({
  data,
  theme = 'sunset',
  replayTo,
  height = 'h-[52vh] min-h-80 sm:h-[62vh]',
}: {
  data: Footprints
  theme?: LitTheme
  replayTo?: string
  height?: string
}) {
  const [mode, setMode] = useState<Mode>('map')
  const icon = 'size-3.5'
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'map', label: <span className="flex items-center gap-1.5"><MapIcon className={icon} strokeWidth={1.6} /><span><span className="hidden sm:inline">足迹</span>地图</span></span> },
            { value: 'globe', label: <span className="flex items-center gap-1.5"><Globe2 className={icon} strokeWidth={1.6} /><span><span className="hidden sm:inline">足迹</span>地球</span></span> },
            { value: 'list', label: <span className="flex items-center gap-1.5"><List className={icon} strokeWidth={1.6} /><span><span className="hidden sm:inline">城市</span>清单</span></span> },
          ]}
        />
        {replayTo && data.trips.length > 0 && (
          <Link to={replayTo} className={buttonClass({ size: 'sm', variant: theme === 'love' ? 'love' : 'outline' })}>
            <Play className="size-3.5" strokeWidth={1.6} />
            3D 回放
          </Link>
        )}
      </div>

      {mode === 'map' && <FootprintMap data={data} theme={theme} className={height} />}
      {mode === 'globe' && (
        <div className={cn('bg-night relative overflow-hidden rounded-xl', height)}>
          <BaseMap className="absolute inset-0" kind="dark" globe center={[110, 30]} zoom={1.6} options={mapGestureOptions}>
            <GlobeLayers data={data} theme={theme} />
          </BaseMap>
          <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 rounded-lg bg-[#0c1314]/55 px-3 py-2 text-xs text-white/65 ring-1 ring-white/10 backdrop-blur">
            <span className="eyebrow !text-white/45">Globe · 地球</span>
            <span className="h-3 w-px bg-white/15" />
            <span>
              <b className="font-num text-gold text-[13px] font-medium">{data.stats.trips}</b> 段旅程
              <b className="font-num text-gold ml-2 text-[13px] font-medium">{data.stats.waypoints}</b> 处足迹
            </span>
          </div>
        </div>
      )}
      {mode === 'list' && <CityList data={data} />}
    </div>
  )
}
