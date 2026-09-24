import { useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageCircle, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Comment, type Waypoint } from '@/api'
import { ReportDialog } from '@/components/report/ReportDialog'
import { Avatar, Button, Empty, LoadError, Textarea, UserName, confirmDialog } from '@/components/ui'
import { useRequireAuth } from '@/hooks/useRequireAuth'
import { fromNow } from '@/lib/format'
import { flattenPages } from '@/lib/pages'
import { useAuth } from '@/stores/auth'

interface Props {
  tripId?: number
  placeId?: number
  /** 评论总数（含回复），取自 trip.comment_count / place.comment_count；分页的 total 只数顶层评论 */
  count?: number
  /** 发布 / 删除成功后通知父级调整计数 */
  onCountChange?: (delta: number) => void
  waypoints?: Waypoint[]
  /** 预选的打卡点（针对某个点评论） */
  waypointId?: number | null
  onClearWaypoint?: () => void
  onJumpWaypoint?: (id: number) => void
}

export function CommentSection({ tripId, placeId, count, onCountChange, waypoints, waypointId, onClearWaypoint, onJumpWaypoint }: Props) {
  const qc = useQueryClient()
  const user = useAuth((s) => s.user)
  const requireAuth = useRequireAuth()
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<Comment | null>(null)
  const [reporting, setReporting] = useState<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 输入框在评论列表上方：回复下面的评论时把它滚到视野中间并聚焦。
  // 在点击事件里同步调用（不放进 effect / requestAnimationFrame），iOS 才会弹出键盘
  const startReply = (c: Comment) => {
    setReplyTo(c)
    const el = inputRef.current
    el?.focus({ preventScroll: true })
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  const key = ['comments', tripId ? `t${tripId}` : `p${placeId}`]
  const wpName = (id: number | null) => waypoints?.find((w) => w.id === id)?.name

  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) =>
      tripId
        ? api.trips.comments(tripId, { page: pageParam, page_size: 20 })
        : api.places.comments(placeId!, { page: pageParam, page_size: 20 }),
    initialPageParam: 1,
    getNextPageParam: (l) => (l.page * l.page_size < l.total ? l.page + 1 : undefined),
  })
  const shown = count ?? q.data?.pages[0]?.total ?? 0
  const comments = flattenPages(q.data?.pages)

  const send = useMutation({
    mutationFn: () => {
      const body = { content: text.trim(), parent_id: replyTo?.id ?? null }
      return tripId
        ? api.trips.addComment(tripId, { ...body, waypoint_id: replyTo ? null : (waypointId ?? null) })
        : api.places.addComment(placeId!, body)
    },
    onSuccess: () => {
      setText('')
      setReplyTo(null)
      onClearWaypoint?.()
      qc.invalidateQueries({ queryKey: key })
      onCountChange?.(1)
      toast.success('评论已发布')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const remove = async (c: Comment) => {
    if (!(await confirmDialog({ title: '删除这条评论？', danger: true, okText: '删除' }))) return
    try {
      await api.comments.remove(c.id)
      onCountChange?.(-1) // 软删除只标记这一条，回复仍保留并计数
      qc.invalidateQueries({ queryKey: key })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const renderComment = (c: Comment, isReply = false) => (
    <div key={c.id} className="flex gap-2.5">
      <Avatar user={c.author} size={isReply ? 26 : 34} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <UserName user={c.author} />
          {c.reply_to && (
            <span className="text-xs text-ink-400">
              回复 <span className="text-ink-700">@{c.reply_to.nickname || c.reply_to.username}</span>
            </span>
          )}
        </div>
        {c.waypoint_id && wpName(c.waypoint_id) && (
          <button
            type="button"
            onClick={() => onJumpWaypoint?.(c.waypoint_id!)}
            className="mt-1 inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-xs text-sky-700"
          >
            📍 {wpName(c.waypoint_id)}
          </button>
        )}
        <p className={`mt-1 text-sm leading-relaxed whitespace-pre-wrap ${c.deleted ? 'text-ink-400 italic' : 'text-ink-700'}`}>
          {c.deleted ? '该评论已删除' : c.content}
        </p>
        <div className="mt-1 flex items-center gap-3 text-xs text-ink-400">
          <span>{fromNow(c.created_at)}</span>
          {!c.deleted && (
            <button
              type="button"
              className="hover:text-brand-600"
              onClick={() => requireAuth(() => startReply(c))}
            >
              回复
            </button>
          )}
          {!c.deleted && c.author.id !== user?.id && (
            <button type="button" className="hover:text-red-600" onClick={() => requireAuth(() => setReporting(c.id))}>
              举报
            </button>
          )}
          {c.can_delete && !c.deleted && (
            <button type="button" className="hover:text-red-600" onClick={() => remove(c)} aria-label="删除">
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
        {!!c.replies?.length && <div className="mt-3 space-y-3">{c.replies.map((r) => renderComment(r, true))}</div>}
      </div>
    </div>
  )

  return (
    <section id="comments">
      <h3 className="mb-4 flex items-center gap-2 text-lg font-bold">
        <MessageCircle className="size-5" />
        评论 {shown > 0 && <span className="text-sm font-normal text-ink-400">{shown}</span>}
      </h3>

      <div className="rounded-2xl bg-white p-3 shadow-card">
        {(replyTo || waypointId) && (
          <div className="mb-2 flex items-center gap-2 text-xs text-ink-500">
            {replyTo ? (
              <span>
                回复 @{replyTo.author.nickname || replyTo.author.username}：{replyTo.content.slice(0, 30)}
              </span>
            ) : (
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-700">📍 评论打卡点：{wpName(waypointId!)}</span>
            )}
            <button
              type="button"
              onClick={() => (replyTo ? setReplyTo(null) : onClearWaypoint?.())}
              className="text-ink-400 hover:text-ink-700"
              aria-label="取消"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        {user ? (
          <>
            <Textarea
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={placeId ? '说说你的真实体验，或问问去过的人～' : '说点什么，或者问问作者细节～'}
              maxLength={1000}
              className="min-h-20 border-transparent bg-ink-100 focus:bg-white"
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-ink-400">{text.length}/1000</span>
              <Button size="sm" disabled={!text.trim()} loading={send.isPending} onClick={() => requireAuth(() => send.mutate())}>
                发布
              </Button>
            </div>
          </>
        ) : (
          // 未登录时不放输入框：聚焦（Tab 键、读屏、滚动时误触）就跳去登录页会打断浏览，改为明确点击才去登录
          <button
            type="button"
            onClick={() => requireAuth(() => {})}
            className="flex min-h-20 w-full items-center justify-center rounded-xl bg-ink-100 px-3 text-sm text-ink-500 transition hover:text-brand-600"
          >
            {placeId ? '登录后说说你的真实体验，或问问去过的人' : '登录后参与评论'}
          </button>
        )}
      </div>

      <div className="mt-5 space-y-5">
        {comments.map((c) => renderComment(c))}
        {q.isLoadingError && <LoadError className="py-8" title="评论加载失败" error={q.error} onRetry={() => q.refetch()} />}
        {!q.isLoading && !q.isLoadingError && comments.length === 0 && <Empty title="还没有评论" desc="来抢沙发吧" className="py-8" />}
        {q.hasNextPage && (
          <div className="flex justify-center">
            <Button variant="ghost" size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
              查看更多评论
            </Button>
          </div>
        )}
      </div>
      <ReportDialog target={reporting ? { type: 'comment', id: reporting } : null} onClose={() => setReporting(null)} />
    </section>
  )
}
