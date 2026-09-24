import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bookmark,
  Box,
  CalendarDays,
  Flag,
  GitCompareArrows,
  GitFork,
  Heart,
  Link2,
  Lock,
  Map as MapIcon,
  MoreHorizontal,
  Navigation,
  PenLine,
  Play,
  Route,
  Share2,
  Trash2,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, errorMessage, isNotFound, type Photo, type TripDetail, type Waypoint } from '@/api'
import { rememberShareCode, rememberedShareCode } from '@/api/client'
import { CommentSection } from '@/components/comments/CommentSection'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { FitOnce, RouteLines, WaypointMarkers } from '@/components/map/layers'
import { ReportDialog } from '@/components/report/ReportDialog'
import { PhotoViewer } from '@/components/trip/PhotoViewer'
import { ShareDialog, ShareSheet } from '@/components/trip/ShareDialog'
import { TripCover } from '@/components/trip/TripCard'
import { WaypointItem } from '@/components/trip/WaypointItem'
import { Avatar, Button, Empty, LoadError, Menu, MenuItem, PageLoader, Stat, Tag, UserName, buttonClass, confirmDialog } from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useRequireAuth } from '@/hooks/useRequireAuth'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { dateRange, fmtCount, fromNow } from '@/lib/format'
import { formatKm } from '@/lib/geo'
import { phases, verdicts } from '@/lib/meta'
import { AMAP_MAX_STOPS, amapMultiRoute } from '@/lib/nav'
import { actualPath, allPoints, bySeq, groupByDay, photosByWaypoint, plannedPath, trackSegments } from '@/lib/trip'

// 游记的 Markdown 渲染库较大：只有写了游记的旅程才加载，且不阻塞地图和行程
const Markdown = lazy(() => import('react-markdown'))

/** refit：FitOnce 重新缩放（如轨迹加载完）后再飞一次，选中的地点不会被全程视野盖掉 */
function FlyToSelected({ w, refit }: { w: Waypoint | null; refit?: string }) {
  const map = useMap()
  useEffect(() => {
    if (map && w) map.flyTo({ center: [w.lng, w.lat], zoom: Math.max(map.getZoom(), 15), duration: 900 })
  }, [map, w, refit])
  return null
}

/** 被邀请成为共同作者、尚未接受时（接受前可预览旅程）；只有作者能发邀请，所以邀请人就是作者 */
function InviteBanner({ trip, queryKey }: { trip: TripDetail; queryKey: string[] }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const m = useMutation({
    mutationFn: (accept: boolean) =>
      accept ? api.trips.acceptInvite(trip.id) : api.trips.declineInvite(trip.id).then(() => null),
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: ['me', 'invites'] })
      qc.invalidateQueries({ queryKey: ['notifications'] })
      if (detail) {
        qc.setQueryData(queryKey, detail)
        qc.invalidateQueries({ queryKey: ['my-trips'] })
        toast.success('已加入旅程，一起规划吧')
        return
      }
      toast.success('已拒绝邀请')
      // 拒绝后非公开的旅程就看不到了
      if (trip.visibility === 'public') qc.invalidateQueries({ queryKey })
      else nav('/me/trips')
    },
    onError: (e) => {
      toast.error(errorMessage(e))
      if (e instanceof ApiError && e.status === 404) qc.invalidateQueries({ queryKey })
    },
  })
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 rounded-2xl bg-gradient-to-r from-sky-50 to-brand-50 p-3">
      <Users className="size-4 shrink-0 text-sky-600" />
      <span className="min-w-0 flex-1 text-sm text-ink-700">
        <b className="font-semibold text-ink-900">{trip.author.nickname || trip.author.username}</b> 邀请你一起编辑这段旅程
      </span>
      <Button size="sm" variant="ghost" loading={m.isPending && !m.variables} disabled={m.isPending} onClick={() => m.mutate(false)}>
        拒绝
      </Button>
      <Button size="sm" loading={m.isPending && m.variables} disabled={m.isPending} onClick={() => m.mutate(true)}>
        接受
      </Button>
    </div>
  )
}

function Itinerary({
  trip,
  selected,
  onSelect,
  onPhoto,
  onComment,
  renderActions,
}: {
  trip: TripDetail
  selected: Waypoint | null
  onSelect: (w: Waypoint) => void
  onPhoto: (p: Photo) => void
  onComment: (w: Waypoint) => void
  renderActions?: (w: Waypoint) => ReactNode
}) {
  const days = groupByDay(trip.waypoints)
  const byWp = photosByWaypoint(trip.photos)
  const order = useMemo(() => new Map([...trip.waypoints].sort(bySeq).map((w, i) => [w.id, i + 1])), [trip.waypoints])
  const hasPlan = trip.waypoints.some((w) => w.planned)
  if (!trip.waypoints.length) return <Empty icon={<MapIcon className="size-10" />} title="还没有打卡点" />
  return (
    <div className="space-y-5">
      {days.map(([day, list]) => (
        <div key={day}>
          {(days.length > 1 || day > 0) && (
            <div className="mb-2 flex items-center gap-2 px-1">
              <span className="bg-brand-gradient rounded-lg px-2 py-0.5 text-xs font-bold text-white">
                {day > 0 ? `DAY ${day}` : '未分天'}
              </span>
              <span className="text-xs text-ink-400">{list.length} 个地点</span>
            </div>
          )}
          <div className="space-y-1">
            {list.map((w) => (
              <WaypointItem
                key={w.id}
                w={w}
                label={String(order.get(w.id))}
                photos={byWp.get(w.id)}
                selected={selected?.id === w.id}
                onSelect={() => onSelect(w)}
                onPhoto={onPhoto}
                onComment={() => onComment(w)}
                actions={renderActions?.(w)}
                showStatus={hasPlan && trip.phase !== 'planning'}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// 同一路由内切换到另一段旅程（「引用自」链接、浏览器前进 / 后退）时整页重新挂载，
// 避免选中的打卡点、评论目标 / 草稿、照片查看器等状态串到另一段旅程
export default function TripDetailPage() {
  const { id, code } = useParams()
  return <TripDetailView key={id ?? `s:${code}`} />
}

function TripDetailView() {
  const { id, code } = useParams()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const requireAuth = useRequireAuth()
  const key = ['trip', id ?? `s:${code}`]
  const { data: trip, isLoading, error, refetch } = useQuery({
    queryKey: key,
    queryFn: async () => {
      if (!code) return api.trips.get(id!)
      const t = await api.trips.byShare(code)
      rememberShareCode(t.id, code)
      return t
    },
  })
  const { data: track } = useQuery({
    queryKey: ['track', trip?.id],
    queryFn: () => api.trips.track(trip!.id),
    enabled: !!trip?.has_track,
  })
  const [selected, setSelected] = useState<Waypoint | null>(null)
  const [viewer, setViewer] = useState<{ list: Photo[]; i: number } | null>(null)
  const [share, setShare] = useState(false)
  const [report, setReport] = useState(false)
  const [commentWp, setCommentWp] = useState<number | null>(null)
  const [shareWp, setShareWp] = useState<Waypoint | null>(null)
  const [forking, setForking] = useState(false)
  const mapBoxRef = useRef<HTMLDivElement>(null)

  // 打卡点分享链接（?wp=打卡点ID）：打开时选中该地点并滚动到行程里的位置（每个链接只处理一次，后台刷新不再跳）
  const wpParam = Number(params.get('wp')) || null
  const deepLinked = useRef('')
  useEffect(() => {
    if (!trip || !wpParam || deepLinked.current === `${trip.id}-${wpParam}`) return
    deepLinked.current = `${trip.id}-${wpParam}`
    const w = trip.waypoints.find((x) => x.id === wpParam)
    if (!w) return
    setSelected(w)
    document.getElementById(`wp-${w.id}`)?.scrollIntoView({ block: 'center' })
  }, [trip, wpParam])

  const patch = (p: Partial<TripDetail>) => qc.setQueryData<TripDetail>(key, (t) => (t ? { ...t, ...p } : t))

  const like = useMutation({
    mutationFn: () => api.trips.like(trip!.id, !trip!.liked),
    onSuccess: (r) => patch({ liked: r.liked, like_count: r.like_count }),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const fav = useMutation({
    mutationFn: () => api.trips.favorite(trip!.id, !trip!.favorited),
    onSuccess: (r) => {
      patch({ favorited: r.favorited, fav_count: r.fav_count })
      qc.invalidateQueries({ queryKey: ['my-favorites'] })
      toast.success(r.favorited ? '已收藏' : '已取消收藏')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const segments = useMemo(() => trackSegments(track), [track])
  const planned = useMemo(() => (trip ? plannedPath(trip.waypoints) : []), [trip])
  const actual = useMemo(() => (trip ? actualPath(trip.waypoints) : []), [trip])
  const sorted = useMemo(() => (trip ? [...trip.waypoints].sort(bySeq) : []), [trip])
  const fitPoints = useMemo(() => (trip ? allPoints(trip.waypoints, segments) : []), [trip, segments])
  useDocumentTitle(trip?.title)

  if (isLoading) return <PageLoader />
  // 后台刷新失败（网络、服务器错误）时保留已加载的内容；404 说明旅程已删除或不再可见
  if (!trip || isNotFound(error))
    return (
      <LoadError
        className="min-h-[60vh]"
        error={error}
        notFoundTitle="旅程不存在或无权查看"
        onRetry={() => refetch()}
        back={
          <Button variant="outline" onClick={() => nav('/')}>
            回到首页
          </Button>
        }
      />
    )

  const fork = async () => {
    if (
      !(await confirmDialog({
        title: '引用这条路线？',
        desc: '会把这段旅程的打卡点复制成你自己的「计划路线」（私密），可以自由修改，出发时按图打卡。',
        okText: '一键引用',
      }))
    )
      return
    setForking(true)
    try {
      const t = await api.trips.fork(trip.id)
      invalidateTripLists(qc)
      toast.success('已引用到你的旅程')
      nav(`/trips/${t.id}/edit`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setForking(false)
    }
  }

  const remove = async () => {
    if (!(await confirmDialog({ title: '删除这段旅程？', desc: '打卡点、照片、轨迹和评论都会被删除，无法恢复。', danger: true, okText: '删除' })))
      return
    try {
      await api.trips.remove(trip.id)
      toast.success('已删除')
      // 列表直接丢掉重新加载，避免已删除的卡片闪一下；返回键也不再回到已删除的旅程
      qc.removeQueries({ queryKey: ['my-trips'] })
      invalidateTripLists(qc)
      await nav('/me/trips', { replace: true })
      // 离开后再移除详情缓存，否则当前页会重新请求并得到 404
      qc.removeQueries({ queryKey: key })
      qc.removeQueries({ queryKey: ['trip', String(trip.id)] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const phase = phases[trip.phase]
  const hasPlan = trip.waypoints.some((w) => w.planned)
  // 「我的收藏」只列出公开旅程和自己参与的旅程：通过分享链接看到的旅程收藏后找不到，不提供收藏（已收藏的仍可取消）
  const canFavorite = trip.favorited || trip.can_edit || (trip.visibility === 'public' && trip.status === 'normal')
  // 单个打卡点的分享链接：「链接可见」的旅程要带分享码，私密旅程不提供
  const knownCode = trip.share_code ?? code ?? rememberedShareCode(trip.id)
  const shareBase = trip.visibility === 'public' ? `/trips/${trip.id}` : trip.visibility === 'unlisted' && knownCode ? `/s/${knownCode}` : null
  const fitKey = `${trip.id}-${fitPoints.length}`
  const hasActual = trip.waypoints.some((w) => w.status === 'visited')
  // 「已打卡/计划」只数计划内的点（与计划 vs 实际页一致，不会超过 100%）；计划外的另记为 +N
  const showProgress = hasPlan && trip.phase !== 'planning'
  const plannedTotal = trip.waypoints.filter((w) => w.planned).length
  const plannedVisited = trip.waypoints.filter((w) => w.planned && w.status === 'visited').length
  const extraVisited = trip.waypoints.filter((w) => !w.planned && w.status === 'visited').length
  const remaining = sorted.filter((w) => w.status === 'todo')
  // 高德一次最多规划 AMAP_MAX_STOPS 站：站数更多时导航接下来的这几站，并在按钮上说明，不再悄悄跳过中间的站
  const navStops = remaining.length ? remaining : sorted
  const navTruncated = navStops.length > AMAP_MAX_STOPS
  const navAll = amapMultiRoute(navStops.map((w) => ({ lng: w.lng, lat: w.lat, name: w.name })))
  const navHint = navTruncated
    ? `高德一次最多规划 ${AMAP_MAX_STOPS} 站，这条路线${remaining.length ? '还剩' : '共'} ${navStops.length} 站` +
      (trip.can_edit && remaining.length ? '；到达并打卡后再点，可继续导航后面的站' : '')
    : undefined
  const gallery = trip.photos
  const wpById = new Map(trip.waypoints.map((w) => [w.id, w]))

  const openPhoto = (p: Photo, list = gallery) => setViewer({ list, i: Math.max(0, list.findIndex((x) => x.id === p.id)) })

  // 窄屏时地图在页面顶部且不吸顶：从列表选中地点时把地图滚回视野；宽屏地图常驻可见则不滚动
  const selectAndShow = (w: Waypoint) => {
    setSelected(w)
    const el = mapBoxRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 56) // 56px = 吸顶 header (h-14)
    if (visible < r.height / 2) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="mx-auto max-w-7xl lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-0">
      {/* 地图（移动端在上方） */}
      <div ref={mapBoxRef} className="order-2 scroll-mt-14 lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)]">
        <BaseMap
          className="h-[46vh] lg:h-full"
          kindSwitcher
          locate
          overlay={
            <div className="absolute bottom-3 left-3 z-10 flex flex-wrap gap-2">
              <Link to={`/trips/${trip.id}/replay`} className={buttonClass({ size: 'sm', variant: 'dark' })}>
                <Box className="size-4" />
                3D 回放
              </Link>
              {sorted.length > 1 && (
                <a
                  href={navAll}
                  target="_blank"
                  rel="noreferrer"
                  title={navHint}
                  onClick={() => navHint && toast(navHint)}
                  className={buttonClass({ size: 'sm', variant: 'outline' })}
                >
                  <Navigation className="size-4" />
                  {navTruncated ? `导航${remaining.length ? '接下来' : '前'} ${AMAP_MAX_STOPS} 站` : '整条路线导航'}
                </a>
              )}
            </div>
          }
        >
          <RouteLines planned={hasPlan && hasActual ? planned : undefined} actual={hasActual ? actual : planned} track={segments} />
          <WaypointMarkers waypoints={sorted} selectedId={selected?.id} onSelect={setSelected} />
          <FitOnce points={fitPoints} fitKey={fitKey} />
          <FlyToSelected w={selected} refit={fitKey} />
        </BaseMap>
        {hasPlan && hasActual && (
          <div className="flex items-center gap-4 border-b border-ink-100 bg-white px-4 py-2 text-xs text-ink-500 lg:absolute lg:top-3 lg:left-3 lg:rounded-full lg:border-none lg:shadow-card">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-5 border-t-2 border-dashed border-sky-500" />
              计划路线
            </span>
            <span className="flex items-center gap-1.5">
              <span className="bg-brand-gradient inline-block h-1 w-5 rounded" />
              实际路线
            </span>
            {segments.length > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-1 w-5 rounded bg-violet-500" />
                GPS 轨迹
              </span>
            )}
          </div>
        )}
      </div>

      {/* 内容 */}
      <div className="order-1 min-w-0 px-4 pt-4 pb-10 lg:max-h-none lg:px-8">
        {trip.cover_url && (
          <div className="mb-4 aspect-[21/9] overflow-hidden rounded-3xl bg-ink-100">
            <TripCover trip={trip} full />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', phase.cls)}>{phase.label}</span>
          {trip.featured && <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">⭐ 精选</span>}
          {trip.together && <span className="bg-love-gradient rounded-full px-2.5 py-0.5 text-xs font-semibold text-white">💕 我们一起</span>}
          {trip.status === 'hidden' && <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-xs text-red-600">已被管理员隐藏</span>}
          {trip.can_edit && trip.visibility !== 'public' && (
            <button
              type="button"
              onClick={() => setShare(true)}
              className="inline-flex items-center gap-0.5 rounded-full bg-ink-900/70 px-2.5 py-0.5 text-xs text-white hover:bg-ink-900"
              title="设置分享"
            >
              {trip.visibility === 'private' ? <Lock className="size-3" /> : <Link2 className="size-3" />}
              {trip.visibility === 'private' ? '私密' : '链接可见'}
            </button>
          )}
        </div>
        <h1 className="mt-2 text-2xl leading-tight font-extrabold md:text-3xl">{trip.title}</h1>
        {trip.forked_from && (
          <p className="mt-1 text-xs text-ink-400">
            <GitFork className="mr-0.5 inline size-3" />
            引用自 <Link to={`/trips/${trip.forked_from.id}`} className="text-brand-600">{trip.forked_from.title}</Link>
            （{trip.forked_from.author.nickname || trip.forked_from.author.username}）
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <div className="flex -space-x-2">
            {[trip.author, ...trip.members].map((u) => (
              <Avatar key={u.id} user={u} size={32} ring />
            ))}
          </div>
          <div className="min-w-0 text-sm">
            <div className="flex flex-wrap items-center gap-x-1">
              <UserName user={trip.author} />
              {trip.members.map((m) => (
                <span key={m.id} className="flex items-center gap-1 text-ink-400">
                  &<UserName user={m} />
                </span>
              ))}
            </div>
            <div className="text-xs text-ink-400">
              {trip.published_at ? `发布于 ${fromNow(trip.published_at)}` : `更新于 ${fromNow(trip.updated_at)}`} · {fmtCount(trip.view_count)} 浏览
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-4 gap-2 rounded-2xl bg-white p-4 shadow-card">
          <Stat label="天数" value={trip.days || '-'} unit={trip.days ? '天' : ''} />
          <Stat
            label={showProgress ? '已打卡/计划' : '打卡点'}
            value={showProgress ? `${plannedVisited}/${plannedTotal}` : trip.waypoint_count}
            unit={showProgress && extraVisited > 0 ? `+${extraVisited}` : undefined}
          />
          <Stat label="里程" value={formatKm(trip.distance_km).replace(/ .*/, '')} unit={formatKm(trip.distance_km).replace(/^[\d.,]+ /, '')} />
          <Stat label="城市" value={trip.cities.length} unit="个" />
        </div>
        {trip.start_date && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-ink-500">
            <CalendarDays className="size-4" />
            {dateRange(trip.start_date, trip.end_date)}
            {trip.cities.length > 0 && <span className="truncate">· {trip.cities.join('、')}</span>}
          </p>
        )}
        {trip.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {trip.tags.map((t) => (
              <Link key={t} to={`/search?tag=${encodeURIComponent(t)}`}>
                <Tag className="hover:bg-brand-50 hover:text-brand-700">#{t}</Tag>
              </Link>
            ))}
          </div>
        )}

        {trip.invite_pending && <InviteBanner trip={trip} queryKey={key} />}

        {/* 操作栏 */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant={trip.liked ? 'primary' : 'outline'}
            size="sm"
            icon={<Heart className={cn('size-4', trip.liked && 'fill-white')} />}
            onClick={() => requireAuth(() => like.mutate())}
          >
            {trip.like_count || '点赞'}
          </Button>
          {canFavorite && (
            <Button
              variant="outline"
              size="sm"
              icon={<Bookmark className={cn('size-4', trip.favorited && 'fill-amber-400 text-amber-400')} />}
              onClick={() => requireAuth(() => fav.mutate())}
            >
              {trip.favorited ? '已收藏' : '收藏'}
            </Button>
          )}
          {!trip.is_owner && trip.waypoints.length > 0 && (
            <Button variant="outline" size="sm" icon={<GitFork className="size-4" />} loading={forking} onClick={() => requireAuth(fork)}>
              引用路线
            </Button>
          )}
          <Button variant="outline" size="sm" icon={<Share2 className="size-4" />} onClick={() => setShare(true)}>
            分享
          </Button>
          {hasPlan && hasActual && (
            <Link to={`/trips/${trip.id}/compare`} className={buttonClass({ variant: 'outline', size: 'sm' })}>
              <GitCompareArrows className="size-4" />
              计划 vs 实际
            </Link>
          )}
          <Menu
            trigger={(t, open) => (
              <Button variant="ghost" size="sm" onClick={t} aria-label="更多" aria-expanded={open}>
                <MoreHorizontal className="size-4" />
              </Button>
            )}
          >
            {(close) => (
              <>
                {!trip.is_owner && (
                  <MenuItem icon={<Flag className="size-4" />} onClick={() => (close(), requireAuth(() => setReport(true)))}>
                    举报
                  </MenuItem>
                )}
                {trip.is_owner && (
                  <MenuItem icon={<Trash2 className="size-4" />} danger onClick={() => (close(), remove())}>
                    删除旅程
                  </MenuItem>
                )}
              </>
            )}
          </Menu>
        </div>

        {trip.can_edit && (
          <div className="mt-4 flex flex-wrap gap-2 rounded-2xl bg-gradient-to-r from-brand-50 to-orange-50 p-3">
            <Link to={`/trips/${trip.id}/edit`} className={buttonClass({ size: 'sm', variant: 'dark' })}>
              <PenLine className="size-4" />
              编辑{trip.phase === 'planning' ? '路线' : '旅程'}
            </Link>
            {trip.phase !== 'finished' && (
              <Link to={`/trips/${trip.id}/go`} className={buttonClass({ size: 'sm' })}>
                {trip.phase === 'ongoing' ? <Route className="size-4" /> : <Play className="size-4" />}
                {trip.phase === 'ongoing' ? '继续旅行' : '出发！按路线走'}
              </Link>
            )}
            <span className="self-center text-xs text-ink-500">
              {trip.phase === 'planning' && '规划好路线后就可以出发，路上一键打卡、实时记录轨迹'}
              {trip.phase === 'ongoing' && '旅行进行中：到了就打卡，还能推荐下一站'}
            </span>
          </div>
        )}

        {trip.summary && <p className="mt-5 text-[15px] leading-relaxed text-ink-700">{trip.summary}</p>}

        <h2 className="mt-8 mb-3 flex items-center gap-2 text-lg font-bold">
          <Route className="size-5" />
          {trip.phase === 'planning' ? '路线安排' : '行程与打卡'}
        </h2>
        <Itinerary
          trip={trip}
          selected={selected}
          onSelect={selectAndShow}
          onPhoto={(p) => openPhoto(p)}
          onComment={(w) => {
            setCommentWp(w.id)
            document.getElementById('comments')?.scrollIntoView({ behavior: 'smooth' })
          }}
          renderActions={
            shareBase
              ? (w) => (
                  <button
                    type="button"
                    onClick={() => setShareWp(w)}
                    className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-ink-500 hover:bg-ink-100"
                  >
                    <Share2 className="size-3.5" />
                    分享
                  </button>
                )
              : undefined
          }
        />

        {trip.content && (
          <>
            <h2 className="mt-10 mb-3 text-lg font-bold">游记</h2>
            <div className="prose-trip text-[15px] text-ink-700">
              <Suspense fallback={<p className="whitespace-pre-wrap">{trip.content}</p>}>
                <Markdown>{trip.content}</Markdown>
              </Suspense>
            </div>
          </>
        )}

        {gallery.length > 0 && (
          <>
            <h2 className="mt-10 mb-3 text-lg font-bold">
              照片 <span className="text-sm font-normal text-ink-400">{gallery.length}</span>
            </h2>
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {gallery.slice(0, 24).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => openPhoto(p)}
                  className="aspect-square overflow-hidden rounded-xl bg-ink-100"
                >
                  <img src={p.thumb_url} alt={p.caption} loading="lazy" className="size-full object-cover transition hover:scale-105" />
                </button>
              ))}
            </div>
          </>
        )}

        <div className="mt-10">
          <CommentSection
            tripId={trip.id}
            count={trip.comment_count}
            // 只改缓存里的计数：重新请求旅程详情会多记一次浏览，还要重拉全部打卡点和照片
            onCountChange={(d) => qc.setQueryData<TripDetail>(key, (t) => (t ? { ...t, comment_count: Math.max(0, t.comment_count + d) } : t))}
            waypoints={trip.waypoints}
            waypointId={commentWp}
            onClearWaypoint={() => setCommentWp(null)}
            onJumpWaypoint={(wid) => {
              const w = wpById.get(wid)
              if (w) selectAndShow(w)
            }}
          />
        </div>
      </div>

      <ShareDialog
        trip={trip}
        shareCode={code ?? rememberedShareCode(trip.id)}
        open={share}
        onClose={() => setShare(false)}
        onUpdated={(t) => {
          qc.setQueryData(key, t)
          invalidateTripLists(qc)
        }}
      />
      <ReportDialog target={report ? { type: 'trip', id: trip.id } : null} onClose={() => setReport(false)} />
      {shareWp && shareBase && (
        <ShareSheet
          open
          onClose={() => setShareWp(null)}
          heading="分享打卡点"
          title={`${shareWp.name} · ${trip.title}`}
          text={[shareWp.verdict && `${verdicts[shareWp.verdict].emoji} ${verdicts[shareWp.verdict].label}`, shareWp.note.slice(0, 60)].filter(Boolean).join(' · ') || undefined}
          url={`${window.location.origin}${shareBase}?wp=${shareWp.id}`}
        />
      )}
      <PhotoViewer
        photos={viewer?.list ?? []}
        index={viewer?.i ?? null}
        onClose={() => setViewer(null)}
        captionOf={(p) => (p.waypoint_id ? wpById.get(p.waypoint_id)?.name : undefined)}
      />
    </div>
  )
}
