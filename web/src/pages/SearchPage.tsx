import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { api } from '@/api'
import { PlaceRow } from '@/components/place/PlaceCard'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { Button, Empty, Input } from '@/components/ui'

export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const tag = params.get('tag') ?? ''
  const [kw, setKw] = useState(q)
  useEffect(() => setKw(q), [q])
  const has = !!(q || tag)

  const trips = useInfiniteQuery({
    queryKey: ['search-trips', q, tag],
    queryFn: ({ pageParam }) => api.trips.list({ q, tag, tab: 'hot', page: pageParam, page_size: 20 }),
    initialPageParam: 1,
    getNextPageParam: (l) => (l.page * l.page_size < l.total ? l.page + 1 : undefined),
    enabled: has,
  })
  const places = useQuery({
    queryKey: ['search-places', q],
    queryFn: () => api.places.list({ q, sort: 'hot', page_size: 6 }),
    enabled: !!q,
  })
  const items = trips.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (kw.trim()) setParams({ q: kw.trim() })
        }}
        className="flex max-w-xl gap-2"
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
          <Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="搜索旅程、城市、标签、打卡地" className="pl-9" autoFocus />
        </div>
        <Button type="submit">搜索</Button>
      </form>
      {tag && <p className="mt-3 text-sm text-ink-500">标签：<b>#{tag}</b></p>}

      {!has ? (
        <Empty icon={<Search className="size-12" />} title="想去哪儿？" desc="试试搜索「杭州」「美食」「情侣」" />
      ) : (
        <>
          {!!places.data?.items.length && (
            <section className="mt-6">
              <h2 className="mb-3 font-bold">相关打卡地</h2>
              <div className="grid gap-2.5 md:grid-cols-2">
                {places.data.items.map((p) => (
                  <PlaceRow key={p.id} place={p} />
                ))}
              </div>
            </section>
          )}
          <section className="mt-6">
            <h2 className="mb-3 font-bold">相关旅程 {trips.data && <span className="text-sm font-normal text-ink-400">{trips.data.pages[0].total}</span>}</h2>
            {trips.isLoading ? (
              <TripGridSkeleton n={4} />
            ) : items.length === 0 ? (
              <Empty title="没有找到相关旅程" />
            ) : (
              <TripGrid trips={items} />
            )}
            {trips.hasNextPage && (
              <div className="mt-6 flex justify-center">
                <Button variant="outline" loading={trips.isFetchingNextPage} onClick={() => trips.fetchNextPage()}>
                  加载更多
                </Button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
