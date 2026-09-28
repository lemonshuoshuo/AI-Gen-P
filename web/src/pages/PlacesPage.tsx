import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { LocateFixed, MapPinned, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, type Category } from '@/api'
import { MoreButton, Note, PageHead } from '@/components/editorial'
import { PlaceRow } from '@/components/place/PlaceCard'
import { Button, Empty, LoadError, TabBar } from '@/components/ui'
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
    <div className="mx-auto max-w-4xl px-4 pt-8 pb-16 md:px-6 md:pt-12">
      <PageHead
        eyebrow="Places · 打卡地"
        title="打卡地"
        dek="来自大家公开旅程的真实打卡：哪里值得去，哪里是坑，一看便知。"
      />

      <form
        role="search"
        className="mt-8 flex items-center gap-3 border-b border-ink-900 transition-colors focus-within:border-brand-500"
        onSubmit={(e) => {
          e.preventDefault()
          set('q', kw.trim())
        }}
      >
        <Search className="size-[18px] shrink-0 text-ink-400" strokeWidth={1.5} />
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          placeholder="搜索店名、景点、城市"
          aria-label="搜索打卡地"
          className="font-display h-12 min-w-0 flex-1 bg-transparent text-[17px] text-ink-900 outline-none placeholder:text-ink-300 md:h-14 md:text-[19px]"
        />
        <button type="submit" className="shrink-0 py-2 text-[13px] tracking-[0.14em] text-ink-700 transition-colors hover:text-ink-900">
          搜索 →
        </button>
      </form>

      <TabBar<Sort>
        className="mt-8"
        value={sort}
        onChange={(v) => (v === 'nearby' ? locate() : set('sort', v))}
        options={[
          { value: 'hot', label: '热门' },
          { value: 'rating', label: '高分' },
          { value: 'avoid', label: '避雷榜' },
          {
            value: 'nearby',
            label: (
              <span className="inline-flex items-center gap-1">
                <LocateFixed className="size-3.5" strokeWidth={1.5} />
                附近
              </span>
            ),
          },
        ]}
      />
      <div className="scrollbar-none -mx-4 mt-4 flex gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0" role="group" aria-label="分类">
        {city && (
          <button
            type="button"
            onClick={() => set('city', '')}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-ink-900 px-3 text-[13px] text-paper"
            aria-label={`取消城市筛选：${city}`}
          >
            {city}
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        )}
        {(['', ...categoryList] as (Category | '')[]).map((c) => {
          const active = category === c
          const Icon = c ? categories[c].icon : null
          return (
            <button
              key={c || 'all'}
              type="button"
              aria-pressed={active}
              onClick={() => set('category', c)}
              className={cn(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[13px] tracking-wide transition-colors',
                active ? 'border-ink-900 bg-ink-900 text-paper' : 'border-ink-200 text-ink-600 hover:border-ink-400 hover:text-ink-900',
              )}
            >
              {Icon && <Icon className="size-3.5" strokeWidth={1.5} style={active ? undefined : { color: categories[c as Category].color }} />}
              {c ? categories[c].label : '全部分类'}
            </button>
          )
        })}
      </div>

      {sort === 'avoid' && (
        <Note tone="caution" label="Caution" className="mt-6">
          避雷榜收录被标记「踩雷」较多的地点。评价来自旅行者的真实体验，仅供参考。
        </Note>
      )}

      <div className="mt-4">
        {loading && (
          <div className="divide-y divide-ink-200" aria-busy="true" aria-label="加载中">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 py-5">
                <div className="h-8 w-8 animate-pulse rounded-sm bg-ink-100" />
                <div className="size-14 animate-pulse rounded-md bg-ink-100 sm:size-[72px]" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-2/5 animate-pulse rounded-sm bg-ink-100" />
                  <div className="h-3 w-3/5 animate-pulse rounded-sm bg-ink-100" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && failed && <LoadError error={active.error} onRetry={() => active.refetch()} />}
        {!loading && !failed && places.length === 0 && (
          <Empty
            icon={<MapPinned className="size-11" />}
            title={sort === 'nearby' && !pos ? '需要定位权限' : '暂时没有打卡地'}
            desc={sort === 'nearby' && !pos ? '允许定位后，查看附近大家打卡过的地方' : '公开旅程里的打卡点，会汇总到这里'}
            action={sort === 'nearby' && !pos && <Button onClick={locate}>获取位置</Button>}
          />
        )}
        {places.length > 0 && (
          <ol className="divide-y divide-ink-200 border-b border-ink-200">
            {places.map((p, i) => (
              <li key={p.id}>
                <PlaceRow place={p} rank={sort !== 'nearby' && !q ? i + 1 : undefined} />
              </li>
            ))}
          </ol>
        )}
        {sort !== 'nearby' && list.hasNextPage && <MoreButton loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()} />}
      </div>
    </div>
  )
}
