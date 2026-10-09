import { useEffect, useState, type ReactNode } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  Bookmark,
  Compass,
  Footprints,
  Heart,
  LogOut,
  Map as MapIcon,
  Plus,
  Search,
  Settings,
  Shield,
  User,
  X,
} from 'lucide-react'
import { api } from '@/api'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { useSpaceInvites } from '@/components/space'
import { Avatar, Button, Menu, MenuItem } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'
import { isAdmin, useAuth } from '@/stores/auth'
import { ThemeMenuSection, ThemeToggle } from '@/theme/ThemeControls'

/** 标识：细线圆框里一个宋体「迹」 */
export function SealMark({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn('font-display inline-flex shrink-0 items-center justify-center rounded-full border border-current/35 text-current', className)}
      style={{ width: size, height: size, fontSize: size * 0.5 }}
      aria-hidden
    >
      迹
    </span>
  )
}

/** 字标：Cormorant 的「TripHub」+ 细小的「旅迹」 */
export function Logo({ className, light }: { className?: string; light?: boolean }) {
  return (
    <Link to="/" className={cn('flex items-baseline gap-2', light ? 'text-white' : 'text-ink-900', className)} aria-label="TripHub 首页">
      <span className="font-display text-[25px] leading-none font-normal tracking-[0.005em]">TripHub</span>
      <span className={cn('hidden text-[10px] tracking-[0.4em] sm:inline', light ? 'text-white/55' : 'text-ink-400')}>旅迹</span>
    </Link>
  )
}

const navItems: { to: string; label: string; icon: typeof Compass; end?: boolean; also?: string[] }[] = [
  { to: '/', label: '发现', icon: Compass, end: true },
  { to: '/places', label: '打卡地', icon: MapIcon },
  { to: '/footprints', label: '我的足迹', icon: Footprints },
  // 「我们」：/together 打开默认空间或总览，空间页都算在「我们」里
  { to: '/together', label: '我们', icon: Heart, also: ['/spaces'] },
]

/** 路径是否属于某个导航项（prefix 的子路径也算） */
function under(pathname: string, prefixes: string[]) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/** 待我回应的空间邀请数：「我们」上的小圆点 */
function useIncomingSpaceInvites() {
  const user = useAuth((s) => s.user)
  const { data } = useSpaceInvites({ poll: true })
  return user ? (data?.incoming.length ?? 0) : 0
}

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
      <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-400" strokeWidth={1.75} />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索旅程、城市、打卡地"
        className="h-8.5 w-full rounded-full border border-ink-200 bg-transparent pr-3 pl-8.5 text-[13px] outline-none placeholder:text-ink-400 hover:border-ink-300 focus:border-ink-600"
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
      trigger={(toggle, open) => (
        <button
          type="button"
          onClick={toggle}
          aria-label="账户菜单"
          aria-expanded={open}
          className="rounded-full ring-ink-900/20 transition hover:ring-2"
        >
          <Avatar user={user} size={32} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="border-b border-ink-200 px-4 pt-2 pb-3">
            <div className="font-display truncate text-lg">{user.nickname || user.username}</div>
            <div className="mt-0.5 text-xs text-ink-400">
              <span className="font-num italic">Lv.{user.level}</span> {user.level_name} · {user.exp} 经验
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
          {/* 外观：深浅色 + 主题快捷切换 */}
          <ThemeMenuSection onNavigate={close} />
          <div className="my-1 border-t border-ink-200" />
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
      className="relative inline-flex size-9 items-center justify-center rounded-full text-ink-700 transition hover:bg-ink-900/[0.07] hover:text-ink-900"
      aria-label="通知"
    >
      <Bell className="size-[18px]" strokeWidth={1.4} />
      {!!unread && (
        <span className="absolute top-1 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-fill px-1 text-[9.5px] font-semibold text-on-brand tabular-nums ring-2 ring-paper">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  )
}

function Header() {
  const user = useAuth((s) => s.user)
  const nav = useNavigate()
  const { pathname } = useLocation()
  const invites = useIncomingSpaceInvites()
  return (
    // 三栏：左侧导航、正中字标、右侧操作（窄屏时字标靠左）
    <header className="glass sticky top-0 z-40 border-b border-ink-200">
      <div className="mx-auto grid h-15 max-w-[90rem] grid-cols-[auto_1fr_auto] items-center gap-4 px-4 md:grid-cols-[1fr_auto_1fr] md:px-8">
        <nav className="hidden items-center gap-7 md:flex">
          {navItems.map((n) => {
            const active = n.end ? pathname === n.to : under(pathname, [n.to, ...(n.also ?? [])])
            const dot = n.to === '/together' && invites > 0
            return (
              <Link
                key={n.to}
                to={n.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  // 当前页：主文字色 + 600 + 贴着顶栏底边的 2px 强调色横线
                  'relative inline-flex items-center gap-1.5 py-1 text-[13px] tracking-[0.04em] transition-colors duration-300',
                  active
                    ? 'font-semibold text-ink-900 after:absolute after:inset-x-0 after:-bottom-[21px] after:h-[2px] after:rounded-full after:bg-brand-600'
                    : 'text-ink-500 hover:text-ink-900',
                )}
              >
                {n.label}
                {dot && (
                  <>
                    <span aria-hidden className="size-1.5 rounded-full bg-brand-500" />
                    <span className="sr-only">（{invites} 个待回应的空间邀请）</span>
                  </>
                )}
              </Link>
            )
          })}
        </nav>
        <Logo className="md:justify-self-center" />
        <div className="flex items-center justify-end gap-1.5 md:gap-2">
        <HeaderSearch />
        <Link to="/search" className="inline-flex size-9 items-center justify-center rounded-full transition hover:bg-ink-900/[0.07] lg:hidden" aria-label="搜索">
          <Search className="size-[18px] text-ink-700" strokeWidth={1.4} />
        </Link>
        {/* 外观：太阳 / 月亮，点开切换深浅色与主题 */}
        <ThemeToggle />
        {user ? (
          <>
            <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />} className="hidden md:inline-flex" onClick={() => nav('/trips/new')}>
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
      </div>
    </header>
  )
}

function TabItem({
  to,
  icon: Icon,
  label,
  active,
  dot,
}: {
  to: string
  icon: typeof Compass
  label: string
  active: boolean
  /** 右上角的小圆点（如待回应的邀请） */
  dot?: string
}) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex flex-1 flex-col items-center gap-1 pt-2 pb-1.5 text-[10.5px] tracking-[0.08em] transition-colors',
        active ? 'font-semibold text-ink-900' : 'text-ink-500',
      )}
    >
      {/* 当前页：顶部一道强调色短横 + 强调色图标 + 加粗标签 */}
      <span aria-hidden className={cn('absolute top-0 h-[2px] w-7 rounded-full transition-colors', active ? 'bg-brand-600' : 'bg-transparent')} />
      <span className="relative">
        <Icon className={cn('size-5', active && 'text-brand-600')} strokeWidth={active ? 1.75 : 1.3} />
        {dot && <span aria-hidden className="absolute -top-0.5 -right-1 size-2 rounded-full bg-brand-500 ring-2 ring-paper" />}
      </span>
      {label}
      {dot && <span className="sr-only">（{dot}）</span>}
    </Link>
  )
}

function MobileTabBar() {
  const user = useAuth((s) => s.user)
  const nav = useNavigate()
  const { pathname } = useLocation()
  const invites = useIncomingSpaceInvites()
  return (
    <nav className="glass pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-ink-200 md:hidden">
      <div className="flex items-end px-2">
        {/* 发现包括打卡地与搜索（打卡地的入口在发现页顶部和搜索页里） */}
        <TabItem to="/" icon={Compass} label="发现" active={pathname === '/' || under(pathname, ['/places', '/search'])} />
        <TabItem
          to="/together"
          icon={Heart}
          label="我们"
          active={under(pathname, ['/together', '/spaces'])}
          dot={invites > 0 ? `${invites} 个待回应的空间邀请` : undefined}
        />
        <div className="flex flex-1 justify-center">
          <button
            type="button"
            onClick={() => nav(user ? '/trips/new' : '/login')}
            aria-label="新旅程"
            className="-mt-3 flex size-11 items-center justify-center rounded-full bg-ink-900 text-paper ring-[5px] ring-paper"
          >
            <Plus className="size-5" strokeWidth={1.75} />
          </button>
        </div>
        <TabItem to="/footprints" icon={Footprints} label="足迹" active={under(pathname, ['/footprints'])} />
        <TabItem to={user ? `/me` : '/login'} icon={User} label="我的" active={under(pathname, ['/me', '/settings'])} />
      </div>
    </nav>
  )
}

// 旅行中的旅程：顶部一条快捷入口，回到旅行模式只需一步（PWA 从桌面图标启动时总是先到首页）
const ONGOING_DISMISSED_KEY = 'triphub.ongoing-dismissed'

function OngoingTripBar() {
  const user = useAuth((s) => s.user)
  const loc = useLocation()
  const [dismissed, setDismissed] = useState<number | null>(() => {
    try {
      return Number(sessionStorage.getItem(ONGOING_DISMISSED_KEY)) || null
    } catch {
      return null
    }
  })
  const { data: trip } = useQuery({
    queryKey: ['my-trips', 'ongoing', user?.id],
    queryFn: () => api.me.trips({ phase: 'ongoing', page_size: 1 }),
    enabled: !!user,
    staleTime: 0,
    select: (d) => d.items[0] ?? null,
  })
  if (!user || !trip || trip.id === dismissed) return null
  // 旅程详情 / 编辑页自带「继续旅行」按钮
  if (loc.pathname === `/trips/${trip.id}` || loc.pathname.startsWith(`/trips/${trip.id}/`)) return null
  const dismiss = () => {
    setDismissed(trip.id)
    try {
      sessionStorage.setItem(ONGOING_DISMISSED_KEY, String(trip.id))
    } catch {
      /* 忽略 */
    }
  }
  return (
    <div className="border-b border-ink-200 bg-surface text-ink-900">
      <div className="mx-auto flex max-w-[90rem] items-center gap-2 px-4 text-[13px] md:px-8">
        <Link to={`/trips/${trip.id}/go`} className="flex min-w-0 flex-1 items-center gap-2 py-2">
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-brand-400" />
          </span>
          <span className="eyebrow shrink-0">On the road</span>
          <span className="font-display min-w-0 flex-1 truncate text-base">{trip.title}</span>
          <span className="shrink-0 text-ink-600">继续旅行 →</span>
        </Link>
        <button type="button" onClick={dismiss} className="-mr-2 shrink-0 rounded-full p-1.5 text-ink-500 hover:bg-ink-900/[0.07] hover:text-ink-900" aria-label="暂时隐藏">
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}

function Announcement() {
  const { data } = useSite()
  const [hidden, setHidden] = useState(false)
  if (!data?.announcement || hidden) return null
  return (
    <div className="border-b border-ink-200 bg-surface">
      <div className="mx-auto flex max-w-[90rem] items-center gap-3 px-4 py-2 text-[13px] text-ink-600 md:px-8">
        <span className="eyebrow shrink-0 !text-brand-600">Notice</span>
        <span className="flex-1">{data.announcement}</span>
        <button type="button" className="text-ink-400 hover:text-ink-900" onClick={() => setHidden(true)}>
          知道了
        </button>
      </div>
    </div>
  )
}

export function AppLayout({ children }: { children?: ReactNode }) {
  const loc = useLocation()
  // 路线编辑页在手机上需要尽量多的空间（吸顶地图 + 列表 + 键盘）：不显示页脚和底部导航
  const immersive = /^\/trips\/[^/]+\/edit\/?$/.test(loc.pathname)
  useEffect(() => {
    window.scrollTo(0, 0)
    // 换页时按需刷新用户信息（对方接受了情侣邀请、经验和存储空间变化等）
    useAuth.getState().refreshMeIfStale()
  }, [loc.pathname])
  return (
    // 纵向 flex：内容不满一屏时页脚仍在底部；手机上 pb-20 给底部导航留位置，页脚在它上方
    // 编辑页在桌面上正好占满一屏（顶栏、公告、旅行中提示条的高度都不固定，由 flex 分配剩余高度）
    <div className={cn('flex min-h-dvh flex-col', immersive ? 'md:h-dvh' : 'pb-20 md:pb-0')}>
      <Header />
      <Announcement />
      <OngoingTripBar />
      <main className={cn('flex-1', immersive && 'md:min-h-0')}>{children ?? <Outlet />}</main>
      {!immersive && <SiteFooter />}
      {!immersive && <MobileTabBar />}
    </div>
  )
}
