import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { MapPin, Search, TriangleAlert } from 'lucide-react'
import { api, ApiError, type Category } from '@/api'
import { Button, CategoryChip, Input, Modal, Spinner } from '@/components/ui'
import { formatDistance, haversine } from '@/lib/geo'

/** 打卡时选中的地点（GCJ-02） */
export interface PickedPlace {
  name: string
  address: string
  amap_id: string
  category: Category | ''
  lng: number
  lat: number
}

interface Row extends PickedPlace {
  key: string
  distance: number
  /** 大家打卡过的地点：踩雷多时提示 */
  community?: { avoid: boolean }
}

/** 计划外打卡时选择所在的店铺 / 景点，打卡点精确到店，也方便大家避雷 */
export function CheckinPicker({
  open,
  onClose,
  here,
  far,
  amap,
  onPick,
}: {
  open: boolean
  onClose: () => void
  /** 当前位置（GCJ-02） */
  here: [number, number]
  /** 离最近的计划地点很远时提示一下 */
  far: { name: string; distance: number } | null
  /** 服务器是否配置了高德 Key（能列出周边店铺） */
  amap: boolean
  /** null 表示就用当前位置打卡 */
  onPick: (p: PickedPlace | null) => void
}) {
  const [kw, setKw] = useState('')
  const [keyword, setKeyword] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setKeyword(kw.trim()), 300)
    return () => clearTimeout(t)
  }, [kw])
  const [lng, lat] = here

  const community = useQuery({
    queryKey: ['checkin-picker', 'places', lng, lat],
    queryFn: () => api.places.nearby({ lng, lat, radius: 300, limit: 10 }),
    enabled: open,
    retry: false, // 网络不好时别让用户干等，随时可以「就用当前位置」
  })
  const around = useQuery({
    queryKey: ['checkin-picker', 'around', lng, lat, keyword],
    queryFn: ({ signal }) => api.geo.around({ lng, lat, radius: keyword ? 1000 : 300, keyword: keyword || undefined }, signal),
    enabled: open && amap,
    placeholderData: keepPreviousData,
    retry: false,
  })

  const rows = useMemo(() => {
    const k = keyword.toLowerCase()
    const places = (community.data ?? []).filter((p) => !k || p.name.toLowerCase().includes(k))
    const known = new Set(places.map((p) => p.amap_id).filter(Boolean))
    const list: Row[] = places.map((p) => ({
      key: `p${p.id}`,
      name: p.name,
      address: p.address,
      amap_id: p.amap_id,
      category: p.category,
      lng: p.lng,
      lat: p.lat,
      distance: p.distance_m ?? haversine([lng, lat], [p.lng, p.lat]),
      community: { avoid: p.avoid_count > p.recommend_count },
    }))
    // 高德周边里已经在「大家打卡过」中的地点不重复列出
    for (const [i, it] of (around.data?.items ?? []).entries()) {
      if (it.amap_id && known.has(it.amap_id)) continue
      list.push({
        key: `a${i}-${it.amap_id}`,
        name: it.name,
        address: it.address,
        amap_id: it.amap_id,
        category: it.category,
        lng: it.lng,
        lat: it.lat,
        distance: it.distance_m ?? haversine([lng, lat], [it.lng, it.lat]),
      })
    }
    return list.sort((a, b) => a.distance - b.distance)
  }, [community.data, around.data, keyword, lng, lat])

  const loading = community.isLoading || (amap && around.isLoading)
  // 服务端没有周边查询接口时不显示搜索框
  const canSearch = amap && !(around.error instanceof ApiError && around.error.status === 404)
  const hint = !amap
    ? '服务器未配置高德 Key，无法列出周边店铺；可先用当前位置打卡，下一步再填写店名'
    : around.isError
      ? '暂时无法列出周边店铺；可先用当前位置打卡，下一步再填写店名'
      : keyword
        ? `附近没有找到「${keyword}」，换个关键词试试，或先用当前位置打卡`
        : '附近没有找到地点，可以搜索店名，或先用当前位置打卡'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="你在哪？"
      footer={
        <Button block variant="outline" icon={<MapPin className="size-4" />} onClick={() => onPick(null)}>
          就用当前位置
        </Button>
      }
    >
      {far && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            离最近的计划地点「{far.name}」还有 {formatDistance(far.distance)}，确定在这里打卡吗？
          </span>
        </div>
      )}
      <p className="mb-2 text-xs text-ink-400">选出你所在的店铺或景点，打卡点更准确，也方便后来的人避雷</p>
      {canSearch && (
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
          <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索附近的店名" maxLength={50} className="pr-9 pl-9" />
          {around.isFetching && <Spinner className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />}
        </div>
      )}
      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-400">{hint}</p>
      ) : (
        <div className="divide-y divide-ink-100">
          {rows.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => onPick(r)}
              className="flex min-h-12 w-full items-center gap-3 py-2.5 text-left hover:bg-ink-50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-ink-900">{r.name}</span>
                  {r.category && <CategoryChip category={r.category} className="!py-0 text-[11px]" />}
                  {r.community && <span className="rounded bg-emerald-50 px-1.5 text-[11px] text-emerald-700">大家打卡过</span>}
                  {r.community?.avoid && <span className="rounded bg-red-50 px-1.5 text-[11px] font-medium text-red-600">⚠️ 慎去</span>}
                </div>
                {r.address && <p className="mt-0.5 truncate text-xs text-ink-400">{r.address}</p>}
              </div>
              <span className="shrink-0 text-xs text-ink-400">{formatDistance(r.distance)}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
