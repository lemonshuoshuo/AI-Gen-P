import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Flag, MapPin, Phone, Plus, Share2, ThumbsDown, ThumbsUp, Users } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, isNotFound, type Photo, type Place, type TripCard, type Verdict } from '@/api'
import { CommentSection } from '@/components/comments/CommentSection'
import { BaseMap } from '@/components/map/BaseMap'
import { WaypointMarkers } from '@/components/map/layers'
import { VerdictBar, recommendRate } from '@/components/place/PlaceCard'
import { ReportDialog, type ReportTarget } from '@/components/report/ReportDialog'
import { NavigateMenu } from '@/components/trip/NavigateMenu'
import { PhotoViewer } from '@/components/trip/PhotoViewer'
import { ShareSheet } from '@/components/trip/ShareDialog'
import {
  Avatar,
  Button,
  CategoryChip,
  Empty,
  LoadError,
  Modal,
  PageLoader,
  Segmented,
  Spinner,
  Stars,
  UserName,
  VerdictBadge,
  buttonClass,
} from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useRequireAuth } from '@/hooks/useRequireAuth'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { fromNow } from '@/lib/format'
import { categoryOf, phases } from '@/lib/meta'
import { dedupeBy } from '@/lib/pages'
import { useAuth } from '@/stores/auth'

/** 把地点加入自己还没结束的旅程：作为计划点追加到路线末尾 */
function AddToTripModal({ place, open, onClose }: { place: Place; open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [adding, setAdding] = useState<number | null>(null)
  // 按阶段分别查询、进行中的在前：旅程很多时，较早的「规划中」旅程不会因为只取最近 50 条而漏掉
  const q = useQuery({
    queryKey: ['my-trips', 'addable'],
    queryFn: () =>
      Promise.all([api.me.trips({ phase: 'ongoing', page_size: 50 }), api.me.trips({ phase: 'planning', page_size: 50 })]).then(
        ([ongoing, planning]) => [...ongoing.items, ...planning.items],
      ),
    enabled: open,
  })
  const trips = q.data ?? []
  const add = async (t: TripCard) => {
    setAdding(t.id)
    try {
      // 必须显式 planned：否则旅行中的旅程会把它记成「此刻已到达」的计划外打卡
      await api.waypoints.create(t.id, {
        name: place.name,
        address: place.address,
        lng: place.lng,
        lat: place.lat,
        category: place.category,
        amap_id: place.amap_id || undefined,
        // 带上地点已知的行政区：服务端直接采用区县，省得再调一次高德逆地理
        province: place.province || undefined,
        city: place.city || undefined,
        district: place.district || undefined,
        planned: true,
        status: 'todo',
      })
      qc.invalidateQueries({ queryKey: ['trip', String(t.id)] })
      invalidateTripLists(qc)
      toast.success(`已加入「${t.title}」`, { action: { label: '去编辑', onClick: () => nav(`/trips/${t.id}/edit`) } })
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setAdding(null)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={`把「${place.name}」加入行程`}>
      {q.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : q.isLoadingError ? (
        <LoadError className="py-8" error={q.error} onRetry={() => q.refetch()} />
      ) : trips.length === 0 ? (
        <Empty
          className="py-8"
          title="还没有规划中的行程"
          desc="新建一段旅程，再把这里加进路线"
          action={
            <Link to="/trips/new" className={buttonClass()}>
              新建旅程
            </Link>
          }
        />
      ) : (
        <div className="space-y-1">
          <p className="mb-2 text-xs text-ink-400">会加到计划路线的末尾，之后可以在编辑页调整顺序和日期</p>
          {trips.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={adding != null}
              onClick={() => add(t)}
              className="flex w-full items-center gap-2.5 rounded-xl p-2.5 text-left transition hover:bg-ink-50 disabled:opacity-60"
            >
              <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', phases[t.phase].cls)}>
                {phases[t.phase].label}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.title}</span>
              {adding === t.id ? (
                <Spinner className="size-4" />
              ) : (
                <span className="shrink-0 text-xs text-ink-400">{t.waypoint_count} 个地点</span>
              )}
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}

export default function PlacePage() {
  const { id } = useParams()
  const qc = useQueryClient()
  const requireAuth = useRequireAuth()
  const me = useAuth((s) => s.user)
  const [verdict, setVerdict] = useState<Verdict | ''>('')
  const [viewer, setViewer] = useState<{ list: Photo[]; i: number } | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [report, setReport] = useState<ReportTarget | null>(null)
  const { data: place, isLoading, error, refetch } = useQuery({ queryKey: ['place', id], queryFn: () => api.places.get(id!) })
  const reviews = useInfiniteQuery({
    queryKey: ['place-reviews', id, verdict],
    queryFn: ({ pageParam }) => api.places.reviews(Number(id), { verdict, page: pageParam, page_size: 10 }),
    initialPageParam: 1,
    getNextPageParam: (l) => (l.page * l.page_size < l.total ? l.page + 1 : undefined),
    enabled: !!place,
  })
  const marker = useMemo(
    () =>
      place
        ? [
            {
              id: place.id,
              lng: place.lng,
              lat: place.lat,
              category: place.category,
              planned: false,
              status: 'visited',
              verdict: place.avoid_count > place.recommend_count ? 'avoid' : '',
            } as never,
          ]
        : [],
    [place],
  )
  useDocumentTitle(place && [place.name, place.city].filter(Boolean).join(' · '))

  if (isLoading) return <PageLoader />
  // 后台刷新失败时保留已加载的内容；404 说明地点已不可见
  if (!place || isNotFound(error))
    return <LoadError className="min-h-[60vh]" error={error} notFoundTitle="地点不存在" onRetry={() => refetch()} />

  const rate = recommendRate(place)
  const total = place.recommend_count + place.neutral_count + place.avoid_count
  const warn = place.avoid_count > place.recommend_count && place.avoid_count > 0
  // 点评没有自己的 id，按打卡点去重
  const items = dedupeBy(reviews.data?.pages.flatMap((p) => p.items) ?? [], (r) => r.waypoint.id)
  const Icon = categoryOf(place.category).icon

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="overflow-hidden rounded-3xl bg-white shadow-card">
        <BaseMap className="h-52" center={[place.lng, place.lat]} zoom={15.5} navigation={false}>
          <WaypointMarkers waypoints={marker} labels={{ [place.id]: '★' }} />
        </BaseMap>
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div
              className="flex size-12 shrink-0 items-center justify-center rounded-2xl"
              style={{ background: categoryOf(place.category).color + '18', color: categoryOf(place.category).color }}
            >
              <Icon className="size-6" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-extrabold">{place.name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-500">
                <CategoryChip category={place.category} />
                {place.rating_count > 0 && (
                  <span className="flex items-center gap-1">
                    <Stars value={place.rating_avg} /> {place.rating_avg.toFixed(1)}
                  </span>
                )}
                {place.avg_cost > 0 && <span>人均 ¥{Math.round(place.avg_cost)}</span>}
              </div>
              <p className="mt-1.5 flex items-start gap-1 text-sm text-ink-500">
                <MapPin className="mt-0.5 size-4 shrink-0" />
                {[place.province, place.city, place.district, place.address].filter(Boolean).join(' ')}
              </p>
              {place.tel && (
                <a href={`tel:${place.tel.split(';')[0]}`} className="mt-1 flex items-center gap-1 text-sm text-brand-600">
                  <Phone className="size-4" />
                  {place.tel}
                </a>
              )}
            </div>
          </div>

          {warn && (
            <div className="mt-4 rounded-2xl bg-red-50 p-3 text-sm text-red-800">
              ⚠️ 这里被 {place.avoid_count} 位旅行者标记为「踩雷」，去之前看看大家的评价吧。
            </div>
          )}

          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-2xl bg-ink-50 p-3">
              <Users className="mx-auto size-4 text-ink-400" />
              <div className="mt-1 text-lg font-bold">{place.checkin_count}</div>
              <div className="text-xs text-ink-400">人打卡</div>
            </div>
            <div className="rounded-2xl bg-emerald-50 p-3">
              <ThumbsUp className="mx-auto size-4 text-emerald-500" />
              <div className="mt-1 text-lg font-bold text-emerald-700">{rate != null ? `${rate}%` : '-'}</div>
              <div className="text-xs text-emerald-600">推荐率</div>
            </div>
            <div className="rounded-2xl bg-red-50 p-3">
              <ThumbsDown className="mx-auto size-4 text-red-500" />
              <div className="mt-1 text-lg font-bold text-red-700">{place.avoid_count}</div>
              <div className="text-xs text-red-600">人踩雷</div>
            </div>
          </div>
          {total > 0 && (
            <div className="mt-3">
              <VerdictBar place={place} className="h-2" />
              <div className="mt-1.5 flex justify-between text-xs text-ink-400">
                <span>👍 推荐 {place.recommend_count}</span>
                <span>😐 一般 {place.neutral_count}</span>
                <span>⚠️ 踩雷 {place.avoid_count}</span>
              </div>
            </div>
          )}
          {/* 评论不计入统计：说明数字从哪来，避免以为在下面评论就算一票 */}
          <p className="mt-2 text-xs text-ink-400">
            推荐率与踩雷数统计自公开旅程中的打卡评价：在你的旅程里打卡这里并选择 推荐 / 一般 / 踩雷，旅程公开后即计入
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <NavigateMenu target={{ lng: place.lng, lat: place.lat, name: place.name, address: place.address }} size="md" variant="primary" label="导航过去" />
            <Button variant="outline" icon={<Plus className="size-4" />} onClick={() => requireAuth(() => setAddOpen(true))}>
              加入行程
            </Button>
            <Button variant="outline" icon={<Share2 className="size-4" />} onClick={() => setShareOpen(true)}>
              分享
            </Button>
            <Button
              variant="ghost"
              icon={<Flag className="size-4" />}
              onClick={() => requireAuth(() => setReport({ type: 'place', id: place.id }))}
            >
              举报
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">大家的打卡体验</h2>
        <Segmented<Verdict | ''>
          size="sm"
          value={verdict}
          onChange={setVerdict}
          options={[
            { value: '', label: '全部' },
            { value: 'recommend', label: '👍 推荐' },
            { value: 'neutral', label: '😐 一般' },
            { value: 'avoid', label: '⚠️ 踩雷' },
          ]}
        />
      </div>
      <div className="mt-4 space-y-3">
        {reviews.isLoadingError && <LoadError className="py-8" error={reviews.error} onRetry={() => reviews.refetch()} />}
        {!reviews.isLoading && !reviews.isLoadingError && items.length === 0 && (
          <Empty title="暂无公开的打卡评价" desc="在旅程中打卡这里并给出评价，旅程公开后会显示在这里" className="py-8" />
        )}
        {items.map((r) => (
          <div key={r.waypoint.id} className="rounded-2xl bg-white p-4 shadow-card">
            <div className="flex items-center gap-2.5">
              <Avatar user={r.author} size={34} />
              <div className="min-w-0 flex-1">
                <UserName user={r.author} />
                <div className="text-xs text-ink-400">
                  {fromNow(r.waypoint.arrived_at ?? r.waypoint.created_at)} · 来自
                  <Link to={`/trips/${r.trip.id}`} className="ml-0.5 text-brand-600">
                    《{r.trip.title}》
                  </Link>
                </div>
              </div>
              <VerdictBadge verdict={r.waypoint.verdict} />
              {/* 点评是那段旅程里的一个打卡点：举报这段旅程，管理员处理方式是隐藏旅程 */}
              {r.author.id !== me?.id && (
                <button
                  type="button"
                  className="shrink-0 text-xs text-ink-400 hover:text-red-600"
                  onClick={() => requireAuth(() => setReport({ type: 'trip', id: r.trip.id }))}
                >
                  举报
                </button>
              )}
            </div>
            <div className="mt-2 flex items-center gap-3 text-xs text-ink-500">
              {r.waypoint.rating > 0 && <Stars value={r.waypoint.rating} size={12} />}
              {r.waypoint.cost > 0 && <span>¥{r.waypoint.cost}/人</span>}
            </div>
            {r.waypoint.note && <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-ink-700">{r.waypoint.note}</p>}
            {r.photos.length > 0 && (
              <div className="mt-2 grid grid-cols-4 gap-1.5">
                {r.photos.slice(0, 8).map((p, i) => (
                  <button key={p.id} type="button" onClick={() => setViewer({ list: r.photos, i })} className="aspect-square overflow-hidden rounded-lg bg-ink-100">
                    <img src={p.thumb_url} alt="" loading="lazy" className="size-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {reviews.hasNextPage && (
          <div className="flex justify-center">
            <Button variant="outline" loading={reviews.isFetchingNextPage} onClick={() => reviews.fetchNextPage()}>
              查看更多
            </Button>
          </div>
        )}
      </div>

      <div className="mt-10">
        <CommentSection
          placeId={place.id}
          count={place.comment_count}
          onCountChange={(d) => qc.setQueryData<Place>(['place', id], (p) => (p ? { ...p, comment_count: Math.max(0, p.comment_count + d) } : p))}
        />
      </div>
      <PhotoViewer photos={viewer?.list ?? []} index={viewer?.i ?? null} onClose={() => setViewer(null)} />
      <AddToTripModal place={place} open={addOpen} onClose={() => setAddOpen(false)} />
      <ShareSheet
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        heading="分享地点"
        title={place.name}
        text={warn ? `⚠️ ${place.avoid_count} 人踩雷` : `${rate != null ? `推荐率 ${rate}% · ` : ''}${place.checkin_count} 人打卡`}
        url={`${window.location.origin}/places/${place.id}`}
      />
      <ReportDialog target={report} onClose={() => setReport(null)} />
    </div>
  )
}
