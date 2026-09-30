import { Link, Navigate, useSearchParams } from 'react-router'
import { useSpaces } from '@/components/space'
import { LoadError, PageLoader, buttonClass } from '@/components/ui'
import { useAuth } from '@/stores/auth'

/**
 * 「我们」的入口（/together）：设置了默认空间就打开它；否则只有一个空间时打开它，
 * 没有或有多个空间时打开总览（/spaces），再点进某个空间。
 * 旧的邀请链接 /together?invite=用户名 转到总览，在那里一键邀请链接的主人
 */
export default function TogetherPage() {
  const me = useAuth((s) => s.user)!
  const [params] = useSearchParams()
  const invite = params.get('invite')
  // 本地保存的默认空间可能已过期（被移出、空间被删除）：空间页会提示并刷新，这里不等列表
  const direct = !invite && me.default_space_id ? me.default_space_id : null
  const q = useSpaces(!invite && !direct)

  if (invite) return <Navigate to={`/spaces?invite=${encodeURIComponent(invite)}`} replace />
  if (direct) return <Navigate to={`/spaces/${direct}`} replace />
  // 按刚取到的列表决定去哪（缓存里的列表可能还有已删除或已退出的空间）；取失败时才用缓存
  if (q.isLoading || (q.isFetching && !q.isFetchedAfterMount)) return <PageLoader />
  if (!q.data)
    return (
      <LoadError
        className="min-h-[60vh]"
        error={q.error}
        onRetry={() => q.refetch()}
        back={
          <Link to="/" className={buttonClass({ variant: 'outline' })}>
            回到首页
          </Link>
        }
      />
    )
  const target = q.data.find((s) => s.is_default) ?? (q.data.length === 1 ? q.data[0] : null)
  return <Navigate to={target ? `/spaces/${target.id}` : '/spaces'} replace />
}
