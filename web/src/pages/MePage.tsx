import type { ReactNode } from 'react'
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
import { Avatar, Card, LevelBadge } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'
import { fmtCount } from '@/lib/format'
import { isAdmin, useAuth } from '@/stores/auth'

interface LinkItem {
  to: string
  label: string
  icon: LucideIcon
  color: string
  extra?: ReactNode
}

function Badge({ children, tone = 'brand' }: { children: ReactNode; tone?: 'brand' | 'love' }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold text-white',
        tone === 'love' ? 'bg-love-gradient' : 'bg-brand-500',
      )}
    >
      {children}
    </span>
  )
}

function LinkGroup({ items }: { items: LinkItem[] }) {
  return (
    <Card className="divide-y divide-ink-100 overflow-hidden">
      {items.map((it) => (
        <Link key={it.to} to={it.to} className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-ink-50 active:bg-ink-100">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl text-white" style={{ background: it.color }}>
            <it.icon className="size-4.5" />
          </span>
          <span className="flex-1 text-[15px] font-medium text-ink-900">{it.label}</span>
          {it.extra && <span className="min-w-0 truncate text-sm text-ink-400">{it.extra}</span>}
          <ChevronRight className="size-4 shrink-0 text-ink-300" />
        </Link>
      ))}
    </Card>
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

  const cur = site?.levels.find((l) => l.level === user.level)
  const nextExp = user.next_level_exp ?? null
  const base = cur?.min_exp ?? 0
  const progress = nextExp ? Math.min(1, Math.max(0, (user.exp - base) / Math.max(1, nextExp - base))) : 1
  const tripInvites = invites.data?.trip_invites.length ?? 0
  const partnerInvites = invites.data?.partner_invites.length ?? 0
  const stats = profile.data?.stats

  const main: LinkItem[] = [
    { to: `/u/${user.username}`, label: '我的主页', icon: User, color: '#0ea5e9' },
    {
      to: '/me/trips',
      label: '我的旅程',
      icon: MapIcon,
      color: '#ff5a5f',
      extra: tripInvites > 0 && <Badge>{tripInvites} 个邀请</Badge>,
    },
    { to: '/me/favorites', label: '我的收藏', icon: Bookmark, color: '#f59e0b' },
    { to: '/footprints', label: '我的足迹', icon: Footprints, color: '#10b981' },
    {
      to: '/together',
      label: '我们（情侣空间）',
      icon: Heart,
      color: '#ec4899',
      extra: user.partner ? (
        `和 ${user.partner.nickname || user.partner.username}`
      ) : partnerInvites > 0 ? (
        <Badge tone="love">{partnerInvites} 个邀请</Badge>
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
      color: '#8b5cf6',
      extra: unread > 0 && <Badge>{unread > 99 ? '99+' : unread}</Badge>,
    },
    { to: '/settings', label: '账号设置', icon: Settings, color: '#64748b' },
    ...(isAdmin(user) ? [{ to: '/admin', label: '管理后台', icon: Shield, color: '#1c1b22' }] : []),
  ]

  return (
    <div className="mx-auto max-w-lg space-y-4 px-4 py-6">
      {/* 资料卡 */}
      <div className="bg-brand-gradient relative overflow-hidden rounded-3xl p-5 text-white shadow-lg shadow-brand-500/20">
        <div className="pointer-events-none absolute -top-16 -right-10 size-48 rounded-full bg-white/10" />
        <div className="relative flex items-center gap-4">
          <Avatar user={user} size={64} ring />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xl font-extrabold">{user.nickname || user.username}</div>
            <div className="truncate text-sm text-white/75">@{user.username}</div>
            <div className="mt-1.5 flex items-center gap-1.5 text-sm">
              <LevelBadge level={user.level} className="ring-1 ring-white/60" />
              <span className="font-medium">{user.level_name}</span>
              {isAdmin(user) && <span className="rounded bg-white/20 px-1.5 text-xs">管理员</span>}
            </div>
          </div>
          <Link
            to="/settings"
            aria-label="编辑资料"
            className="flex size-9 shrink-0 items-center justify-center self-start rounded-full bg-white/20 transition hover:bg-white/30"
          >
            <PenLine className="size-4" />
          </Link>
        </div>
        <div className="relative mt-4">
          <div className="flex justify-between text-xs text-white/80 tabular-nums">
            <span>经验 {user.exp}</span>
            <span>{nextExp ? `下一级 ${nextExp}` : '已满级'}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/25">
            <div className="h-full rounded-full bg-white" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      </div>

      {/* 数据 */}
      <Card className="grid grid-cols-4 py-3.5 text-center">
        {(
          [
            ['旅程', stats?.trips],
            ['粉丝', stats?.followers],
            ['关注', stats?.following],
            ['获赞', stats?.likes],
          ] as const
        ).map(([label, v]) => (
          <Link key={label} to={`/u/${user.username}`} className="min-w-0">
            <div className="text-lg font-bold tabular-nums">{v == null ? '–' : fmtCount(v)}</div>
            <div className="text-xs text-ink-400">{label}</div>
          </Link>
        ))}
      </Card>

      <LinkGroup items={main} />
      <LinkGroup items={more} />

      <Card className="overflow-hidden">
        <button
          type="button"
          onClick={async () => {
            // 先离开受保护页面再登出，避免被重定向到登录页
            await nav('/', { replace: true })
            await logout()
          }}
          className="flex w-full items-center justify-center gap-2 py-3.5 text-[15px] font-medium text-red-600 transition hover:bg-red-50"
        >
          <LogOut className="size-4.5" />
          退出登录
        </button>
      </Card>
    </div>
  )
}
