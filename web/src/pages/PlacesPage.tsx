import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { LocateFixed, MapPinned, Search } from 'lucide-react'
import { toast } from 'sonner'
import { api, type Category } from '@/api'
import { PlaceRow } from '@/components/place/PlaceCard'
import { Button, Empty, Input, LoadError, Segmented } from '@/components/ui'
import { cn } from '@/lib/cn'
import { getCurrentPosition } from '@/lib/geo'
import { categories, categoryList } from '@/lib/meta'
import { flattenPages } from '@/lib/pages'

type Sort = 'hot' | 'rating' | 'avoid' | 'nearby'

export default function PlacesPage() {
  const [params, setParams] = useSearchParams()
  const sort = (params.get('sort') as Sort) || 'hot'
  const category = params.get('category') || ''
  const q = params.get('q') || ''
  const city = params.get('city') || ''
  const [kw, setKw] = useState(q)
  const [pos, setPos] = useState<[number, number] | null>(null)
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params)
    if (v) n.set(k, v)
    else n.delete(k)
    setParams(n, { replace: true })
  }

  const list = useInfiniteQuery({
    queryKey: ['places', sort, category, q, city],
    queryFn: ({ pageParam }) => api.places.list({ sort, category, q, city, page: pageParam, page_size: 20 }),
    initialPageParam: 1,
    getNextPageParam: (l) => (l.page * l.page_size < l.total ? l.page + 1 : undefined),
    enabled: sort !== 'nearby',
  })
  const nearby = useQuery({
    queryKey: ['places-nearby', pos],
    queryFn: () => api.places.nearby({ lng: pos![0], lat: pos![1], radius: 5000, limit: 50 }),
    enabled: sort === 'nearby' && !!pos,
  })

  const locate = async () => {
    try {
      const p = await getCurrentPosition()
      setPos(p.gcj)
      set('sort', 'nearby')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const places =
    sort === 'nearby'
      ? (nearby.data ?? []).filter((p) => !category || p.category === category)
      : flattenPages(list.data?.pages)
  const loading = sort === 'nearby' ? nearby.isLoading && !!pos : list.isLoading
  // 首次加载失败（没有任何数据）才显示错误；「加载更多」失败时保留已加载的列表
  const active = sort === 'nearby' ? nearby : list
  const failed = active.isLoadingError

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-extrabold">打卡地</h1>
      <p className="mt-1 text-sm text-ink-500">来自大家公开旅程的真实打卡：哪里值得去，哪里是坑，一看便知</p>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          set('q', kw.trim())
        }}
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
          <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索店名、景点、城市" className="pl-9" />
        </div>
        <Button type="submit">搜索</Button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Segmented<Sort>
          value={sort}
          onChange={(v) => (v === 'nearby' ? locate() : set('sort', v))}
          options={[
            { value: 'hot', label: '热门' },
            { value: 'rating', label: '高分' },
            { value: 'avoid', label: '⚠️ 避雷榜' },
            { value: 'nearby', label: <span className="inline-flex items-center gap-1"><LocateFixed className="size-3.5" />附近</span> },
          ]}
        />
        {city && (
          <button type="button" onClick={() => set('city', '')} className="rounded-full bg-ink-900 px-3 py-1 text-xs text-white">
            {city} ✕
          </button>
        )}
      </div>
      <div className="scrollbar-none mt-3 flex gap-2 overflow-x-auto">
        {(['', ...categoryList] as (Category | '')[]).map((c) => (
          <button
            key={c || 'all'}
            type="button"
            onClick={() => set('category', c)}
            className={cn(
              'shrink-0 rounded-full px-3 py-1 text-sm transition',
              category === c ? 'bg-brand-500 text-white' : 'bg-white text-ink-600 shadow-card hover:bg-ink-50',
            )}
          >
            {c ? categories[c].label : '全部'}
          </button>
        ))}
      </div>

      {sort === 'avoid' && (
        <p className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">
          ⚠️ 避雷榜：被标记「踩雷」较多的地点。评价来自用户真实体验，仅供参考。
        </p>
      )}

      <div className="mt-4 space-y-2.5">
        {loading &&
          Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-white shadow-card" />)}
        {!loading && failed && <LoadError error={active.error} onRetry={() => active.refetch()} />}
        {!loading && !failed && places.length === 0 && (
          <Empty
            icon={<MapPinned className="size-12" />}
            title={sort === 'nearby' && !pos ? '需要定位权限' : '暂时没有打卡地'}
            desc={sort === 'nearby' && !pos ? '允许定位后查看附近大家打卡过的地方' : '公开旅程里的打卡点会汇总到这里'}
            action={sort === 'nearby' && !pos && <Button onClick={locate}>获取位置</Button>}
          />
        )}
        {places.map((p, i) => (
          <PlaceRow key={p.id} place={p} rank={sort !== 'nearby' && !q ? i + 1 : undefined} />
        ))}
        {sort !== 'nearby' && list.hasNextPage && (
          <div className="flex justify-center pt-2">
            <Button variant="outline" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
              加载更多
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
