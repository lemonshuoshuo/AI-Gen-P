import { Link } from 'react-router'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Heart, MessageCircle, Route, Star, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type TripCard } from '@/api'
import { Button, Select, UserName, confirmDialog } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fmtCount, fromNow } from '@/lib/format'
import { phases, visibilities } from '@/lib/meta'
import { ADMIN_PAGE_SIZE, FilterBar, FilterSlot, PanelHeader, Pill, SearchInput, useFilters } from './common'
import { DataTable, type Column } from './DataTable'

function Thumb({ trip }: { trip: TripCard }) {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand-gradient">
      {trip.cover_url ? (
        <img src={trip.cover_url} alt="" loading="lazy" className="size-full object-cover" />
      ) : (
        <Route className="size-5 text-white" />
      )}
    </div>
  )
}

export function TripsPanel() {
  const qc = useQueryClient()
  const { f, set, setPage } = useFilters({ q: '', status: '', visibility: '' })
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin', 'trips', f],
    queryFn: () => api.admin.trips({ ...f, page_size: ADMIN_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'trips'] })
    qc.invalidateQueries({ queryKey: ['admin', 'stats'] })
    // 精选 / 隐藏会影响前台列表
    qc.invalidateQueries({ queryKey: ['trips'] })
  }

  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { featured?: boolean; status?: 'normal' | 'hidden' }; ok: string }) =>
      api.admin.updateTrip(id, body),
    onSuccess: (_, v) => {
      toast.success(v.ok)
      refresh()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.admin.deleteTrip(id),
    onSuccess: () => {
      toast.success('旅程已删除')
      refresh()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const toggleHidden = async (t: TripCard) => {
    const hide = t.status !== 'hidden'
    if (
      hide &&
      !(await confirmDialog({
        title: `隐藏《${t.title}》？`,
        desc: '隐藏后除作者本人外，其他人都无法看到这段旅程。可以随时恢复。',
        danger: true,
        okText: '隐藏',
      }))
    )
      return
    update.mutate({ id: t.id, body: { status: hide ? 'hidden' : 'normal' }, ok: hide ? '已隐藏' : '已恢复' })
  }

  const del = async (t: TripCard) => {
    if (
      await confirmDialog({
        title: `删除《${t.title}》？`,
        desc: '旅程及其打卡点、照片、评论将被永久删除，无法恢复。',
        danger: true,
        okText: '删除',
      })
    )
      remove.mutate(t.id)
  }

  const columns: Column<TripCard>[] = [
    {
      key: 'trip',
      header: '旅程',
      primary: true,
      className: 'max-w-72',
      cell: (t) => (
        <Link to={`/trips/${t.id}`} className="group flex min-w-0 items-center gap-3">
          <Thumb trip={t} />
          <div className="min-w-0">
            <div className="line-clamp-1 font-medium text-ink-900 group-hover:text-brand-600">{t.title}</div>
            <div className="truncate text-xs text-ink-400">
              {t.cities.slice(0, 3).join(' · ') || '未设置城市'} · {fromNow(t.created_at)}
            </div>
          </div>
        </Link>
      ),
    },
    {
      key: 'author',
      header: '作者',
      className: 'max-w-36',
      cell: (t) => <UserName user={t.author} className="max-w-full text-sm" />,
    },
    {
      key: 'visibility',
      header: '可见性',
      className: 'whitespace-nowrap',
      cell: (t) => <span className="text-ink-700">{visibilities[t.visibility]?.label ?? t.visibility}</span>,
    },
    {
      key: 'status',
      header: '状态',
      cell: (t) => (
        <div className="flex flex-wrap gap-1">
          {t.status === 'hidden' ? <Pill tone="red">已隐藏</Pill> : <Pill tone="green">正常</Pill>}
          {t.featured && (
            <Pill tone="amber" icon={<Star className="size-3 fill-current" />}>
              精选
            </Pill>
          )}
          <Pill tone="gray">{phases[t.phase]?.label ?? t.phase}</Pill>
        </div>
      ),
    },
    {
      key: 'data',
      header: '数据',
      className: 'whitespace-nowrap',
      cell: (t) => (
        <span className="inline-flex items-center gap-2.5 text-xs text-ink-500 tabular-nums">
          <span className="inline-flex items-center gap-0.5" title="浏览">
            <Eye className="size-3.5" />
            {fmtCount(t.view_count)}
          </span>
          <span className="inline-flex items-center gap-0.5" title="点赞">
            <Heart className="size-3.5" />
            {fmtCount(t.like_count)}
          </span>
          <span className="inline-flex items-center gap-0.5" title="评论">
            <MessageCircle className="size-3.5" />
            {fmtCount(t.comment_count)}
          </span>
        </span>
      ),
    },
  ]

  const actions = (t: TripCard) => (
    <>
      <Button
        size="xs"
        variant="ghost"
        className={cn(t.featured && 'text-amber-600')}
        icon={<Star className={cn('size-3.5', t.featured && 'fill-amber-400 text-amber-400')} />}
        onClick={() =>
          update.mutate({ id: t.id, body: { featured: !t.featured }, ok: t.featured ? '已取消精选' : '已设为精选' })
        }
      >
        {t.featured ? '取消精选' : '精选'}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        icon={t.status === 'hidden' ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        onClick={() => toggleHidden(t)}
      >
        {t.status === 'hidden' ? '恢复' : '隐藏'}
      </Button>
      <Button size="xs" variant="ghost" className="text-red-600 hover:bg-red-50" icon={<Trash2 className="size-3.5" />} onClick={() => del(t)}>
        删除
      </Button>
    </>
  )

  return (
    <div>
      <PanelHeader title="内容管理" desc={data ? `共 ${data.total} 段旅程` : undefined} />
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => set({ q })} placeholder="搜索标题、城市或作者" className="w-full sm:w-64" />
        <FilterSlot>
          <Select value={f.status} onChange={(e) => set({ status: e.target.value })} aria-label="状态">
            <option value="">全部状态</option>
            <option value="normal">正常</option>
            <option value="hidden">已隐藏</option>
          </Select>
        </FilterSlot>
        <FilterSlot>
          <Select value={f.visibility} onChange={(e) => set({ visibility: e.target.value })} aria-label="可见性">
            <option value="">全部可见性</option>
            {Object.entries(visibilities).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </FilterSlot>
      </FilterBar>
      <DataTable
        rows={data?.items}
        columns={columns}
        rowKey={(t) => t.id}
        actions={actions}
        loading={isLoading}
        fetching={isFetching}
        emptyText="没有符合条件的旅程"
        page={f.page}
        total={data?.total ?? 0}
        pageSize={ADMIN_PAGE_SIZE}
        onPage={setPage}
      />
    </div>
  )
}
