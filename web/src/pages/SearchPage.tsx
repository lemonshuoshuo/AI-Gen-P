import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { api } from '@/api'
import { MoreButton, SectionHead } from '@/components/editorial'
import { PlaceRow } from '@/components/place/PlaceCard'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { Empty, LoadError } from '@/components/ui'
import { flattenPages } from '@/lib/pages'

const suggestions = ['杭州', '美食', '情侣', '自驾', '徒步', '古镇', '海边']

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
  const items = flattenPages(trips.data?.pages)

  return (
    <div className="mx-auto max-w-6xl px-4 pt-8 pb-16 md:px-6 md:pt-12">
      <p className="eyebrow">Search · 搜索</p>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          if (kw.trim()) setParams({ q: kw.trim() })
        }}
        className="mt-3 flex max-w-3xl items-center gap-3 border-b-2 border-ink-900 transition-colors focus-within:border-brand-500"
      >
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          placeholder="想去哪儿？"
          aria-label="搜索旅程、城市、标签、打卡地"
          className="font-display h-14 min-w-0 flex-1 bg-transparent text-[26px] text-ink-900 outline-none placeholder:text-ink-300 md:h-16 md:text-[34px]"
          autoFocus
        />
        <button
          type="submit"
          aria-label="搜索"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-ink-700 transition-colors hover:bg-ink-900/5 hover:text-ink-900"
        >
          <Search className="size-5" strokeWidth={1.5} />
        </button>
      </form>
      {tag ? (
        <p className="mt-3 text-sm text-ink-500">
          标签 <span className="font-display text-ink-900">#{tag}</span>
        </p>
      ) : (
        <p className="mt-3 text-sm text-ink-400">旅程、城市、标签、打卡地，都可以搜</p>
      )}

      {!has ? (
        <section className="mt-12 max-w-3xl" aria-labelledby="suggest-title">
          <p id="suggest-title" className="eyebrow">
            Try · 不妨试试
          </p>
          <ul className="mt-3 flex flex-wrap items-baseline gap-y-2">
            {suggestions.map((w) => (
              <li key={w} className="flex items-baseline after:mx-3 after:text-ink-300 after:content-['/'] last:after:content-none">
                <Link
                  to={`/search?q=${encodeURIComponent(w)}`}
                  className="font-display text-[22px] text-ink-700 underline decoration-transparent underline-offset-[6px] transition-colors hover:text-ink-900 hover:decoration-ink-900 md:text-[26px]"
                >
                  {w}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <>
          {!!places.data?.items.length && (
            <section className="mt-12" aria-labelledby="places-title">
              <SectionHead
                id="places-title"
                eyebrow="Places · 相关打卡地"
                title="打卡地"
                extra={
                  <Link to={`/places?q=${encodeURIComponent(q)}`} className="pb-0.5 text-xs text-ink-400 transition-colors hover:text-ink-900">
                    全部 →
                  </Link>
                }
              />
              <ul className="grid border-b border-ink-200 md:grid-cols-2 md:gap-x-10">
                {places.data.items.map((p) => (
                  <li key={p.id} className="border-b border-ink-200 last:border-b-0 md:[&:nth-last-child(2):nth-child(odd)]:border-b-0">
                    <PlaceRow place={p} variant="compact" />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="mt-12" aria-labelledby="trips-title">
            <SectionHead
              id="trips-title"
              eyebrow="Journeys · 相关旅程"
              title={
                <>
                  旅程
                  {trips.data && <span className="font-num ml-2 text-base text-ink-400">{trips.data.pages[0].total}</span>}
                </>
              }
            />
            <div className="mt-7">
              {trips.isLoading ? (
                <TripGridSkeleton n={4} />
              ) : trips.isLoadingError ? (
                <LoadError error={trips.error} onRetry={() => trips.refetch()} />
              ) : items.length === 0 ? (
                <Empty title="没有找到相关旅程" desc="换个关键词，或者去打卡地看看" />
              ) : (
                <TripGrid trips={items} />
              )}
              {trips.hasNextPage && <MoreButton loading={trips.isFetchingNextPage} onClick={() => trips.fetchNextPage()} />}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
