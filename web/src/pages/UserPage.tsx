import { lazy, Suspense, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Flag, Heart, Settings, UserCheck, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, isNotFound, type UserProfile } from '@/api'
import { ReportDialog } from '@/components/report/ReportDialog'
import { FootprintStats } from '@/components/three/FootprintStats'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { Avatar, Button, Empty, LevelBadge, LoadError, Modal, PageLoader, TabBar, UserName, buttonClass } from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useRequireAuth } from '@/hooks/useRequireAuth'
import { fmtDate } from '@/lib/format'
import { levelColor } from '@/lib/meta'
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
      <div className="space-y-2">
        {q.isSuccess && users.length === 0 && <p className="py-6 text-center text-sm text-ink-400">暂无</p>}
        {users.map((u) => (
          <Link key={u.id} to={`/u/${u.username}`} onClick={onClose} className="flex items-center gap-3 rounded-xl p-2 hover:bg-ink-50">
            <Avatar user={u} size={36} />
            <UserName user={u} link={false} />
          </Link>
        ))}
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

  return (
    <div>
      <div className="relative overflow-hidden bg-ink-900 text-white">
        <div className="absolute inset-0 opacity-60" style={{ background: `radial-gradient(circle at 20% 0%, ${levelColor(user.level)}, transparent 60%), radial-gradient(circle at 90% 100%, #ff5a5f, transparent 50%)` }} />
        <div className="relative mx-auto flex max-w-6xl flex-wrap items-end gap-5 px-4 pt-10 pb-6">
          <Avatar user={user} size={88} ring />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-extrabold">{user.nickname || user.username}</h1>
              <LevelBadge level={user.level} className="!h-5 !px-1.5 !text-xs" />
              <span className="text-sm text-white/60">{user.level_name}</span>
              {user.role === 'admin' && <span className="rounded bg-white/15 px-1.5 text-xs">管理员</span>}
            </div>
            <p className="text-sm text-white/50">@{user.username} · {fmtDate(user.created_at)} 加入</p>
            {user.bio && <p className="mt-2 max-w-xl text-sm text-white/80">{user.bio}</p>}
            {user.partner && (
              <Link to={`/u/${user.partner.username}`} className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs">
                <Heart className="size-3.5 fill-pink-400 text-pink-400" />
                和 {user.partner.nickname || user.partner.username} 一起旅行中
              </Link>
            )}
            <div className="mt-3 flex gap-5 text-sm">
              <span><b>{user.stats.trips}</b> <span className="text-white/60">旅程</span></span>
              <button type="button" onClick={() => setList('followers')}><b>{user.stats.followers}</b> <span className="text-white/60">粉丝</span></button>
              <button type="button" onClick={() => setList('following')}><b>{user.stats.following}</b> <span className="text-white/60">关注</span></button>
              <span><b>{user.stats.likes}</b> <span className="text-white/60">获赞</span></span>
            </div>
          </div>
          {user.is_me ? (
            <Link
              to="/settings"
              className={buttonClass({ variant: 'outline', size: 'sm', className: 'border-white/20 bg-white/10 text-white hover:bg-white/20' })}
            >
              <Settings className="size-4" />
              编辑资料
            </Link>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={user.is_following ? 'outline' : 'primary'}
                className={user.is_following ? 'border-white/20 bg-white/10 text-white hover:bg-white/20' : ''}
                loading={follow.isPending}
                icon={user.is_following ? <UserCheck className="size-4" /> : <UserPlus className="size-4" />}
                onClick={() => requireAuth(() => follow.mutate())}
              >
                {user.is_following ? '已关注' : '关注'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="border-white/20 bg-white/10 px-2 text-white hover:bg-white/20"
                aria-label="举报"
                title="举报"
                onClick={() => requireAuth(() => setReport(true))}
              >
                <Flag className="size-4" />
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-5">
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
        <div className="mt-5">
          {tab === 'trips' &&
            (trips.isLoading ? (
              <TripGridSkeleton n={4} />
            ) : trips.isLoadingError ? (
              <LoadError error={trips.error} onRetry={() => trips.refetch()} />
            ) : items.length === 0 ? (
              <Empty title="还没有公开的旅程" />
            ) : (
              <>
                <TripGrid trips={items} showAuthor={false} />
                {trips.hasNextPage && (
                  <div className="mt-6 flex justify-center">
                    <Button variant="outline" loading={trips.isFetchingNextPage} onClick={() => trips.fetchNextPage()}>
                      加载更多
                    </Button>
                  </div>
                )}
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
