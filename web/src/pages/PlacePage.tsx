import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Flag, MapPin, Phone, Plus, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, isNotFound, type Photo, type Place, type TripCard, type Verdict } from '@/api'
import { CommentSection } from '@/components/comments/CommentSection'
import { EmptyNote, FilterLinks, LabelRow, MoreButton, Note, Reveal, SectionHead } from '@/components/editorial'
import { BaseMap } from '@/components/map/BaseMap'
import { WaypointMarkers } from '@/components/map/layers'
import { VerdictBar, recommendRate } from '@/components/place/PlaceCard'
import { ReportDialog, type ReportTarget } from '@/components/report/ReportDialog'
import { NavigateMenu } from '@/components/trip/NavigateMenu'
import { PhotoViewer } from '@/components/trip/PhotoViewer'
import { ShareSheet } from '@/components/trip/ShareDialog'
import { Avatar, Button, CategoryChip, Empty, LoadError, Modal, PageLoader, Spinner, Stars, buttonClass } from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useRequireAuth } from '@/hooks/useRequireAuth'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { fromNow } from '@/lib/format'
import { phases, verdicts } from '@/lib/meta'
import { dedupeBy } from '@/lib/pages'
import { useAuth } from '@/stores/auth'

/** 数字和紧跟的量词不拆行（「7 点」「40 分钟」），避免数字孤零零落在行尾 */
function keepNumbers(text: string): ReactNode[] {
  return text.split(/(\d[\d.,:]*\s?[^\s\d，。、！？,.!?]?)/).map((part, i) =>
    i % 2 ? (
      <span key={i} className="whitespace-nowrap">
        {part}
      </span>
    ) : (
      part
    ),
  )
}

/** 引语字号随长度变化：一句短评用区块标题的字号档，长段落回到阅读字号（不超过卡片标题太多） */
function quoteSize(text: string) {
  const n = [...text].length
  if (n <= 14 && !text.includes('\n')) return 'text-[length:var(--text-h2)] leading-[1.35]'
  if (n <= 60) return 'text-[1.1875rem] leading-[1.7] md:text-[1.3125rem]'
  return 'text-[1.0625rem] leading-[1.8] md:text-[1.125rem]'
}

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
          <p className="caption mb-4">会加到计划路线的末尾，之后可以在编辑页调整顺序和日期</p>
          <ul className="divide-y divide-ink-200 border-y border-ink-200">
            {trips.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={adding != null}
                  onClick={() => add(t)}
                  className="group flex min-h-14 w-full items-center gap-3 py-3 text-left transition-colors disabled:opacity-60"
                >
                  <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-ink-200 px-2.5 text-[11px] tracking-wider text-ink-600">
                    <span
                      aria-hidden
                      className={cn('size-[5px] rounded-full', t.phase === 'ongoing' ? 'bg-brand-500' : 'border border-ink-500')}
                    />
                    {phases[t.phase].label}
                  </span>
                  <span className="font-display min-w-0 flex-1 truncate text-[length:var(--text-card)] text-ink-900 transition-colors group-hover:text-ink-600">{t.title}</span>
                  {adding === t.id ? (
                    <Spinner className="size-4" />
                  ) : (
                    <span className="caption shrink-0">
                      <span className="font-num text-ink-800">{t.waypoint_count}</span> 个地点
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
    <div className="mx-auto max-w-[90rem] px-4 pt-10 pb-24 [font-variant-numeric:lining-nums] md:px-8 md:pt-16 md:pb-32">
      <LabelRow
        label={
          <nav aria-label="位置" className="-my-3 flex flex-wrap items-center gap-2 md:my-0">
            <Link to="/places" className="inline-flex min-h-10 items-center transition-colors hover:text-ink-500 md:min-h-0">
              Places · 打卡地
            </Link>
            {place.city && (
              <>
                <span aria-hidden className="text-ink-300">
                  /
                </span>
                <Link
                  to={`/places?city=${encodeURIComponent(place.city)}`}
                  className="inline-flex min-h-10 min-w-10 items-center transition-colors hover:text-ink-500 md:min-h-0 md:min-w-0"
                >
                  {place.city}
                </Link>
              </>
            )}
          </nav>
        }
        count={`No. ${String(place.id).padStart(3, '0')}`}
        extra={
          <button
            type="button"
            onClick={() => requireAuth(() => setReport({ type: 'place', id: place.id }))}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 text-[13px] text-ink-400 transition-colors hover:text-brand-600 md:h-8"
          >
            <Flag className="size-3.5" strokeWidth={1.25} />
            举报
          </button>
        }
      />

      {/* 地名：页面 H1（text-display-lg），一屏唯一的展示级标题 */}
      <header className="animate-slide-up mt-10 md:mt-14">
        <p className="flex items-center gap-3 text-[13px] text-ink-500">
          <CategoryChip category={place.category} className="text-[13px] text-ink-700" />
          {warn && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2 py-0.5 text-[12px] font-medium text-red-700">
              <span aria-hidden className="size-1.5 rounded-full bg-red-600" />
              慎去
            </span>
          )}
        </p>
        <h1 className="text-display-lg mt-4 font-normal text-balance [font-feature-settings:'halt'] md:mt-5">
          {place.name}
        </h1>
      </header>

      {place.cover_url && (
        <figure className="mt-10 md:mt-14">
          <div className="aspect-[3/2] overflow-hidden rounded-image bg-surface md:aspect-[21/9]">
            <img src={place.cover_url} alt={place.name} className="size-full object-cover" />
          </div>
          <figcaption className="mt-3">
            <span className="block text-[13px] text-ink-900">{place.name}</span>
            <span className="caption block">来自旅行者的打卡照片</span>
          </figcaption>
        </figure>
      )}

      <div className="mt-10 grid gap-x-8 gap-y-12 md:mt-14 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col justify-between gap-10 lg:col-span-4">
          <div>
            {/* 说明文字对：地址（亮）+ 坐标（灰） */}
            <p className="flex items-start gap-2">
              <MapPin className="mt-0.5 size-4 shrink-0 text-ink-400" strokeWidth={1.25} />
              <span>
                <span className="block text-[14px] leading-relaxed text-ink-900">{address || place.name}</span>
                <span className="caption font-num block">
                  {place.lat.toFixed(4)}°N · {place.lng.toFixed(4)}°E
                </span>
              </span>
            </p>
            {(place.rating_count > 0 || place.avg_cost > 0 || place.tel) && (
              <dl className="mt-8 divide-y divide-ink-200 border-y border-ink-200 text-[13.5px]">
                {place.rating_count > 0 && (
                  <div className="flex items-center justify-between gap-4 py-3">
                    <dt className="text-ink-500">评分</dt>
                    <dd className="flex items-center gap-2">
                      <Stars value={place.rating_avg} size={12} />
                      <span className="font-num text-[17px] text-ink-900">{place.rating_avg.toFixed(1)}</span>
                      <span className="caption">· {place.rating_count} 人</span>
                    </dd>
                  </div>
                )}
                {place.avg_cost > 0 && (
                  <div className="flex items-center justify-between gap-4 py-3">
                    <dt className="text-ink-500">人均</dt>
                    <dd className="font-num text-[17px] text-ink-900">¥{Math.round(place.avg_cost)}</dd>
                  </div>
                )}
                {place.tel && (
                  <div className="flex items-center justify-between gap-4 py-3">
                    <dt className="text-ink-500">电话</dt>
                    <dd>
                      <a
                        href={`tel:${place.tel.split(';')[0]}`}
                        className="inline-flex items-center gap-1.5 text-ink-900 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-900"
                      >
                        <Phone className="size-3.5" strokeWidth={1.25} />
                        {place.tel}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            )}

            {warn && (
              <Note tone="caution" label="Caution" className="mt-8">
                这里被 <span className="font-num">{place.avoid_count}</span> 位旅行者标记为「踩雷」，去之前看看大家的评价吧。
              </Note>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <NavigateMenu target={{ lng: place.lng, lat: place.lat, name: place.name, address: place.address }} size="md" variant="primary" label="导航过去" />
            <Button variant="outline" icon={<Plus className="size-4" strokeWidth={1.5} />} onClick={() => requireAuth(() => setAddOpen(true))}>
              加入行程
            </Button>
            <Button variant="outline" icon={<Share2 className="size-4" strokeWidth={1.5} />} onClick={() => setShareOpen(true)}>
              分享
            </Button>
          </div>
        </div>

        {/* 地图外框：无底色，一圈细线，圆角随主题；控件和版权说明的样式由地图样式表按主题给出 */}
        <figure className="relative aspect-[4/3] overflow-hidden rounded-image bg-surface ring-1 ring-line md:aspect-[16/10] lg:col-span-8">
          <BaseMap className="absolute inset-0 size-full" center={[place.lng, place.lat]} zoom={15.5} navigation={false}>
            <WaypointMarkers waypoints={marker} labels={{ [place.id]: '◎' }} />
          </BaseMap>
          <figcaption className="glass font-num pointer-events-none absolute top-3 left-3 z-10 rounded-full px-3 py-1 text-[11.5px] tracking-wider text-ink-700 ring-1 ring-line">
            {place.lat.toFixed(3)}°N {place.lng.toFixed(3)}°E
          </figcaption>
        </figure>
      </div>

      {/* 评价账目：推荐率（大数字 text-num）+ 推荐 / 一般 / 踩雷 三栏 + 比例细条 */}
      <Reveal as="section" aria-label="打卡评价统计" className="mt-20 md:mt-28">
        <LabelRow label="Verdict · 评价统计" count={`${total} 条评价 · ${place.checkin_count} 人打卡`} />
        <div className="mt-8 grid gap-x-8 gap-y-10 md:mt-10 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <div className="flex items-baseline gap-1">
              <span className="font-num text-num text-ink-900">{rate ?? '—'}</span>
              {rate != null && <span className="font-num text-[length:var(--text-h2)] text-ink-500">%</span>}
            </div>
            <p className="mt-4">
              <span className="block text-[13px] text-ink-900">推荐率</span>
              <span className="caption block">推荐占全部评价的比例</span>
            </p>
          </div>
          <div className="lg:col-span-7 lg:col-start-6">
            <dl className="grid grid-cols-3">
              {ledger.map((x, i) => (
                <div key={x.key} className={cn('min-w-0', i > 0 && 'border-l border-ink-200 pl-4 sm:pl-8')}>
                  <dt className={cn('flex items-center gap-1.5 text-[13px] font-medium tracking-wide', x.v.text)}>
                    <span className="text-[10px] leading-none">{x.v.mark}</span>
                    {x.v.label}
                  </dt>
                  <dd className="mt-3 flex items-baseline gap-1.5">
                    <span className="font-num text-[length:var(--text-h2)] leading-none text-ink-900">{x.n}</span>
                    <span className="text-xs text-ink-500">人</span>
                  </dd>
                  <dd className="caption font-num mt-2">{total ? Math.round((x.n / total) * 100) : 0}%</dd>
                </div>
              ))}
            </dl>
            {total > 0 ? <VerdictBar place={place} className="mt-8" /> : <div className="mt-8 h-px bg-ink-200" />}
            {/* 评论不计入统计：说明数字从哪来，避免以为在下面评论就算一票 */}
            <p className="caption mt-6 max-w-lg">
              推荐率与踩雷数统计自公开旅程中的打卡评价：在你的旅程里打卡这里，并选择 推荐 / 一般 / 踩雷，旅程公开后即计入。
            </p>
          </div>
        </div>
      </Reveal>

      <section className="mt-20 md:mt-28" aria-labelledby="reviews-title">
        <SectionHead
          id="reviews-title"
          eyebrow="Field Notes · 打卡手记"
          count={reviewTotal ? `${reviewTotal} 篇` : undefined}
          title="大家的打卡体验"
          extra={
            <FilterLinks<Verdict | ''>
              label="评价"
              value={verdict}
              onChange={setVerdict}
              className="-mr-3"
              options={[
                { value: '', label: '全部' },
                { value: 'recommend', label: `${verdicts.recommend.mark} 推荐` },
                { value: 'neutral', label: `${verdicts.neutral.mark} 一般` },
                { value: 'avoid', label: `${verdicts.avoid.mark} 踩雷` },
              ]}
            />
          }
        />
        <div className="mt-8 md:mt-10">
          {reviews.isLoadingError && <LoadError className="py-8" error={reviews.error} onRetry={() => reviews.refetch()} />}
          {!reviews.isLoading && !reviews.isLoadingError && items.length === 0 && (
            <EmptyNote title="还没有公开的打卡评价。" desc="在旅程中打卡这里并给出评价，旅程公开后会显示在这里。" />
          )}
          {items.length > 0 && (
            <ol className="border-b border-ink-200">
              {items.map((r) => {
                const v = r.waypoint.verdict ? verdicts[r.waypoint.verdict] : null
                const photos = r.photos.slice(0, 6)
                return (
                  <li key={r.waypoint.id} className="grid gap-x-8 gap-y-6 border-t border-ink-200 py-8 md:py-10 lg:grid-cols-12">
                    <div className={cn('min-w-0', photos.length ? 'lg:col-span-7' : 'lg:col-span-10')}>
                      {r.waypoint.note ? (
                        <blockquote>
                          {/* 引语：宋体，半角的「」（halt）贴着栏线 */}
                          <p
                            className={cn(
                              "font-display whitespace-pre-wrap text-ink-900 [font-feature-settings:'halt']",
                              quoteSize(r.waypoint.note),
                            )}
                          >
                            「{keepNumbers(r.waypoint.note)}」
                          </p>
                        </blockquote>
                      ) : (
                        <p className="caption">没有写下文字</p>
                      )}
                      {/* 一行元信息：谁 · 何时 · 来自哪段旅程 · 评价 · 评分人均 · 举报 */}
                      <div className="mt-4 flex flex-wrap items-center gap-x-3 text-[13px] text-ink-500 md:mt-5">
                        <Link to={`/u/${r.author.username}`} className="group/a inline-flex min-h-10 items-center gap-2.5 text-ink-900">
                          <Avatar user={r.author} size={26} className="!bg-ink-100 !text-ink-700" />
                          <span className="underline decoration-transparent underline-offset-4 transition-colors group-hover/a:decoration-ink-500">
                            {r.author.nickname || r.author.username}
                          </span>
                        </Link>
                        <span aria-hidden className="text-ink-300">
                          ·
                        </span>
                        <span className="font-num text-[14px]">{fromNow(r.waypoint.arrived_at ?? r.waypoint.created_at)}</span>
                        <span aria-hidden className="text-ink-300">
                          ·
                        </span>
                        <span className="inline-flex min-w-0 items-center">
                          来自
                          <Link
                            to={`/trips/${r.trip.id}`}
                            className="inline-flex min-h-10 min-w-0 items-center text-ink-700 underline decoration-ink-300 underline-offset-4 transition-colors hover:text-ink-900 hover:decoration-ink-900"
                          >
                            <span className="truncate">《{r.trip.title}》</span>
                          </Link>
                        </span>
                        {v && (
                          <span className={cn('inline-flex items-center gap-1.5 font-medium tracking-wide', v.text)}>
                            <span className="text-[10px] leading-none">{v.mark}</span>
                            {v.label}
                          </span>
                        )}
                        {r.waypoint.rating > 0 && <Stars value={r.waypoint.rating} size={11} />}
                        {r.waypoint.cost > 0 && (
                          <span>
                            人均 <span className="font-num text-[14px] text-ink-800">¥{r.waypoint.cost}</span>
                          </span>
                        )}
                        {/* 点评是那段旅程里的一个打卡点：举报这段旅程，管理员处理方式是隐藏旅程 */}
                        {r.author.id !== me?.id && (
                          <button
                            type="button"
                            className="ml-auto inline-flex min-h-10 min-w-10 items-center justify-end text-xs text-ink-400 transition-colors hover:text-brand-600"
                            onClick={() => requireAuth(() => setReport({ type: 'trip', id: r.trip.id }))}
                          >
                            举报
                          </button>
                        )}
                      </div>
                    </div>
                    {photos.length > 0 && (
                      <div className="grid grid-cols-3 gap-2 self-start lg:col-span-5 lg:gap-3">
                        {photos.map((p, i) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setViewer({ list: r.photos, i })}
                            className="group relative aspect-[4/5] overflow-hidden rounded-lg bg-surface"
                            aria-label={`查看照片 ${i + 1}`}
                          >
                            <img
                              src={p.thumb_url}
                              alt=""
                              loading="lazy"
                              className="size-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.03]"
                            />
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
          {reviews.hasNextPage && (
            <MoreButton loading={reviews.isFetchingNextPage} onClick={() => reviews.fetchNextPage()} className="pt-10">
              查看更多
            </MoreButton>
          )}
        </div>
      </section>

      <div className="mt-20 md:mt-28">
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
