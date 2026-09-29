import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowRight, Search } from 'lucide-react'
import { api } from '@/api'
import { EmptyNote, LabelRow, MoreButton, SectionHead, TextLink, pad2 } from '@/components/editorial'
import { PlaceRow } from '@/components/place/PlaceCard'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { LoadError } from '@/components/ui'
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
  const tripTotal = trips.data?.pages[0]?.total
  const placeTotal = q ? (places.data?.total ?? 0) : 0
  const subject = tag ? `#${tag}` : `「${q}」`

  return (
    <div className="mx-auto max-w-[90rem] px-4 pt-12 pb-24 [font-variant-numeric:lining-nums] md:px-8 md:pt-20 md:pb-32">
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
          placeholder="想去哪儿"
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
      {/* 搜索后，输入框下面的提示换成结果数；没有搜索时是一句用法说明 */}
      <p className="mt-4 text-[13px] text-ink-500">
        {tag && (
          <>
            标签 <span className="text-ink-900">#{tag}</span>
            {tripTotal != null && ' · '}
          </>
        )}
        {has ? (
          tripTotal != null && (
            <>
              <span className="font-num text-[14px] text-ink-900">{tripTotal}</span> 段旅程
              {placeTotal > 0 && (
                <>
                  {' · '}
                  <span className="font-num text-[14px] text-ink-900">{placeTotal}</span> 处打卡地
                </>
              )}
            </>
          )
        ) : (
          '旅程、城市、标签、打卡地，都可以搜'
        )}
      </p>

      {!has ? (
        <>
        {/* 打卡地的入口：手机底部导航里没有「打卡地」，从搜索也能直接去逛 */}
        <section className="mt-16 md:mt-24" aria-labelledby="places-entry-title">
          <LabelRow
            id="places-entry-title"
            label="Places · 打卡地"
            extra={
              <Link to="/places" className="inline-flex h-10 items-center gap-1 text-[13px] text-ink-500 transition-colors hover:text-ink-900 md:h-8">
                全部打卡地
                <ArrowRight className="size-3.5" strokeWidth={1.5} />
              </Link>
            }
          />
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {(
              [
                ['hot', '热门打卡地', '去的人最多的地方'],
                ['rating', '高分打卡地', '大家评分最高的地方'],
                ['avoid', '避雷榜', '多人踩雷，出发前就知道'],
              ] as const
            ).map(([sort, title, desc]) => (
              <Link
                key={sort}
                to={`/places?sort=${sort}`}
                className="th-card group flex items-center justify-between gap-3 p-4 transition-colors hover:border-ink-400"
              >
                <span className="min-w-0">
                  <span className="block text-[15px] text-ink-900">{title}</span>
                  <span className="caption block">{desc}</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-ink-400 transition-colors group-hover:text-ink-900" strokeWidth={1.5} />
              </Link>
            ))}
          </div>
        </section>
        <section className="mt-16 md:mt-24" aria-labelledby="suggest-title">
          <LabelRow id="suggest-title" label="Try · 不妨试试" count={pad2(suggestions.length)} />
          <ul className="mt-8 flex flex-wrap items-baseline gap-x-7 gap-y-3 md:mt-12 md:gap-x-0">
            {suggestions.map((w) => (
              <li
                key={w}
                // 手机上只用间距分隔；宽屏用斜线，斜线在每个词的前面（第一个除外），折行时不会挂在行尾
                className="flex items-baseline md:before:mx-6 md:before:text-[1.5rem] md:before:text-ink-300 md:before:content-['/'] md:first:before:content-none"
              >
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
        </>
      ) : (
        <>
          {!!places.data?.items.length && (
            <section className="mt-16 md:mt-24" aria-labelledby="places-title">
              <SectionHead
                id="places-title"
                eyebrow="Places · 相关打卡地"
                count={places.data.total}
                title={`${subject}的 ${places.data.total} 处打卡地`}
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
          <section className={placeTotal > 0 ? 'mt-24 md:mt-36' : 'mt-16 md:mt-24'} aria-labelledby="trips-title">
            <SectionHead
              id="trips-title"
              eyebrow="Journeys · 相关旅程"
              count={tripTotal}
              title={tripTotal ? `${subject}相关的 ${tripTotal} 段旅程` : undefined}
            />
            <div className="mt-10 md:mt-16">
              {trips.isLoading ? (
                <TripGridSkeleton n={4} />
              ) : trips.isLoadingError ? (
                <LoadError error={trips.error} onRetry={() => trips.refetch()} />
              ) : items.length === 0 ? (
                <EmptyNote
                  title="没有找到相关的旅程。"
                  desc="换个关键词，或者去打卡地看看。"
                  action={<TextLink to={q ? `/places?q=${encodeURIComponent(q)}` : '/places'}>去打卡地看看</TextLink>}
                />
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
