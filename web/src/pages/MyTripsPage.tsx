import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Heart, Map as MapIcon, Plus, Route } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Phase, type TripCard, type UserBrief, type Visibility } from '@/api'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { Avatar, Button, Card, Empty, Segmented } from '@/components/ui'
import { fromNow } from '@/lib/format'
import { phases, visibilities } from '@/lib/meta'

type TripInvite = { trip: TripCard; from: UserBrief; created_at: string }

function InviteCard({ inv }: { inv: TripInvite }) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: (accept: boolean) => (accept ? api.trips.acceptInvite(inv.trip.id) : api.trips.declineInvite(inv.trip.id)),
    onSuccess: (_, accept) => {
      toast.success(accept ? '已加入旅程，一起规划吧' : '已拒绝邀请')
      qc.invalidateQueries({ queryKey: ['me', 'invites'] })
      if (accept) qc.invalidateQueries({ queryKey: ['my-trips'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const from = inv.from.nickname || inv.from.username
  return (
    <Card className="flex items-center gap-3 p-3">
      <div className="bg-brand-gradient flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl">
        {inv.trip.cover_url ? (
          <img src={inv.trip.cover_url} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <Route className="size-6 text-white" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <Link to={`/trips/${inv.trip.id}`} className="line-clamp-1 font-semibold hover:text-brand-600">
          {inv.trip.title}
        </Link>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-400">
          <Avatar user={inv.from} size={16} />
          <span className="truncate">
            {from} 邀请你一起编辑 · {fromNow(inv.created_at)}
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
    </Card>
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
  const trips = q.data?.pages.flatMap((p) => p.items) ?? []
  const total = q.data?.pages[0]?.total
  const filtered = phase !== '' || visibility !== ''
  const tripInvites = invites.data?.trip_invites ?? []
  const partnerInvites = invites.data?.partner_invites ?? []

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">我的旅程</h1>
          <p className="mt-1 text-sm text-ink-500">
            {total != null && !filtered ? `共 ${total} 段旅程，包括你创建和参与的` : '你创建和参与的旅程'}
          </p>
        </div>
        <Button icon={<Plus className="size-4" />} onClick={() => nav('/trips/new')}>
          新建旅程
        </Button>
      </div>

      {tripInvites.length > 0 && (
        <section className="mt-5">
          <h2 className="mb-2.5 text-sm font-semibold text-ink-700">待处理的邀请</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {tripInvites.map((inv) => (
              <InviteCard key={inv.trip.id} inv={inv} />
            ))}
          </div>
        </section>
      )}

      {partnerInvites.length > 0 && (
        <Link
          to="/together"
          className="bg-love-gradient mt-4 flex items-center gap-2 rounded-2xl px-4 py-3 text-sm text-white shadow-sm shadow-pink-500/30"
        >
          <Heart className="size-4 fill-white" />
          <span className="min-w-0 flex-1 truncate">
            {partnerInvites[0].from.nickname || partnerInvites[0].from.username} 邀请你绑定情侣空间
          </span>
          <span className="shrink-0 text-white/85">去看看 →</span>
        </Link>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Segmented<Phase | ''>
          size="sm"
          value={phase}
          onChange={setPhase}
          options={[
            { value: '', label: '全部' },
            ...(Object.keys(phases) as Phase[]).map((p) => ({ value: p, label: phases[p].label })),
          ]}
        />
        <Segmented<Visibility | ''>
          size="sm"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: '', label: '全部可见性' },
            ...(Object.keys(visibilities) as Visibility[]).map((v) => ({ value: v, label: visibilities[v].label })),
          ]}
        />
      </div>

      <div className="mt-4">
        {q.isLoading ? (
          <TripGridSkeleton />
        ) : q.isError ? (
          <Empty title="加载失败" desc={errorMessage(q.error)} action={<Button onClick={() => q.refetch()}>重试</Button>} />
        ) : trips.length === 0 ? (
          filtered ? (
            <Empty icon={<MapIcon className="size-12" />} title="没有符合条件的旅程" desc="换个筛选条件试试" />
          ) : (
            <Empty
              icon={<MapIcon className="size-12" />}
              title="还没有旅程"
              desc="规划一条路线，或者记录一次说走就走的旅行"
              action={
                <Button icon={<Plus className="size-4" />} onClick={() => nav('/trips/new')}>
                  创建第一段旅程
                </Button>
              }
            />
          )
        ) : (
          <>
            <TripGrid trips={trips} showAuthor={false} />
            {q.hasNextPage && (
              <div className="mt-6 flex justify-center">
                <Button variant="outline" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                  加载更多
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
