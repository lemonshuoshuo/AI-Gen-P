import { Link } from 'react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Bookmark, Compass } from 'lucide-react'
import { api } from '@/api'
import { MoreButton, PageHead } from '@/components/editorial'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { Empty, LoadError, buttonClass } from '@/components/ui'
import { flattenPages } from '@/lib/pages'

export default function FavoritesPage() {
  const q = useInfiniteQuery({
    queryKey: ['my-favorites'],
    queryFn: ({ pageParam }) => api.me.favorites({ page: pageParam, page_size: 20 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.page_size < last.total ? last.page + 1 : undefined),
  })
  const trips = flattenPages(q.data?.pages)
  const total = q.data?.pages[0]?.total

  return (
    <div className="mx-auto max-w-6xl px-4 pt-8 pb-16 md:px-6 md:pt-12">
      <PageHead
        eyebrow="Saved · 收藏夹"
        title="我的收藏"
        dek={
          total ? (
            <>
              收藏了 <span className="font-num text-ink-900">{total}</span> 段旅程，慢慢看，慢慢出发
            </>
          ) : (
            '喜欢的路线和游记，收藏起来慢慢看'
          )
        }
      />
      <div className="mt-8 border-t border-ink-200 pt-8">
        {q.isLoading ? (
          <TripGridSkeleton />
        ) : q.isLoadingError ? (
          <LoadError error={q.error} onRetry={() => q.refetch()} />
        ) : trips.length === 0 ? (
          <Empty
            icon={<Bookmark className="size-11" />}
            title="还没有收藏"
            desc="在旅程详情页点「收藏」，就能在这里找到它"
            action={
              <Link to="/" className={buttonClass()}>
                <Compass className="size-4" strokeWidth={1.75} />
                去发现
              </Link>
            }
          />
        ) : (
          <>
            <TripGrid trips={trips} />
            {q.hasNextPage && <MoreButton loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />}
          </>
        )}
      </div>
    </div>
  )
}
