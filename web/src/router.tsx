import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import { createBrowserRouter, Navigate, useLocation, useRouteError } from 'react-router'
import { AppLayout } from '@/components/layout/AppLayout'
import { Button, Empty, PageLoader } from '@/components/ui'
import { isAdmin, useAuth } from '@/stores/auth'

function page(loader: () => Promise<{ default: ComponentType }>) {
  const C = lazy(loader)
  return (
    <Suspense fallback={<PageLoader />}>
      <C />
    </Suspense>
  )
}

function RequireAuth({ children, admin }: { children: ReactNode; admin?: boolean }) {
  const { user, ready } = useAuth()
  const loc = useLocation()
  if (!ready) return <PageLoader />
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  if (admin && !isAdmin(user)) return <Empty title="没有权限" desc="该页面仅管理员可访问" />
  return <>{children}</>
}

function ErrorPage() {
  const err = useRouteError() as Error | undefined
  const chunkError = /dynamically imported module|Failed to fetch/i.test(err?.message ?? '')
  return (
    <Empty
      className="min-h-dvh"
      title={chunkError ? '网站已更新' : '页面出错了'}
      desc={chunkError ? '请刷新页面加载最新版本' : err?.message}
      action={<Button onClick={() => window.location.reload()}>刷新页面</Button>}
    />
  )
}

const auth = (el: ReactNode, admin?: boolean) => <RequireAuth admin={admin}>{el}</RequireAuth>

export const router = createBrowserRouter([
  {
    errorElement: <ErrorPage />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: page(() => import('@/pages/DiscoverPage')) },
          { path: 'search', element: page(() => import('@/pages/SearchPage')) },
          { path: 'places', element: page(() => import('@/pages/PlacesPage')) },
          { path: 'places/:id', element: page(() => import('@/pages/PlacePage')) },
          { path: 'trips/new', element: auth(page(() => import('@/pages/NewTripPage'))) },
          { path: 'trips/:id', element: page(() => import('@/pages/TripDetailPage')) },
          { path: 's/:code', element: page(() => import('@/pages/TripDetailPage')) },
          { path: 'trips/:id/edit', element: auth(page(() => import('@/pages/TripEditPage'))) },
          { path: 'trips/:id/compare', element: page(() => import('@/pages/ComparePage')) },
          { path: 'footprints', element: auth(page(() => import('@/pages/FootprintsPage'))) },
          { path: 'together', element: auth(page(() => import('@/pages/TogetherPage'))) },
          { path: 'u/:username', element: page(() => import('@/pages/UserPage')) },
          { path: 'me', element: auth(page(() => import('@/pages/MePage'))) },
          { path: 'me/trips', element: auth(page(() => import('@/pages/MyTripsPage'))) },
          { path: 'me/favorites', element: auth(page(() => import('@/pages/FavoritesPage'))) },
          { path: 'notifications', element: auth(page(() => import('@/pages/NotificationsPage'))) },
          { path: 'settings', element: auth(page(() => import('@/pages/SettingsPage'))) },
          { path: 'admin/*', element: auth(page(() => import('@/pages/admin/AdminPage')), true) },
          { path: '*', element: <Empty className="min-h-[60vh]" title="页面不存在" desc="你要找的页面可能已被删除或移动" /> },
        ],
      },
      // 全屏页面
      { path: 'login', element: page(() => import('@/pages/LoginPage')) },
      { path: 'register', element: page(() => import('@/pages/LoginPage')) },
      { path: 'trips/:id/go', element: auth(page(() => import('@/pages/TravelModePage'))) },
      { path: 'trips/:id/replay', element: page(() => import('@/pages/ReplayPage')) },
      { path: 'together/replay', element: auth(page(() => import('@/pages/ReplayPage'))) },
    ],
  },
])
