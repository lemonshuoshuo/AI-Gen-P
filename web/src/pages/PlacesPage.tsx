import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { LocateFixed, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, type Category } from '@/api'
import { EmptyNote, FilterLinks, LabelRow, MoreButton, Note, PageHead } from '@/components/editorial'
import { PlaceRow } from '@/components/place/PlaceCard'
import { ChoiceChip, LoadError, OptionGroup } from '@/components/ui'
import { getCurrentPosition } from '@/lib/geo'
import { categories, categoryList } from '@/lib/meta'
import { flattenPages } from '@/lib/pages'

type Sort = 'hot' | 'rating' | 'avoid' | 'nearby'

const sortTitle: Record<Sort, string> = { hot: '热门', rating: '高分', avoid: '避雷榜', nearby: '附近' }

export default function PlacesPage() {
  const [params, setParams] = useSearchParams()
  const sort = (params.get('sort') as Sort) || 'hot'
  const category = params.get('category') || ''
  const q = params.get('q') || ''
  const city = params.get('city') || ''
  const [kw, setKw] = useState(q)
  const [pos, setPos] = useState<[number, number] | null>(null)
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params)
    if (v) n.set(k, v)
    else n.delete(k)
    setParams(n, { replace: true })
  }

  const list = useInfiniteQuery({
    queryKey: ['places', sort, category, q, city],
    queryFn: ({ pageParam }) => api.places.list({ sort, category, q, city, page: pageParam, page_size: 20 }),
    initialPageParam: 1,
    getNextPageParam: (l) => (l.page * l.page_size < l.total ? l.page + 1 : undefined),
    enabled: sort !== 'nearby',
  })
  const nearby = useQuery({
    queryKey: ['places-nearby', pos],
    queryFn: () => api.places.nearby({ lng: pos![0], lat: pos![1], radius: 5000, limit: 50 }),
    enabled: sort === 'nearby' && !!pos,
  })

  const locate = async () => {
    try {
      const p = await getCurrentPosition()
      setPos(p.gcj)
      set('sort', 'nearby')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const places =
    sort === 'nearby'
      ? (nearby.data ?? []).filter((p) => !category || p.category === category)
      : flattenPages(list.data?.pages)
  const loading = sort === 'nearby' ? nearby.isLoading && !!pos : list.isLoading
  // 首次加载失败（没有任何数据）才显示错误；「加载更多」失败时保留已加载的列表
  const active = sort === 'nearby' ? nearby : list
  const failed = active.isLoadingError
  const total = sort === 'nearby' ? (pos ? places.length : undefined) : list.data?.pages[0]?.total

  return (
    <div className="mx-auto max-w-[90rem] px-4 pt-12 pb-24 [font-variant-numeric:lining-nums] md:px-8 md:pt-20 md:pb-32">
      <PageHead
        eyebrow="Places · 打卡地"
        meta={total != null ? `${total} 处` : undefined}
        title="打卡地"
        dek="来自大家公开旅程的真实打卡：哪里值得去，哪里是坑，一看便知。"
      />

      <div className="mt-12 grid gap-x-8 gap-y-12 md:mt-16 lg:grid-cols-12">
        {/* 左栏：搜索与筛选（宽屏吸顶） */}
        <aside className="min-w-0 lg:sticky lg:top-24 lg:col-span-4 lg:self-start">
          <form
            role="search"
            className="flex items-center gap-3 border-b border-ink-300 transition-colors duration-300 focus-within:border-ink-900"
            onSubmit={(e) => {
              e.preventDefault()
              set('q', kw.trim())
            }}
          >
            <Search className="size-[18px] shrink-0 text-ink-400" strokeWidth={1.25} />
            <input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder="搜索店名、景点、城市"
              aria-label="搜索打卡地"
              className="font-display h-12 min-w-0 flex-1 bg-transparent text-[length:var(--text-card)] text-ink-900 outline-none placeholder:text-ink-400"
            />
            <button type="submit" className="h-10 shrink-0 text-[13px] tracking-[0.12em] text-ink-500 transition-colors hover:text-ink-900">
              搜索 →
            </button>
          </form>

          <div className="mt-10">
            <p className="eyebrow">Sort · 排序</p>
            <FilterLinks<Sort>
              className="mt-2 -ml-3 text-[14px]"
              value={sort}
              onChange={(v) => (v === 'nearby' ? locate() : set('sort', v))}
              options={[
                { value: 'hot', label: '热门' },
                { value: 'rating', label: '高分' },
                { value: 'avoid', label: '避雷榜' },
                {
                  value: 'nearby',
                  label: (
                    <span className="inline-flex items-center gap-1">
                      <LocateFixed className="size-3.5" strokeWidth={1.25} />
                      附近
                    </span>
                  ),
                },
              ]}
            />
          </div>

          <div className="mt-8">
            <p className="eyebrow">Category · 分类</p>
            {/* 分类是带图标的筛选 chip：选中是主题的实心 chip + 勾（单选，方向键可切换） */}
            <OptionGroup label="分类" className="mt-3 flex flex-wrap gap-1.5">
              {(['', ...categoryList] as (Category | '')[]).map((c) => {
                const Icon = c ? categories[c].icon : null
                return (
                  <ChoiceChip
                    key={c || '_all'}
                    role="radio"
                    selected={category === c}
                    onClick={() => set('category', c)}
                    icon={Icon ? <Icon strokeWidth={1.5} aria-hidden /> : undefined}
                    className="h-9 px-3.5"
                  >
                    {c ? categories[c].label : '全部'}
                  </ChoiceChip>
                )
              })}
            </OptionGroup>
            {city && (
              <p className="mt-4 flex items-center gap-3">
                <span className="eyebrow">City · 城市</span>
                <button
                  type="button"
                  onClick={() => set('city', '')}
                  className="th-chip is-selected h-10 gap-1.5 px-4 md:h-9"
                  aria-label={`取消城市筛选：${city}`}
                >
                  {city}
                  <X className="size-3.5" strokeWidth={1.5} />
                </button>
              </p>
            )}
          </div>

          {sort === 'avoid' && (
            <Note tone="caution" label="Caution" className="mt-10">
              避雷榜收录被标记「踩雷」较多的地点。评价来自旅行者的真实体验，仅供参考。
            </Note>
          )}
        </aside>

        {/* 右栏：编号的细线排版列表 */}
        <section className="min-w-0 lg:col-span-8" aria-label="打卡地列表">
          <LabelRow
            label={`${sortTitle[sort]}${q ? ` · 「${q}」` : ''}`}
            count={places.length > 0 ? `${places.length}${total != null && total > places.length ? ` / ${total}` : ''}` : undefined}
            className="border-ink-300"
          />
          {loading && (
            <div className="divide-y divide-ink-200" aria-busy="true" aria-label="加载中">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-5 py-6">
                  <div className="h-7 w-9 animate-pulse rounded-sm bg-ink-100" />
                  <div className="flex-1 space-y-2.5">
                    <div className="h-5 w-2/5 animate-pulse rounded-sm bg-ink-100" />
                    <div className="h-3 w-3/5 animate-pulse rounded-sm bg-ink-100" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {!loading && failed && <LoadError error={active.error} onRetry={() => active.refetch()} />}
          {!loading && !failed && places.length === 0 && (
            <EmptyNote
              className="pt-8"
              title={sort === 'nearby' && !pos ? '需要你的位置。' : '暂时没有打卡地。'}
              desc={sort === 'nearby' && !pos ? '允许定位后，看看附近大家打卡过的地方。' : '公开旅程里的打卡点，会汇总到这里。'}
              action={
                sort === 'nearby' &&
                !pos && (
                  <button
                    type="button"
                    onClick={locate}
                    className="inline-flex min-h-10 items-center gap-2 text-[13.5px] text-ink-900 underline decoration-ink-300 underline-offset-[6px] transition-colors hover:decoration-ink-900"
                  >
                    获取位置 <span aria-hidden>→</span>
                  </button>
                )
              }
            />
          )}
          {places.length > 0 && (
            <ol className="divide-y divide-ink-200 border-b border-ink-200">
              {places.map((p, i) => (
                <li key={p.id} className="animate-slide-up [animation-fill-mode:both]" style={{ animationDelay: `${Math.min(i, 8) * 60}ms` }}>
                  <PlaceRow place={p} rank={sort !== 'nearby' && !q ? i + 1 : undefined} />
                </li>
              ))}
            </ol>
          )}
          {sort !== 'nearby' && list.hasNextPage && <MoreButton loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()} />}
        </section>
      </div>
    </div>
  )
}
