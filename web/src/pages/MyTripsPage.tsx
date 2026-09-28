import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Heart, Map as MapIcon, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Phase, type TripCard, type UserBrief, type Visibility } from '@/api'
import { FilterLinks, MoreButton, PageHead, cityShort, mineralOf } from '@/components/editorial'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { Avatar, Button, Empty, LoadError } from '@/components/ui'
import { fromNow } from '@/lib/format'
import { phases, visibilities } from '@/lib/meta'
import { flattenPages } from '@/lib/pages'

type TripInvite = { trip: TripCard; from: UserBrief; created_at: string }

/** 邀请行里的小封面：有照片用照片，没有时是矿物色块 + 城市名 */
function MiniCover({ trip }: { trip: TripCard }) {
  const m = mineralOf(trip.id)
  return (
    <div className="relative size-14 shrink-0 overflow-hidden rounded-md" style={{ background: m.bg, color: m.fg }}>
      {trip.cover_url ? (
        <img src={trip.cover_thumb_url || trip.cover_url} alt="" loading="lazy" className="size-full object-cover" />
      ) : (
        <span className="font-display absolute bottom-1.5 left-2 text-[15px] leading-none">{cityShort(trip.cities?.[0] ?? '') || '旅'}</span>
      )}
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-ink-900/10 ring-inset" />
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
    <li className="flex items-center gap-3.5 py-3.5">
      <MiniCover trip={inv.trip} />
      <div className="min-w-0 flex-1">
        <Link to={`/trips/${inv.trip.id}`} className="font-display line-clamp-1 text-[16px] text-ink-900 transition-colors hover:text-brand-700">
          {inv.trip.title}
        </Link>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-ink-400">
          <Avatar user={inv.from} size={16} />
          <span className="truncate">
            <span className="text-ink-700">{from}</span> 邀请你一起编辑 · {fromNow(inv.created_at)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
        <Button size="sm" loading={m.isPending && m.variables} disabled={m.isPending} onClick={() => m.mutate(true)}>
          接受
        </Button>
        <Button size="sm" variant="ghost" loading={m.isPending && !m.variables} disabled={m.isPending} onClick={() => m.mutate(false)}>
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
    <div className="mx-auto max-w-6xl px-4 pt-8 pb-16 md:px-6 md:pt-12">
      <PageHead
        eyebrow="My Journeys · 我的旅程"
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
          <Button icon={<Plus className="size-4" strokeWidth={1.75} />} onClick={() => nav('/trips/new')}>
            新建旅程
          </Button>
        }
      />

      {partnerInvites.length > 0 && (
        <Link
          to="/together"
          className="group mt-8 flex items-center gap-3 border-l-2 border-pink-500 bg-white/55 py-3 pr-4 pl-4 text-sm text-ink-700"
        >
          <Heart className="size-4 shrink-0 text-pink-500" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-ink-900">{partnerInvites[0].from.nickname || partnerInvites[0].from.username}</span> 邀请你绑定情侣空间
          </span>
          <span className="shrink-0 text-ink-500 transition-colors group-hover:text-ink-900">去看看 →</span>
        </Link>
      )}

      {tripInvites.length > 0 && (
        <section className="mt-8" aria-labelledby="invites-title">
          <div className="border-b border-ink-900 pb-2">
            <p id="invites-title" className="eyebrow">
              Invitations · 待处理的邀请 <span className="font-num">{tripInvites.length}</span>
            </p>
          </div>
          <ul className="max-w-3xl divide-y divide-ink-200 border-b border-ink-200">
            {tripInvites.map((inv) => (
              <InviteRow key={inv.trip.id} inv={inv} />
            ))}
          </ul>
        </section>
      )}

      <div className="mt-10 flex flex-col gap-2 border-b border-ink-200 pb-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-10">
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

      <div className="mt-8">
        {q.isLoading ? (
          <TripGridSkeleton />
        ) : q.isLoadingError ? (
          <LoadError error={q.error} onRetry={() => q.refetch()} />
        ) : trips.length === 0 ? (
          filtered ? (
            <Empty icon={<MapIcon className="size-11" />} title="没有符合条件的旅程" desc="换个筛选条件试试" />
          ) : (
            <Empty
              icon={<MapIcon className="size-11" />}
              title="还没有旅程"
              desc="规划一条路线，或者记录一次说走就走的旅行"
              action={
                <Button icon={<Plus className="size-4" strokeWidth={1.75} />} onClick={() => nav('/trips/new')}>
                  创建第一段旅程
                </Button>
              }
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
