import { Link, useSearchParams } from 'react-router'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Eye, EyeOff, Heart, MessageCircle, Route, Star, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type TripCard } from '@/api'
import { MenuItem, Select, confirmDialog } from '@/components/ui'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { fmtCount, fromNow } from '@/lib/format'
import { phases, visibilities } from '@/lib/meta'
import {
  ADMIN_PAGE_SIZE,
  FilterBar,
  FilterSlot,
  PanelHeader,
  PersonName,
  Pill,
  RowMenu,
  SearchInput,
  useFilters,
  usePageGuard,
} from './common'
import { DataTable, type Column } from './DataTable'

/**
 * 封面：4:5 照片，悬停缓慢放大。没有封面时不画框，近黑底上一个灰色大号宋体城市首字（邮戳是字，不是方块）
 */
function Thumb({ trip }: { trip: TripCard }) {
  const label = (trip.cities[0] || trip.title).trim().slice(0, 1)
  return (
    <div className="flex h-20 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[2px]">
      {trip.cover_url ? (
        <img
          src={trip.cover_thumb_url || trip.cover_url}
          alt=""
          loading="lazy"
          className="size-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]"
        />
      ) : label ? (
        <span className="font-display text-[2rem] leading-none text-ink-500 transition-colors duration-300 group-hover:text-ink-700">{label}</span>
      ) : (
        <Route className="size-6 text-ink-500" strokeWidth={1} />
      )}
    </div>
  )
}

/** 状态胶囊：待审核是全站统一的朱砂小点，已隐藏是空心点；正常不显示胶囊 */
function StatusPill({ t }: { t: TripCard }) {
  if (t.status === 'pending') return <Pill tone="brand">待审核</Pill>
  if (t.status === 'hidden') return <Pill tone="hollow">已隐藏</Pill>
  return null
}

export function TripsPanel() {
  const qc = useQueryClient()
  // 概览的「去审核」链接到 ?status=pending，直接打开审核队列
  const [params] = useSearchParams()
  const { f, set, setPage } = useFilters({ q: '', status: params.get('status') ?? '', visibility: '' })
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin', 'trips', f],
    queryFn: () => api.admin.trips({ ...f, page_size: ADMIN_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  })
  usePageGuard(data, setPage)

  const refresh = (id: number) => {
    // 含侧边导航的待审核角标 ['admin', 'trips', 'pending-count']
    qc.invalidateQueries({ queryKey: ['admin', 'trips'] })
    qc.invalidateQueries({ queryKey: ['admin', 'stats'] })
    // 精选 / 隐藏 / 审核通过会影响广场、搜索、个人主页等前台列表，以及旅程详情
    invalidateTripLists(qc)
    qc.invalidateQueries({ queryKey: ['trip', String(id)] })
  }

  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { featured?: boolean; status?: 'normal' | 'hidden' }; ok: string }) =>
      api.admin.updateTrip(id, body),
    onSuccess: (_, v) => {
      toast.success(v.ok)
      refresh(v.id)
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.admin.deleteTrip(id),
    onSuccess: (_, id) => {
      toast.success('旅程已删除')
      refresh(id)
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

  // 驳回待审核的旅程：状态改为 hidden，作者会收到通知
  const reject = async (t: TripCard) => {
    if (
      await confirmDialog({
        title: `驳回《${t.title}》？`,
        desc: '驳回后旅程会被隐藏，作者会收到通知；之后可以在这里恢复显示。',
        danger: true,
        okText: '驳回',
      })
    )
      update.mutate({ id: t.id, body: { status: 'hidden' }, ok: '已驳回' })
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
      mobile: 'primary',
      cell: (t) => (
        <Link to={`/trips/${t.id}`} className="group flex min-w-0 items-center gap-4 lg:gap-5">
          <Thumb trip={t} />
          <div className="min-w-0">
            <div className="font-display line-clamp-1 text-[19px] leading-snug text-ink-900 underline decoration-transparent underline-offset-4 transition-colors duration-300 group-hover:decoration-ink-500 lg:text-[20px]">
              {t.title}
            </div>
            <div className="caption mt-1 truncate">
              {t.cities.slice(0, 3).join(' · ') || '未设置城市'} · {fromNow(t.created_at)}
            </div>
            {/* 小屏：作者、可见性和不正常的状态并成一行 */}
            <div className="caption mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 lg:hidden">
              <span className="max-w-[9rem] truncate text-ink-700">{t.author.nickname || t.author.username}</span>
              <span aria-hidden className="text-ink-300">
                ·
              </span>
              <span>{visibilities[t.visibility]?.label ?? t.visibility}</span>
              {t.featured && (
                <>
                  <span aria-hidden className="text-ink-300">
                    ·
                  </span>
                  <span className="inline-flex items-center gap-1 text-ink-700">
                    <Star className="size-3 fill-current" strokeWidth={1.5} />
                    精选
                  </span>
                </>
              )}
              <StatusPill t={t} />
            </div>
          </div>
        </Link>
      ),
    },
    {
      key: 'author',
      header: '作者',
      className: 'max-w-40',
      mobile: 'hide',
      cell: (t) => <PersonName user={t.author} className="max-w-full text-[14px]" />,
    },
    {
      key: 'visibility',
      header: '可见性',
      className: 'whitespace-nowrap',
      mobile: 'hide',
      cell: (t) => <span className="text-[13px] text-ink-700">{visibilities[t.visibility]?.label ?? t.visibility}</span>,
    },
    {
      key: 'status',
      header: '状态',
      mobile: 'hide',
      cell: (t) => (
        <div className="flex flex-wrap gap-1">
          <StatusPill t={t} />
          {t.status !== 'pending' && t.status !== 'hidden' && (
            <span className="px-0.5 text-[13px] leading-[22px] text-ink-500">正常</span>
          )}
          {t.featured && <Pill icon={<Star className="size-3 fill-current" strokeWidth={1.5} />}>精选</Pill>}
          <Pill>{phases[t.phase]?.label ?? t.phase}</Pill>
        </div>
      ),
    },
    {
      key: 'data',
      header: '数据',
      className: 'whitespace-nowrap',
      mobile: 'hide',
      cell: (t) => (
        <span className="font-num inline-flex items-center gap-4 text-[15px] text-ink-700">
          <span className="inline-flex items-center gap-1.5" title="浏览">
            <Eye className="size-3.5 text-ink-400" strokeWidth={1.25} />
            {fmtCount(t.view_count)}
          </span>
          <span className="inline-flex items-center gap-1.5" title="点赞">
            <Heart className="size-3.5 text-ink-400" strokeWidth={1.25} />
            {fmtCount(t.like_count)}
          </span>
          <span className="inline-flex items-center gap-1.5" title="评论">
            <MessageCircle className="size-3.5 text-ink-400" strokeWidth={1.25} />
            {fmtCount(t.comment_count)}
          </span>
        </span>
      ),
    },
  ]

  // 每行只有一个「…」：审核、精选、隐藏与删除都收在菜单里，危险操作的朱砂只在菜单里出现
  const actions = (t: TripCard) => (
    <RowMenu>
      {(close) => (
        <>
          {t.status === 'pending' ? (
            <>
              <MenuItem
                icon={<Check className="size-4" />}
                onClick={() => (close(), update.mutate({ id: t.id, body: { status: 'normal' }, ok: '已通过，旅程已公开' }))}
              >
                通过审核
              </MenuItem>
              <MenuItem icon={<X className="size-4" />} onClick={() => (close(), reject(t))}>
                驳回
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem
                icon={<Star className={cn('size-4', t.featured && 'fill-current')} />}
                onClick={() => (
                  close(),
                  update.mutate({ id: t.id, body: { featured: !t.featured }, ok: t.featured ? '已取消精选' : '已设为精选' })
                )}
              >
                {t.featured ? '取消精选' : '设为精选'}
              </MenuItem>
              <MenuItem
                icon={t.status === 'hidden' ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
                onClick={() => (close(), toggleHidden(t))}
              >
                {t.status === 'hidden' ? '恢复显示' : '隐藏'}
              </MenuItem>
            </>
          )}
          <MenuItem icon={<Trash2 className="size-4" />} danger onClick={() => (close(), del(t))}>
            删除
          </MenuItem>
        </>
      )}
    </RowMenu>
  )

  return (
    <div>
      <PanelHeader
        eyebrow="Journals · 内容"
        title="内容管理"
        desc={
          data ? (
            f.status === 'pending' ? (
              <>
                <span className="font-num text-[17px] text-ink-900">{data.total}</span> 段公开旅程等待审核
              </>
            ) : (
              <>
                共 <span className="font-num text-[17px] text-ink-900">{data.total}</span> 段旅程
              </>
            )
          ) : undefined
        }
      />
      <FilterBar>
        <SearchInput value={f.q} onChange={(q) => set({ q })} placeholder="搜索标题、城市或作者" className="w-full sm:w-64" />
        <FilterSlot>
          <Select value={f.status} onChange={(e) => set({ status: e.target.value })} aria-label="状态">
            <option value="">全部状态</option>
            <option value="pending">待审核</option>
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
        compactActions
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
