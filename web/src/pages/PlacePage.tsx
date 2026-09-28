import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Flag, MapPin, Phone, Plus, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, isNotFound, type Photo, type Place, type TripCard, type Verdict } from '@/api'
import { CommentSection } from '@/components/comments/CommentSection'
import { FilterLinks, MoreButton, Note, SectionHead } from '@/components/editorial'
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
import { phases, verdicts } from '@/lib/meta'
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
        <div>
          <p className="mb-2 text-xs leading-relaxed text-ink-400">会加到计划路线的末尾，之后可以在编辑页调整顺序和日期</p>
          <ul className="divide-y divide-ink-200 border-y border-ink-200">
            {trips.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={adding != null}
                  onClick={() => add(t)}
                  className="group flex w-full items-center gap-3 py-3 text-left transition-colors disabled:opacity-60"
                >
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-[3px] border border-ink-200 px-1.5 py-0.5 text-[11px] tracking-wider text-ink-600">
                    <span
                      aria-hidden
                      className={cn('size-[5px] rounded-full', t.phase === 'ongoing' ? 'bg-emerald-500' : 'border border-sky-600')}
                    />
                    {phases[t.phase].label}
                  </span>
                  <span className="font-display min-w-0 flex-1 truncate text-[15px] text-ink-900 group-hover:text-brand-700">{t.title}</span>
                  {adding === t.id ? (
                    <Spinner className="size-4" />
                  ) : (
                    <span className="shrink-0 text-xs text-ink-400">
                      <span className="font-num text-ink-700">{t.waypoint_count}</span> 个地点
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
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
  const reviewTotal = reviews.data?.pages[0]?.total
  const address = [place.province, place.city, place.district, place.address].filter(Boolean).join(' ')
  const ledger = (['recommend', 'neutral', 'avoid'] as const).map((k) => ({
    key: k,
    v: verdicts[k],
    n: place[`${k}_count`],
  }))

  return (
    <div className="mx-auto max-w-5xl px-4 pt-6 pb-16 md:px-6 md:pt-10">
      <nav aria-label="位置" className="eyebrow flex flex-wrap items-center gap-2">
        <Link to="/places" className="transition-colors hover:text-ink-900">
          Places · 打卡地
        </Link>
        {place.city && (
          <>
            <span aria-hidden className="text-ink-300">
              /
            </span>
            <Link to={`/places?city=${encodeURIComponent(place.city)}`} className="transition-colors hover:text-ink-900">
              {place.city}
            </Link>
          </>
        )}
      </nav>

      <div className="mt-5 grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,400px)] md:gap-12">
        <div className="min-w-0">
          <CategoryChip category={place.category} className="text-[13px]" />
          <h1 className="mt-3 text-[32px] leading-[1.2] text-balance md:text-[44px]">{place.name}</h1>
          {address && (
            <p className="mt-4 flex items-start gap-1.5 text-sm leading-relaxed text-ink-500">
              <MapPin className="mt-0.5 size-4 shrink-0 text-ink-400" strokeWidth={1.5} />
              {address}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-ink-500">
            {place.rating_count > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <Stars value={place.rating_avg} />
                <span className="font-num text-ink-900">{place.rating_avg.toFixed(1)}</span>
                <span className="text-xs text-ink-400">· {place.rating_count} 人评分</span>
              </span>
            )}
            {place.avg_cost > 0 && (
              <span>
                人均 <span className="font-num text-ink-900">¥{Math.round(place.avg_cost)}</span>
              </span>
            )}
            {place.tel && (
              <a
                href={`tel:${place.tel.split(';')[0]}`}
                className="inline-flex items-center gap-1 text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-900"
              >
                <Phone className="size-3.5" strokeWidth={1.5} />
                {place.tel}
              </a>
            )}
          </div>

          {warn && (
            <Note tone="caution" label="Caution" className="mt-5">
              这里被 <span className="font-num">{place.avoid_count}</span> 位旅行者标记为「踩雷」，去之前看看大家的评价吧。
            </Note>
          )}

          <div className="mt-7 flex flex-wrap gap-2">
            <NavigateMenu target={{ lng: place.lng, lat: place.lat, name: place.name, address: place.address }} size="md" variant="primary" label="导航过去" />
            <Button variant="outline" icon={<Plus className="size-4" strokeWidth={1.75} />} onClick={() => requireAuth(() => setAddOpen(true))}>
              加入行程
            </Button>
            <Button variant="outline" icon={<Share2 className="size-4" strokeWidth={1.75} />} onClick={() => setShareOpen(true)}>
              分享
            </Button>
            <Button
              variant="ghost"
              aria-label="举报"
              title="举报"
              className="px-2.5 sm:px-4"
              icon={<Flag className="size-4" strokeWidth={1.75} />}
              onClick={() => requireAuth(() => setReport({ type: 'place', id: place.id }))}
            >
              <span className="hidden sm:inline">举报</span>
            </Button>
          </div>
        </div>

        <figure className="relative h-56 overflow-hidden rounded-[9px] bg-ink-100 md:h-auto md:min-h-72">
          <BaseMap className="absolute inset-0 size-full" center={[place.lng, place.lat]} zoom={15.5} navigation={false}>
            <WaypointMarkers waypoints={marker} labels={{ [place.id]: '◎' }} />
          </BaseMap>
          <figcaption className="font-num pointer-events-none absolute top-2.5 left-2.5 z-10 rounded-[3px] bg-white/90 px-1.5 py-0.5 text-[11px] tracking-wider text-ink-600 italic ring-1 ring-ink-900/10">
            {place.lat.toFixed(3)}°N {place.lng.toFixed(3)}°E
          </figcaption>
          <span aria-hidden className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] ring-1 ring-ink-900/10 ring-inset" />
        </figure>
      </div>

      {/* 评价账目：推荐率大数字 + 推荐 / 一般 / 踩雷 三栏 + 比例细条 */}
      <section aria-label="打卡评价统计" className="mt-12 border-t-2 border-ink-900 pt-6 md:mt-16">
        <div className="grid gap-8 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)] md:gap-14">
          <div>
            <p className="eyebrow">Recommended · 推荐率</p>
            <div className="mt-3 flex items-baseline gap-1">
              <span className="font-num text-[64px] leading-[0.9] text-ink-900 md:text-[80px]">{rate ?? '—'}</span>
              {rate != null && <span className="font-num text-2xl text-ink-400">%</span>}
            </div>
            <p className="mt-3 text-xs text-ink-400">
              <span className="font-num text-ink-700">{place.checkin_count}</span> 人打卡 ·{' '}
              <span className="font-num text-ink-700">{total}</span> 条评价
            </p>
          </div>
          <div className="md:pt-7">
            <dl className="grid grid-cols-3">
              {ledger.map((x, i) => (
                <div key={x.key} className={cn('min-w-0', i > 0 && 'border-l border-ink-200 pl-4 sm:pl-6')}>
                  <dt className="flex items-center gap-1.5 text-[13px] tracking-wide" style={{ color: x.v.color }}>
                    <span className="text-[11px] leading-none">{x.v.mark}</span>
                    {x.v.label}
                  </dt>
                  <dd className="mt-2 flex items-baseline gap-1">
                    <span className="font-num text-[36px] leading-none text-ink-900 md:text-[44px]">{x.n}</span>
                    <span className="text-xs text-ink-400">人</span>
                  </dd>
                  <dd className="font-num mt-1.5 text-xs text-ink-400">{total ? Math.round((x.n / total) * 100) : 0}%</dd>
                </div>
              ))}
            </dl>
            {total > 0 ? <VerdictBar place={place} className="mt-5 h-1" /> : <div className="mt-5 h-1 bg-ink-100" />}
          </div>
        </div>
        {/* 评论不计入统计：说明数字从哪来，避免以为在下面评论就算一票 */}
        <p className="mt-6 border-t border-ink-200 pt-3 text-xs leading-relaxed text-ink-400">
          推荐率与踩雷数统计自公开旅程中的打卡评价：在你的旅程里打卡这里，并选择 推荐 / 一般 / 踩雷，旅程公开后即计入。
        </p>
      </section>

      <section className="mt-14 md:mt-20" aria-labelledby="reviews-title">
        <SectionHead
          id="reviews-title"
          eyebrow="Field Notes · 打卡手记"
          title={
            <>
              大家的打卡体验
              {!!reviewTotal && <span className="font-num ml-2 text-base text-ink-400">{reviewTotal}</span>}
            </>
          }
          extra={
            <FilterLinks<Verdict | ''>
              label="评价"
              value={verdict}
              onChange={setVerdict}
              options={[
                { value: '', label: '全部' },
                { value: 'recommend', label: `${verdicts.recommend.mark} 推荐` },
                { value: 'neutral', label: `${verdicts.neutral.mark} 一般` },
                { value: 'avoid', label: `${verdicts.avoid.mark} 踩雷` },
              ]}
            />
          }
        />
        {reviews.isLoadingError && <LoadError className="py-8" error={reviews.error} onRetry={() => reviews.refetch()} />}
        {!reviews.isLoading && !reviews.isLoadingError && items.length === 0 && (
          <Empty title="暂无公开的打卡评价" desc="在旅程中打卡这里并给出评价，旅程公开后会显示在这里" className="py-10" />
        )}
        <ol className="divide-y divide-ink-200">
          {items.map((r) => (
            <li key={r.waypoint.id} className="py-6">
              <div className="flex items-center gap-3">
                <Avatar user={r.author} size={34} />
                <div className="min-w-0 flex-1">
                  <UserName user={r.author} className="text-sm" />
                  <div className="mt-0.5 truncate text-xs text-ink-400">
                    <span className="font-num">{fromNow(r.waypoint.arrived_at ?? r.waypoint.created_at)}</span> · 来自
                    <Link
                      to={`/trips/${r.trip.id}`}
                      className="ml-0.5 text-ink-700 underline decoration-ink-300 underline-offset-2 transition-colors hover:decoration-ink-900"
                    >
                      《{r.trip.title}》
                    </Link>
                  </div>
                </div>
                <VerdictBadge verdict={r.waypoint.verdict} className="shrink-0" />
                {/* 点评是那段旅程里的一个打卡点：举报这段旅程，管理员处理方式是隐藏旅程 */}
                {r.author.id !== me?.id && (
                  <button
                    type="button"
                    className="shrink-0 text-xs text-ink-400 transition-colors hover:text-brand-600"
                    onClick={() => requireAuth(() => setReport({ type: 'trip', id: r.trip.id }))}
                  >
                    举报
                  </button>
                )}
              </div>
              <div className="sm:pl-[46px]">
                {(r.waypoint.rating > 0 || r.waypoint.cost > 0) && (
                  <div className="mt-3 flex items-center gap-3 text-xs text-ink-500">
                    {r.waypoint.rating > 0 && <Stars value={r.waypoint.rating} size={12} />}
                    {r.waypoint.cost > 0 && (
                      <span>
                        人均 <span className="font-num text-ink-800">¥{r.waypoint.cost}</span>
                      </span>
                    )}
                  </div>
                )}
                {r.waypoint.note && (
                  <p className="mt-3 text-[15px] leading-[1.85] whitespace-pre-wrap text-ink-700">{r.waypoint.note}</p>
                )}
                {r.photos.length > 0 && (
                  <div className="mt-3.5 grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                    {r.photos.slice(0, 8).map((p, i) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setViewer({ list: r.photos, i })}
                        className="relative aspect-square overflow-hidden rounded-[5px] bg-ink-100"
                        aria-label={`查看照片 ${i + 1}`}
                      >
                        <img src={p.thumb_url} alt="" loading="lazy" className="size-full object-cover" />
                        <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-ink-900/10 ring-inset" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        {reviews.hasNextPage && <MoreButton loading={reviews.isFetchingNextPage} onClick={() => reviews.fetchNextPage()} className="pt-4">查看更多</MoreButton>}
      </section>

      <div className="mt-16 md:mt-20">
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
        text={warn ? `${place.avoid_count} 人标记踩雷` : `${rate != null ? `推荐率 ${rate}% · ` : ''}${place.checkin_count} 人打卡`}
        url={`${window.location.origin}/places/${place.id}`}
      />
      <ReportDialog target={report} onClose={() => setReport(null)} />
    </div>
  )
}
