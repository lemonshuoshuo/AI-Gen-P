import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { EmptyNote, MoreButton, PageHead, TextLink } from '@/components/editorial'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { LoadError } from '@/components/ui'
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
    <div className="mx-auto max-w-[90rem] px-4 pt-12 pb-24 [font-variant-numeric:lining-nums] md:px-8 md:pt-20 md:pb-32">
      <PageHead
        eyebrow="Saved · 收藏夹"
        meta={total ? `${total} 段` : undefined}
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
      <div className="mt-12 md:mt-16">
        {q.isLoading ? (
          <TripGridSkeleton />
        ) : q.isLoadingError ? (
          <LoadError error={q.error} onRetry={() => q.refetch()} />
        ) : trips.length === 0 ? (
          // 空状态：页头细线之下左对齐的一行宋体 + 说明 + 文字链接
          <div className="border-t border-ink-200 pt-10 md:pt-14">
            <EmptyNote title="还没有收藏。" desc="在旅程详情页点「收藏」，就能在这里找到它。" action={<TextLink to="/">去发现</TextLink>} />
          </div>
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
