import { Link } from 'react-router'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MapPin, Route, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Comment } from '@/api'
import { Avatar, UserName, confirmDialog } from '@/components/ui'
import { fromNow } from '@/lib/format'
import { ActionButton, ADMIN_PAGE_SIZE, FilterBar, PanelHeader, Pill, SearchInput, useFilters } from './common'
import { DataTable, type Column } from './DataTable'

export function CommentWhere({ c }: { c: Pick<Comment, 'trip' | 'place' | 'trip_id' | 'place_id'> }) {
  const cls = 'inline-flex max-w-full min-w-0 items-center gap-1 text-ink-700 hover:text-brand-600'
  if (c.trip || c.trip_id)
    return (
      <Link to={`/trips/${c.trip?.id ?? c.trip_id}`} className={cls}>
        <Route className="size-3.5 shrink-0 text-ink-400" />
        <span className="truncate">{c.trip ? `《${c.trip.title}》` : `旅程 #${c.trip_id}`}</span>
      </Link>
    )
  if (c.place || c.place_id)
    return (
      <Link to={`/places/${c.place?.id ?? c.place_id}`} className={cls}>
        <MapPin className="size-3.5 shrink-0 text-ink-400" />
        <span className="truncate">{c.place ? c.place.name : `打卡地 #${c.place_id}`}</span>
      </Link>
    )
  return <span className="text-ink-400">—</span>
}

export function CommentsPanel() {
  const qc = useQueryClient()
  const { f, set, setPage } = useFilters({ q: '' })
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin', 'comments', f],
    queryFn: () => api.admin.comments({ ...f, page_size: ADMIN_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.admin.deleteComment(id),
    onSuccess: () => {
      toast.success('评论已删除')
      qc.invalidateQueries({ queryKey: ['admin', 'comments'] })
      qc.invalidateQueries({ queryKey: ['admin', 'stats'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const del = async (c: Comment) => {
    if (
      await confirmDialog({
        title: '删除这条评论？',
        desc: `「${c.content.slice(0, 60)}${c.content.length > 60 ? '…' : ''}」删除后无法恢复。`,
        danger: true,
        okText: '删除',
      })
    )
      remove.mutate(c.id)
  }

  const columns: Column<Comment>[] = [
    {
      key: 'content',
      header: '内容',
      primary: true,
      cell: (c) => (
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2 lg:hidden">
            <Avatar user={c.author} size={22} />
            <UserName user={c.author} className="text-sm" />
            <span className="ml-auto shrink-0 text-xs text-ink-400">{fromNow(c.created_at)}</span>
          </div>
          <p className={c.deleted ? 'text-ink-400 line-through' : 'line-clamp-3 break-words text-ink-900'}>
            {c.reply_to && <span className="text-ink-400">回复 @{c.reply_to.nickname || c.reply_to.username}：</span>}
            {c.content}
          </p>
          {c.deleted && (
            <span className="mt-1 inline-block">
              <Pill tone="gray">已删除</Pill>
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'author',
      header: '作者',
      hideOnMobile: true,
      className: 'max-w-36',
      cell: (c) => <UserName user={c.author} className="max-w-full text-sm" />,
    },
    { key: 'where', header: '所在', className: 'max-w-56', cell: (c) => <CommentWhere c={c} /> },
    {
      key: 'time',
      header: '时间',
      hideOnMobile: true,
      className: 'whitespace-nowrap text-ink-500',
      cell: (c) => fromNow(c.created_at),
    },
  ]

  return (
    <div>
      <PanelHeader title="评论管理" desc={data ? `共 ${data.total} 条评论` : undefined} />
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => set({ q })} placeholder="搜索评论内容或作者" className="w-full sm:w-72" />
      </FilterBar>
      <DataTable
        rows={data?.items}
        columns={columns}
        rowKey={(c) => c.id}
        actions={(c) => (
          <ActionButton label="删除" danger icon={<Trash2 className="size-3.5" />} disabled={c.deleted} onClick={() => del(c)} />
        )}
        loading={isLoading}
        fetching={isFetching}
        emptyText="没有符合条件的评论"
        page={f.page}
        total={data?.total ?? 0}
        pageSize={ADMIN_PAGE_SIZE}
        onPage={setPage}
      />
    </div>
  )
}
