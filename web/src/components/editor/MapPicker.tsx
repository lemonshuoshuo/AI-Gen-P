import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Marker } from 'maplibre-gl'
import { useQuery } from '@tanstack/react-query'
import { Crosshair, Info, X } from 'lucide-react'
import {
  errorMessage,
  isAvoided,
  isNotFound,
  api,
  type GeoPickCandidate,
  type GeoPickResult,
  type WaypointInput,
} from '@/api'
import { useMap } from '@/components/map/BaseMap'
import { fc, lineFeature, removeLayers, upsertSource, useMapPaintKey } from '@/components/map/layers'
import { PlaceStatsBadge } from '@/components/trip/WaypointItem'
import { Button, CategoryChip, confirmDialog } from '@/components/ui'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { cssColor } from '@/lib/color'
import { formatDistance } from '@/lib/geo'
import { isAdmin, useAuth } from '@/stores/auth'
import { IndeterminateLine } from './Indeterminate'
import { sentence } from './text'

type LngLat = [number, number]

// 旧版服务端没有 /geo/pick（404）：本次会话里不再请求，直接走逆地理自动命名
let unsupported = false
export const geoPickUnsupported = () => unsupported

// 强调色十字准星：外圈脉冲、内圈细线、四个刻度和中心点（颜色是主题令牌，换主题自动跟着变；
// 纸色描边让它在深色底图、卫星图上也看得清）
const V = 'var(--color-brand-600)'
const HALO = 'drop-shadow(0 0 1.5px var(--color-paper))'
const PIN_HTML = `<div style="position:relative;width:36px;height:36px;pointer-events:none;filter:${HALO}">
  <span class="animate-pulse-ring" style="position:absolute;inset:6px;border-radius:999px;border:1.5px solid ${V}"></span>
  <span style="position:absolute;inset:10px;border-radius:999px;border:1.5px solid ${V};background:color-mix(in oklab, ${V} 14%, transparent)"></span>
  <span style="position:absolute;left:17.5px;top:0;width:1px;height:8px;background:${V}"></span>
  <span style="position:absolute;left:17.5px;bottom:0;width:1px;height:8px;background:${V}"></span>
  <span style="position:absolute;top:17.5px;left:0;width:8px;height:1px;background:${V}"></span>
  <span style="position:absolute;top:17.5px;right:0;width:8px;height:1px;background:${V}"></span>
  <span style="position:absolute;left:15.5px;top:15.5px;width:5px;height:5px;border-radius:999px;background:${V}"></span>
</div>`

// 悬停的候选位置：纸色圆点 + 主文字色描边
const HOVER_HTML = `<div style="width:14px;height:14px;border-radius:999px;background:var(--color-surface);border:2.5px solid var(--color-ink-900);box-shadow:0 1px 5px rgb(0 0 0 / .35);pointer-events:none"></div>`

const PANEL_W = 344

const kindOrder: Record<GeoPickCandidate['kind'], number> = { aoi: 0, poi: 1, place: 2, address: 3 }

/** 候选 → 新打卡点。景区 / 店铺 / 社区地点用它的名称和坐标；「就用这个位置」不提交名称（由服务端按地址命名，不新建地点） */
function toInput(c: GeoPickCandidate, r: GeoPickResult): WaypointInput {
  // 点击处的行政区：景区范围包含点击位置、附近 300 米内的点基本同区，带上可省一次逆地理
  const hint =
    c.kind === 'aoi' || c.kind === 'address' || c.distance_m <= 300
      ? {
          province: r.address.province || undefined,
          city: r.address.city || undefined,
          district: r.address.district || undefined,
        }
      : {}
  if (c.kind === 'address')
    // 只提交真正的地址：没有地址时（如只识别到城市）由服务端按行政区命名，再在编辑框里改成真正的名字
    return { lng: c.lng, lat: c.lat, address: c.address || r.address.address || undefined, ...hint }
  return {
    name: c.name,
    address: c.address || undefined,
    lng: c.lng,
    lat: c.lat,
    category: c.category || undefined,
    amap_id: c.amap_id || undefined,
    ...hint,
  }
}

/** 地图选点：点击处附近的景区、店铺、社区地点，以及「就用这个位置」 */
export function MapPicker({
  point,
  onChoose,
  onFallback,
  onClose,
}: {
  point: LngLat
  /** openEditor：新点没有真正的名称（只用了位置），打开编辑框让用户填写 */
  onChoose: (input: WaypointInput, openEditor: boolean) => void
  /** 服务端不支持选点（404）或用户选择直接用坐标：按旧逻辑由服务端逆地理自动命名 */
  onFallback: (p: LngLat) => void
  onClose: () => void
}) {
  const map = useMap()
  const desktop = useIsDesktop()
  const user = useAuth((s) => s.user)
  const titleId = useId()
  const [lng, lat] = point
  const [hover, setHover] = useState<GeoPickCandidate | null>(null)
  const [zoom] = useState(() => map?.getZoom() ?? 14)
  const cb = useRef({ onFallback, onClose })
  cb.current = { onFallback, onClose }

  const q = useQuery({
    queryKey: ['geo-pick', lng.toFixed(6), lat.toFixed(6)],
    queryFn: ({ signal }) => api.geo.pick({ lng, lat }, signal),
    retry: false,
    staleTime: 5 * 60_000,
  })

  useEffect(() => {
    if (q.error && isNotFound(q.error)) {
      unsupported = true
      cb.current.onFallback([lng, lat])
    }
  }, [q.error, lng, lat])

  // 换了点击位置：清掉上一次的悬停预览
  useEffect(() => setHover(null), [lng, lat])

  useEffect(() => {
    // 上面还开着确认框（如多人踩雷提示）时，Esc 只关确认框
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]') && cb.current.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 点击位置：朱砂十字准星
  const pin = useRef<Marker | null>(null)
  const hoverPin = useRef<Marker | null>(null)
  useEffect(() => {
    if (!map) return
    const el = document.createElement('div')
    el.innerHTML = PIN_HTML
    pin.current = new Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(map)
    return () => {
      pin.current?.remove()
      pin.current = null
      hoverPin.current?.remove()
      hoverPin.current = null
      removeLayers(map, ['th-pick-link'], ['th-pick-link'])
    }
    // 标记只创建一次，位置在下面同步
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])
  useEffect(() => {
    pin.current?.setLngLat([lng, lat])
    // 宽屏上候选面板浮在地图左上角：点在面板下面时把地图往右挪，让准星露在面板右侧
    if (!map || !desktop) return
    const p = map.project([lng, lat])
    const W = map.getContainer().clientWidth
    const edge = PANEL_W + 24
    if (p.x < edge && W > edge + 160) map.panBy([p.x - (edge + (W - edge) / 2), 0], { duration: 450 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lng, lat])

  // 悬停 / 聚焦某个候选时，在地图上标出它的位置并用虚线连到点击处（虚线是主文字色，换主题 / 底图时重新解析）
  const paintKey = useMapPaintKey(map)
  useEffect(() => {
    if (!map) return
    const target: LngLat | null = hover && hover.kind !== 'address' ? [hover.lng, hover.lat] : null
    upsertSource(map, 'th-pick-link', fc(target ? [lineFeature([[lng, lat], target])] : []))
    const linkColor = cssColor('--color-ink-900', undefined, map.getContainer())
    if (!map.getLayer('th-pick-link'))
      map.addLayer({
        id: 'th-pick-link',
        type: 'line',
        source: 'th-pick-link',
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': linkColor, 'line-width': 1.5, 'line-dasharray': [1.5, 2], 'line-opacity': 0.75 },
      })
    else map.setPaintProperty('th-pick-link', 'line-color', linkColor)
    if (target) {
      if (!hoverPin.current) {
        const el = document.createElement('div')
        el.innerHTML = HOVER_HTML
        hoverPin.current = new Marker({ element: el, anchor: 'center' })
      }
      hoverPin.current.setLngLat(target).addTo(map)
    } else hoverPin.current?.remove()
  }, [map, hover, lng, lat, paintKey])

  const r = q.data
  const cands = r ? [...r.candidates].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]) : []
  // 服务端没给「这个位置本身」时补一个：总能直接用点击的位置
  if (r && !cands.some((c) => c.kind === 'address'))
    cands.push({
      kind: 'address',
      name: [r.address.district, r.address.street].filter(Boolean).join(' · '),
      address: r.address.address,
      category: '',
      amap_id: '',
      place_id: null,
      lng,
      lat,
      distance_m: 0,
    })
  const named = cands.filter((c) => c.kind !== 'address')

  const choose = async (c: GeoPickCandidate) => {
    if (!r) return
    if (
      c.place &&
      isAvoided(c.place) &&
      !(await confirmDialog({
        title: '这里有多人踩雷',
        desc: `「${c.name}」在社区中有 ${c.place.avoid_count} 人标记踩雷（${c.place.recommend_count} 人推荐）。仍要加入路线吗？`,
        okText: '仍要加入',
        danger: true,
      }))
    )
      return
    onChoose(toInput(c, r), c.kind === 'address')
  }

  const where = r
    ? [r.address.district, r.address.street].filter(Boolean).join(' · ') || r.address.city || r.address.province || '地图上的这个位置'
    : '这里是哪儿？'
  const coords = `${lat.toFixed(4)}°N  ${lng.toFixed(4)}°E`

  const panel = (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      className={cn(
        'flex flex-col border border-ink-900/10 bg-surface-2 shadow-float',
        desktop
          ? 'animate-fade-in absolute top-[4.25rem] left-4 z-20 max-h-[calc(100%-5.5rem)] w-[344px] max-w-[calc(100%-2rem)] rounded-xl'
          : 'animate-slide-up fixed inset-x-0 bottom-0 z-40 max-h-[52dvh] rounded-t-xl border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]',
      )}
    >
      {!desktop && <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-ink-300" />}
      <div className="flex items-start gap-3 px-5 pt-4 pb-4">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Pick · 选点</p>
          <h3 id={titleId} className="mt-2 truncate text-[22px] leading-snug text-ink-900">
            {where}
          </h3>
          <p className="font-num mt-1 truncate text-[13px] tracking-wide text-ink-500">
            {r?.address.address ? `${r.address.address}` : coords}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-2 flex size-10 items-center justify-center rounded-full text-ink-500 transition-colors hover:bg-ink-900/[0.06] hover:text-ink-900"
          aria-label="关闭选点"
        >
          <X className="size-5" strokeWidth={1.25} />
        </button>
      </div>
      {q.isFetching ? <IndeterminateLine label="正在识别附近的地点" /> : <div className="h-px shrink-0 bg-ink-200" />}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {q.isPending && !q.error && (
          <p className="px-5 py-5 text-sm text-ink-500">正在识别附近的景区、店铺和社区地点…</p>
        )}
        {q.error && !isNotFound(q.error) && (
          <div className="space-y-3 px-5 py-4">
            <p className="text-sm leading-relaxed text-ink-600">{errorMessage(q.error)}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => q.refetch()}>
                重试
              </Button>
              <Button size="sm" variant="ghost" icon={<Crosshair className="size-4" strokeWidth={1.5} />} onClick={() => onFallback(point)}>
                直接用这个位置
              </Button>
            </div>
          </div>
        )}
        {r && (
          <>
            {r.amap_error && (
              <p className="mx-5 mt-4 flex gap-2 border-l border-amber-500 py-1 pl-3 text-xs leading-relaxed text-ink-700">
                <Info className="mt-px size-3.5 shrink-0 text-amber-600" strokeWidth={1.5} />
                <span>高德地点服务暂不可用：{sentence(r.amap_error)}</span>
              </p>
            )}
            {named.length === 0 && (
              <p className="px-5 pt-4 text-xs leading-relaxed text-ink-500">
                附近没有识别到景区或店铺。
                {zoom < 13 ? '把地图放大到街道后再点，会更准确；' : ''}也可以直接用这个位置，稍后在编辑框里写上名字。
                {r.source === 'local' && !r.amap_error && isAdmin(user) && (
                  <span className="mt-1 block text-amber-700">管理员：配置高德「Web服务」Key 后，可以识别具体的景区和店铺。</span>
                )}
              </p>
            )}
            <ul className="divide-y divide-ink-200 py-1" onMouseLeave={() => setHover(null)}>
              {cands.map((c, i) => (
                <li key={`${c.kind}-${c.amap_id || c.place_id || c.name}-${i}`}>
                  <CandidateRow c={c} onChoose={() => choose(c)} onPreview={(on) => setHover(on ? c : null)} />
                </li>
              ))}
            </ul>
            {(r.source === 'tianditu' || r.source === 'local') && (
              <p className="eyebrow border-t border-ink-200 px-5 py-2.5 !text-[10px]">
                {r.source === 'tianditu' ? 'Tianditu · 候选来自天地图' : 'Offline · 社区与离线数据'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
  return desktop ? panel : createPortal(panel, document.body)
}

function CandidateRow({
  c,
  onChoose,
  onPreview,
}: {
  c: GeoPickCandidate
  onChoose: () => void
  onPreview: (on: boolean) => void
}) {
  const rowCls =
    'group flex w-full items-start gap-3 px-5 py-3.5 text-left transition-colors duration-300 hover:bg-ink-100 focus-visible:bg-ink-100'
  if (c.kind === 'address')
    return (
      <button type="button" onClick={onChoose} onMouseEnter={() => onPreview(false)} className={rowCls}>
        <Crosshair className="mt-0.5 size-4 shrink-0 text-brand-500" strokeWidth={1.25} />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] text-ink-900">
            就用这个位置<span className="text-ink-500">（街道）</span>
          </span>
          {(c.name || c.address) && <span className="mt-0.5 block truncate text-xs text-ink-500">{c.name || c.address}</span>}
        </span>
      </button>
    )
  return (
    <button
      type="button"
      onClick={onChoose}
      onMouseEnter={() => onPreview(true)}
      onFocus={() => onPreview(true)}
      onBlur={() => onPreview(false)}
      className={rowCls}
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          {c.kind === 'aoi' && (
            <span className="shrink-0 rounded-full border border-brand-300 px-1.5 py-0.5 text-[10.5px] leading-none tracking-wide text-brand-700">
              景区/区域
            </span>
          )}
          {c.kind === 'place' && (
            <span className="shrink-0 rounded-full border border-emerald-400 px-1.5 py-0.5 text-[10.5px] leading-none tracking-wide text-emerald-700">
              社区地点
            </span>
          )}
          <span className="font-display truncate text-[17px] leading-snug text-ink-900">{c.name}</span>
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-ink-500">
          {c.category && <CategoryChip category={c.category} className="shrink-0" />}
          {c.address && <span className="truncate">{c.address}</span>}
        </span>
        {c.place && <PlaceStatsBadge stats={c.place} className="mt-1 !py-0 text-[11px]" />}
      </span>
      {c.kind === 'aoi' ? (
        <span className="mt-0.5 shrink-0 text-[11px] tracking-wide text-ink-500">所在范围</span>
      ) : (
        c.distance_m > 0 && (
          <span className="font-num mt-0.5 shrink-0 text-[13px] text-ink-500">{formatDistance(c.distance_m)}</span>
        )
      )}
    </button>
  )
}
