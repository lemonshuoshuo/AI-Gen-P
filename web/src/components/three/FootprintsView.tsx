import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArcLayer, ColumnLayer, ScatterplotLayer } from '@deck.gl/layers'
import { Box, Globe2, List, Play } from 'lucide-react'
import type { Map as MLMap } from 'maplibre-gl'
import type { Footprints } from '@/api/types'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { removeLayers, upsertSource } from '@/components/map/layers'
import { Segmented, buttonClass } from '@/components/ui'
import { loadAtlas } from '@/lib/atlas'
import { cn } from '@/lib/cn'
import { CHINA_CENTER } from '@/lib/geo'
import { DeckLayers } from './deck'
import { LitProvinces, provinceHeight, type LitTheme } from './LitProvinces'

type Mode = 'china' | 'globe' | 'list'
type City = Footprints['cities'][number]

/** 中国东西跨约 62 个经度，3.2 级需要约 900px 宽；手机等窄容器按宽度缩小，保证东部沿海和西部都在画面内 */
function fitChinaWidth(map: MLMap) {
  const w = map.getContainer().clientWidth
  const z = Math.log2(((w - 24) * 360) / (64 * 512))
  if (z < 3.2) map.jumpTo({ zoom: z })
}

// 触屏上单指滑动用来滚动页面（地图很高，否则很难滑到下面的内容），双指才拖动地图
const coarsePointer = window.matchMedia('(pointer: coarse)').matches
const mapGestureOptions = {
  cooperativeGestures: coarsePointer,
  locale: {
    'CooperativeGesturesHandler.MobileHelpText': '双指拖动可移动地图',
    'CooperativeGesturesHandler.WindowsHelpText': '按住 Ctrl 并滚动鼠标可缩放地图',
    'CooperativeGesturesHandler.MacHelpText': '按住 ⌘ 并滚动鼠标可缩放地图',
  },
}

type Arc = { from: [number, number]; to: [number, number]; fromCount: number; toCount: number }

function CityLayers({ data, theme, counts }: { data: Footprints; theme: LitTheme; counts: Record<string, number> }) {
  const max = Math.max(1, ...data.cities.map((c) => c.count))
  // deck.gl 画在地图上方的独立画布上，和 LitProvinces 的立体省份没有共同的深度：光柱、光晕、弧线的底部要抬到所在省份的顶面，
  // 否则会穿过省份、挂在省份侧壁上。省界数据与 LitProvinces 共用同一个查询；加载完省份才升起，这里同步升起（1.2 秒动画）
  const { data: atlas } = useQuery({ queryKey: ['atlas'], queryFn: loadAtlas, staleTime: Infinity })
  const [risen, setRisen] = useState(false)
  useEffect(() => {
    if (!atlas) return
    const h = requestAnimationFrame(() => setRisen(true))
    return () => cancelAnimationFrame(h)
  }, [atlas])
  const maxProv = Math.max(1, ...Object.values(counts))
  const lift = (provinceCount: number) => (risen ? provinceHeight(provinceCount, maxProv) : 0)
  // 城市编码前两位 + 0000 即省级编码（与服务端 geo.ProvinceCodeOf 一致）
  const top = (cityCode: string) => lift(counts[cityCode.slice(0, 2) + '0000'] ?? 0)
  // 按时间顺序把旅程串起来画弧线；弧线两端是各段旅程的起点，所在省份取这段旅程的第一个打卡点
  const arcs = useMemo(() => {
    const provCount = new Map(data.provinces.map((p) => [p.name, p.count]))
    const tripCount = new Map<number, number>()
    for (const p of data.points) if (!tripCount.has(p.trip_id)) tripCount.set(p.trip_id, provCount.get(p.province) ?? 0)
    const trips = [...data.trips].filter((t) => t.path.length).sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))
    const out: Arc[] = []
    for (let i = 1; i < trips.length; i++)
      out.push({
        from: trips[i - 1].path[0],
        to: trips[i].path[0],
        fromCount: tripCount.get(trips[i - 1].id) ?? 0,
        toCount: tripCount.get(trips[i].id) ?? 0,
      })
    return out
  }, [data.trips, data.points, data.provinces])
  const love = theme === 'love'
  const rise = [risen, maxProv, counts]
  return (
    <DeckLayers
      layers={[
        new ArcLayer<Arc>({
          id: 'fp-arcs',
          data: arcs,
          getSourcePosition: (a) => [...a.from, lift(a.fromCount)],
          getTargetPosition: (a) => [...a.to, lift(a.toCount)],
          getSourceColor: love ? [255, 142, 199, 200] : [255, 154, 68, 200],
          getTargetColor: love ? [155, 92, 255, 200] : [255, 90, 95, 200],
          getWidth: 2,
          getHeight: 0.5,
          transitions: { getSourcePosition: 1200, getTargetPosition: 1200 },
          updateTriggers: { getSourcePosition: rise, getTargetPosition: rise },
        }),
        new ColumnLayer<City>({
          id: 'fp-city-columns',
          data: data.cities,
          diskResolution: 20,
          radius: 14000,
          extruded: true,
          getPosition: (c) => [c.lng, c.lat, top(c.code)],
          getElevation: (c) => 260000 + (c.count / max) * 420000,
          getFillColor: love ? [255, 220, 240, 240] : [255, 240, 200, 240],
          material: { ambient: 0.7, diffuse: 0.5 },
          transitions: { getPosition: 1200 },
          updateTriggers: { getPosition: rise },
        }),
        new ScatterplotLayer<City>({
          id: 'fp-city-glow',
          data: data.cities,
          getPosition: (c) => [c.lng, c.lat, top(c.code)],
          getRadius: (c) => 26000 + (c.count / max) * 30000,
          getFillColor: love ? [255, 110, 180, 90] : [255, 180, 90, 90],
          radiusMinPixels: 5,
          transitions: { getPosition: 1200 },
          updateTriggers: { getPosition: rise },
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

export function FootprintsView({
  data,
  theme = 'sunset',
  replayTo,
  height = 'h-[46vh] sm:h-[62vh]',
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
          <Link to={replayTo} className={buttonClass({ size: 'sm', variant: theme === 'love' ? 'love' : 'dark' })}>
            <Play className="size-4" />
            3D 回放足迹
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
            options={mapGestureOptions}
            onReady={mode === 'china' ? fitChinaWidth : undefined}
          >
            {mode === 'china' && (
              <>
                <LitProvinces counts={counts} theme={theme} />
                <CityLayers data={data} theme={theme} counts={counts} />
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
