import { useRef, useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MapPin, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Comment, type Waypoint } from '@/api'
import { LabelRow } from '@/components/editorial'
import { ReportDialog } from '@/components/report/ReportDialog'
import { Avatar, Button, Empty, LoadError, Textarea, UserName, confirmDialog } from '@/components/ui'
import { useRequireAuth } from '@/hooks/useRequireAuth'
import { cn } from '@/lib/cn'
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
    <div key={c.id} className={cn('flex gap-3.5', !isReply && 'py-7')}>
      <Avatar user={c.author} size={isReply ? 26 : 34} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[13.5px] text-ink-900">
          <UserName user={c.author} />
          {c.reply_to && (
            <span className="caption">
              回复 <span className="text-ink-700">@{c.reply_to.nickname || c.reply_to.username}</span>
            </span>
          )}
          <span className="caption font-num ml-auto">{fromNow(c.created_at)}</span>
        </div>
        {c.waypoint_id && wpName(c.waypoint_id) && (
          <button
            type="button"
            onClick={() => onJumpWaypoint?.(c.waypoint_id!)}
            className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-full border border-ink-200 px-2.5 text-xs text-ink-600 transition-colors hover:border-ink-500 hover:text-ink-900"
          >
            <MapPin className="size-3" strokeWidth={1.5} />
            {wpName(c.waypoint_id)}
          </button>
        )}
        <p className={cn('mt-2 max-w-2xl text-[15px] leading-[1.85] whitespace-pre-wrap', c.deleted ? 'text-ink-400 italic' : 'text-ink-700')}>
          {c.deleted ? '该评论已删除' : c.content}
        </p>
        <div className="-ml-1 mt-1 flex items-center gap-1 text-xs text-ink-400">
          {!c.deleted && (
            <button type="button" className="inline-flex h-10 items-center px-1 transition-colors hover:text-ink-900 md:h-8" onClick={() => requireAuth(() => startReply(c))}>
              回复
            </button>
          )}
          {!c.deleted && c.author.id !== user?.id && (
            <button type="button" className="inline-flex h-10 items-center px-1 transition-colors hover:text-brand-600 md:h-8" onClick={() => requireAuth(() => setReporting(c.id))}>
              举报
            </button>
          )}
          {c.can_delete && !c.deleted && (
            <button type="button" className="inline-flex size-10 items-center justify-center transition-colors hover:text-brand-600 md:size-8" onClick={() => remove(c)} aria-label="删除" title="删除">
              <Trash2 className="size-3.5" strokeWidth={1.25} />
            </button>
          )}
        </div>
        {!!c.replies?.length && (
          <div className="mt-4 space-y-5 border-l border-ink-200 pl-5">{c.replies.map((r) => renderComment(r, true))}</div>
        )}
      </div>
    </div>
  )

  return (
    <section id="comments" aria-labelledby="comments-title">
      <LabelRow label="Comments · 评论" count={shown > 0 ? `${shown} 条` : undefined} />
      <h2 id="comments-title" className="text-display-md mt-8 font-normal md:mt-12">
        评论
      </h2>

      <div className="mt-8 rounded-md border border-ink-200 bg-surface transition-colors duration-300 focus-within:border-ink-500 md:mt-12">
        {(replyTo || waypointId) && (
          <div className="flex items-center gap-2 border-b border-ink-200 px-4 py-2.5 text-xs text-ink-500">
            {replyTo ? (
              <span className="min-w-0 truncate">
                回复 <span className="text-ink-800">@{replyTo.author.nickname || replyTo.author.username}</span>：{replyTo.content.slice(0, 30)}
              </span>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <MapPin className="size-3 shrink-0" strokeWidth={1.5} />
                评论打卡点：<span className="text-ink-800">{wpName(waypointId!)}</span>
              </span>
            )}
            <button
              type="button"
              onClick={() => (replyTo ? setReplyTo(null) : onClearWaypoint?.())}
              className="ml-auto shrink-0 rounded-sm p-0.5 text-ink-400 hover:text-ink-900"
              aria-label="取消"
            >
              <X className="size-3.5" strokeWidth={1.5} />
            </button>
          </div>
        )}
        {user ? (
          <>
            <Textarea
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={placeId ? '说说你的真实体验，或者问问去过的人' : '说点什么，或者问问作者细节'}
              aria-label="评论内容"
              maxLength={1000}
              className="min-h-28 resize-y rounded-md border-transparent bg-transparent px-4 py-3.5 text-[15px] hover:border-transparent focus:border-transparent focus:ring-0"
            />
            <div className="flex items-center justify-between border-t border-ink-200 py-2.5 pr-2.5 pl-4">
              <span className="font-num text-xs text-ink-400">{text.length} / 1000</span>
              <Button disabled={!text.trim()} loading={send.isPending} onClick={() => requireAuth(() => send.mutate())}>
                发布
              </Button>
            </div>
          </>
        ) : (
          // 未登录时不放输入框：聚焦（Tab 键、读屏、滚动时误触）就跳去登录页会打断浏览，改为明确点击才去登录
          <button
            type="button"
            onClick={() => requireAuth(() => {})}
            className="flex min-h-24 w-full items-center justify-center gap-2 rounded-md px-3 text-sm text-ink-500 transition-colors hover:text-ink-900"
          >
            {placeId ? '登录后说说你的真实体验，或问问去过的人' : '登录后参与评论'}
            <span aria-hidden>→</span>
          </button>
        )}
      </div>

      <div className="mt-6 divide-y divide-ink-200">{comments.map((c) => renderComment(c))}</div>
      {q.isLoadingError && <LoadError className="py-8" title="评论加载失败" error={q.error} onRetry={() => q.refetch()} />}
      {!q.isLoading && !q.isLoadingError && comments.length === 0 && <Empty title="还没有评论" desc="来写下第一条吧" className="py-10" />}
      {q.hasNextPage && (
        <div className="flex justify-center border-t border-ink-200 pt-6">
          <Button variant="outline" size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            查看更多评论
          </Button>
        </div>
      )}
      <ReportDialog target={reporting ? { type: 'comment', id: reporting } : null} onClose={() => setReporting(null)} />
    </section>
  )
}
