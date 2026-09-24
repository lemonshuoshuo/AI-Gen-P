import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { ArcLayer, ColumnLayer, ScatterplotLayer } from '@deck.gl/layers'
import { Box, Globe2, List, Play } from 'lucide-react'
import type { Footprints } from '@/api/types'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { removeLayers, upsertSource } from '@/components/map/layers'
import { Button, Segmented } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fmtDate } from '@/lib/format'
import { CHINA_CENTER, formatKm } from '@/lib/geo'
import { DeckLayers } from './deck'
import { LitProvinces, type LitTheme } from './LitProvinces'

type Mode = 'china' | 'globe' | 'list'
type City = Footprints['cities'][number]

function CityLayers({ data, theme }: { data: Footprints; theme: LitTheme }) {
  const max = Math.max(1, ...data.cities.map((c) => c.count))
  // 按时间顺序把旅程串起来画弧线
  const arcs = useMemo(() => {
    const trips = [...data.trips].filter((t) => t.path.length).sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))
    const out: { from: [number, number]; to: [number, number] }[] = []
    for (let i = 1; i < trips.length; i++) out.push({ from: trips[i - 1].path[0], to: trips[i].path[0] })
    return out
  }, [data.trips])
  const love = theme === 'love'
  return (
    <DeckLayers
      layers={[
        new ArcLayer<{ from: [number, number]; to: [number, number] }>({
          id: 'fp-arcs',
          data: arcs,
          getSourcePosition: (a) => a.from,
          getTargetPosition: (a) => a.to,
          getSourceColor: love ? [255, 142, 199, 200] : [255, 154, 68, 200],
          getTargetColor: love ? [155, 92, 255, 200] : [255, 90, 95, 200],
          getWidth: 2,
          getHeight: 0.5,
        }),
        new ColumnLayer<City>({
          id: 'fp-city-columns',
          data: data.cities,
          diskResolution: 20,
          radius: 14000,
          extruded: true,
          getPosition: (c) => [c.lng, c.lat],
          getElevation: (c) => 260000 + (c.count / max) * 420000,
          getFillColor: love ? [255, 220, 240, 240] : [255, 240, 200, 240],
          material: { ambient: 0.7, diffuse: 0.5 },
        }),
        new ScatterplotLayer<City>({
          id: 'fp-city-glow',
          data: data.cities,
          getPosition: (c) => [c.lng, c.lat],
          getRadius: (c) => 26000 + (c.count / max) * 30000,
          getFillColor: love ? [255, 110, 180, 90] : [255, 180, 90, 90],
          radiusMinPixels: 5,
        }),
      ]}
    />
  )
}

/** 地球模式：原生图层（支持球面投影），缓慢自转 */
function GlobeLayers({ data, theme }: { data: Footprints; theme: LitTheme }) {
  const map = useMap()
  useEffect(() => {
    if (!map) return
    const color = theme === 'love' ? '#ff6bb0' : '#ff7a45'
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
      map.addLayer({ id: 'globe-paths', type: 'line', source: 'globe-paths', paint: { 'line-color': color, 'line-width': 2, 'line-opacity': 0.8 } })
      map.addLayer({
        id: 'globe-glow',
        type: 'circle',
        source: 'globe-points',
        paint: { 'circle-radius': 9, 'circle-color': color, 'circle-opacity': 0.18, 'circle-blur': 0.8 },
      })
      map.addLayer({
        id: 'globe-points',
        type: 'circle',
        source: 'globe-points',
        paint: { 'circle-radius': 3, 'circle-color': '#fff', 'circle-stroke-color': color, 'circle-stroke-width': 1.5 },
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

export function FootprintStats({ data, className, dark }: { data: Footprints; className?: string; dark?: boolean }) {
  const s = data.stats
  const items = [
    { label: '旅程', value: s.trips },
    { label: '城市', value: s.cities },
    { label: '省份', value: s.provinces },
    { label: '打卡点', value: s.waypoints },
    { label: '里程', value: formatKm(s.distance_km) },
    { label: '天', value: s.days },
  ]
  return (
    <div className={cn('grid grid-cols-3 gap-2 sm:grid-cols-6', className)}>
      {items.map((i) => (
        <div key={i.label} className={cn('rounded-2xl px-3 py-2.5', dark ? 'bg-white/8 ring-1 ring-white/10' : 'bg-white shadow-card')}>
          <div className="truncate text-lg font-extrabold tabular-nums">{i.value}</div>
          <div className={cn('text-xs', dark ? 'text-white/50' : 'text-ink-400')}>{i.label}</div>
        </div>
      ))}
    </div>
  )
}

export function FootprintsView({
  data,
  theme = 'sunset',
  replayTo,
  height = 'h-[62vh]',
}: {
  data: Footprints
  theme?: LitTheme
  replayTo?: string
  height?: string
}) {
  const [mode, setMode] = useState<Mode>('china')
  const counts = useMemo(() => Object.fromEntries(data.provinces.map((p) => [p.code, p.count])), [data.provinces])
  const byProvince = useMemo(() => {
    const m = new Map<string, Footprints['cities']>()
    data.cities.forEach((c) => m.set(c.province, [...(m.get(c.province) ?? []), c]))
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [data.cities])

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'china', label: <span className="flex items-center gap-1"><Box className="size-3.5" />点亮中国</span> },
            { value: 'globe', label: <span className="flex items-center gap-1"><Globe2 className="size-3.5" />足迹地球</span> },
            { value: 'list', label: <span className="flex items-center gap-1"><List className="size-3.5" />城市清单</span> },
          ]}
        />
        {replayTo && data.trips.length > 0 && (
          <Link to={replayTo}>
            <Button size="sm" variant={theme === 'love' ? 'love' : 'dark'} icon={<Play className="size-4" />}>
              3D 回放足迹
            </Button>
          </Link>
        )}
      </div>

      {mode !== 'list' ? (
        <div className={cn('bg-night relative overflow-hidden rounded-3xl', height)}>
          <BaseMap
            key={mode}
            className="absolute inset-0"
            kind="dark"
            globe={mode === 'globe'}
            center={mode === 'globe' ? [110, 30] : CHINA_CENTER}
            zoom={mode === 'globe' ? 1.6 : 3.2}
            pitch={mode === 'china' ? 48 : 0}
            bearing={mode === 'china' ? -8 : 0}
          >
            {mode === 'china' && (
              <>
                <LitProvinces counts={counts} theme={theme} />
                <CityLayers data={data} theme={theme} />
              </>
            )}
            {mode === 'globe' && <GlobeLayers data={data} theme={theme} />}
          </BaseMap>
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-2xl bg-black/40 px-3 py-2 text-xs text-white/80 backdrop-blur">
            已点亮 <b className="text-white">{data.stats.provinces}</b> 个省份 · <b className="text-white">{data.stats.cities}</b> 座城市
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {byProvince.length === 0 && <p className="py-10 text-center text-sm text-ink-400">还没有足迹</p>}
          {byProvince.map(([prov, cities]) => (
            <div key={prov} className="rounded-2xl bg-white p-4 shadow-card">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{prov}</span>
                <span className="text-xs text-ink-400">{cities.length} 座城市</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {cities.map((c) => (
                  <span key={c.code} className="rounded-full bg-brand-50 px-2.5 py-1 text-xs text-brand-700">
                    {c.name} · {c.count}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function FootprintTimeline({ data }: { data: Footprints }) {
  const trips = [...data.trips].sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))
  if (!trips.length) return null
  return (
    <div className="relative space-y-3 pl-5">
      <div className="absolute top-2 bottom-2 left-1.5 w-0.5 rounded bg-gradient-to-b from-brand-400 to-orange-300" />
      {trips.map((t) => (
        <Link key={t.id} to={`/trips/${t.id}`} className="relative flex items-center gap-3 rounded-2xl bg-white p-3 shadow-card hover:shadow-float">
          <span className="absolute top-1/2 -left-[18px] size-3 -translate-y-1/2 rounded-full border-2 border-white bg-brand-500 shadow" />
          {t.cover_url && <img src={t.cover_url} alt="" className="size-12 rounded-xl object-cover" />}
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{t.title}</div>
            <div className="text-xs text-ink-400">
              {fmtDate(t.start_date) || '未设置日期'} · {t.path.length} 个地点 · {formatKm(t.distance_km)}
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}
