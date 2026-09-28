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
import { api, ApiError, errorMessage, type Notification, type NotificationType, type Paged } from '@/api'
import { Avatar, Button, Empty, LoadError, PageLoader, TabBar } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fromNow } from '@/lib/format'
import { flattenPages } from '@/lib/pages'

type Filter = 'all' | 'unread'
type NoticePages = InfiniteData<Paged<Notification>, number>

// 类型只用细线小图标区分，不再用彩色圆底
const typeIcon: Record<NotificationType, LucideIcon> = {
  comment: MessageCircle,
  reply: Reply,
  like: Heart,
  favorite: Bookmark,
  fork: GitFork,
  follow: UserPlus,
  trip_invite: Users,
  partner_invite: Heart,
  partner_accept: HeartHandshake,
  featured: Star,
  system: Megaphone,
}

/** 人名、旅程名、地点名：宋体 */
const B = ({ children }: { children: ReactNode }) => <span className="font-display font-semibold text-ink-900">{children}</span>

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
      // 邀请已处理，或情侣被直接加入旅程（「把你加入了共同旅程…」）时按通知原文展示
      return n.invite_pending || !n.content ? <>{who} 邀请你一起编辑旅程{trip}</> : <>{who} {n.content}</>
    case 'partner_invite':
      return (
        <>
          {who} 邀请你绑定情侣空间{n.content && <span className="text-ink-500">：“{n.content}”</span>}
        </>
      )
    case 'partner_accept':
      return <>{who} 接受了你的情侣空间邀请，你们已绑定</>
    case 'featured':
      // content 是服务端生成的同一句摘要（「你的旅程「X」被设为精选」），不再重复显示
      return <>你的旅程{trip}被设为精选</>
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
  }
  if (n.trip) return `/trips/${n.trip.id}`
  if (n.place) return `/places/${n.place.id}`
  return null
}

function NoticeAvatar({ n }: { n: Notification }) {
  const Icon = typeIcon[n.type] ?? typeIcon.system
  // 系统 / 精选通知没有发起人：细线圆框 + 图标
  if (!n.actor)
    return (
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-ink-200 bg-white text-ink-600">
        <Icon className="size-[18px]" strokeWidth={1.5} />
      </span>
    )
  return (
    <span className="relative size-10 shrink-0">
      <Avatar user={n.actor} size={40} />
      <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full border border-ink-200 bg-white text-ink-600 ring-2 ring-paper">
        <Icon className="size-2.5" strokeWidth={2} />
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
    onError: (e) => {
      toast.error(errorMessage(e))
      // 邀请已在别处处理：刷新列表，按钮会消失
      if (e instanceof ApiError && e.status === 404) qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
  if (result === 'accepted')
    return (
      <div className="mt-2 text-xs text-emerald-700">
        已接受 ·{' '}
        <Link to={`/trips/${tripId}`} className="underline underline-offset-4">
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
  // 只有仍待处理的旅程邀请才显示接受 / 拒绝
  const actionable = n.type === 'trip_invite' && !!n.trip && !!n.invite_pending
  const body = (
    <>
      {/* 未读：左侧页边一粒朱砂小点，不给整行铺底色 */}
      {!n.read && (
        <span className="absolute top-[1.625rem] left-0.5 size-1.5 rounded-full bg-brand-500" aria-hidden />
      )}
      <NoticeAvatar n={n} />
      <div className="min-w-0 flex-1">
        <p className={cn('line-clamp-3 text-[15px] leading-relaxed break-words', n.read ? 'text-ink-600' : 'text-ink-800')}>
          {!n.read && <span className="sr-only">未读：</span>}
          {describe(n)}
        </p>
        <div className="font-num mt-1 text-xs text-ink-400">{fromNow(n.created_at)}</div>
        {actionable && n.trip && <InviteActions tripId={n.trip.id} onDone={onRead} />}
      </div>
    </>
  )
  const cls = 'relative flex w-full gap-3.5 py-4 pr-1 pl-5 text-left transition-colors'
  // 待处理的旅程邀请包含操作按钮，不整体可点
  if (actionable) return <div className={cls}>{body}</div>
  return (
    <button type="button" onClick={onOpen} className={cn(cls, 'hover:bg-white/55')}>
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
  const items = flattenPages(q.data?.pages)

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
    <div className="mx-auto max-w-2xl px-4 pt-6 pb-12 md:pt-10">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div>
          <p className="eyebrow">Notifications · 通知</p>
          <h1 className="mt-2 text-[28px] leading-[1.15] text-ink-900 md:text-[34px]">通知</h1>
          <p className="mt-2 text-sm text-ink-500">
            {unread > 0 ? (
              <>
                <span className="font-num text-base text-brand-600">{unread}</span> 条未读
              </>
            ) : (
              '全部已读'
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          icon={<CheckCheck className="size-4" strokeWidth={1.75} />}
          disabled={unread === 0}
          loading={readAll.isPending}
          onClick={() => readAll.mutate()}
        >
          全部已读
        </Button>
      </header>

      <TabBar<Filter>
        className="mt-7"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: '全部' },
          { value: 'unread', label: '未读' },
        ]}
      />

      <div>
        {q.isLoading ? (
          <PageLoader />
        ) : q.isLoadingError ? (
          <LoadError title="通知加载失败" error={q.error} onRetry={() => q.refetch()} />
        ) : items.length === 0 ? (
          <Empty
            icon={filter === 'unread' ? <BellOff className="size-10" /> : <Bell className="size-10" />}
            title={filter === 'unread' ? '没有未读通知' : '还没有通知'}
            desc="有人评论、点赞、关注你或邀请你一起旅行时，会在这里提醒你"
          />
        ) : (
          <>
            <ul className="divide-y divide-ink-200 border-b border-ink-200">
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
