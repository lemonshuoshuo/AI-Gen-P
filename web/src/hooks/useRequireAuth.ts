import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useAuth } from '@/stores/auth'

/** 返回一个包装器：未登录时跳转登录页，登录后返回当前页 */
export function useRequireAuth() {
  const user = useAuth((s) => s.user)
  const nav = useNavigate()
  const loc = useLocation()
  return useCallback(
    <T,>(fn: () => T): T | undefined => {
      if (!user) {
        toast('请先登录', { description: '登录后即可点赞、收藏、评论和引用路线' })
        nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`)
        return undefined
      }
      return fn()
    },
    [user, nav, loc],
  )
}
