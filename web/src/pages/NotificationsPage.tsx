import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import {
  Bell,
  BellOff,
  Bookmark,
  CheckCheck,
  GitFork,
  Heart,
  HeartHandshake,
  Megaphone,
  MessageCircle,
  Reply,
  Star,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Notification, type NotificationType, type Paged } from '@/api'
import { Avatar, Button, Empty, PageLoader, Segmented } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fromNow } from '@/lib/format'

type Filter = 'all' | 'unread'
type NoticePages = InfiniteData<Paged<Notification>, number>

const typeIcon: Record<NotificationType, { icon: LucideIcon; cls: string }> = {
  comment: { icon: MessageCircle, cls: 'bg-sky-500' },
  reply: { icon: Reply, cls: 'bg-sky-500' },
  like: { icon: Heart, cls: 'bg-brand-500' },
  favorite: { icon: Bookmark, cls: 'bg-amber-500' },
  fork: { icon: GitFork, cls: 'bg-violet-500' },
  follow: { icon: UserPlus, cls: 'bg-emerald-500' },
  trip_invite: { icon: Users, cls: 'bg-sky-500' },
  partner_invite: { icon: Heart, cls: 'bg-pink-500' },
  partner_accept: { icon: HeartHandshake, cls: 'bg-pink-500' },
  featured: { icon: Star, cls: 'bg-amber-500' },
  system: { icon: Megaphone, cls: 'bg-ink-700' },
}

const B = ({ children }: { children: ReactNode }) => <b className="font-semibold text-ink-900">{children}</b>

/** 通知的中文描述 */
function describe(n: Notification): ReactNode {
  const who = <B>{n.actor ? n.actor.nickname || n.actor.username : '有人'}</B>
  const trip = n.trip && <B>《{n.trip.title}》</B>
  const place = n.place && <B>「{n.place.name}」</B>
  const quote = n.content && <span className="text-ink-500">：{n.content}</span>
  switch (n.type) {
    case 'comment':
      return (
        <>
          {who} 评论了{trip ? <>你的旅程{trip}</> : place ? <>打卡地{place}</> : '你'}
          {quote}
        </>
      )
    case 'reply':
      return (
        <>
          {who} {trip || place ? <>在{trip || place}中</> : ''}回复了你{quote}
        </>
      )
    case 'like':
      return <>{who} 赞了你的旅程{trip}</>
    case 'favorite':
      return <>{who} 收藏了你的旅程{trip}</>
    case 'fork':
      return <>{who} 引用了你的旅程{trip}的路线</>
    case 'follow':
      return <>{who} 关注了你</>
    case 'trip_invite':
      return <>{who} 邀请你一起编辑旅程{trip}</>
    case 'partner_invite':
      return (
        <>
          {who} 邀请你绑定情侣空间{n.content && <span className="text-ink-500">：“{n.content}”</span>}
        </>
      )
    case 'partner_accept':
      return <>{who} 接受了你的情侣空间邀请，你们绑定啦 💕</>
    case 'featured':
      return (
        <>
          你的旅程{trip}被设为精选 🎉
          {n.content && <span className="text-ink-500"> {n.content}</span>}
        </>
      )
    default:
      return n.content || '系统通知'
  }
}

/** 点击通知后跳转的地址；null 表示不跳转 */
function targetOf(n: Notification): string | null {
  switch (n.type) {
    case 'follow':
      return n.actor ? `/u/${n.actor.username}` : null
    case 'partner_invite':
    case 'partner_accept':
      return '/together'
    case 'trip_invite':
      return null
  }
  if (n.trip) return `/trips/${n.trip.id}`
  if (n.place) return `/places/${n.place.id}`
  return null
}

function NoticeAvatar({ n }: { n: Notification }) {
  const t = typeIcon[n.type] ?? typeIcon.system
  const Icon = t.icon
  if (!n.actor)
    return (
      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full text-white', t.cls)}>
        <Icon className="size-5" />
      </span>
    )
  return (
    <span className="relative shrink-0">
      <Avatar user={n.actor} size={40} />
      <span
        className={cn(
          'absolute -right-0.5 -bottom-0.5 flex size-4.5 items-center justify-center rounded-full text-white ring-2 ring-white',
          t.cls,
        )}
      >
        <Icon className="size-2.5" />
      </span>
    </span>
  )
}

function InviteActions({ tripId, onDone }: { tripId: number; onDone: () => void }) {
  const qc = useQueryClient()
  const [result, setResult] = useState<'accepted' | 'declined' | null>(null)
  const m = useMutation({
    mutationFn: (accept: boolean) => (accept ? api.trips.acceptInvite(tripId) : api.trips.declineInvite(tripId)),
    onSuccess: (_, accept) => {
      setResult(accept ? 'accepted' : 'declined')
      toast.success(accept ? '已加入旅程，一起规划吧' : '已拒绝邀请')
      qc.invalidateQueries({ queryKey: ['me', 'invites'] })
      qc.invalidateQueries({ queryKey: ['my-trips'] })
      onDone()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  if (result === 'accepted')
    return (
      <div className="mt-2 text-xs text-emerald-600">
        已接受 ·{' '}
        <Link to={`/trips/${tripId}`} className="font-medium underline">
          查看旅程
        </Link>
      </div>
    )
  if (result === 'declined') return <div className="mt-2 text-xs text-ink-400">已拒绝</div>
  return (
    <div className="mt-2.5 flex gap-2">
      <Button size="xs" variant="outline" loading={m.isPending && !m.variables} disabled={m.isPending} onClick={() => m.mutate(false)}>
        拒绝
      </Button>
      <Button size="xs" loading={m.isPending && m.variables} disabled={m.isPending} onClick={() => m.mutate(true)}>
        接受
      </Button>
    </div>
  )
}

function NoticeItem({ n, onOpen, onRead }: { n: Notification; onOpen: () => void; onRead: () => void }) {
  const body = (
    <>
      <NoticeAvatar n={n} />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-3 text-sm leading-relaxed break-words text-ink-700">{describe(n)}</p>
        <div className="mt-1 text-xs text-ink-400">{fromNow(n.created_at)}</div>
        {n.type === 'trip_invite' && n.trip && <InviteActions tripId={n.trip.id} onDone={onRead} />}
      </div>
      {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-500" aria-label="未读" />}
    </>
  )
  const cls = cn(
    'flex w-full gap-3 rounded-2xl p-4 text-left transition',
    n.read ? 'bg-white shadow-card' : 'bg-brand-50 ring-1 ring-brand-100',
  )
  // 旅程邀请包含操作按钮，不整体可点
  if (n.type === 'trip_invite') return <div className={cls}>{body}</div>
  return (
    <button type="button" onClick={onOpen} className={cn(cls, 'hover:brightness-[0.98]')}>
      {body}
    </button>
  )
}

export default function NotificationsPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<Filter>('all')
  const q = useInfiniteQuery({
    queryKey: ['notifications', filter],
    queryFn: ({ pageParam }) =>
      api.notifications.list({ page: pageParam, page_size: 20, unread_only: filter === 'unread' || undefined }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.page_size < last.total ? last.page + 1 : undefined),
  })
  const { data: unread = 0 } = useQuery({
    queryKey: ['unread'],
    queryFn: api.notifications.unreadCount,
    select: (d) => d.count,
  })
  const items = q.data?.pages.flatMap((p) => p.items) ?? []

  /** 在本地缓存中标记已读（未读筛选下保留条目，避免列表跳动） */
  const markLocal = (ids?: number[]) => {
    qc.setQueriesData<NoticePages>({ queryKey: ['notifications'] }, (d) =>
      d
        ? {
            ...d,
            pages: d.pages.map((p) => ({
              ...p,
              items: p.items.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)),
            })),
          }
        : d,
    )
    qc.setQueryData<{ count: number }>(['unread'], (d) => (d ? { count: ids ? Math.max(0, d.count - ids.length) : 0 } : d))
  }

  const readOne = (n: Notification) => {
    if (n.read) return
    markLocal([n.id])
    api.notifications
      .read([n.id])
      .catch(() => {})
      .finally(() => qc.invalidateQueries({ queryKey: ['unread'] }))
  }

  const readAll = useMutation({
    mutationFn: () => api.notifications.read(),
    onSuccess: () => {
      markLocal()
      qc.invalidateQueries({ queryKey: ['unread'] })
      toast.success('已全部标记为已读')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const open = (n: Notification) => {
    readOne(n)
    const to = targetOf(n)
    if (to) nav(to)
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">通知</h1>
          <p className="mt-1 text-sm text-ink-500">{unread > 0 ? `${unread} 条未读` : '全部已读'}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          icon={<CheckCheck className="size-4" />}
          disabled={unread === 0}
          loading={readAll.isPending}
          onClick={() => readAll.mutate()}
        >
          全部已读
        </Button>
      </div>

      <Segmented<Filter>
        className="mt-4"
        size="sm"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: '全部' },
          { value: 'unread', label: '未读' },
        ]}
      />

      <div className="mt-4">
        {q.isLoading ? (
          <PageLoader />
        ) : q.isError ? (
          <Empty
            title="通知加载失败"
            desc={errorMessage(q.error)}
            action={<Button onClick={() => q.refetch()}>重试</Button>}
          />
        ) : items.length === 0 ? (
          <Empty
            icon={filter === 'unread' ? <BellOff className="size-12" /> : <Bell className="size-12" />}
            title={filter === 'unread' ? '没有未读通知' : '还没有通知'}
            desc="有人评论、点赞、关注你或邀请你一起旅行时，会在这里提醒你"
          />
        ) : (
          <>
            <ul className="space-y-2">
              {items.map((n) => (
                <li key={n.id}>
                  <NoticeItem n={n} onOpen={() => open(n)} onRead={() => readOne(n)} />
                </li>
              ))}
            </ul>
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
