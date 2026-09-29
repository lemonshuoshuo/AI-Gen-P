import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import {
  ArrowUpRight,
  Bell,
  BellOff,
  Bookmark,
  CheckCheck,
  GitFork,
  Heart,
  HeartHandshake,
  MailPlus,
  MailX,
  Megaphone,
  MessageCircle,
  Reply,
  Star,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, errorMessage, type Notification, type NotificationType, type Paged, type SpaceDetail } from '@/api'
import { refreshSpaces } from '@/components/space'
import { Avatar, Button, Empty, LoadError, PageLoader, selectedClass } from '@/components/ui'
import { cn } from '@/lib/cn'
import { dayjs, fromNow } from '@/lib/format'
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
  space_invite: MailPlus,
  space_accept: HeartHandshake,
  space_decline: MailX,
  partner_invite: Heart,
  partner_accept: HeartHandshake,
  featured: Star,
  system: Megaphone,
}

/** 人名、旅程名、地点名：象牙白宋体（只加载了 400 字重，不加粗）；数字用齐线数字，「1 GB」不会变成「ı GB」 */
const B = ({ children }: { children: ReactNode }) => (
  <span className="font-display text-ink-900 [font-variant-numeric:lining-nums]">{children}</span>
)

/** 默认头像：近黑底 + 细线圈 + 象牙白首字，不用彩色圆片 */
const monoAvatar = '!bg-surface-2 ring-1 ring-inset ring-ink-300 !text-ink-800'

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
    case 'space_invite':
      // space 只在自己已加入或邀请仍待回应时返回；否则 content 里只有留言
      return (
        <>
          {who} 邀请你加入
          {n.space ? (
            <>
              <B>「{n.space.name}」</B>
              <span className="text-ink-500">（{n.space.type_label}）</span>
            </>
          ) : (
            '一个空间'
          )}
          {n.content && <span className="text-ink-500">：“{n.content}”</span>}
        </>
      )
    case 'space_accept':
    case 'space_decline':
      // content 是跟在昵称后的一句话，如「接受了邀请，加入了「我们」」
      return (
        <>
          {who} {n.content || (n.type === 'space_accept' ? '接受了你的空间邀请' : '婉拒了你的空间邀请')}
        </>
      )
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
    case 'space_invite':
      // 待回应的邀请在总览最上方；已加入的直接打开那个空间
      return n.space && !n.space_invite_id ? `/spaces/${n.space.id}` : '/spaces'
    case 'space_accept':
    case 'space_decline':
      return n.space ? `/spaces/${n.space.id}` : '/spaces'
    case 'partner_invite':
    case 'partner_accept':
      return '/together'
  }
  // 退出、移除、成为新的创建者等空间的系统通知
  if (n.space) return `/spaces/${n.space.id}`
  if (n.trip) return `/trips/${n.trip.id}`
  if (n.place) return `/places/${n.place.id}`
  return null
}

/** 类型的小标签：西文 + 中文 */
const typeLabel: Record<NotificationType, string> = {
  comment: 'Comment · 评论',
  reply: 'Reply · 回复',
  like: 'Like · 点赞',
  favorite: 'Saved · 收藏',
  fork: 'Fork · 引用',
  follow: 'Follow · 关注',
  trip_invite: 'Invite · 邀请',
  space_invite: 'Invite · 空间邀请',
  space_accept: 'Together · 我们',
  space_decline: 'Together · 我们',
  partner_invite: 'Together · 情侣',
  partner_accept: 'Together · 情侣',
  featured: 'Featured · 精选',
  system: 'System · 系统',
}

function NoticeAvatar({ n }: { n: Notification }) {
  const Icon = typeIcon[n.type] ?? typeIcon.system
  // 系统 / 精选通知没有发起人：细线圆框 + 图标
  if (!n.actor)
    return (
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full border border-ink-200 text-ink-600">
        <Icon className="size-[18px]" strokeWidth={1.25} />
      </span>
    )
  return (
    <span className="relative size-11 shrink-0">
      <Avatar user={n.actor} size={44} className={monoAvatar} />
      <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full border border-ink-200 bg-paper text-ink-600">
        <Icon className="size-2.5" strokeWidth={1.75} />
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
      <div className="mt-4 text-[13px] text-ink-700">
        已接受 ·{' '}
        <Link to={`/trips/${tripId}`} className="text-ink-900 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-900">
          查看旅程
        </Link>
      </div>
    )
  if (result === 'declined') return <div className="mt-4 text-[13px] text-ink-400">已拒绝</div>
  return (
    <div className="mt-4 flex gap-2">
      <Button size="sm" variant="outline" className="max-sm:h-10" loading={m.isPending && !m.variables} disabled={m.isPending} onClick={() => m.mutate(false)}>
        拒绝
      </Button>
      <Button size="sm" className="max-sm:h-10" loading={m.isPending && m.variables} disabled={m.isPending} onClick={() => m.mutate(true)}>
        接受
      </Button>
    </div>
  )
}

/** 空间邀请：接受后给出进入空间的链接；处理结果留在这一条上，不刷新整个列表 */
function SpaceInviteActions({ inviteId, onDone }: { inviteId: number; onDone: () => void }) {
  const qc = useQueryClient()
  const [result, setResult] = useState<{ accepted: boolean; space?: SpaceDetail } | null>(null)
  const m = useMutation({
    mutationFn: async (accept: boolean) => (accept ? api.spaces.accept(inviteId) : api.spaces.decline(inviteId).then(() => undefined)),
    onSuccess: (space, accept) => {
      setResult({ accepted: accept, space })
      toast.success(accept ? `已加入「${space?.name ?? '空间'}」` : '已婉拒邀请')
      refreshSpaces(qc, { trips: accept, notifications: false })
      onDone()
    },
    onError: (e) => {
      toast.error(errorMessage(e))
      // 邀请已撤回或在别处处理：刷新列表，按钮会消失
      if (e instanceof ApiError && e.status === 404) {
        qc.invalidateQueries({ queryKey: ['notifications'] })
        refreshSpaces(qc)
      }
    },
  })
  if (result?.accepted)
    return (
      <div className="mt-4 text-[13px] text-ink-700">
        已加入 ·{' '}
        <Link
          to={result.space ? `/spaces/${result.space.id}` : '/spaces'}
          className="text-ink-900 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-900"
        >
          进入空间
        </Link>
      </div>
    )
  if (result) return <div className="mt-4 text-[13px] text-ink-500">已婉拒</div>
  return (
    <div className="mt-4 flex gap-2">
      <Button size="sm" variant="outline" className="max-sm:h-10" loading={m.isPending && !m.variables} disabled={m.isPending} onClick={() => m.mutate(false)}>
        婉拒
      </Button>
      <Button size="sm" className="max-sm:h-10" loading={m.isPending && m.variables} disabled={m.isPending} onClick={() => m.mutate(true)}>
        接受邀请
      </Button>
    </div>
  )
}

function NoticeItem({ n, onOpen, onRead }: { n: Notification; onOpen: () => void; onRead: () => void }) {
  // 只有仍待处理的旅程邀请、空间邀请才显示接受 / 拒绝
  const tripAction = n.type === 'trip_invite' && !!n.trip && !!n.invite_pending
  const spaceAction = n.type === 'space_invite' && !!n.invite_pending && !!n.space_invite_id
  const actionable = tripAction || spaceAction
  const clickable = !actionable && !!targetOf(n)
  const d = dayjs(n.created_at)
  const body = (
    <>
      {/* 左栏：时间（亮）+ 相对时间（灰）；未读是一粒朱砂小点，不给整行铺底色。
          大屏占 4 栏，正文与「我的」「账号设置」从同一条竖线（第 5 栏）起排 */}
      <div className="flex items-baseline gap-3 max-md:col-span-2 md:col-span-3 md:block lg:col-span-4">
        <p className="flex items-center gap-2.5 text-[13px] text-ink-900">
          <span
            className={cn('size-1.5 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-brand-500')}
            aria-hidden
          />
          <span className="font-num text-[15px]">{d.format(d.isSame(dayjs(), 'year') ? 'MM.DD HH:mm' : 'YYYY.MM.DD')}</span>
        </p>
        <p className="caption md:mt-0.5 md:pl-4">{fromNow(n.created_at)}</p>
        <p className="eyebrow ml-auto md:hidden">{typeLabel[n.type] ?? typeLabel.system}</p>
      </div>
      <div className="flex min-w-0 gap-4 max-md:col-span-2 md:col-span-6 md:gap-5">
        <NoticeAvatar n={n} />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'font-display line-clamp-3 text-[17px] leading-[1.7] break-words transition-colors duration-300 [font-feature-settings:"halt"] [font-variant-numeric:lining-nums] md:text-[20px]',
              n.read ? 'text-ink-500' : 'text-ink-700',
              clickable && 'group-hover:text-ink-800',
            )}
          >
            {!n.read && <span className="sr-only">未读：</span>}
            {describe(n)}
          </p>
          {tripAction && n.trip && <InviteActions tripId={n.trip.id} onDone={onRead} />}
          {spaceAction && n.space_invite_id && <SpaceInviteActions inviteId={n.space_invite_id} onDone={onRead} />}
        </div>
      </div>
      {/* 箭头位总是占着，右侧的类型标签列才有一条整齐的右边 */}
      <div className="hidden items-start justify-end gap-6 pt-1 md:col-span-3 md:flex lg:col-span-2">
        <span className="eyebrow whitespace-nowrap">{typeLabel[n.type] ?? typeLabel.system}</span>
        {clickable ? (
          <ArrowUpRight
            className="size-4 shrink-0 text-ink-300 transition-colors duration-300 group-hover:text-ink-900"
            strokeWidth={1.25}
          />
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}
      </div>
    </>
  )
  const cls = 'group grid w-full grid-cols-2 gap-x-8 gap-y-4 py-7 text-left md:grid-cols-12 md:py-9'
  // 待处理的旅程邀请包含操作按钮，不整体可点
  if (actionable) return <div className={cls}>{body}</div>
  return (
    <button type="button" onClick={onOpen} className={cls}>
      {body}
    </button>
  )
}

/** 按日期分组：今天 / 昨天 / 近 7 天 / 按月 */
function groupOf(t: string): { key: string; label: string } {
  const d = dayjs(t)
  const now = dayjs()
  if (d.isSame(now, 'day')) return { key: 'today', label: 'Today · 今天' }
  if (d.isSame(now.subtract(1, 'day'), 'day')) return { key: 'yesterday', label: 'Yesterday · 昨天' }
  if (now.diff(d, 'day') < 7) return { key: 'week', label: 'This week · 近 7 天' }
  return { key: d.format('YYYY-MM'), label: d.format('YYYY.MM') }
}

/** 细线标签行：一条 border-t，左侧 eyebrow + 灰色计数，右侧补充 */
function LabelRow({ label, count, extra }: { label: ReactNode; count?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-ink-200 pt-3 pb-1">
      <p className="flex min-w-0 items-baseline gap-3">
        <span className="eyebrow !text-ink-800">{label}</span>
        {count != null && <span className="font-num text-[13px] text-ink-400">{count}</span>}
      </p>
      {extra}
    </div>
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
  const total = q.data?.pages[0]?.total

  const groups: { key: string; label: string; items: Notification[] }[] = []
  for (const n of items) {
    const g = groupOf(n.created_at)
    const last = groups[groups.length - 1]
    if (last?.key === g.key) last.items.push(n)
    else groups.push({ ...g, items: [n] })
  }

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
    <div className="mx-auto max-w-[90rem] px-4 pt-10 pb-24 [font-variant-numeric:lining-nums] md:px-8 md:pt-20 md:pb-32">
      {/* 页头：细线标签行 + 大号宋体标题；右栏是未读数（大号细字）与「全部已读」 */}
      <header className="animate-slide-up">
        <LabelRow
          label="Notifications · 通知"
          extra={total != null && filter === 'all' && <span className="font-num text-[13px] text-ink-400">{total} 条</span>}
        />
        <div className="mt-10 grid gap-x-8 gap-y-8 md:mt-16 lg:grid-cols-12 lg:items-end">
          <h1 className="text-display-lg font-normal lg:col-span-7">通知</h1>
          <div className="flex items-end justify-between gap-6 lg:col-span-4 lg:col-start-9 lg:pb-2">
            <p className="flex items-baseline gap-3">
              <span className="font-num text-num text-ink-900">{unread}</span>
              <span className="text-[13px] text-ink-500">{unread > 0 ? '条未读' : '全部已读'}</span>
            </p>
            <Button
              variant="outline"
              size="sm"
              icon={<CheckCheck className="size-4" strokeWidth={1.5} />}
              disabled={unread === 0}
              loading={readAll.isPending}
              onClick={() => readAll.mutate()}
              className="max-sm:h-10"
            >
              全部已读
            </Button>
          </div>
        </div>
      </header>

      {/* 文字筛选：当前项象牙白下划线 */}
      <div role="group" aria-label="筛选" className="mt-16 flex items-center text-[13.5px] md:mt-24">
        <span aria-hidden className="eyebrow mr-3">
          Show
        </span>
        {(
          [
            ['all', '全部'],
            ['unread', '未读'],
          ] as const
        ).map(([v, label], i) => (
          <span key={v} className="flex items-center">
            {i > 0 && (
              <span aria-hidden className="text-ink-300">
                /
              </span>
            )}
            <button
              type="button"
              aria-pressed={filter === v}
              onClick={() => setFilter(v)}
              className={selectedClass(filter === v, 'filter', 'mx-0.5 inline-flex h-10 items-center px-3 tracking-wide')}
            >
              {label}
            </button>
          </span>
        ))}
      </div>

      <div className="mt-6 md:mt-8">
        {q.isLoading ? (
          <div className="border-t border-ink-200">
            <PageLoader />
          </div>
        ) : q.isLoadingError ? (
          <div className="border-t border-ink-200">
            <LoadError title="通知加载失败" error={q.error} onRetry={() => q.refetch()} />
          </div>
        ) : items.length === 0 ? (
          <div className="border-t border-ink-200">
            <Empty
              className="py-24"
              icon={filter === 'unread' ? <BellOff className="size-9" /> : <Bell className="size-9" />}
              title={filter === 'unread' ? '没有未读通知' : '还没有通知'}
              desc="有人评论、点赞、关注你或邀请你一起旅行时，会在这里提醒你"
            />
          </div>
        ) : (
          <div className="space-y-14 md:space-y-20">
            {groups.map((g) => (
              <section key={g.key} className="animate-fade-in">
                <LabelRow label={g.label} count={String(g.items.length).padStart(2, '0')} />
                <ul className="mt-2 divide-y divide-ink-200 border-b border-ink-200">
                  {g.items.map((n) => (
                    <li key={n.id}>
                      <NoticeItem n={n} onOpen={() => open(n)} onRead={() => readOne(n)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {q.hasNextPage && (
              <div className="flex items-center gap-5">
                <span className="h-px flex-1 bg-ink-200" />
                <button
                  type="button"
                  onClick={() => q.fetchNextPage()}
                  disabled={q.isFetchingNextPage}
                  className="inline-flex h-10 items-center gap-2 rounded-full border border-ink-900/20 px-6 text-[13px] tracking-[0.08em] text-ink-800 transition-colors duration-300 hover:border-ink-900/60 hover:text-ink-900 disabled:opacity-50"
                >
                  {q.isFetchingNextPage ? '加载中…' : '加载更多'}
                </button>
                <span className="h-px flex-1 bg-ink-200" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
