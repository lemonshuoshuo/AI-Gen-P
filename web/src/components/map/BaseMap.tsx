import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AttributionControl, Map as MLMap, NavigationControl, setWorkerUrl, type MapOptions } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { Layers, LocateFixed } from 'lucide-react'
import { toast } from 'sonner'
import { useSite } from '@/hooks/useSite'
import { loadAtlas } from '@/lib/atlas'
import { cn } from '@/lib/cn'
import { CHINA_CENTER, getCurrentPosition } from '@/lib/geo'

/**
 * 平面地图的可视范围：只做国内，限制在中国及周边，不再缩小到世界地图
 * （世界级别的瓦片几乎全是海洋，标准底图一片漆黑，卫星图南极拉伸成一大块白色）。
 * 地球（globe）模式不限制。
 */
const CHINA_BOUNDS: [[number, number], [number, number]] = [
  [60, 2],
  [150, 58],
]
const FLAT_MIN_ZOOM = 2.8
import { atlasPaint, buildStyle, defaultAttribution, defaultTiles, setBaseKind, type BaseKind } from './style'
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
  /** 覆盖主栅格图层（th-normal）的调色，如完全去色；只影响这张地图，卫星图不受影响 */
  rasterTone?: Partial<Record<'raster-saturation' | 'raster-contrast' | 'raster-brightness-min' | 'raster-brightness-max' | 'raster-opacity', number>>
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
    const paint = atlasPaint(kind(), map)
    map.addSource('th-atlas', { type: 'geojson', data: atlas.provinces })
    map.addLayer(
      {
        id: 'th-atlas-fill',
        type: 'fill',
        source: 'th-atlas',
        paint: { 'fill-color': paint.fill as string, 'fill-opacity': 0.9 },
      },
      'th-normal',
    )
    map.addLayer(
      {
        id: 'th-atlas-line',
        type: 'line',
        source: 'th-atlas',
        paint: { 'line-color': paint.line as string, 'line-width': 0.8 },
      },
      'th-normal',
    )
  } catch {
    /* 忽略 */
  }
}

/** 地图上的细线小胶囊（底图切换、定位、全程等）：近黑玻璃 + 细亮线；手机上高 40px 方便手指点 */
export const mapChipClass =
  'glass flex h-10 items-center justify-center gap-1.5 rounded-full border border-white/25 px-3.5 text-xs font-medium tracking-[0.04em] text-ink-800 transition-colors duration-300 hover:border-white/50 hover:text-ink-900 disabled:opacity-45 sm:h-9'

export function BaseMap({
  className,
  center,
  zoom,
  pitch = 0,
  bearing = 0,
  kind = 'normal',
  rasterTone,
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
  const toneRef = useRef(rasterTone)
  toneRef.current = rasterTone

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
      ...(globe ? {} : { maxBounds: CHINA_BOUNDS, minZoom: FLAT_MIN_ZOOM }),
      renderWorldCopies: false,
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
    if (!map) return
    setBaseKind(map, baseKind)
    // 切换底图会重设调色：之后再覆盖
    const tone = toneRef.current
    if (tone && baseKind !== 'satellite' && map.getLayer('th-normal'))
      for (const [k, v] of Object.entries(tone)) map.setPaintProperty('th-normal', k as 'raster-saturation', v)
  }, [map, baseKind])

  useEffect(() => setKind(kind), [kind])

  useEffect(() => {
    if (!map) return
    map.setProjection({ type: globe ? 'globe' : 'mercator' })
    // 地球模式可以转到任意位置；回到平面地图时恢复国内范围（页面自己传了范围的除外）
    if (globe) {
      map.setMaxBounds(null)
      map.setMinZoom(options?.minZoom ?? 0)
    } else if (!options || !('maxBounds' in options)) {
      map.setMaxBounds(CHINA_BOUNDS)
      map.setMinZoom(Math.max(options?.minZoom ?? 0, FLAT_MIN_ZOOM))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div
      className={cn(
        !/\b(absolute|fixed)\b/.test(className ?? '') && 'relative',
        // 独立的层叠上下文：地图内部（deck.gl 画布、标记、控件）的 z-index 不会盖住页面上的卡片和浮层
        'isolate overflow-hidden',
        baseKind === 'dark' && 'th-map-dark',
        className,
      )}
    >
      <div ref={ref} className="absolute inset-0" />
      <MapCtx.Provider value={map}>{map && children}</MapCtx.Provider>
      {(kindSwitcher || locate) && (
        <div className="absolute top-3 right-3 z-10 flex flex-col items-end gap-2">
          {kindSwitcher && (
            <button
              type="button"
              onClick={() =>
                setKind((k) => (k === 'normal' ? 'satellite' : k === 'satellite' ? 'dark' : 'normal'))
              }
              className={mapChipClass}
              title="切换底图"
            >
              <Layers className="size-3.5" strokeWidth={1.4} />
              {baseKind === 'satellite' ? '卫星' : baseKind === 'dark' ? '夜间' : '标准'}
            </button>
          )}
          {locate && (
            <button type="button" onClick={doLocate} className={cn(mapChipClass, 'w-10 px-0 sm:w-9')} title="定位到当前位置" aria-label="定位到当前位置">
              <LocateFixed className="size-4" strokeWidth={1.4} />
            </button>
          )}
        </div>
      )}
      {overlay}
    </div>
  )
}
