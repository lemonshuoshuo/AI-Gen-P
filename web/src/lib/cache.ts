import type { QueryClient } from '@tanstack/react-query'

// 旅程新建 / 删除 / 改信息 / 阶段流转后调用：列表、个人统计、足迹缓存失效（当前挂载的立即重拉，其余下次进入时重拉）
// 不含旅程详情 ['trip', id]，由调用方自行更新
const TRIP_LIST_ROOTS = new Set([
  'trips',
  'my-trips',
  'my-favorites',
  'user',
  'user-trips',
  'user-footprints',
  'my-footprints',
  'partner-trips',
  'partner-footprints',
  // 空间：列表上的旅程数 / 最近一次旅程、空间页的统计、足迹与旅程
  'spaces',
  'space',
  'space-trips',
  'space-footprints',
  'search-trips',
])

export function invalidateTripLists(qc: QueryClient) {
  return qc.invalidateQueries({ predicate: (q) => TRIP_LIST_ROOTS.has(String(q.queryKey[0])) })
}
