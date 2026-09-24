import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AttributionControl, Map as MLMap, NavigationControl, setWorkerUrl, type MapOptions } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { Layers, LocateFixed } from 'lucide-react'
import { toast } from 'sonner'
import { useSite } from '@/hooks/useSite'
import { loadAtlas } from '@/lib/atlas'
import { cn } from '@/lib/cn'
import { CHINA_CENTER, getCurrentPosition } from '@/lib/geo'
import { buildStyle, defaultAttribution, defaultTiles, setBaseKind, type BaseKind } from './style'
import './maplibre.css'

setWorkerUrl(workerUrl)

const MapCtx = createContext<MLMap | null>(null)
export const useMap = () => useContext(MapCtx)

export interface BaseMapProps {
  className?: string
  center?: [number, number]
  zoom?: number
  pitch?: number
  bearing?: number
  kind?: BaseKind
  /** 显示右上角底图切换 */
  kindSwitcher?: boolean
  /** 显示定位按钮 */
  locate?: boolean
  onLocate?: (gcj: [number, number]) => void
  navigation?: boolean
  interactive?: boolean
  globe?: boolean
  options?: Partial<MapOptions>
  onReady?: (map: MLMap) => void
  children?: ReactNode
  overlay?: ReactNode
}

/** 底图瓦片加载失败时，用内置省界数据画一个兜底轮廓 */
async function addAtlasFallback(map: MLMap, kind: () => BaseKind) {
  if (map.getSource('th-atlas')) return
  try {
    const atlas = await loadAtlas()
    if (!map.getStyle() || map.getSource('th-atlas')) return
    map.addSource('th-atlas', { type: 'geojson', data: atlas.provinces })
    map.addLayer(
      {
        id: 'th-atlas-fill',
        type: 'fill',
        source: 'th-atlas',
        paint: { 'fill-color': kind() === 'dark' ? '#161a33' : '#ffffff', 'fill-opacity': 0.9 },
      },
      'th-normal',
    )
    map.addLayer(
      {
        id: 'th-atlas-line',
        type: 'line',
        source: 'th-atlas',
        paint: { 'line-color': kind() === 'dark' ? '#323a6b' : '#c9c6d3', 'line-width': 0.8 },
      },
      'th-normal',
    )
  } catch {
    /* 忽略 */
  }
}

export function BaseMap({
  className,
  center,
  zoom,
  pitch = 0,
  bearing = 0,
  kind = 'normal',
  kindSwitcher,
  locate,
  onLocate,
  navigation = true,
  interactive = true,
  globe,
  options,
  onReady,
  children,
  overlay,
}: BaseMapProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<MLMap | null>(null)
  const [baseKind, setKind] = useState<BaseKind>(kind)
  const kindRef = useRef(baseKind)
  kindRef.current = baseKind
  const { data: site, isPending } = useSite()
  const tiles = site?.map.tiles ?? defaultTiles
  // 底图版权 / 审图号由服务端配置：换了瓦片源时跟着换，不再固定显示「© 高德地图」
  const attribution = site?.map.attribution || defaultAttribution
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  useEffect(() => {
    // 等站点配置（瓦片地址）加载完再创建地图
    if (!ref.current || isPending) return
    const m = new MLMap({
      container: ref.current,
      style: buildStyle(tiles, kind, attribution),
      center: center ?? CHINA_CENTER,
      zoom: zoom ?? (center ? 12 : 3.2),
      pitch,
      bearing,
      maxPitch: 85,
      interactive,
      attributionControl: false,
      dragRotate: true,
      pitchWithRotate: true,
      fadeDuration: 150,
      ...options,
    })
    if (import.meta.env.DEV) (window as unknown as { __map: MLMap }).__map = m
    m.addControl(new AttributionControl({ compact: true }), 'bottom-right')
    if (navigation && interactive) m.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right')

    let tileErrors = 0
    m.on('error', (e) => {
      const src = (e as unknown as { sourceId?: string }).sourceId
      if (src?.startsWith('th-') && ++tileErrors === 4) addAtlasFallback(m, () => kindRef.current)
    })
    // 样式就绪即可叠加业务图层，不必等所有瓦片加载完（弱网下 load 事件会很慢）
    let ready = false
    const onStyleReady = () => {
      if (ready) return
      ready = true
      if (globe) m.setProjection({ type: 'globe' })
      setMap(m)
      onReadyRef.current?.(m)
    }
    m.once('style.load', onStyleReady)
    m.once('load', onStyleReady)
    return () => {
      setMap(null)
      m.remove()
    }
    // 地图实例只创建一次；其余属性变化通过 map API 同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPending])

  useEffect(() => {
    if (map) setBaseKind(map, baseKind)
  }, [map, baseKind])

  useEffect(() => setKind(kind), [kind])

  useEffect(() => {
    if (!map) return
    map.setProjection({ type: globe ? 'globe' : 'mercator' })
  }, [map, globe])

  const doLocate = async () => {
    try {
      const pos = await getCurrentPosition()
      map?.flyTo({ center: pos.gcj, zoom: Math.max(map.getZoom(), 14) })
      onLocate?.(pos.gcj)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className={cn(!/\b(absolute|fixed)\b/.test(className ?? '') && 'relative', 'overflow-hidden', className)}>
      <div ref={ref} className="absolute inset-0" />
      <MapCtx.Provider value={map}>{map && children}</MapCtx.Provider>
      {(kindSwitcher || locate) && (
        <div className="absolute top-3 right-3 z-10 flex flex-col gap-2">
          {kindSwitcher && (
            <button
              type="button"
              onClick={() =>
                setKind((k) => (k === 'normal' ? 'satellite' : k === 'satellite' ? 'dark' : 'normal'))
              }
              className="glass flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-ink-700 shadow-card"
              title="切换底图"
            >
              <Layers className="size-4" />
              {baseKind === 'normal' ? '标准' : baseKind === 'satellite' ? '卫星' : '夜间'}
            </button>
          )}
          {locate && (
            <button
              type="button"
              onClick={doLocate}
              className="glass flex size-9 items-center justify-center self-end rounded-full text-ink-700 shadow-card"
              title="定位到当前位置"
            >
              <LocateFixed className="size-4" />
            </button>
          )}
        </div>
      )}
      {overlay}
    </div>
  )
}
