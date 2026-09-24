import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { MapPin, Phone, ThumbsDown, ThumbsUp, Users } from 'lucide-react'
import { api, errorMessage, type Photo, type Verdict } from '@/api'
import { CommentSection } from '@/components/comments/CommentSection'
import { BaseMap } from '@/components/map/BaseMap'
import { WaypointMarkers } from '@/components/map/layers'
import { VerdictBar, recommendRate } from '@/components/place/PlaceCard'
import { NavigateMenu } from '@/components/trip/NavigateMenu'
import { PhotoViewer } from '@/components/trip/PhotoViewer'
import { Avatar, Button, CategoryChip, Empty, PageLoader, Segmented, Stars, UserName, VerdictBadge } from '@/components/ui'
import { fromNow } from '@/lib/format'
import { categoryOf } from '@/lib/meta'

export default function PlacePage() {
  const { id } = useParams()
  const [verdict, setVerdict] = useState<Verdict | ''>('')
  const [viewer, setViewer] = useState<{ list: Photo[]; i: number } | null>(null)
  const { data: place, isLoading, error } = useQuery({ queryKey: ['place', id], queryFn: () => api.places.get(id!) })
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

  if (isLoading) return <PageLoader />
  if (error || !place) return <Empty className="min-h-[60vh]" title="地点不存在" desc={errorMessage(error)} />

  const rate = recommendRate(place)
  const total = place.recommend_count + place.neutral_count + place.avoid_count
  const warn = place.avoid_count > place.recommend_count && place.avoid_count > 0
  const items = reviews.data?.pages.flatMap((p) => p.items) ?? []
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
          <div className="mt-4">
            <NavigateMenu target={{ lng: place.lng, lat: place.lat, name: place.name, address: place.address }} size="md" variant="primary" label="导航过去" />
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
        {!reviews.isLoading && items.length === 0 && <Empty title="暂无公开的打卡评价" className="py-8" />}
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
        <CommentSection placeId={place.id} />
      </div>
      <PhotoViewer photos={viewer?.list ?? []} index={viewer?.i ?? null} onClose={() => setViewer(null)} />
    </div>
  )
}
