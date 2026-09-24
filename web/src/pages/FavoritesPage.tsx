import { Link } from 'react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Bookmark, Compass } from 'lucide-react'
import { api } from '@/api'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { Button, Empty, LoadError, buttonClass } from '@/components/ui'
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
    <div className="mx-auto max-w-6xl px-4 py-6">
      <h1 className="text-2xl font-extrabold">我的收藏</h1>
      <p className="mt-1 text-sm text-ink-500">{total ? `收藏了 ${total} 段旅程` : '喜欢的路线和游记，收藏起来慢慢看'}</p>

      <div className="mt-5">
        {q.isLoading ? (
          <TripGridSkeleton />
        ) : q.isLoadingError ? (
          <LoadError error={q.error} onRetry={() => q.refetch()} />
        ) : trips.length === 0 ? (
          <Empty
            icon={<Bookmark className="size-12" />}
            title="还没有收藏"
            desc="在旅程详情页点击「收藏」，就能在这里找到它"
            action={
              <Link to="/" className={buttonClass()}>
                <Compass className="size-4" />
                去发现
              </Link>
            }
          />
        ) : (
          <>
            <TripGrid trips={trips} />
            {q.hasNextPage && (
              <div className="mt-6 flex justify-center">
                <Button variant="outline" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                  加载更多
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
