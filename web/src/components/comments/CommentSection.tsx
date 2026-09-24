import { useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { MessageCircle, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Comment, type Waypoint } from '@/api'
import { Avatar, Button, Empty, Textarea, UserName, confirmDialog } from '@/components/ui'
import { useRequireAuth } from '@/hooks/useRequireAuth'
import { fromNow } from '@/lib/format'
import { useAuth } from '@/stores/auth'

interface Props {
  tripId?: number
  placeId?: number
  waypoints?: Waypoint[]
  /** 预选的打卡点（针对某个点评论） */
  waypointId?: number | null
  onClearWaypoint?: () => void
  onJumpWaypoint?: (id: number) => void
}

export function CommentSection({ tripId, placeId, waypoints, waypointId, onClearWaypoint, onJumpWaypoint }: Props) {
  const qc = useQueryClient()
  const user = useAuth((s) => s.user)
  const requireAuth = useRequireAuth()
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<Comment | null>(null)
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
  const total = q.data?.pages[0]?.total ?? 0
  const comments = q.data?.pages.flatMap((p) => p.items) ?? []

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
      toast.success('评论已发布')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const remove = async (c: Comment) => {
    if (!(await confirmDialog({ title: '删除这条评论？', danger: true, okText: '删除' }))) return
    try {
      await api.comments.remove(c.id)
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
        <p className={`mt-1 text-sm leading-relaxed whitespace-pre-wrap ${c.deleted ? 'text-ink-300 italic' : 'text-ink-700'}`}>
          {c.deleted ? '该评论已删除' : c.content}
        </p>
        <div className="mt-1 flex items-center gap-3 text-xs text-ink-400">
          <span>{fromNow(c.created_at)}</span>
          {!c.deleted && (
            <button
              type="button"
              className="hover:text-brand-600"
              onClick={() => requireAuth(() => setReplyTo(c))}
            >
              回复
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
        评论 {total > 0 && <span className="text-sm font-normal text-ink-400">{total}</span>}
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
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => !user && requireAuth(() => {})}
          placeholder={placeId ? '去过吗？说说真实体验，帮大家避雷～' : '说点什么，或者问问作者细节～'}
          maxLength={1000}
          className="min-h-20 border-none bg-ink-50 focus:ring-0"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-ink-300">{text.length}/1000</span>
          <Button size="sm" disabled={!text.trim()} loading={send.isPending} onClick={() => requireAuth(() => send.mutate())}>
            发布
          </Button>
        </div>
      </div>

      <div className="mt-5 space-y-5">
        {comments.map((c) => renderComment(c))}
        {!q.isLoading && comments.length === 0 && <Empty title="还没有评论" desc="来抢沙发吧" className="py-8" />}
        {q.hasNextPage && (
          <div className="flex justify-center">
            <Button variant="ghost" size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
              查看更多评论
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}
