import { Link } from 'react-router'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MapPin, Route, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Comment } from '@/api'
import { Avatar, MenuItem, confirmDialog } from '@/components/ui'
import { fromNow } from '@/lib/format'
import {
  ADMIN_PAGE_SIZE,
  FilterBar,
  monoAvatar,
  PanelHeader,
  PersonName,
  Pill,
  RowMenu,
  SearchInput,
  useFilters,
  usePageGuard,
} from './common'
import { DataTable, type Column } from './DataTable'

export function CommentWhere({ c }: { c: Pick<Comment, 'trip' | 'place' | 'trip_id' | 'place_id'> }) {
  const cls =
    'inline-flex max-w-full min-w-0 items-center gap-1.5 text-[14px] text-ink-700 underline decoration-transparent underline-offset-4 transition-colors duration-300 hover:text-ink-900 hover:decoration-ink-500'
  if (c.trip || c.trip_id)
    return (
      <Link to={`/trips/${c.trip?.id ?? c.trip_id}`} className={cls}>
        <Route className="size-3.5 shrink-0 text-ink-400" strokeWidth={1.25} />
        <span className="font-display truncate">{c.trip ? `《${c.trip.title}》` : `旅程 #${c.trip_id}`}</span>
      </Link>
    )
  if (c.place || c.place_id)
    return (
      <Link to={`/places/${c.place?.id ?? c.place_id}`} className={cls}>
        <MapPin className="size-3.5 shrink-0 text-ink-400" strokeWidth={1.25} />
        <span className="font-display truncate">{c.place ? c.place.name : `打卡地 #${c.place_id}`}</span>
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
  usePageGuard(data, setPage)

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
      mobile: 'primary',
      cell: (c) => (
        <div className="min-w-0">
          {/* 小屏：作者与时间在内容上方 */}
          <div className="mb-2.5 flex min-w-0 items-center gap-2.5 lg:hidden">
            <Avatar user={c.author} size={24} className={monoAvatar} />
            <PersonName user={c.author} handle={false} className="text-[13.5px]" />
            <span className="caption shrink-0">· {fromNow(c.created_at)}</span>
          </div>
          <p
            className={
              c.deleted
                ? 'text-[15px] text-ink-400 line-through'
                : "font-display line-clamp-3 text-[17px] leading-[1.7] break-words text-ink-800 [font-feature-settings:'halt']"
            }
          >
            {c.reply_to && <span className="font-sans text-[13px] text-ink-500">回复 @{c.reply_to.nickname || c.reply_to.username}：</span>}
            {c.content}
          </p>
          {c.deleted && (
            <span className="mt-1 inline-block">
              <Pill>已删除</Pill>
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'author',
      header: '作者',
      mobile: 'hide',
      className: 'max-w-40',
      cell: (c) => <PersonName user={c.author} className="max-w-full text-[14px]" />,
    },
    { key: 'where', header: '所在', className: 'max-w-56', cell: (c) => <CommentWhere c={c} /> },
    {
      key: 'time',
      header: '时间',
      mobile: 'hide',
      className: 'whitespace-nowrap',
      cell: (c) => <span className="text-[13px] text-ink-500">{fromNow(c.created_at)}</span>,
    },
  ]

  return (
    <div>
      <PanelHeader
        eyebrow="Comments · 评论"
        title="评论管理"
        desc={
          data ? (
            <>
              共 <span className="font-num text-[17px] text-ink-900">{data.total}</span> 条评论
            </>
          ) : undefined
        }
      />
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => set({ q })} placeholder="搜索评论内容或作者" className="w-full sm:w-72" />
      </FilterBar>
      <DataTable
        rows={data?.items}
        columns={columns}
        rowKey={(c) => c.id}
        actions={(c) =>
          // 已删除的评论没有可做的操作
          c.deleted ? null : (
            <RowMenu>
              {(close) => (
                <MenuItem icon={<Trash2 className="size-4" />} danger onClick={() => (close(), del(c))}>
                  删除评论
                </MenuItem>
              )}
            </RowMenu>
          )
        }
        compactActions
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
