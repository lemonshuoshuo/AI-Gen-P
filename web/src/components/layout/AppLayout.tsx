import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  Bookmark,
  Compass,
  Footprints,
  Heart,
  LogOut,
  Map as MapIcon,
  MapPinned,
  Plus,
  Search,
  Settings,
  Shield,
  User,
} from 'lucide-react'
import { api } from '@/api'
import { Avatar, Button, Menu, MenuItem } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'
import { isAdmin, useAuth } from '@/stores/auth'

export function Logo({ className, light }: { className?: string; light?: boolean }) {
  return (
    <Link to="/" className={cn('flex items-center gap-2', className)}>
      <span className="bg-brand-gradient flex size-8 items-center justify-center rounded-xl shadow-sm shadow-brand-500/30">
        <MapPinned className="size-4.5 text-white" />
      </span>
      <span className={cn('text-lg font-extrabold tracking-tight', light ? 'text-white' : 'text-ink-900')}>
        Trip<span className={light ? 'text-brand-300' : 'text-brand-gradient'}>Hub</span>
      </span>
    </Link>
  )
}

const navItems = [
  { to: '/', label: '发现', icon: Compass, end: true },
  { to: '/places', label: '打卡地', icon: MapIcon },
  { to: '/footprints', label: '我的足迹', icon: Footprints },
  { to: '/together', label: '我们', icon: Heart },
]

function useUnread() {
  const user = useAuth((s) => s.user)
  return useQuery({
    queryKey: ['unread'],
    queryFn: api.notifications.unreadCount,
    enabled: !!user,
    refetchInterval: 60_000,
    select: (d) => d.count,
  })
}

function HeaderSearch() {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`)
      }}
      className="relative hidden w-56 lg:block"
    >
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索旅程、城市、打卡地"
        className="h-9 w-full rounded-full bg-ink-100 pr-3 pl-9 text-sm outline-none placeholder:text-ink-400 focus:bg-white focus:ring-2 focus:ring-brand-200"
      />
    </form>
  )
}

function UserMenu() {
  const user = useAuth((s) => s.user)!
  const logout = useAuth((s) => s.logout)
  const nav = useNavigate()
  return (
    <Menu
      trigger={(toggle) => (
        <button type="button" onClick={toggle} className="rounded-full ring-brand-200 transition hover:ring-4">
          <Avatar user={user} size={34} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="border-b border-ink-100 px-4 pt-1.5 pb-2.5">
            <div className="truncate font-semibold">{user.nickname || user.username}</div>
            <div className="text-xs text-ink-400">
              Lv{user.level} {user.level_name} · {user.exp} 经验
            </div>
          </div>
          <MenuItem icon={<User className="size-4" />} onClick={() => (close(), nav(`/u/${user.username}`))}>
            我的主页
          </MenuItem>
          <MenuItem icon={<MapIcon className="size-4" />} onClick={() => (close(), nav('/me/trips'))}>
            我的旅程
          </MenuItem>
          <MenuItem icon={<Bookmark className="size-4" />} onClick={() => (close(), nav('/me/favorites'))}>
            我的收藏
          </MenuItem>
          <MenuItem icon={<Settings className="size-4" />} onClick={() => (close(), nav('/settings'))}>
            账号设置
          </MenuItem>
          {isAdmin(user) && (
            <MenuItem icon={<Shield className="size-4" />} onClick={() => (close(), nav('/admin'))}>
              管理后台
            </MenuItem>
          )}
          <div className="my-1 border-t border-ink-100" />
          <MenuItem
            icon={<LogOut className="size-4" />}
            danger
            onClick={async () => {
              close()
              await logout()
              nav('/')
            }}
          >
            退出登录
          </MenuItem>
        </>
      )}
    </Menu>
  )
}

function BellLink() {
  const { data: unread } = useUnread()
  return (
    <Link
      to="/notifications"
      className="relative inline-flex size-9 items-center justify-center rounded-full text-ink-700 hover:bg-ink-100"
      aria-label="通知"
    >
      <Bell className="size-5" />
      {!!unread && (
        <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-bold text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  )
}

function Header() {
  const user = useAuth((s) => s.user)
  const nav = useNavigate()
  return (
    <header className="glass sticky top-0 z-40 border-b border-ink-200/60">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Logo />
        <nav className="ml-4 hidden items-center gap-1 md:flex">
          {navItems.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  'rounded-full px-3.5 py-1.5 text-sm font-medium transition',
                  isActive ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900',
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex-1" />
        <HeaderSearch />
        <Link to="/search" className="inline-flex size-9 items-center justify-center rounded-full hover:bg-ink-100 lg:hidden" aria-label="搜索">
          <Search className="size-5 text-ink-700" />
        </Link>
        {user ? (
          <>
            <Button size="sm" icon={<Plus className="size-4" />} className="hidden md:inline-flex" onClick={() => nav('/trips/new')}>
              新旅程
            </Button>
            <BellLink />
            <div className="hidden md:block">
              <UserMenu />
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => nav('/login')}>
              登录
            </Button>
            <Button size="sm" onClick={() => nav('/register')}>
              注册
            </Button>
          </div>
        )}
      </div>
    </header>
  )
}

function TabItem({ to, icon: Icon, label, end }: { to: string; icon: typeof Compass; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn('flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[11px] font-medium', isActive ? 'text-brand-600' : 'text-ink-400')
      }
    >
      <Icon className="size-5.5" />
      {label}
    </NavLink>
  )
}

function MobileTabBar() {
  const user = useAuth((s) => s.user)
  const nav = useNavigate()
  return (
    <nav className="glass pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-ink-200/60 md:hidden">
      <div className="flex items-end px-2">
        <TabItem to="/" icon={Compass} label="发现" end />
        <TabItem to="/places" icon={MapIcon} label="打卡地" />
        <div className="flex flex-1 justify-center">
          <button
            type="button"
            onClick={() => nav(user ? '/trips/new' : '/login')}
            aria-label="新旅程"
            className="bg-brand-gradient -mt-4 flex size-12 items-center justify-center rounded-2xl text-white shadow-lg shadow-brand-500/40"
          >
            <Plus className="size-6" />
          </button>
        </div>
        <TabItem to="/footprints" icon={Footprints} label="足迹" />
        <TabItem to={user ? `/me` : '/login'} icon={User} label="我的" />
      </div>
    </nav>
  )
}

function Announcement() {
  const { data } = useSite()
  const [hidden, setHidden] = useState(false)
  if (!data?.announcement || hidden) return null
  return (
    <div className="bg-brand-50 text-brand-800">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2 text-sm">
        <span className="flex-1">📢 {data.announcement}</span>
        <button type="button" className="text-brand-600" onClick={() => setHidden(true)}>
          知道了
        </button>
      </div>
    </div>
  )
}

export function AppLayout({ children }: { children?: ReactNode }) {
  const loc = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [loc.pathname])
  return (
    <div className="min-h-dvh pb-20 md:pb-0">
      <Header />
      <Announcement />
      <main>{children ?? <Outlet />}</main>
      <MobileTabBar />
    </div>
  )
}
