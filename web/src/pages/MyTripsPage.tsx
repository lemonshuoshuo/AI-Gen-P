import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Heart, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Phase, type TripCard, type UserBrief, type Visibility } from '@/api'
import { EmptyNote, FilterLinks, LabelRow, MoreButton, PageHead, TextLink, cityShort } from '@/components/editorial'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { Avatar, Button, LoadError } from '@/components/ui'
import { fromNow } from '@/lib/format'
import { phases, visibilities } from '@/lib/meta'
import { flattenPages } from '@/lib/pages'

type TripInvite = { trip: TripCard; from: UserBrief; created_at: string }

/** 邀请行里的小封面：有照片用照片，没有时是近黑底上的宋体城市名 */
function MiniCover({ trip }: { trip: TripCard }) {
  return (
    <div className="relative aspect-[4/5] w-14 shrink-0 overflow-hidden bg-surface text-ink-900 sm:w-16">
      {trip.cover_url ? (
        <img src={trip.cover_thumb_url || trip.cover_url} alt="" loading="lazy" className="size-full object-cover" />
      ) : (
        <span className="font-display absolute bottom-2 left-2 text-[1.35rem] leading-none">{cityShort(trip.cities?.[0] ?? '').slice(0, 2) || '旅'}</span>
      )}
    </div>
  )
}

function InviteRow({ inv }: { inv: TripInvite }) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: (accept: boolean) => (accept ? api.trips.acceptInvite(inv.trip.id) : api.trips.declineInvite(inv.trip.id)),
    onSuccess: (_, accept) => {
      toast.success(accept ? '已加入旅程，一起规划吧' : '已拒绝邀请')
      qc.invalidateQueries({ queryKey: ['me', 'invites'] })
      qc.invalidateQueries({ queryKey: ['notifications'] })
      if (accept) qc.invalidateQueries({ queryKey: ['my-trips'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const from = inv.from.nickname || inv.from.username
  return (
    <li className="flex items-center gap-4 py-5 sm:gap-6">
      <MiniCover trip={inv.trip} />
      <div className="min-w-0 flex-1">
        <Link to={`/trips/${inv.trip.id}`} className="font-display line-clamp-1 text-[1.3rem] text-ink-900 transition-colors hover:text-ink-600 md:text-[1.5rem]">
          {inv.trip.title}
        </Link>
        <div className="caption mt-1.5 flex items-center gap-2">
          <Avatar user={inv.from} size={18} />
          <span className="truncate">
            <span className="text-ink-900">{from}</span> 邀请你一起编辑 · {fromNow(inv.created_at)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
        <Button loading={m.isPending && m.variables} disabled={m.isPending} onClick={() => m.mutate(true)}>
          接受
        </Button>
        <Button variant="ghost" loading={m.isPending && !m.variables} disabled={m.isPending} onClick={() => m.mutate(false)}>
          拒绝
        </Button>
      </div>
    </li>
  )
}

export default function MyTripsPage() {
  const nav = useNavigate()
  const [phase, setPhase] = useState<Phase | ''>('')
  const [visibility, setVisibility] = useState<Visibility | ''>('')
  const q = useInfiniteQuery({
    queryKey: ['my-trips', phase, visibility],
    queryFn: ({ pageParam }) => api.me.trips({ phase, visibility, page: pageParam, page_size: 20 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.page_size < last.total ? last.page + 1 : undefined),
  })
  const invites = useQuery({ queryKey: ['me', 'invites'], queryFn: api.me.invites })
  const trips = flattenPages(q.data?.pages)
  const total = q.data?.pages[0]?.total
  const filtered = phase !== '' || visibility !== ''
  const tripInvites = invites.data?.trip_invites ?? []
  const partnerInvites = invites.data?.partner_invites ?? []

  return (
    <div className="mx-auto max-w-[90rem] px-4 pt-12 pb-24 [font-variant-numeric:lining-nums] md:px-8 md:pt-20 md:pb-32">
      <PageHead
        eyebrow="My Journeys · 我的旅程"
        meta={total != null && !filtered ? `${total} 段` : undefined}
        title="我的旅程"
        dek={
          total != null && !filtered ? (
            <>
              共 <span className="font-num text-ink-900">{total}</span> 段旅程，包括你创建和参与的
            </>
          ) : (
            '你创建和参与的旅程'
          )
        }
        actions={
          <Button size="lg" icon={<Plus className="size-4" strokeWidth={1.5} />} onClick={() => nav('/trips/new')}>
            新建旅程
          </Button>
        }
      />

      {partnerInvites.length > 0 && (
        <Link
          to="/together"
          className="group mt-14 flex min-h-12 items-center gap-3 border-y border-ink-200 py-3 text-sm text-ink-700 md:mt-20"
        >
          <Heart className="size-4 shrink-0 text-pink-500" strokeWidth={1.5} />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-ink-900">{partnerInvites[0].from.nickname || partnerInvites[0].from.username}</span> 邀请你绑定情侣空间
          </span>
          <span className="shrink-0 text-ink-500 transition-colors group-hover:text-ink-900">去看看 →</span>
        </Link>
      )}

      {tripInvites.length > 0 && (
        <section className="mt-14 md:mt-20" aria-labelledby="invites-title">
          <LabelRow id="invites-title" label="Invitations · 待处理的邀请" count={tripInvites.length} />
          <ul className="max-w-4xl divide-y divide-ink-200 border-b border-ink-200">
            {tripInvites.map((inv) => (
              <InviteRow key={inv.trip.id} inv={inv} />
            ))}
          </ul>
        </section>
      )}

      <div className="mt-16 flex flex-col gap-1 border-t border-ink-200 pt-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-10 md:mt-24">
        <FilterLinks<Phase | ''>
          label="阶段"
          value={phase}
          onChange={setPhase}
          options={[{ value: '', label: '全部' }, ...(Object.keys(phases) as Phase[]).map((p) => ({ value: p, label: phases[p].label }))]}
        />
        <FilterLinks<Visibility | ''>
          label="可见"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: '', label: '全部' },
            ...(Object.keys(visibilities) as Visibility[]).map((v) => ({ value: v, label: visibilities[v].label })),
          ]}
        />
      </div>

      <div className="mt-10 md:mt-14">
        {q.isLoading ? (
          <TripGridSkeleton />
        ) : q.isLoadingError ? (
          <LoadError error={q.error} onRetry={() => q.refetch()} />
        ) : trips.length === 0 ? (
          filtered ? (
            <EmptyNote title="没有符合条件的旅程。" desc="换个筛选条件试试。" />
          ) : (
            <EmptyNote
              title="还没有旅程。"
              desc="规划一条路线，或者记录一次说走就走的旅行。"
              action={<TextLink to="/trips/new">创建第一段旅程</TextLink>}
            />
          )
        ) : (
          <>
            <TripGrid trips={trips} showAuthor={false} />
            {q.hasNextPage && <MoreButton loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />}
          </>
        )}
      </div>
    </div>
  )
}
