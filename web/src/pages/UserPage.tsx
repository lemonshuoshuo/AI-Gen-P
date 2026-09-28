import { lazy, Suspense, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Flag, Heart, Settings, UserCheck, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, isNotFound, type UserProfile } from '@/api'
import { FilterLinks, LabelRow, MoreButton } from '@/components/editorial'
import { ReportDialog } from '@/components/report/ReportDialog'
import { FootprintStats } from '@/components/three/FootprintStats'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { Avatar, Button, Empty, LevelBadge, LoadError, Modal, PageLoader, UserName, buttonClass } from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useRequireAuth } from '@/hooks/useRequireAuth'
import { cn } from '@/lib/cn'
import { fmtDate } from '@/lib/format'
import { flattenPages } from '@/lib/pages'

type Tab = 'trips' | 'footprints'

// 足迹地图（maplibre + deck.gl）只在「足迹地图」标签页用到：按需加载，默认的旅程列表不用等它
const loadFootprintsView = () => import('@/components/three/FootprintsView')
const FootprintsView = lazy(() => loadFootprintsView().then((m) => ({ default: m.FootprintsView })))

function FollowList({ username, kind, onClose }: { username: string; kind: 'followers' | 'following' | null; onClose: () => void }) {
  // 服务端每页最多 50 条：分页加载，粉丝多的博主也能看全
  const q = useInfiniteQuery({
    queryKey: ['follow-list', username, kind],
    queryFn: ({ pageParam }) =>
      kind === 'followers'
        ? api.users.followers(username, { page: pageParam, page_size: 50 })
        : api.users.following(username, { page: pageParam, page_size: 50 }),
    initialPageParam: 1,
    getNextPageParam: (l) => (l.page * l.page_size < l.total ? l.page + 1 : undefined),
    enabled: !!kind,
  })
  const users = flattenPages(q.data?.pages)
  return (
    <Modal open={!!kind} onClose={onClose} title={kind === 'followers' ? '粉丝' : '关注'}>
      <div>
        {q.isSuccess && users.length === 0 && <p className="py-8 text-center text-sm text-ink-400">暂时还没有</p>}
        <ul className="divide-y divide-ink-200">
          {users.map((u) => (
            <li key={u.id}>
              <Link to={`/u/${u.username}`} onClick={onClose} className="group flex min-h-14 items-center gap-3 py-3">
                <Avatar user={u} size={34} />
                <UserName user={u} link={false} className="text-[15px] text-ink-900 transition-colors group-hover:text-ink-600" />
                <span aria-hidden className="ml-auto text-ink-300 transition-colors group-hover:text-ink-900">
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {q.hasNextPage && (
          <div className="flex justify-center pt-2">
            <Button variant="outline" size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
              加载更多
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}

export default function UserPage() {
  const { username = '' } = useParams()
  const qc = useQueryClient()
  const requireAuth = useRequireAuth()
  const [tab, setTab] = useState<Tab>('trips')
  const [list, setList] = useState<'followers' | 'following' | null>(null)
  const [report, setReport] = useState(false)
  const key = ['user', username]
  const { data: user, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.users.get(username) })
  const trips = useInfiniteQuery({
    queryKey: ['user-trips', username],
    queryFn: ({ pageParam }) => api.users.trips(username, { page: pageParam, page_size: 20 }),
    initialPageParam: 1,
    getNextPageParam: (l) => (l.page * l.page_size < l.total ? l.page + 1 : undefined),
    enabled: !!user,
  })
  const fp = useQuery({ queryKey: ['user-footprints', username], queryFn: () => api.users.footprints(username), enabled: !!user && tab === 'footprints' })
  useDocumentTitle(user && (user.nickname || user.username))
  const follow = useMutation({
    mutationFn: () => (user!.is_following ? api.users.unfollow(username) : api.users.follow(username)),
    onSuccess: (r) =>
      qc.setQueryData<UserProfile>(key, (u) => (u ? { ...u, is_following: r.following, stats: { ...u.stats, followers: r.followers } } : u)),
    onError: (e) => toast.error(errorMessage(e)),
  })

  if (isLoading) return <PageLoader />
  // 后台刷新失败时保留已加载的资料；404 说明账号已注销
  if (!user || isNotFound(error))
    return <LoadError className="min-h-[60vh]" error={error} notFoundTitle="用户不存在" onRetry={() => refetch()} />
  const items = flattenPages(trips.data?.pages)

  const stats = [
    { en: 'Trips', zh: '旅程', n: user.stats.trips },
    { en: 'Followers', zh: '粉丝', n: user.stats.followers, open: 'followers' as const },
    { en: 'Following', zh: '关注', n: user.stats.following, open: 'following' as const },
    { en: 'Likes', zh: '获赞', n: user.stats.likes },
  ]

  const tripsLabel = user.is_me ? '我的旅程' : 'TA 的旅程'

  return (
    <div>
      <header className="mx-auto max-w-[90rem] px-4 pt-10 md:px-8 md:pt-16">
        <LabelRow label="Traveller · 旅人档案" count={`No. ${String(user.id).padStart(4, '0')}`} />
        <div className="animate-slide-up mt-12 grid gap-x-8 gap-y-8 md:mt-20 lg:grid-cols-12 lg:items-end">
          <div className="min-w-0 lg:col-span-8">
            <Avatar user={user} size={72} className="mb-8 ring-1 ring-ink-200 ring-offset-4 ring-offset-paper lg:hidden" />
            <h1 className="text-display-xl font-normal break-words">{user.nickname || user.username}</h1>
            {/* 说明文字对：等级（亮）+ 账号与加入时间（灰） */}
            <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-900 md:mt-8">
              <LevelBadge level={user.level} />
              <span>{user.level_name}</span>
              {user.role === 'admin' && (
                <span className="inline-flex h-5 items-center rounded-full border border-ink-300 px-2 text-[11px] leading-none text-ink-700">管理员</span>
              )}
            </p>
            <p className="caption mt-0.5">
              <span className="font-num">@{user.username}</span> · <span className="font-num">{fmtDate(user.created_at)}</span> 加入
            </p>
          </div>
          <div className="flex flex-col items-start gap-6 lg:col-span-4 lg:items-end">
            <Avatar user={user} size={128} className="hidden ring-1 ring-ink-200 ring-offset-8 ring-offset-paper lg:inline-flex" />
            <div className="flex items-center gap-2">
              {user.is_me ? (
                <Link to="/settings" className={buttonClass({ variant: 'outline' })}>
                  <Settings className="size-4" strokeWidth={1.5} />
                  编辑资料
                </Link>
              ) : (
                <>
                  <Button
                    variant={user.is_following ? 'outline' : 'primary'}
                    loading={follow.isPending}
                    icon={
                      user.is_following ? <UserCheck className="size-4" strokeWidth={1.5} /> : <UserPlus className="size-4" strokeWidth={1.5} />
                    }
                    onClick={() => requireAuth(() => follow.mutate())}
                  >
                    {user.is_following ? '已关注' : '关注'}
                  </Button>
                  <Button variant="ghost" className="w-10 px-0" aria-label="举报" title="举报" onClick={() => requireAuth(() => setReport(true))}>
                    <Flag className="size-4" strokeWidth={1.25} />
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        {(user.bio || user.partner) && (
          <div className="mt-14 max-w-3xl md:mt-20">
            {user.bio && (
              <p className="font-display text-[1.45rem] leading-[1.6] text-ink-700 md:text-[2rem] md:leading-[1.5]">
                <span aria-hidden className="font-num mr-1 text-ink-400">
                  &ldquo;
                </span>
                {user.bio}
                <span aria-hidden className="font-num ml-1 text-ink-400">
                  &rdquo;
                </span>
              </p>
            )}
            {user.partner && (
              <Link
                to={`/u/${user.partner.username}`}
                className="mt-5 inline-flex h-10 items-center gap-2 text-[13px] text-ink-700 underline decoration-ink-300 underline-offset-4 transition-colors hover:text-ink-900 hover:decoration-ink-900"
              >
                <Heart className="size-3.5 text-pink-500" strokeWidth={1.5} />
                和 {user.partner.nickname || user.partner.username} 一起旅行中
              </Link>
            )}
          </div>
        )}

        {/* 统计：大号细字 Cormorant 数字，之间用竖细线分隔 */}
        <dl className="mt-14 grid grid-cols-2 border-y border-ink-200 md:mt-20 md:grid-cols-4">
          {stats.map((x, i) => {
            const inner = (
              <>
                <dt className="eyebrow">
                  {x.en} · {x.zh}
                </dt>
                <dd className="font-num mt-4 text-[3rem] leading-none font-light text-ink-900 transition-colors duration-300 md:text-[4.5rem]">{x.n}</dd>
              </>
            )
            const cls = cn(
              'block py-6 text-left md:py-8',
              i % 2 === 1 && 'border-l border-ink-200 pl-5',
              i >= 2 && 'border-t border-ink-200 md:border-t-0',
              i === 2 && 'md:border-l md:pl-6',
              i > 0 && 'md:pl-6',
            )
            return x.open ? (
              <button key={x.en} type="button" onClick={() => setList(x.open)} className={cn(cls, 'group hover:[&_dd]:text-ink-600')}>
                {inner}
              </button>
            ) : (
              <div key={x.en} className={cls}>
                {inner}
              </div>
            )
          })}
        </dl>
      </header>

      <section className="mx-auto max-w-[90rem] px-4 pt-24 pb-24 md:px-8 md:pt-36 md:pb-32" aria-labelledby="user-tab-title">
        <LabelRow
          label={tab === 'trips' ? 'Journeys · 旅程' : 'Footprints · 足迹'}
          count={tab === 'trips' && trips.data ? `${trips.data.pages[0].total} 段` : undefined}
          extra={
            <FilterLinks<Tab>
              label="查看"
              value={tab}
              onChange={(t) => {
                if (t === 'footprints') void loadFootprintsView() // 与足迹数据同时下载
                setTab(t)
              }}
              className="-mr-2"
              options={[
                { value: 'trips', label: tripsLabel },
                { value: 'footprints', label: '足迹地图' },
              ]}
            />
          }
        />
        <h2 id="user-tab-title" className="text-display-md mt-8 font-normal md:mt-12">
          {tab === 'trips' ? tripsLabel : '足迹地图'}
        </h2>
        <div className="mt-10 md:mt-16">
          {tab === 'trips' &&
            (trips.isLoading ? (
              <TripGridSkeleton n={4} />
            ) : trips.isLoadingError ? (
              <LoadError error={trips.error} onRetry={() => trips.refetch()} />
            ) : items.length === 0 ? (
              <Empty title="还没有公开的旅程" desc={user.is_me ? '把旅程设为公开后，会出现在这里' : undefined} />
            ) : (
              <>
                <TripGrid trips={items} showAuthor={false} />
                {trips.hasNextPage && <MoreButton loading={trips.isFetchingNextPage} onClick={() => trips.fetchNextPage()} />}
              </>
            ))}
          {tab === 'footprints' &&
            (fp.isLoading ? (
              <PageLoader />
            ) : fp.isLoadingError ? (
              <LoadError error={fp.error} onRetry={() => fp.refetch()} />
            ) : fp.data && fp.data.stats.waypoints > 0 ? (
              <>
                <FootprintStats data={fp.data} className="mb-8" />
                <Suspense fallback={<PageLoader />}>
                  <FootprintsView data={fp.data} height="h-[46vh] sm:h-[62vh]" />
                </Suspense>
              </>
            ) : (
              <Empty title="还没有公开的足迹" />
            ))}
        </div>
      </section>
      <FollowList username={username} kind={list} onClose={() => setList(null)} />
      <ReportDialog target={report ? { type: 'user', id: user.id } : null} onClose={() => setReport(false)} />
    </div>
  )
}
