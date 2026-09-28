import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bookmark,
  Box,
  EyeOff,
  Flag,
  GitCompareArrows,
  GitFork,
  Heart,
  Hourglass,
  Link2,
  Lock,
  Map as MapIcon,
  MoreHorizontal,
  Navigation,
  PenLine,
  Play,
  Radio,
  Route,
  Share2,
  Trash2,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, errorMessage, isNotFound, type Photo, type TripDetail, type Waypoint } from '@/api'
import { rememberShareCode, rememberedShareCode } from '@/api/client'
import { CommentSection } from '@/components/comments/CommentSection'
import { Markdown } from '@/components/Markdown'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { FitOnce, RouteLines, WaypointMarkers } from '@/components/map/layers'
import { ReportDialog } from '@/components/report/ReportDialog'
import { PhotoViewer } from '@/components/trip/PhotoViewer'
import { ShareDialog, ShareSheet } from '@/components/trip/ShareDialog'
import { WaypointItem } from '@/components/trip/WaypointItem'
import {
  Avatar,
  Button,
  Empty,
  LoadError,
  Menu,
  MenuItem,
  Modal,
  PageLoader,
  Switch,
  Tag,
  UserName,
  buttonClass,
  confirmDialog,
} from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useRequireAuth } from '@/hooks/useRequireAuth'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { dateRange, dayjs, fmtCount, fromNow } from '@/lib/format'
import { formatKm } from '@/lib/geo'
import { phases, tripStatuses, verdicts } from '@/lib/meta'
import { AMAP_MAX_STOPS, amapMultiRoute } from '@/lib/nav'
import { actualPath, allPoints, bySeq, groupByDay, photosByWaypoint, plannedPath, trackSegments } from '@/lib/trip'

/** refit：FitOnce 重新缩放（如轨迹加载完）后再飞一次，选中的地点不会被全程视野盖掉 */
function FlyToSelected({ w, refit }: { w: Waypoint | null; refit?: string }) {
  const map = useMap()
  useEffect(() => {
    if (map && w)
      map.flyTo({
        center: [w.lng, w.lat],
        zoom: Math.max(map.getZoom(), 15),
        duration: 900,
      })
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
    <div className="mt-6 flex flex-wrap items-center gap-3 border-l-2 border-sky-500 bg-white py-3 pr-3 pl-4 shadow-card">
      <Users className="size-4 shrink-0 text-sky-600" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 text-sm text-ink-700">
        <span className="font-display text-[15px] text-ink-900">{trip.author.nickname || trip.author.username}</span>{' '}
        邀请你一起编辑这段旅程
      </span>
      <Button
        size="sm"
        variant="ghost"
        loading={m.isPending && !m.variables}
        disabled={m.isPending}
        onClick={() => m.mutate(false)}
      >
        拒绝
      </Button>
      <Button size="sm" loading={m.isPending && m.variables} disabled={m.isPending} onClick={() => m.mutate(true)}>
        接受
      </Button>
    </div>
  )
}

/** 引用路线：原作者标记为「踩雷」的地点默认不复制（与服务端 include_avoid 缺省一致），可以选择一并复制 */
function ForkDialog({ trip, onClose }: { trip: TripDetail; onClose: () => void }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [includeAvoid, setIncludeAvoid] = useState(false)
  const [forking, setForking] = useState(false)
  // 服务端不复制跳过的点；旅行中未开启实时公开的旅程对非成员只返回计划（没有评价），这里为 0
  const avoidCount = trip.waypoints.filter((w) => w.verdict === 'avoid' && w.status !== 'skipped').length
  const close = () => {
    if (!forking) onClose()
  }
  const fork = async () => {
    setForking(true)
    try {
      const t = await api.trips.fork(trip.id, { include_avoid: includeAvoid })
      invalidateTripLists(qc)
      toast.success(avoidCount > 0 && !includeAvoid ? `已引用到你的旅程，已跳过 ${avoidCount} 个踩雷地点` : '已引用到你的旅程')
      nav(`/trips/${t.id}/edit`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setForking(false)
    }
  }
  return (
    <Modal
      open
      onClose={close}
      title="引用这条路线？"
      footer={
        <>
          <Button variant="ghost" disabled={forking} onClick={close}>
            取消
          </Button>
          <Button loading={forking} onClick={fork}>
            一键引用
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-500">
        会把这段旅程的打卡点复制成你自己的「计划路线」（私密），可以自由修改，出发时按图打卡。
      </p>
      {avoidCount > 0 && (
        <div className="mt-4 space-y-1.5 rounded-lg border border-ink-200 bg-ink-50/70 p-3">
          <Switch
            checked={includeAvoid}
            onChange={setIncludeAvoid}
            label={<span className="text-left">{`同时复制 ${avoidCount} 个原作者标记为「踩雷」的地点`}</span>}
          />
          <p className="pl-12 text-xs leading-relaxed text-ink-400">默认不复制；复制时会在备注里注明原作者踩雷</p>
        </div>
      )}
    </Modal>
  )
}

/** 大号统计：Fraunces 数字 + 小号单位与标签，多个之间用竖细线分隔 */
function BigStat({ label, value, unit, sub }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0 px-2.5 first:pl-0 last:pr-0 sm:px-5">
      <div className="flex flex-wrap items-baseline gap-x-1">
        <span className="font-num text-[1.55rem] leading-none font-[450] tracking-tight whitespace-nowrap text-ink-900 sm:text-[2.35rem]">
          {value}
        </span>
        {unit && <span className="text-[11px] whitespace-nowrap text-ink-400 sm:text-xs">{unit}</span>}
        {sub}
      </div>
      <div className="mt-2 text-[11px] tracking-[0.04em] whitespace-nowrap text-ink-400 sm:tracking-[0.12em]">{label}</div>
    </div>
  )
}

const dayDate = (start: string | null, day: number) =>
  start && day > 0
    ? dayjs(start)
        .add(day - 1, 'day')
        .format('M月D日 · ddd')
    : ''

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
  if (!trip.waypoints.length)
    return (
      <Empty icon={<MapIcon className="size-9" strokeWidth={1.75} />} title="还没有打卡点" desc="路线规划好之后，行程会像旅行指南一样排在这里" />
    )
  return (
    <div className="space-y-12">
      {days.map(([day, list]) => (
        <section key={day} aria-label={day > 0 ? `第 ${day} 天` : '未分天'}>
          {(days.length > 1 || day > 0) && (
            <div className="flex items-baseline gap-3 border-b border-ink-200 pb-2.5">
              {day > 0 ? (
                <>
                  <span className="font-num text-[11px] font-medium tracking-[0.22em] text-brand-500 uppercase">Day</span>
                  <span className="font-num -ml-1 text-[2rem] leading-none font-[450] text-ink-900">
                    {String(day).padStart(2, '0')}
                  </span>
                  {trip.start_date && (
                    <span className="text-[13px] tracking-wide text-ink-500">{dayDate(trip.start_date, day)}</span>
                  )}
                </>
              ) : (
                <span className="font-display text-lg text-ink-700">未分天</span>
              )}
              <span className="ml-auto text-xs tracking-wide text-ink-400">
                <span className="font-num">{list.length}</span> 个地点
              </span>
            </div>
          )}
          {/* 细线画在外层：条目本身左右各探出一点（选中时的底色），分隔线仍与正文对齐 */}
          <div className="divide-y divide-ink-200">
            {list.map((w) => (
              <div key={w.id}>
                <WaypointItem
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
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/** 区块标题：西文 eyebrow + 宋体标题，上方一条墨色细线 */
function SectionHead({ eyebrow, title, aside }: { eyebrow: string; title: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-end justify-between gap-4 border-t border-ink-900 pt-4">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="mt-1.5 text-[22px] leading-tight md:text-[24px]">{title}</h2>
      </div>
      {aside && <div className="shrink-0 pb-1 text-xs tracking-wide text-ink-400">{aside}</div>}
    </div>
  )
}

const mapChip = 'inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] tracking-wide shadow-card transition-colors'

const phaseEyebrow = {
  planning: 'Route Plan',
  ongoing: 'On the Road',
  finished: 'Travelogue',
} as const

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
  const {
    data: trip,
    isLoading,
    error,
    refetch,
  } = useQuery({
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
  const [forkOpen, setForkOpen] = useState(false)
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

  const remove = async () => {
    if (
      !(await confirmDialog({
        title: '删除这段旅程？',
        desc: '打卡点、照片、轨迹和评论都会被删除，无法恢复。',
        danger: true,
        okText: '删除',
      }))
    )
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
  const shareBase =
    trip.visibility === 'public' ? `/trips/${trip.id}` : trip.visibility === 'unlisted' && knownCode ? `/s/${knownCode}` : null
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
  const km = formatKm(trip.distance_km)
  const canPlanPreview = plannedTotal >= 2
  const authors = [trip.author, ...trip.members]
  const dates = dateRange(trip.start_date, trip.end_date)

  const openPhoto = (p: Photo, list = gallery) =>
    setViewer({
      list,
      i: Math.max(
        0,
        list.findIndex((x) => x.id === p.id),
      ),
    })

  // 窄屏时地图在行程上方且不吸顶：从列表选中地点时把地图滚回视野；宽屏地图常驻可见则不滚动
  const selectAndShow = (w: Waypoint) => {
    setSelected(w)
    const el = mapBoxRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 56) // 56px = 吸顶 header (h-14)
    if (visible < r.height / 2) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const titleBlock = (
    <>
      <p className="eyebrow">
        {phaseEyebrow[trip.phase]} · {phase.label}
      </p>
      <h1 className="mt-3 text-[28px] leading-[1.22] text-balance text-ink-900 md:text-[40px] md:leading-[1.15]">{trip.title}</h1>
    </>
  )

  return (
    <article className="pb-12">
      {/* 封面：有照片时全出血，标题放在压住照片下缘的纸色题签上；没有照片时是干净的标题区 */}
      {trip.cover_url ? (
        <div>
          <div className="relative h-[44vh] min-h-[260px] overflow-hidden border-b border-ink-200 bg-ink-100 md:h-[58vh] md:max-h-[620px]">
            <img src={trip.cover_url} alt={trip.title} className="size-full object-cover" />
          </div>
          <div className="mx-auto max-w-7xl px-4 lg:px-10">
            <div className="relative -mt-14 -ml-4 max-w-3xl bg-paper pt-5 pr-5 pl-4 md:-mt-24 md:-ml-8 md:pt-8 md:pr-10 md:pl-8">{titleBlock}</div>
          </div>
        </div>
      ) : (
        <div className="mx-auto max-w-7xl px-4 pt-8 md:pt-12 lg:px-10">
          <div className="max-w-3xl">{titleBlock}</div>
        </div>
      )}

      <div className="mx-auto max-w-7xl lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-12 lg:px-10 xl:gap-x-16">
        {/* 头部信息 */}
        <header className="px-4 lg:col-start-1 lg:row-start-1 lg:px-0">
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {trip.featured && <Tag className="border-brand-300 text-brand-600">精选</Tag>}
            {trip.together && <Tag className="border-pink-300 text-pink-600">我们一起</Tag>}
            {trip.status === 'hidden' && <Tag className="border-brand-300 text-brand-600">已被管理员隐藏</Tag>}
            {trip.status === 'pending' && <Tag className="border-amber-300 text-amber-700">{tripStatuses.pending.label}</Tag>}
            {trip.can_edit && trip.visibility !== 'public' && (
              <button
                type="button"
                onClick={() => setShare(true)}
                className="inline-flex items-center gap-1 rounded-sm border border-ink-200 px-1.5 py-0.5 text-xs tracking-wide text-ink-600 transition-colors hover:border-ink-900 hover:text-ink-900"
                title="设置分享"
              >
                {trip.visibility === 'private' ? (
                  <Lock className="size-3" strokeWidth={1.75} />
                ) : (
                  <Link2 className="size-3" strokeWidth={1.75} />
                )}
                {trip.visibility === 'private' ? '私密' : '链接可见'}
              </button>
            )}
          </div>
          {trip.forked_from && (
            <p className="mt-2 text-xs tracking-wide text-ink-400">
              <GitFork className="mr-1 inline size-3 align-[-1px]" strokeWidth={1.75} />
              引用自{' '}
              <Link
                to={`/trips/${trip.forked_from.id}`}
                className="font-display text-ink-700 underline decoration-ink-300 underline-offset-2 hover:text-brand-600"
              >
                {trip.forked_from.title}
              </Link>
              （{trip.forked_from.author.nickname || trip.forked_from.author.username}）
            </p>
          )}

          {/* 作者、日期、城市 */}
          <div className="mt-5 flex items-center gap-3">
            <div className="flex -space-x-2">
              {authors.map((u) => (
                <Avatar key={u.id} user={u} size={34} ring />
              ))}
            </div>
            <div className="min-w-0 text-[13px] text-ink-700">
              <div className="flex flex-wrap items-center gap-x-1.5">
                <span className="eyebrow !text-[10px]">By</span>
                <UserName user={trip.author} />
                {trip.members.map((m) => (
                  <span key={m.id} className="flex items-center gap-1.5 text-ink-400">
                    &amp;
                    <UserName user={m} />
                  </span>
                ))}
              </div>
              {(dates || trip.cities.length > 0) && (
                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] tracking-[0.06em] text-ink-500">
                  {dates && <span className="font-num">{dates}</span>}
                  {dates && trip.cities.length > 0 && <span className="text-ink-300">·</span>}
                  {trip.cities.length > 0 && <span className="truncate">{trip.cities.join(' / ')}</span>}
                </div>
              )}
              <div className="mt-0.5 text-[11.5px] tracking-[0.04em] text-ink-400">
                {trip.published_at ? `发布于 ${fromNow(trip.published_at)}` : `更新于 ${fromNow(trip.updated_at)}`}
                {' · '}
                <span className="font-num">{fmtCount(trip.view_count)}</span> 浏览
              </div>
            </div>
          </div>

          {/* 数字 */}
          <div className="mt-7 grid grid-cols-4 divide-x divide-ink-200 border-y border-ink-200 py-5">
            <BigStat label="天数" value={trip.days || '–'} unit={trip.days ? '天' : undefined} />
            <BigStat
              label={showProgress ? '已打卡/计划' : '地点'}
              value={
                showProgress ? (
                  <>
                    {plannedVisited}
                    <span className="text-ink-300">/</span>
                    {plannedTotal}
                  </>
                ) : (
                  trip.waypoint_count
                )
              }
              sub={
                showProgress && extraVisited > 0 ? (
                  <span className="font-num text-xs text-violet-600">+{extraVisited}</span>
                ) : undefined
              }
            />
            <BigStat label="里程" value={km.split(' ')[0]} unit={km.split(' ')[1]} />
            <BigStat label="城市" value={trip.cities.length} unit="座" />
          </div>

          {trip.tags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1">
              {trip.tags.map((t) => (
                <Link
                  key={t}
                  to={`/search?tag=${encodeURIComponent(t)}`}
                  className="text-[13px] tracking-wide text-ink-500 transition-colors hover:text-brand-600"
                >
                  #{t}
                </Link>
              ))}
            </div>
          )}

          {trip.invite_pending && <InviteBanner trip={trip} queryKey={key} />}
          {trip.can_edit && trip.status === 'pending' && (
            <div className="mt-6 flex items-start gap-2.5 border-l-2 border-amber-400 bg-amber-50/70 py-2.5 pr-3 pl-3.5 text-sm text-amber-800">
              <Hourglass className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
              <span>公开申请审核中：管理员通过后才会出现在发现广场，在此之前只有你和共同作者能看到。</span>
            </div>
          )}

          {/* 操作栏 */}
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-pressed={trip.liked}
              className={cn(trip.liked && 'border-brand-300 text-brand-600 hover:border-brand-500')}
              icon={<Heart className={cn('size-4', trip.liked && 'fill-brand-500 text-brand-500')} strokeWidth={1.75} />}
              onClick={() => requireAuth(() => like.mutate())}
            >
              {trip.like_count ? <span className="font-num">{trip.like_count}</span> : '点赞'}
            </Button>
            {canFavorite && (
              <Button
                variant="outline"
                size="sm"
                aria-pressed={trip.favorited}
                icon={<Bookmark className={cn('size-4', trip.favorited && 'fill-ink-900')} strokeWidth={1.75} />}
                onClick={() => requireAuth(() => fav.mutate())}
              >
                {trip.favorited ? '已收藏' : '收藏'}
              </Button>
            )}
            {!trip.is_owner && trip.waypoints.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                icon={<GitFork className="size-4" strokeWidth={1.75} />}
                onClick={() => requireAuth(() => setForkOpen(true))}
              >
                引用路线
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              icon={<Share2 className="size-4" strokeWidth={1.75} />}
              onClick={() => setShare(true)}
            >
              分享
            </Button>
            {hasPlan && hasActual && (
              <Link to={`/trips/${trip.id}/compare`} className={buttonClass({ variant: 'outline', size: 'sm' })}>
                <GitCompareArrows className="size-4" strokeWidth={1.75} />
                计划 vs 实际
              </Link>
            )}
            <Menu
              trigger={(t, open) => (
                <Button variant="ghost" size="sm" onClick={t} aria-label="更多" aria-expanded={open}>
                  <MoreHorizontal className="size-4" strokeWidth={1.75} />
                </Button>
              )}
            >
              {(close) => (
                <>
                  {!trip.is_owner && (
                    <MenuItem icon={<Flag className="size-4" strokeWidth={1.75} />} onClick={() => (close(), requireAuth(() => setReport(true)))}>
                      举报
                    </MenuItem>
                  )}
                  {trip.is_owner && (
                    <MenuItem icon={<Trash2 className="size-4" strokeWidth={1.75} />} danger onClick={() => (close(), remove())}>
                      删除旅程
                    </MenuItem>
                  )}
                </>
              )}
            </Menu>
          </div>

          {trip.can_edit && (
            <div className="mt-6 rounded-xl border border-ink-200 bg-white/70 p-4">
              <p className="eyebrow">Your Trip · 你的旅程</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
                {trip.phase === 'planning' && '规划好路线后就可以出发，路上一键打卡、实时记录轨迹。'}
                {trip.phase === 'ongoing' && '旅行进行中：到了就打卡，还能推荐下一站。'}
                {trip.phase === 'finished' && '旅程已结束：补充评价、写写游记，留给之后的自己和别人。'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to={`/trips/${trip.id}/edit`} className={buttonClass({ size: 'sm', variant: 'primary' })}>
                  <PenLine className="size-4" strokeWidth={1.75} />
                  编辑{trip.phase === 'planning' ? '路线' : '旅程'}
                </Link>
                {trip.phase !== 'finished' && (
                  <Link to={`/trips/${trip.id}/go`} className={buttonClass({ size: 'sm', variant: 'accent' })}>
                    {trip.phase === 'ongoing' ? (
                      <Route className="size-4" strokeWidth={1.75} />
                    ) : (
                      <Play className="size-4" strokeWidth={1.75} />
                    )}
                    {trip.phase === 'ongoing' ? '继续旅行' : '出发，按路线走'}
                  </Link>
                )}
                {canPlanPreview && (
                  <Link to={`/trips/${trip.id}/replay?plan=1`} className={buttonClass({ size: 'sm', variant: 'outline' })}>
                    <Box className="size-4" strokeWidth={1.75} />
                    3D 预览
                  </Link>
                )}
              </div>
              {/* 旅行中其他人能看到什么（live_share 只有作者能改，在编辑页「信息」里） */}
              {trip.is_owner && trip.phase === 'ongoing' && trip.visibility !== 'private' && (
                <p className="mt-3 flex items-start gap-1.5 border-t border-ink-100 pt-3 text-xs leading-relaxed text-ink-500">
                  {trip.live_share ? (
                    <Radio className="mt-px size-3.5 shrink-0 text-emerald-600" strokeWidth={1.75} />
                  ) : (
                    <EyeOff className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
                  )}
                  <span>
                    {trip.live_share
                      ? '旅行中：已开启实时公开位置，能看到这段旅程的人可以实时看到你们的打卡、照片和轨迹'
                      : '旅行中：其他人只能看到计划路线，打卡、照片和轨迹在旅程结束后才公开'}
                    <Link
                      to={`/trips/${trip.id}/edit?panel=info`}
                      className="ml-1.5 text-ink-900 underline decoration-ink-300 underline-offset-2 hover:text-brand-600"
                    >
                      修改
                    </Link>
                  </span>
                </p>
              )}
            </div>
          )}
        </header>

        {/* 地图：窄屏在行程上方；宽屏在右侧吸顶 */}
        <div ref={mapBoxRef} className="mt-8 scroll-mt-14 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-3">
          <div className="lg:sticky lg:top-[4.5rem]">
            <div className="relative overflow-hidden border-y border-ink-200 lg:rounded-xl lg:border">
              <BaseMap
                className="h-[44vh] lg:h-[calc(100dvh-6.5rem)]"
                kindSwitcher
                locate
                overlay={
                  <div className="absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-4.5rem)] flex-wrap gap-2">
                    {hasActual && (
                      <Link to={`/trips/${trip.id}/replay`} className={cn(mapChip, 'bg-ink-900 text-paper hover:bg-ink-700')}>
                        <Box className="size-4" strokeWidth={1.75} />
                        3D 回放
                      </Link>
                    )}
                    {canPlanPreview && (
                      <Link
                        to={`/trips/${trip.id}/replay?plan=1`}
                        className={cn(
                          mapChip,
                          hasActual ? 'glass text-ink-800 hover:text-ink-900' : 'bg-ink-900 text-paper hover:bg-ink-700',
                        )}
                        title="沿计划路线 3D 飞行预览"
                      >
                        <Box className="size-4" strokeWidth={1.75} />
                        3D 预览
                      </Link>
                    )}
                    {sorted.length > 1 && (
                      <a
                        href={navAll}
                        target="_blank"
                        rel="noreferrer"
                        title={navHint}
                        onClick={() => navHint && toast(navHint)}
                        className={cn(mapChip, 'glass text-ink-800 hover:text-ink-900')}
                      >
                        <Navigation className="size-4" strokeWidth={1.75} />
                        {navTruncated ? `导航${remaining.length ? '接下来' : '前'} ${AMAP_MAX_STOPS} 站` : '整条路线导航'}
                      </a>
                    )}
                  </div>
                }
              >
                <RouteLines
                  planned={hasPlan && hasActual ? planned : undefined}
                  actual={hasActual ? actual : planned}
                  track={segments}
                />
                <WaypointMarkers waypoints={sorted} selectedId={selected?.id} onSelect={setSelected} />
                <FitOnce points={fitPoints} fitKey={fitKey} />
                <FlyToSelected w={selected} refit={fitKey} />
              </BaseMap>
              {((hasPlan && hasActual) || segments.length > 0) && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-200 bg-white/80 px-4 py-2 text-[11px] tracking-wide text-ink-500 lg:glass lg:absolute lg:top-3 lg:left-3 lg:rounded-full lg:border-0 lg:py-1.5 lg:shadow-card">
                  {hasPlan && hasActual && (
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block w-5 border-t-[2px] border-dashed border-sky-500" />
                      计划路线
                    </span>
                  )}
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-[3px] w-5 rounded-full bg-brand-500" />
                    {hasActual ? '实际路线' : '路线'}
                  </span>
                  {segments.length > 0 && (
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-[3px] w-5 rounded-full bg-amber-500" />
                      GPS 轨迹
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 正文 */}
        <div className="min-w-0 px-4 lg:col-start-1 lg:row-start-2 lg:px-0">
          {trip.summary && (
            <p className="font-display mt-10 border-l-2 border-brand-500 pl-4 text-[17px] leading-[1.85] text-ink-700 md:text-[19px]">
              {trip.summary}
            </p>
          )}

          <section className="mt-12">
            <SectionHead
              eyebrow="Itinerary · 行程"
              title={trip.phase === 'planning' ? '路线安排' : '行程与打卡'}
              aside={
                trip.waypoints.length > 0 && (
                  <>
                    <span className="font-num">{trip.waypoints.length}</span> 个地点
                  </>
                )
              }
            />
            <div className="mt-8">
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
                          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs tracking-wide text-ink-500 transition-colors hover:bg-ink-900/5 hover:text-ink-900"
                        >
                          <Share2 className="size-3.5" strokeWidth={1.75} />
                          分享
                        </button>
                      )
                    : undefined
                }
              />
            </div>
          </section>

          {trip.content && (
            <section className="mt-14">
              <SectionHead eyebrow="Journal · 游记" title="旅途手记" />
              <div className="prose-trip mt-4 max-w-2xl text-[15px]">
                {/* Markdown 渲染库只有写了游记的旅程才加载，且不阻塞地图和行程 */}
                <Markdown fallback={<p className="whitespace-pre-wrap">{trip.content}</p>}>{trip.content}</Markdown>
              </div>
            </section>
          )}

          {gallery.length > 0 && (
            <section className="mt-14">
              <SectionHead
                eyebrow="Photographs · 照片"
                title="沿途影像"
                aside={
                  <>
                    <span className="font-num">{gallery.length}</span> 张
                  </>
                }
              />
              <div className="mt-4 grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                {gallery.slice(0, 24).map((p, i) => {
                  const more = i === 23 && gallery.length > 24 ? gallery.length - 24 : 0
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => openPhoto(p)}
                      className="group relative aspect-square overflow-hidden rounded-md bg-ink-100 ring-1 ring-ink-900/5"
                      aria-label={more ? `还有 ${more} 张，查看全部` : p.caption || '查看照片'}
                    >
                      <img
                        src={p.thumb_url}
                        alt={p.caption}
                        loading="lazy"
                        className="size-full object-cover transition-opacity group-hover:opacity-90"
                      />
                      {more > 0 && (
                        <span className="font-num absolute inset-0 flex items-center justify-center bg-ink-900/55 text-xl text-paper">
                          +{more}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          <div className="mt-14 border-t border-ink-900 pt-5">
            <CommentSection
              tripId={trip.id}
              count={trip.comment_count}
              // 只改缓存里的计数：重新请求旅程详情会多记一次浏览，还要重拉全部打卡点和照片
              onCountChange={(d) =>
                qc.setQueryData<TripDetail>(key, (t) => (t ? { ...t, comment_count: Math.max(0, t.comment_count + d) } : t))
              }
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
      {forkOpen && <ForkDialog trip={trip} onClose={() => setForkOpen(false)} />}
      {shareWp && shareBase && (
        <ShareSheet
          open
          onClose={() => setShareWp(null)}
          heading="分享打卡点"
          title={`${shareWp.name} · ${trip.title}`}
          text={
            [shareWp.verdict && `${verdicts[shareWp.verdict].mark} ${verdicts[shareWp.verdict].label}`, shareWp.note.slice(0, 60)]
              .filter(Boolean)
              .join(' · ') || undefined
          }
          url={`${window.location.origin}${shareBase}?wp=${shareWp.id}`}
        />
      )}
      <PhotoViewer
        photos={viewer?.list ?? []}
        index={viewer?.i ?? null}
        onClose={() => setViewer(null)}
        captionOf={(p) => (p.waypoint_id ? wpById.get(p.waypoint_id)?.name : undefined)}
      />
    </article>
  )
}
