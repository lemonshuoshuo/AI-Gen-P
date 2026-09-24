import { useEffect, useRef, useState } from 'react'
import { Loader2, MapPin, Search, X } from 'lucide-react'
import { api, errorMessage, isAvoided, type GeoSearchItem, type Place, type PlaceStats } from '@/api'
import { recommendRate } from '@/components/place/PlaceCard'
import { PlaceStatsBadge } from '@/components/trip/WaypointItem'
import { CategoryChip, confirmDialog } from '@/components/ui'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'
import { isAdmin, useAuth } from '@/stores/auth'

/** 结果来源：高德 / 离线城市列表（source=local）/ 社区里大家打卡过的地点 */
export type PickSource = 'amap' | 'local' | 'community'

export function PlaceSearch({
  onPick,
  city,
  near,
  placeholder = '搜索景点、餐厅、酒店、街道…',
  className,
  autoFocus,
}: {
  onPick: (item: GeoSearchItem, source: PickSource) => void
  city?: string
  near?: [number, number] | null
  placeholder?: string
  className?: string
  autoFocus?: boolean
}) {
  const [kw, setKw] = useState('')
  const [items, setItems] = useState<GeoSearchItem[]>([])
  const [community, setCommunity] = useState<Place[]>([])
  const [source, setSource] = useState<'amap' | 'local' | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const isDesktop = useIsDesktop()
  const { data: site } = useSite()
  const user = useAuth((s) => s.user)
  // 手机上搜索时全屏显示：输入框在顶部、结果紧跟其下，不会被键盘挡住
  const sheet = active && !isDesktop
  // city / near 只是搜索提示，发起搜索时才读取最新值：它们变化（新加、拖动、排序打卡点后）不重新搜索，
  // 否则关键词还留在框里时会重复请求高德，并把用户已经关掉的结果列表重新弹出来
  const nearLng = near?.[0]
  const nearLat = near?.[1]
  const hintRef = useRef({ city, lng: nearLng, lat: nearLat })
  useEffect(() => {
    hintRef.current = { city, lng: nearLng, lat: nearLat }
  }, [city, nearLng, nearLat])

  useEffect(() => {
    const k = kw.trim()
    if (!k) {
      abortRef.current?.abort()
      setItems([])
      setCommunity([])
      setFailed(null)
      setLoading(false)
      return
    }
    const t = setTimeout(async () => {
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      setLoading(true)
      try {
        const hint = hintRef.current
        // 同时搜社区里大家打卡过的地点：能直接看到评价，加入路线前就能避雷
        const [g, p] = await Promise.allSettled([
          api.geo.search({ keyword: k, city: hint.city, lng: hint.lng, lat: hint.lat }, ac.signal),
          api.places.list({ q: k, page_size: 5 }, ac.signal),
        ])
        if (ac.signal.aborted) return
        if (g.status === 'fulfilled') {
          setItems(g.value.items)
          setSource(g.value.source)
          setFailed(null)
        } else {
          setItems([])
          setSource(null)
          setFailed(errorMessage(g.reason))
        }
        setCommunity(p.status === 'fulfilled' ? p.value.items : [])
        setOpen(true)
      } finally {
        if (!ac.signal.aborted) setLoading(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [kw, attempt])

  const closeSheet = () => {
    setActive(false)
    setOpen(false)
    inputRef.current?.blur()
  }
  // stats：该地点的社区统计（高德结果的 place / 社区地点本身）；多人踩雷时先确认，取消则保留结果列表
  const pick = async (it: GeoSearchItem, from: PickSource, stats?: Pick<PlaceStats, 'avoid_count' | 'recommend_count'> | null) => {
    if (
      stats &&
      isAvoided(stats) &&
      !(await confirmDialog({
        title: '这里有多人踩雷',
        desc: `「${it.name}」在社区中有 ${stats.avoid_count} 人标记踩雷（${stats.recommend_count} 人推荐）。仍要加入路线吗？`,
        okText: '仍要加入',
        danger: true,
      }))
    )
      return
    onPick(it, from)
    setKw('')
    if (sheet) closeSheet()
    else setOpen(false)
  }

  const communityIds = new Set(community.map((p) => p.amap_id).filter(Boolean))
  const geoItems = items.filter((it) => !it.amap_id || !communityIds.has(it.amap_id))

  return (
    <div
      className={cn(
        sheet ? 'fixed inset-0 z-50 !m-0 flex flex-col bg-white px-4 pt-[max(env(safe-area-inset-top),0.75rem)]' : 'relative',
        !sheet && className,
      )}
    >
      <div className="relative flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
          <input
            ref={inputRef}
            value={kw}
            autoFocus={autoFocus}
            maxLength={50}
            onChange={(e) => setKw(e.target.value)}
            onFocus={() => {
              setActive(true)
              if (items.length || community.length || failed) setOpen(true)
            }}
            placeholder={placeholder}
            className="h-11 w-full rounded-xl border border-ink-200 bg-white pr-9 pl-9 text-sm outline-none focus:border-brand-400 focus:ring-4 focus:ring-brand-100"
          />
          {loading ? (
            <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-ink-400" />
          ) : (
            kw && (
              <button
                type="button"
                onClick={() => {
                  setKw('')
                  setItems([])
                  setCommunity([])
                  setFailed(null)
                }}
                className="absolute top-1/2 right-3 -translate-y-1/2 text-ink-400"
                aria-label="清空"
              >
                <X className="size-4" />
              </button>
            )
          )}
        </div>
        {sheet && (
          <button type="button" onClick={closeSheet} className="shrink-0 px-1 text-sm text-ink-500">
            取消
          </button>
        )}
      </div>
      {open && kw.trim() && (
        <>
          {!sheet && (
            <div
              className="fixed inset-0 z-30"
              onClick={() => {
                setOpen(false)
                setActive(false)
              }}
            />
          )}
          <div
            className={cn(
              'overflow-y-auto bg-white py-1',
              sheet
                ? 'pb-safe mt-2 min-h-0 flex-1 overscroll-contain'
                : 'absolute inset-x-0 z-40 mt-1.5 max-h-80 rounded-2xl shadow-float ring-1 ring-ink-100',
            )}
          >
            {community.length > 0 && (
              <>
                <p className="px-4 pt-1.5 pb-1 text-xs font-medium text-ink-400">社区打卡地</p>
                {community.map((p) => {
                  const rate = recommendRate(p)
                  const avoid = isAvoided(p)
                  return (
                    <button
                      key={`p-${p.id}`}
                      type="button"
                      onClick={() =>
                        pick(
                          {
                            amap_id: p.amap_id,
                            name: p.name,
                            address: p.address,
                            province: p.province,
                            city: p.city,
                            district: p.district,
                            category: p.category,
                            lng: p.lng,
                            lat: p.lat,
                          },
                          'community',
                          p,
                        )
                      }
                      className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-ink-50"
                    >
                      <MapPin className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{p.name}</span>
                          <CategoryChip category={p.category} className="shrink-0 whitespace-nowrap" />
                          {avoid && (
                            <span className="shrink-0 rounded bg-red-50 px-1 text-[11px] font-medium whitespace-nowrap text-red-600">
                              ⚠️ {p.avoid_count} 人踩雷
                            </span>
                          )}
                        </div>
                        <div className={cn('text-xs', avoid ? 'text-red-600' : 'text-ink-500')}>
                          {p.checkin_count} 人打卡{rate != null && ` · 推荐率 ${rate}%`}
                        </div>
                        <div className="truncate text-xs text-ink-400">
                          {[p.city, p.district, p.address].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </button>
                  )
                })}
                {(geoItems.length > 0 || failed || source === 'local') && (
                  <p className="border-t border-ink-100 px-4 pt-2 pb-1 text-xs font-medium text-ink-400">更多地点</p>
                )}
              </>
            )}
            {failed ? (
              <button
                type="button"
                onClick={() => setAttempt((a) => a + 1)}
                className="w-full px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50"
              >
                {failed}，点此重试
              </button>
            ) : (
              source === 'local' && (
                <p className="border-b border-ink-100 px-4 py-2 text-xs text-amber-700">
                  {site?.amap_search
                    ? '地点搜索暂时不可用，只显示了城市结果；具体地点可稍后再搜，或直接在地图上点选。'
                    : `这里只能搜到城市；具体店铺、景点请直接在地图上点选。${isAdmin(user) ? '（管理员：配置高德 Web 服务 Key 后可搜索具体地点）' : ''}`}
                </p>
              )
            )}
            {!failed && !loading && items.length === 0 && community.length === 0 && (
              <p className="px-4 py-3 text-sm text-ink-400">没有找到相关地点</p>
            )}
            {geoItems.map((it, i) => {
              const avoid = isAvoided(it.place)
              return (
                <button
                  key={`${it.amap_id}-${i}`}
                  type="button"
                  onClick={() => pick(it, source ?? 'amap', it.place)}
                  className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-ink-50"
                >
                  <MapPin className="mt-0.5 size-4 shrink-0 text-brand-500" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{it.name}</span>
                      {it.category && <CategoryChip category={it.category} className="shrink-0 whitespace-nowrap" />}
                    </div>
                    {/* 社区统计放在第二行：手机上名称不会被挤得太短 */}
                    <div className="flex min-w-0 items-center gap-1.5">
                      {it.place && <PlaceStatsBadge stats={it.place} className="!py-0 shrink-0 text-[11px]" />}
                      <span className={cn('truncate text-xs', avoid ? 'text-red-600' : 'text-ink-400')}>
                        {[it.city, it.district, it.address].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
