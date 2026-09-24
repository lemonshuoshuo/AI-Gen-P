import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Markdown from 'react-markdown'
import {
  Bookmark,
  Box,
  CalendarDays,
  Flag,
  GitCompareArrows,
  GitFork,
  Heart,
  Map as MapIcon,
  MoreHorizontal,
  Navigation,
  PenLine,
  Play,
  Route,
  Share2,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Photo, type TripDetail, type Waypoint } from '@/api'
import { CommentSection } from '@/components/comments/CommentSection'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { FitOnce, RouteLines, WaypointMarkers } from '@/components/map/layers'
import { PhotoViewer } from '@/components/trip/PhotoViewer'
import { ShareDialog } from '@/components/trip/ShareDialog'
import { TripCover } from '@/components/trip/TripCard'
import { WaypointItem } from '@/components/trip/WaypointItem'
import { Avatar, Button, Empty, Menu, MenuItem, Modal, PageLoader, Stat, Tag, Textarea, UserName, confirmDialog } from '@/components/ui'
import { useRequireAuth } from '@/hooks/useRequireAuth'
import { cn } from '@/lib/cn'
import { dateRange, fmtCount, fromNow } from '@/lib/format'
import { formatKm } from '@/lib/geo'
import { phases } from '@/lib/meta'
import { amapMultiRoute } from '@/lib/nav'
import { actualPath, allPoints, bySeq, groupByDay, photosByWaypoint, plannedPath, trackSegments } from '@/lib/trip'

function FlyToSelected({ w }: { w: Waypoint | null }) {
  const map = useMap()
  useEffect(() => {
    if (map && w) map.flyTo({ center: [w.lng, w.lat], zoom: Math.max(map.getZoom(), 15), duration: 900 })
  }, [map, w])
  return null
}

function ReportDialog({ tripId, open, onClose }: { tripId: number; open: boolean; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const m = useMutation({
    mutationFn: () => api.reports.create({ target_type: 'trip', target_id: tripId, reason }),
    onSuccess: () => {
      toast.success('已提交，管理员会尽快处理')
      onClose()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="举报"
      footer={
        <Button disabled={!reason.trim()} loading={m.isPending} onClick={() => m.mutate()}>
          提交
        </Button>
      }
    >
      <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="请描述问题（广告、虚假信息、违规内容等）" />
    </Modal>
  )
}

function Itinerary({
  trip,
  selected,
  onSelect,
  onPhoto,
  onComment,
}: {
  trip: TripDetail
  selected: Waypoint | null
  onSelect: (w: Waypoint) => void
  onPhoto: (p: Photo) => void
  onComment: (w: Waypoint) => void
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
                showStatus={hasPlan && trip.phase !== 'planning'}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function TripDetailPage() {
  const { id, code } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const requireAuth = useRequireAuth()
  const key = ['trip', id ?? `s:${code}`]
  const { data: trip, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => (code ? api.trips.byShare(code) : api.trips.get(id!)),
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
  const [forking, setForking] = useState(false)

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
      toast.success(r.favorited ? '已收藏' : '已取消收藏')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const segments = useMemo(() => trackSegments(track), [track])
  const planned = useMemo(() => (trip ? plannedPath(trip.waypoints) : []), [trip])
  const actual = useMemo(() => (trip ? actualPath(trip.waypoints) : []), [trip])
  const sorted = useMemo(() => (trip ? [...trip.waypoints].sort(bySeq) : []), [trip])
  const fitPoints = useMemo(() => (trip ? allPoints(trip.waypoints, segments) : []), [trip, segments])

  if (isLoading) return <PageLoader />
  if (error || !trip)
    return (
      <Empty
        className="min-h-[60vh]"
        title="旅程不存在或无权查看"
        desc={errorMessage(error)}
        action={<Button onClick={() => nav('/')}>回到首页</Button>}
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
      nav('/me/trips')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const phase = phases[trip.phase]
  const hasPlan = trip.waypoints.some((w) => w.planned)
  const hasActual = trip.waypoints.some((w) => w.status === 'visited')
  const remaining = sorted.filter((w) => w.status === 'todo')
  const navAll = amapMultiRoute((remaining.length ? remaining : sorted).map((w) => ({ lng: w.lng, lat: w.lat, name: w.name })))
  const gallery = trip.photos
  const wpById = new Map(trip.waypoints.map((w) => [w.id, w]))

  const openPhoto = (p: Photo, list = gallery) => setViewer({ list, i: Math.max(0, list.findIndex((x) => x.id === p.id)) })

  return (
    <div className="mx-auto max-w-7xl lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-0">
      {/* 地图（移动端在上方） */}
      <div className="order-2 lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)]">
        <BaseMap
          className="h-[46vh] lg:h-full"
          kindSwitcher
          locate
          overlay={
            <div className="absolute bottom-3 left-3 z-10 flex flex-wrap gap-2">
              <Link to={`/trips/${trip.id}/replay`}>
                <Button size="sm" variant="dark" icon={<Box className="size-4" />}>
                  3D 回放
                </Button>
              </Link>
              {sorted.length > 1 && (
                <a href={navAll} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="outline" icon={<Navigation className="size-4" />}>
                    整条路线导航
                  </Button>
                </a>
              )}
            </div>
          }
        >
          <RouteLines planned={hasPlan && hasActual ? planned : undefined} actual={hasActual ? actual : planned} track={segments} />
          <WaypointMarkers waypoints={sorted} selectedId={selected?.id} onSelect={setSelected} />
          <FitOnce points={fitPoints} fitKey={`${trip.id}-${fitPoints.length}`} />
          <FlyToSelected w={selected} />
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
            <TripCover trip={trip} />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', phase.cls)}>{phase.label}</span>
          {trip.featured && <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">⭐ 精选</span>}
          {trip.together && <span className="bg-love-gradient rounded-full px-2.5 py-0.5 text-xs font-semibold text-white">💕 我们一起</span>}
          {trip.status === 'hidden' && <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-xs text-red-600">已被管理员隐藏</span>}
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
          <Stat label={hasPlan && trip.phase !== 'planning' ? '已打卡/计划' : '打卡点'} value={hasPlan && trip.phase !== 'planning' ? `${trip.visited_count}/${trip.planned_count}` : trip.waypoint_count} />
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
          <Button
            variant="outline"
            size="sm"
            icon={<Bookmark className={cn('size-4', trip.favorited && 'fill-amber-400 text-amber-400')} />}
            onClick={() => requireAuth(() => fav.mutate())}
          >
            {trip.favorited ? '已收藏' : '收藏'}
          </Button>
          {!trip.is_owner && trip.waypoints.length > 0 && (
            <Button variant="outline" size="sm" icon={<GitFork className="size-4" />} loading={forking} onClick={() => requireAuth(fork)}>
              引用路线
            </Button>
          )}
          <Button variant="outline" size="sm" icon={<Share2 className="size-4" />} onClick={() => setShare(true)}>
            分享
          </Button>
          {hasPlan && hasActual && (
            <Link to={`/trips/${trip.id}/compare`}>
              <Button variant="outline" size="sm" icon={<GitCompareArrows className="size-4" />}>
                计划 vs 实际
              </Button>
            </Link>
          )}
          <Menu
            trigger={(t) => (
              <Button variant="ghost" size="sm" onClick={t} aria-label="更多">
                <MoreHorizontal className="size-4" />
              </Button>
            )}
          >
            {(close) => (
              <>
                <MenuItem icon={<Flag className="size-4" />} onClick={() => (close(), requireAuth(() => setReport(true)))}>
                  举报
                </MenuItem>
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
            <Link to={`/trips/${trip.id}/edit`}>
              <Button size="sm" variant="dark" icon={<PenLine className="size-4" />}>
                编辑{trip.phase === 'planning' ? '路线' : '旅程'}
              </Button>
            </Link>
            {trip.phase !== 'finished' && (
              <Link to={`/trips/${trip.id}/go`}>
                <Button size="sm" icon={trip.phase === 'ongoing' ? <Route className="size-4" /> : <Play className="size-4" />}>
                  {trip.phase === 'ongoing' ? '继续旅行' : '出发！按路线走'}
                </Button>
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
          onSelect={setSelected}
          onPhoto={(p) => openPhoto(p)}
          onComment={(w) => {
            setCommentWp(w.id)
            document.getElementById('comments')?.scrollIntoView({ behavior: 'smooth' })
          }}
        />

        {trip.content && (
          <>
            <h2 className="mt-10 mb-3 text-lg font-bold">游记</h2>
            <div className="prose-trip text-[15px] text-ink-700">
              <Markdown>{trip.content}</Markdown>
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
            waypoints={trip.waypoints}
            waypointId={commentWp}
            onClearWaypoint={() => setCommentWp(null)}
            onJumpWaypoint={(wid) => {
              const w = wpById.get(wid)
              if (w) {
                setSelected(w)
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }
            }}
          />
        </div>
      </div>

      <ShareDialog trip={trip} open={share} onClose={() => setShare(false)} />
      <ReportDialog tripId={trip.id} open={report} onClose={() => setReport(false)} />
      <PhotoViewer
        photos={viewer?.list ?? []}
        index={viewer?.i ?? null}
        onClose={() => setViewer(null)}
        captionOf={(p) => (p.waypoint_id ? wpById.get(p.waypoint_id)?.name : undefined)}
      />
    </div>
  )
}
