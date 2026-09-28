import { useEffect, useRef } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { CommentsPanel } from '@/components/admin/CommentsPanel'
import { DiagnosticsPanel } from '@/components/admin/DiagnosticsPanel'
import { Overview } from '@/components/admin/Overview'
import { ReportsPanel } from '@/components/admin/ReportsPanel'
import { SettingsPanel } from '@/components/admin/SettingsPanel'
import { TripsPanel } from '@/components/admin/TripsPanel'
import { UsersPanel } from '@/components/admin/UsersPanel'
import { cn } from '@/lib/cn'

const sections: { path: string; label: string }[] = [
  { path: '', label: '概览' },
  { path: 'users', label: '用户管理' },
  { path: 'trips', label: '内容管理' },
  { path: 'comments', label: '评论管理' },
  { path: 'reports', label: '举报处理' },
  { path: 'settings', label: '站点设置' },
  { path: 'diagnostics', label: '系统诊断' },
]

const toOf = (path: string) => (path ? `/admin/${path}` : '/admin')

/** 待处理数量：朱砂小圆点 + 小号 Cormorant 数字，不用色块 */
function Count({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-num text-[13px] leading-none text-brand-700">
      <span className="size-1 rounded-full bg-brand-500" aria-hidden />
      <span aria-hidden>{n > 99 ? '99+' : n}</span>
      <span className="sr-only">
        （{n} 条{label}）
      </span>
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
  const badgeLabel = (path: string) => (path === 'reports' ? '待处理举报' : '待审核旅程')

  // 手机上的横向标签：当前项（如靠后的「系统诊断」）滚动到可见位置，只滚动标签条本身
  const { pathname } = useLocation()
  const tabsRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const bar = tabsRef.current
    const el = bar?.querySelector<HTMLElement>('[aria-current="page"]')
    if (bar && el) bar.scrollLeft = el.offsetLeft - (bar.clientWidth - el.offsetWidth) / 2
  }, [pathname])

  return (
    <div className="mx-auto max-w-[90rem] px-4 pt-10 pb-24 md:px-8 md:pt-20 md:pb-32">
      <div className="md:grid md:grid-cols-[12rem_minmax(0,1fr)] md:gap-12 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-20">
        {/* 桌面端侧边导航：安静的目录，细线分隔；当前项象牙白 + 左侧一道细线 */}
        <nav className="hidden md:block" aria-label="管理后台导航">
          <div className="animate-fade-in sticky top-24">
            <div className="flex min-h-12 items-center border-t border-ink-200 pt-3 pb-1">
              <p className="eyebrow !text-ink-800">Console</p>
            </div>
            <p className="font-display mt-8 text-[2rem] leading-tight text-ink-900 md:mt-12">管理后台</p>
            <ul className="mt-10 border-t border-ink-200">
              {sections.map((s, i) => (
                <li key={s.path} className="border-b border-ink-200">
                  <NavLink
                    to={toOf(s.path)}
                    end={!s.path}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex h-12 items-center gap-4 pr-1 pl-4 text-[14px] tracking-wide transition-colors duration-300',
                        isActive ? 'text-ink-900' : 'text-ink-500 hover:text-ink-900',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute inset-y-3.5 left-0 w-px bg-ink-900" aria-hidden />}
                        <span
                          className={cn(
                            'font-num w-5 text-[13px] transition-colors duration-300',
                            isActive ? 'text-ink-900' : 'text-ink-400 group-hover:text-ink-700',
                          )}
                        >
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <span>{s.label}</span>
                        {badgeOf(s.path) > 0 && (
                          <span className="ml-auto">
                            <Count n={badgeOf(s.path)} label={badgeLabel(s.path)} />
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        {/* 移动端：细线标签行 + 横向滚动的文字标签 */}
        <div className="md:hidden">
          <div className="flex min-h-12 items-center border-t border-ink-200 pt-3 pb-1">
            <p className="eyebrow !text-ink-800">Console · 管理后台</p>
          </div>
          <nav
            ref={tabsRef}
            className="scrollbar-none relative -mx-4 mt-2 mb-10 flex gap-7 overflow-x-auto border-b border-ink-200 px-4"
            aria-label="管理后台导航"
          >
            {sections.map((s) => (
              <NavLink
                key={s.path}
                to={toOf(s.path)}
                end={!s.path}
                className={({ isActive }) =>
                  cn(
                    'relative inline-flex h-12 shrink-0 items-center gap-1.5 text-[14px] whitespace-nowrap transition-colors duration-300',
                    isActive ? 'text-ink-900' : 'text-ink-400 hover:text-ink-700',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {s.label}
                    {badgeOf(s.path) > 0 && <Count n={badgeOf(s.path)} label={badgeLabel(s.path)} />}
                    {isActive && <span className="absolute right-0 -bottom-px left-0 h-px bg-ink-900" aria-hidden />}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </div>

        <section className="min-w-0">
          <Routes>
            <Route index element={<Overview />} />
            <Route path="users" element={<UsersPanel />} />
            <Route path="trips" element={<TripsPanel />} />
            <Route path="comments" element={<CommentsPanel />} />
            <Route path="reports" element={<ReportsPanel />} />
            <Route path="settings" element={<SettingsPanel />} />
            <Route path="diagnostics" element={<DiagnosticsPanel />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </section>
      </div>
    </div>
  )
}
