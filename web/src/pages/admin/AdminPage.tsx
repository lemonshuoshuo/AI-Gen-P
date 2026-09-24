import { NavLink, Navigate, Route, Routes } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Flag, LayoutDashboard, MessageSquare, Route as RouteIcon, Settings, Shield, Users, type LucideIcon } from 'lucide-react'
import { api } from '@/api'
import { CommentsPanel } from '@/components/admin/CommentsPanel'
import { Overview } from '@/components/admin/Overview'
import { ReportsPanel } from '@/components/admin/ReportsPanel'
import { SettingsPanel } from '@/components/admin/SettingsPanel'
import { TripsPanel } from '@/components/admin/TripsPanel'
import { UsersPanel } from '@/components/admin/UsersPanel'
import { cn } from '@/lib/cn'

const sections: { path: string; label: string; icon: LucideIcon }[] = [
  { path: '', label: '概览', icon: LayoutDashboard },
  { path: 'users', label: '用户管理', icon: Users },
  { path: 'trips', label: '内容管理', icon: RouteIcon },
  { path: 'comments', label: '评论管理', icon: MessageSquare },
  { path: 'reports', label: '举报处理', icon: Flag },
  { path: 'settings', label: '站点设置', icon: Settings },
]

const toOf = (path: string) => (path ? `/admin/${path}` : '/admin')

function CountBadge({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-bold text-white tabular-nums',
        className,
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  )
}

export default function AdminPage() {
  const { data: pendingReports = 0 } = useQuery({
    queryKey: ['admin', 'reports', 'pending-count'],
    queryFn: () => api.admin.reports({ status: 'pending', page_size: 1 }),
    select: (d) => d.total,
    refetchInterval: 120_000,
  })
  // 待审核的公开旅程；内容管理里通过 / 驳回后会让 ['admin', 'trips'] 失效，角标随之刷新
  const { data: pendingTrips = 0 } = useQuery({
    queryKey: ['admin', 'trips', 'pending-count'],
    queryFn: () => api.admin.trips({ status: 'pending', page_size: 1 }),
    select: (d) => d.total,
    refetchInterval: 120_000,
  })
  const badgeOf = (path: string) => (path === 'reports' ? pendingReports : path === 'trips' ? pendingTrips : 0)

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="flex items-center gap-2.5">
        <span className="flex size-9 items-center justify-center rounded-xl bg-ink-900 text-white">
          <Shield className="size-4.5" />
        </span>
        <h1 className="text-2xl font-extrabold">管理后台</h1>
      </div>

      <div className="mt-5 md:grid md:grid-cols-[176px_minmax(0,1fr)] md:gap-6">
        {/* 桌面端侧边导航 */}
        <nav className="hidden md:block" aria-label="管理后台导航">
          <div className="sticky top-20 space-y-1">
            {sections.map((s) => (
              <NavLink
                key={s.path}
                to={toOf(s.path)}
                end={!s.path}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition',
                    isActive ? 'bg-white text-ink-900 shadow-card' : 'text-ink-500 hover:bg-white/70 hover:text-ink-900',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <s.icon className={cn('size-4.5', isActive && 'text-brand-500')} />
                    {s.label}
                    {badgeOf(s.path) > 0 && <CountBadge n={badgeOf(s.path)} className="ml-auto" />}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </nav>

        {/* 移动端横向滚动标签 */}
        <nav className="scrollbar-none -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 md:hidden" aria-label="管理后台导航">
          {sections.map((s) => (
            <NavLink
              key={s.path}
              to={toOf(s.path)}
              end={!s.path}
              className={({ isActive }) =>
                cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition',
                  isActive ? 'bg-ink-900 text-white' : 'bg-white text-ink-500 shadow-card',
                )
              }
            >
              <s.icon className="size-4" />
              {s.label}
              {badgeOf(s.path) > 0 && <CountBadge n={badgeOf(s.path)} />}
            </NavLink>
          ))}
        </nav>

        <section className="min-w-0">
          <Routes>
            <Route index element={<Overview />} />
            <Route path="users" element={<UsersPanel />} />
            <Route path="trips" element={<TripsPanel />} />
            <Route path="comments" element={<CommentsPanel />} />
            <Route path="reports" element={<ReportsPanel />} />
            <Route path="settings" element={<SettingsPanel />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </section>
      </div>
    </div>
  )
}
