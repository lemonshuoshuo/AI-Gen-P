import { lazy, Suspense, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Flag, Heart, Settings, UserCheck, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, isNotFound, type UserProfile } from '@/api'
import { DoubleRule, MoreButton } from '@/components/editorial'
import { ReportDialog } from '@/components/report/ReportDialog'
import { FootprintStats } from '@/components/three/FootprintStats'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { Avatar, Button, Empty, LevelBadge, LoadError, Modal, PageLoader, TabBar, UserName, buttonClass } from '@/components/ui'
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
              <Link to={`/u/${u.username}`} onClick={onClose} className="group flex items-center gap-3 py-3">
                <Avatar user={u} size={34} />
                <UserName user={u} link={false} className="text-[15px] group-hover:text-brand-700" />
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

  return (
    <div>
      <header className="mx-auto max-w-6xl px-4 pt-8 md:px-6 md:pt-12">
        <div className="flex items-center justify-between gap-4 pb-2.5">
          <p className="eyebrow">Traveller · 旅人档案</p>
          <p className="eyebrow">
            No. <span className="font-num">{String(user.id).padStart(4, '0')}</span>
          </p>
        </div>
        <DoubleRule />
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-5 gap-y-5 pt-7 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-end md:gap-x-8 md:pt-9">
          <Avatar user={user} size={96} className="hidden ring-1 ring-ink-900/10 ring-offset-4 ring-offset-paper md:inline-flex" />
          <Avatar user={user} size={64} className="ring-1 ring-ink-900/10 ring-offset-2 ring-offset-paper md:hidden" />
          <div className="min-w-0">
            <h1 className="text-[28px] leading-tight break-words md:text-[42px]">{user.nickname || user.username}</h1>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-500">
              <LevelBadge level={user.level} />
              <span>{user.level_name}</span>
              {user.role === 'admin' && (
                <span className="inline-flex h-4 items-center rounded-sm bg-ink-900 px-1 text-[10px] leading-none text-paper">管理员</span>
              )}
              <span aria-hidden className="text-ink-300">
                ·
              </span>
              <span className="font-num text-ink-400">@{user.username}</span>
              <span aria-hidden className="text-ink-300">
                ·
              </span>
              <span className="text-ink-400">
                <span className="font-num">{fmtDate(user.created_at)}</span> 加入
              </span>
            </p>
          </div>
          <div className="col-span-2 flex items-center gap-2 md:col-span-1 md:justify-end md:self-end">
            {user.is_me ? (
              <Link to="/settings" className={buttonClass({ variant: 'outline', size: 'sm' })}>
                <Settings className="size-4" strokeWidth={1.75} />
                编辑资料
              </Link>
            ) : (
              <>
                <Button
                  size="sm"
                  variant={user.is_following ? 'outline' : 'primary'}
                  loading={follow.isPending}
                  icon={
                    user.is_following ? (
                      <UserCheck className="size-4" strokeWidth={1.75} />
                    ) : (
                      <UserPlus className="size-4" strokeWidth={1.75} />
                    )
                  }
                  onClick={() => requireAuth(() => follow.mutate())}
                >
                  {user.is_following ? '已关注' : '关注'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="px-2"
                  aria-label="举报"
                  title="举报"
                  onClick={() => requireAuth(() => setReport(true))}
                >
                  <Flag className="size-4" strokeWidth={1.75} />
                </Button>
              </>
            )}
          </div>
        </div>
        {(user.bio || user.partner) && (
          <div className="mt-5 max-w-2xl md:ml-[128px]">
            {user.bio && (
              <p className="font-display text-[16px] leading-[1.75] text-ink-700 md:text-[17px]">
                <span aria-hidden className="font-num mr-0.5 text-brand-500">
                  &ldquo;
                </span>
                {user.bio}
                <span aria-hidden className="font-num ml-0.5 text-brand-500">
                  &rdquo;
                </span>
              </p>
            )}
            {user.partner && (
              <Link
                to={`/u/${user.partner.username}`}
                className="mt-2.5 inline-flex items-center gap-1.5 text-[13px] text-pink-600 underline decoration-pink-200 underline-offset-4 transition-colors hover:decoration-pink-600"
              >
                <Heart className="size-3.5" strokeWidth={1.75} />
                和 {user.partner.nickname || user.partner.username} 一起旅行中
              </Link>
            )}
          </div>
        )}

        <div className="mt-8 grid grid-cols-4 border-y border-ink-200">
          {stats.map((x, i) => {
            const inner = (
              <>
                <span className="font-num block text-[26px] leading-none text-ink-900 md:text-[34px]">{x.n}</span>
                <span className="mt-2 block text-xs tracking-wide text-ink-400">
                  <span className="eyebrow mr-1 hidden md:inline">{x.en} ·</span>
                  {x.zh}
                </span>
              </>
            )
            const cls = cn('block py-4 text-left md:py-5', i > 0 && 'border-l border-ink-200 pl-3 md:pl-6')
            return x.open ? (
              <button key={x.en} type="button" onClick={() => setList(x.open)} className={cn(cls, 'group transition-colors hover:bg-white/40')}>
                {inner}
              </button>
            ) : (
              <div key={x.en} className={cls}>
                {inner}
              </div>
            )
          })}
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 pt-10 pb-16 md:px-6">
        <TabBar<Tab>
          value={tab}
          onChange={(t) => {
            if (t === 'footprints') void loadFootprintsView() // 与足迹数据同时下载
            setTab(t)
          }}
          options={[
            { value: 'trips', label: user.is_me ? '我的旅程' : 'TA 的旅程' },
            { value: 'footprints', label: '足迹地图' },
          ]}
        />
        <div className="mt-7">
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
                <FootprintStats data={fp.data} className="mb-5" />
                <Suspense fallback={<PageLoader />}>
                  <FootprintsView data={fp.data} height="h-[46vh] sm:h-[56vh]" />
                </Suspense>
              </>
            ) : (
              <Empty title="还没有公开的足迹" />
            ))}
        </div>
      </div>
      <FollowList username={username} kind={list} onClose={() => setList(null)} />
      <ReportDialog target={report ? { type: 'user', id: user.id } : null} onClose={() => setReport(false)} />
    </div>
  )
}
