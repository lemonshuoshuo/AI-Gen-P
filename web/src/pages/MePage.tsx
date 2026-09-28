import { useEffect, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  Bookmark,
  ChevronRight,
  Footprints,
  Heart,
  LogOut,
  Map as MapIcon,
  PenLine,
  Settings,
  Shield,
  User,
  type LucideIcon,
} from 'lucide-react'
import { api } from '@/api'
import { Avatar, buttonClass, LevelBadge } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fmtCount } from '@/lib/format'
import { useSite } from '@/hooks/useSite'
import { isAdmin, useAuth } from '@/stores/auth'

interface LinkItem {
  to: string
  label: string
  icon: LucideIcon
  extra?: ReactNode
}

/** 待处理数量：小号 Fraunces 数字 + 文字，朱砂色（情侣空间用胭脂色），不用色块 */
function Badge({ children, tone = 'brand' }: { children: ReactNode; tone?: 'brand' | 'love' }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[13px]', tone === 'love' ? 'text-pink-600' : 'text-brand-600')}>
      <span className={cn('size-1.5 rounded-full', tone === 'love' ? 'bg-pink-500' : 'bg-brand-500')} aria-hidden />
      {children}
    </span>
  )
}

const Num = ({ children }: { children: ReactNode }) => <span className="font-num">{children}</span>

/** 目录式的细线列表：细线图标 + 标签 + 右侧补充 + 箭头 */
function LinkGroup({ title, items }: { title: string; items: LinkItem[] }) {
  return (
    <section>
      <p className="eyebrow">{title}</p>
      <ul className="mt-2 divide-y divide-ink-200 border-y border-ink-200">
        {items.map((it) => (
          <li key={it.to}>
            <Link
              to={it.to}
              className="group flex items-center gap-3.5 py-3.5 transition-colors hover:bg-white/55 active:bg-white/80"
            >
              <it.icon className="size-[18px] shrink-0 text-ink-500 group-hover:text-ink-900" strokeWidth={1.5} />
              <span className="flex-1 text-[15px] text-ink-900">{it.label}</span>
              {it.extra && <span className="min-w-0 truncate text-sm text-ink-400">{it.extra}</span>}
              <ChevronRight className="size-4 shrink-0 text-ink-300 transition-transform group-hover:translate-x-0.5" strokeWidth={1.5} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function MePage() {
  const user = useAuth((s) => s.user)!
  const logout = useAuth((s) => s.logout)
  const nav = useNavigate()
  const { data: site } = useSite()
  const profile = useQuery({ queryKey: ['user', user.username], queryFn: () => api.users.get(user.username) })
  const { data: unread = 0 } = useQuery({
    queryKey: ['unread'],
    queryFn: api.notifications.unreadCount,
    select: (d) => d.count,
  })
  const invites = useQuery({ queryKey: ['me', 'invites'], queryFn: api.me.invites })
  // 等级经验、情侣绑定以服务端为准：每次打开都刷新
  useEffect(() => {
    void useAuth.getState().refreshMe()
  }, [])

  const cur = site?.levels.find((l) => l.level === user.level)
  const nextExp = user.next_level_exp ?? null
  const base = cur?.min_exp ?? 0
  const progress = nextExp ? Math.min(1, Math.max(0, (user.exp - base) / Math.max(1, nextExp - base))) : 1
  const tripInvites = invites.data?.trip_invites.length ?? 0
  const partnerInvites = invites.data?.partner_invites.length ?? 0
  const stats = profile.data?.stats

  const main: LinkItem[] = [
    { to: `/u/${user.username}`, label: '我的主页', icon: User },
    {
      to: '/me/trips',
      label: '我的旅程',
      icon: MapIcon,
      extra: tripInvites > 0 && (
        <Badge>
          <Num>{tripInvites}</Num> 个邀请
        </Badge>
      ),
    },
    { to: '/me/favorites', label: '我的收藏', icon: Bookmark },
    { to: '/footprints', label: '我的足迹', icon: Footprints },
    {
      to: '/together',
      label: '我们（情侣空间）',
      icon: Heart,
      extra: user.partner ? (
        `和 ${user.partner.nickname || user.partner.username}`
      ) : partnerInvites > 0 ? (
        <Badge tone="love">
          <Num>{partnerInvites}</Num> 个邀请
        </Badge>
      ) : (
        '未绑定'
      ),
    },
  ]
  const more: LinkItem[] = [
    {
      to: '/notifications',
      label: '通知',
      icon: Bell,
      extra: unread > 0 && (
        <Badge>
          <Num>{unread > 99 ? '99+' : unread}</Num> 条未读
        </Badge>
      ),
    },
    { to: '/settings', label: '账号设置', icon: Settings },
    ...(isAdmin(user) ? [{ to: '/admin', label: '管理后台', icon: Shield }] : []),
  ]

  return (
    <div className="mx-auto max-w-lg px-4 pt-6 pb-12 md:pt-10">
      {/* 刊头：头像、宋体名字、等级与经验细线 */}
      <header>
        <p className="eyebrow">Traveler · 旅人</p>
        <div className="mt-4 flex items-center gap-4">
          <Avatar user={user} size={68} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[26px] leading-tight text-ink-900">{user.nickname || user.username}</h1>
            <div className="mt-1 flex min-w-0 items-center gap-2 text-sm text-ink-500">
              <span className="truncate">@{user.username}</span>
              {isAdmin(user) && (
                <span className="inline-flex h-4 shrink-0 items-center rounded-sm bg-ink-900 px-1 text-[10px] leading-none text-paper">
                  管理员
                </span>
              )}
            </div>
          </div>
          <Link to="/settings" aria-label="编辑资料" className={buttonClass({ variant: 'outline', size: 'sm', className: 'self-start' })}>
            <PenLine className="size-3.5" strokeWidth={1.75} />
            <span className="max-sm:sr-only">编辑资料</span>
          </Link>
        </div>

        <div className="mt-6">
          <div className="flex items-end justify-between gap-3">
            <div className="flex items-center gap-2">
              <LevelBadge level={user.level} className="h-5 px-1.5 text-xs" />
              <span className="font-display text-[15px] text-ink-900">{user.level_name}</span>
            </div>
            <div className="text-xs text-ink-400">
              经验 <span className="font-num text-xl leading-none text-ink-900">{user.exp}</span>
              {nextExp ? (
                <>
                  {' '}
                  / <span className="font-num">{nextExp}</span>
                </>
              ) : (
                ' · 已满级'
              )}
            </div>
          </div>
          <div
            className="relative mt-2.5 h-[3px] bg-ink-200"
            role="progressbar"
            aria-label="升级进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <div className="absolute inset-y-0 left-0 bg-brand-500" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      </header>

      {/* 数据：大号 Fraunces 数字，竖细线分隔 */}
      <div className="mt-8 grid grid-cols-4 divide-x divide-ink-200 border-y border-ink-200">
        {(
          [
            ['旅程', stats?.trips],
            ['粉丝', stats?.followers],
            ['关注', stats?.following],
            ['获赞', stats?.likes],
          ] as const
        ).map(([label, v]) => (
          <Link
            key={label}
            to={`/u/${user.username}`}
            className="min-w-0 py-4 text-center transition-colors hover:bg-white/55"
          >
            <div className="font-num text-[1.75rem] leading-none text-ink-900">{v == null ? '–' : fmtCount(v)}</div>
            <div className="mt-2 text-xs tracking-wide text-ink-400">{label}</div>
          </Link>
        ))}
      </div>

      <div className="mt-10 space-y-8">
        <LinkGroup title="Journal · 旅行" items={main} />
        <LinkGroup title="Account · 账户" items={more} />
      </div>

      <button
        type="button"
        onClick={async () => {
          // 先离开受保护页面再登出，避免被重定向到登录页
          await nav('/', { replace: true })
          await logout()
        }}
        className="mt-8 flex w-full items-center justify-center gap-2 border-y border-ink-200 py-3.5 text-[15px] text-ink-500 transition-colors hover:bg-white/55 hover:text-brand-600"
      >
        <LogOut className="size-[18px]" strokeWidth={1.5} />
        退出登录
      </button>
    </div>
  )
}
