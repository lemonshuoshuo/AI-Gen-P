import { useEffect, useRef } from 'react'
import { MapboxOverlay } from '@deck.gl/mapbox'
import type { LayersList } from '@deck.gl/core'
import type { IControl } from 'maplibre-gl'
import { useMap } from '@/components/map/BaseMap'

/** 在 MapLibre 上叠加 deck.gl 图层（独立画布，与地图相机同步） */
export function useDeckOverlay() {
  const map = useMap()
  const overlay = useRef<MapboxOverlay | null>(null)
  useEffect(() => {
    if (!map) return
    const o = new MapboxOverlay({ interleaved: false, layers: [] })
    map.addControl(o as unknown as IControl)
    overlay.current = o
    return () => {
      overlay.current = null
      try {
        map.removeControl(o as unknown as IControl)
      } catch {
        /* 地图已销毁 */
      }
    }
  }, [map])
  return overlay
}

export function DeckLayers({ layers }: { layers: LayersList }) {
  const overlay = useDeckOverlay()
  useEffect(() => {
    overlay.current?.setProps({ layers })
  })
  return null
}

export function hexToRgb(hex: string, alpha = 255): [number, number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha]
}
