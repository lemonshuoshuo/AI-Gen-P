import { useEffect, useRef, useState } from 'react'
import { Marker, type MapMouseEvent } from 'maplibre-gl'
import { Check, MapPin } from 'lucide-react'
import type { Category, GeoSearchItem } from '@/api'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { Button, Modal } from '@/components/ui'
import { cn } from '@/lib/cn'
import { PlaceSearch, type PickSource } from './PlaceSearch'

type LngLat = [number, number]

/** 确认后的位置：搜索选中的地点带名称、地址和高德 ID；在地图上点的只有坐标 */
export interface ConfirmedPlace {
  lng: number
  lat: number
  name?: string
  address?: string
  amap_id?: string
  category?: Category
}

/** 可拖动的针：点地图或拖动都会改位置 */
function Pin({ pos, onChange }: { pos: LngLat | null; onChange: (p: LngLat) => void }) {
  const map = useMap()
  const marker = useRef<Marker | null>(null)
  const cb = useRef(onChange)
  cb.current = onChange
  useEffect(() => {
    if (!map) return
    const onClick = (e: MapMouseEvent) => cb.current([e.lngLat.lng, e.lngLat.lat])
    map.getCanvas().style.cursor = 'crosshair'
    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
      marker.current?.remove()
      marker.current = null
    }
  }, [map])
  useEffect(() => {
    if (!map) return
    if (!pos) {
      marker.current?.remove()
      marker.current = null
      return
    }
    if (!marker.current) {
      const el = document.createElement('div')
      el.innerHTML =
        '<div style="display:flex;flex-direction:column;align-items:center"><div style="width:26px;height:26px;border-radius:999px;background:var(--color-brand-500);border:2px solid var(--color-paper);box-shadow:0 4px 12px -4px rgb(0 0 0 / .6)"></div><div style="width:2px;height:8px;background:var(--color-brand-500)"></div></div>'
      el.style.cursor = 'grab'
      marker.current = new Marker({ element: el, anchor: 'bottom', draggable: true }).setLngLat(pos).addTo(map)
      marker.current.on('dragend', () => {
        const p = marker.current!.getLngLat()
        cb.current([p.lng, p.lat])
      })
    } else marker.current.setLngLat(pos)
    map.easeTo({ center: pos, zoom: Math.max(map.getZoom(), 14), duration: 500 })
  }, [map, pos])
  return null
}

/**
 * 确认 AI 没能准确定位的地点：搜索正确的地点，或在地图上点 / 拖动到它的位置。
 * 不确认的地点不会加入路线（不会被悄悄放在错误的位置）
 */
export function ConfirmPlaceDialog({
  open,
  name,
  city,
  guess,
  onClose,
  onConfirm,
  title,
  hint,
  keyword,
}: {
  open: boolean
  name: string
  /** 标题，缺省为「确认「名称」的位置」 */
  title?: string
  /** 说明，缺省说 AI 没能准确定位 */
  hint?: string
  /** 打开时搜索的关键词，缺省为名称 */
  keyword?: string
  city?: string
  /** AI 估计的位置（未经地图校正）：作为起点，需要用户确认 */
  guess?: LngLat | null
  onClose: () => void
  onConfirm: (p: ConfirmedPlace) => void
}) {
  const [picked, setPicked] = useState<ConfirmedPlace | null>(null)
  const [pos, setPos] = useState<LngLat | null>(guess ?? null)
  const onPick = (it: GeoSearchItem, from: PickSource) => {
    setPicked({
      lng: it.lng,
      lat: it.lat,
      name: it.amap_id || from === 'community' || from === 'tianditu' ? it.name : undefined,
      address: it.address || undefined,
      amap_id: it.amap_id || undefined,
      category: it.category || undefined,
    })
    setPos([it.lng, it.lat])
  }
  const onMapPoint = (p: LngLat) => {
    setPos(p)
    setPicked({ lng: p[0], lat: p[1] })
  }
  const ready = !!pos
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={title ?? `确认「${name}」的位置`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            先不确认
          </Button>
          <Button
            disabled={!ready}
            icon={<Check className="size-4" strokeWidth={1.75} />}
            onClick={() => pos && onConfirm(picked && picked.lng === pos[0] && picked.lat === pos[1] ? picked : { ...picked, lng: pos[0], lat: pos[1] })}
          >
            确认这个位置
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-ink-500">
        {hint ?? `AI 没能在地图上准确找到这个地点${guess ? '（红点是它估计的位置，可能偏差很大）' : ''}。`}搜索正确的地点，或在地图上点一下、拖动红点到它的位置。
      </p>
      <div className="mt-4 space-y-3">
        <PlaceSearch onPick={onPick} city={city} near={guess ?? undefined} inline initialKeyword={keyword ?? name} placeholder="搜索这个地点的正确名称" />
        <div className="-mx-6 overflow-hidden border-y border-ink-200 md:mx-0 md:rounded-sm md:border-0 md:ring-1 md:ring-ink-200">
          <BaseMap className="h-64 md:h-80" center={guess ?? undefined} zoom={guess ? 13 : undefined} navigation={false}>
            <Pin pos={pos} onChange={onMapPoint} />
          </BaseMap>
        </div>
        <p className={cn('flex items-center gap-2 text-[12.5px]', ready ? 'text-ink-700' : 'text-ink-400')}>
          <MapPin className="size-3.5 shrink-0" strokeWidth={1.5} />
          {picked?.name ? `已选：${picked.name}${picked.address ? ` · ${picked.address}` : ''}` : ready ? '已在地图上标出位置' : '还没有选择位置'}
        </p>
      </div>
    </Modal>
  )
}
