import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { api } from '@/api'
import { LabelRow, MoreButton, SectionHead, pad2 } from '@/components/editorial'
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
    <div className="mx-auto max-w-[90rem] px-4 pt-12 pb-24 md:px-8 md:pt-20 md:pb-32">
      <LabelRow label="Search · 搜索" count={tag ? `#${tag}` : q ? `「${q}」` : undefined} />
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          if (kw.trim()) setParams({ q: kw.trim() })
        }}
        className="animate-slide-up mt-12 flex items-end gap-4 border-b border-ink-300 pb-2 transition-colors duration-300 focus-within:border-ink-900 md:mt-20"
      >
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          placeholder="想去哪儿？"
          aria-label="搜索旅程、城市、标签、打卡地"
          className="text-display-lg min-w-0 flex-1 bg-transparent py-2 text-ink-900 outline-none placeholder:text-ink-400"
          autoFocus
        />
        <button
          type="submit"
          aria-label="搜索"
          className="mb-1 inline-flex size-12 shrink-0 items-center justify-center rounded-full border border-ink-900/20 text-ink-800 transition-colors duration-300 hover:border-ink-900/60 hover:text-ink-900 md:size-14"
        >
          <Search className="size-5" strokeWidth={1.25} />
        </button>
      </form>
      {tag ? (
        <p className="mt-4 text-[13px] text-ink-500">
          标签 <span className="text-ink-900">#{tag}</span>
        </p>
      ) : (
        <p className="caption mt-4">旅程、城市、标签、打卡地，都可以搜</p>
      )}

      {!has ? (
        <section className="mt-24 md:mt-36" aria-labelledby="suggest-title">
          <LabelRow id="suggest-title" label="Try · 不妨试试" count={pad2(suggestions.length)} />
          <ul className="mt-8 flex flex-wrap items-baseline gap-y-3 md:mt-12">
            {suggestions.map((w) => (
              <li key={w} className="flex items-baseline after:mx-4 after:text-[1.5rem] after:text-ink-300 after:content-['/'] last:after:content-none md:after:mx-6">
                <Link
                  to={`/search?q=${encodeURIComponent(w)}`}
                  className="text-display-md inline-block py-1.5 text-ink-500 transition-colors duration-300 hover:text-ink-900"
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
            <section className="mt-24 md:mt-36" aria-labelledby="places-title">
              <SectionHead
                id="places-title"
                eyebrow="Places · 相关打卡地"
                count={places.data.total}
                title="打卡地"
                extra={
                  <Link
                    to={`/places?q=${encodeURIComponent(q)}`}
                    className="inline-flex h-10 items-center text-[13px] text-ink-500 transition-colors hover:text-ink-900 md:h-8"
                  >
                    全部 →
                  </Link>
                }
              />
              <ul className="mt-8 grid border-b border-ink-200 md:mt-12 lg:grid-cols-2 lg:gap-x-8">
                {places.data.items.map((p) => (
                  <li key={p.id} className="border-t border-ink-200">
                    <PlaceRow place={p} variant="compact" />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="mt-24 md:mt-36" aria-labelledby="trips-title">
            <SectionHead id="trips-title" eyebrow="Journeys · 相关旅程" count={trips.data?.pages[0].total} title="旅程" />
            <div className="mt-10 md:mt-16">
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
