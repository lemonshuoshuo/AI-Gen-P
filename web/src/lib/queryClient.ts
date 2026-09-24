import { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api'

// 单独成模块：登录 / 退出时 stores/auth 需要清空缓存，避免下一个人看到上一个账号的数据
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
})

// 与账号无关的站点配置、行政区划数据保留：BaseMap 等站点配置加载完才创建地图，清掉会让页面上的地图重建
const SHARED_ROOTS = new Set(['site', 'atlas'])

/** 登录、退出、切换账号时清空与账号相关的缓存（私密旅程、通知、旅程的 can_edit / liked 等） */
export function clearUserCache() {
  queryClient.removeQueries({ predicate: (q) => !SHARED_ROOTS.has(String(q.queryKey[0])) })
}
