import { useState } from 'react'
import { Link } from 'react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowRight, ArrowUpRight, Compass } from 'lucide-react'
import { api, type Phase, type TripCard as Trip } from '@/api'
import { DoubleRule, FilterLinks, MoreButton, SectionHead } from '@/components/editorial'
import { RouteSketch } from '@/components/editorial/RouteSketch'
import { PlaceRow } from '@/components/place/PlaceCard'
import { TripCover, TripGrid, TripGridSkeleton, kmShort } from '@/components/trip/TripCard'
import { Avatar, Empty, LoadError, TabBar, buttonClass } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'
import { dateRange, dayjs } from '@/lib/format'
import { flattenPages } from '@/lib/pages'
import { useAuth } from '@/stores/auth'

type Tab = 'featured' | 'latest' | 'hot' | 'following'

const phaseOptions: { value: Phase | ''; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'finished', label: '游记' },
  { value: 'planning', label: '路线攻略' },
  { value: 'ongoing', label: '旅行中' },
]

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 期号：一年中的第几周（ISO 周） */
function issueNo(d = dayjs()) {
  const date = new Date(Date.UTC(d.year(), d.month(), d.date()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

const sections = [
  { t: '计划 vs 实际', d: '路线逐站对照', to: '/trips/new' },
  { t: '打卡地避雷', d: '多人踩雷，提前知道', to: '/places?sort=avoid' },
  { t: '3D 足迹', d: '点亮走过的城市', to: '/footprints' },
  { t: '我们的足迹', d: '两个人的旅行地图', to: '/together' },
]

/** 报头：期号与日期、宋体大标题、一句导语、两个入口，右侧线描路线 */
function Masthead() {
  const user = useAuth((s) => s.user)
  const { data: site } = useSite()
  const now = dayjs()
  return (
    <section className="mx-auto max-w-6xl px-4 pt-6 md:px-6 md:pt-9">
      <div className="flex items-center justify-between gap-4 pb-2.5">
        <p className="eyebrow">
          Issue <span className="font-num">{issueNo(now)}</span> · 旅行志
        </p>
        <p className="eyebrow hidden md:block">{site?.name || 'TripHub'} · Travel Journal</p>
        <p className="eyebrow">
          {now.format('YYYY.MM.DD')} · {weekdays[now.day()]}
        </p>
      </div>
      <DoubleRule />

      <div className="grid items-center gap-6 pt-8 pb-8 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] md:gap-10 md:pt-12 md:pb-12">
        <div className="animate-slide-up">
          <h1 className="text-[34px] leading-[1.25] tracking-[0.02em] md:text-[46px] md:leading-[1.22] lg:text-[50px]">
            <span className="inline-block">规划路线，</span>
            <span className="inline-block">按图出发；</span>
            <br className="hidden sm:block" />
            <span className="inline-block">把走过的地方，</span>
            <span className="inline-block">
              都<span className="text-brand-500">点亮</span>。
            </span>
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-[1.9] text-ink-500">
            每个打卡点都有真实的体验记录，推荐与避雷一目了然；看中别人的路线，一键引用，旅途中再为你推荐下一站。
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link to={user ? '/trips/new' : '/register'} className={buttonClass({ size: 'lg' })}>
              开始规划旅程
              <ArrowRight className="size-4" strokeWidth={1.75} />
            </Link>
            {site?.ai_enabled ? (
              <Link to={user ? '/trips/new?ai=1' : '/register'} className={buttonClass({ variant: 'outline', size: 'lg' })}>
                让 AI 先拟一版
              </Link>
            ) : (
              <Link to="/places" className={buttonClass({ variant: 'outline', size: 'lg' })}>
                看看打卡地
              </Link>
            )}
          </div>
        </div>
        <figure className="animate-fade-in md:pl-4">
          <RouteSketch className="max-h-[300px] md:max-h-none" />
          <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-ink-200 pt-2.5 text-[11.5px] text-ink-400">
            <span>
              <span className="font-num italic">Fig. 1</span> 江南五日 · 上海至黄山
            </span>
            <span className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-[2px] w-4 bg-brand-500" />
                已走过
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-4 border-t border-dashed border-ink-500" />
                计划中
              </span>
            </span>
          </figcaption>
        </figure>
      </div>

      {/* 本期栏目 */}
      <nav aria-label="栏目" className="grid grid-cols-2 border-y border-ink-200 md:grid-cols-4">
        {sections.map((x, i) => (
          <Link
            key={x.t}
            to={x.to}
            className={cn(
              'group flex items-start gap-3 py-4',
              i % 2 === 0 ? 'border-r border-ink-200 pr-3' : 'pl-4',
              i < 2 && 'border-b border-ink-200',
              'md:border-r-0 md:border-b-0 md:px-5',
              i > 0 && 'md:border-l md:border-ink-200',
              i === 0 && 'md:pl-0',
            )}
          >
            <span className="font-num pt-0.5 text-[12px] text-ink-400 italic">{String(i + 1).padStart(2, '0')}</span>
            <span className="min-w-0 flex-1">
              <span className="font-display block text-[15px] text-ink-900 transition-colors group-hover:text-brand-700">{x.t}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-400">{x.d}</span>
            </span>
            <ArrowUpRight
              className="mt-1 hidden size-3.5 shrink-0 text-ink-300 transition-colors group-hover:text-ink-900 sm:block"
              strokeWidth={1.5}
            />
          </Link>
        ))}
      </nav>
    </section>
  )
}

/** 本期封面：精选里的第一篇（没有精选时取最热的一篇），大图 + 宋体标题 + 数字 */
function CoverStory() {
  const q = useQuery({
    queryKey: ['trips', 'cover-story'],
    queryFn: async (): Promise<{ trip: Trip; featured: boolean } | null> => {
      const f = await api.trips.list({ tab: 'featured', page_size: 1 })
      if (f.items[0]) return { trip: f.items[0], featured: true }
      const h = await api.trips.list({ tab: 'hot', page_size: 1 })
      return h.items[0] ? { trip: h.items[0], featured: false } : null
    },
    staleTime: 5 * 60_000,
  })
  if (!q.data) return null
  const { trip: t, featured } = q.data
  const cities = t.cities ?? []
  const summary =
    t.summary ||
    [
      cities.length ? `从${cities[0].replace(/市$/, '')}出发` : '一段旅程',
      t.days > 0 && `，${t.days} 天`,
      t.waypoint_count > 0 && `，沿途 ${t.waypoint_count} 个打卡点`,
      '。每一站的去留与评价都记在这里。',
    ]
      .filter(Boolean)
      .join('')
  const stats = [
    { v: t.days || '—', u: '天', l: 'Days' },
    { v: t.distance_km > 0 ? kmShort(t.distance_km) : '—', u: 'km', l: 'Distance' },
    { v: t.waypoint_count, u: '处', l: 'Stops' },
  ]
  return (
    <section className="mx-auto max-w-6xl px-4 pt-10 md:px-6 md:pt-14">
      <Link to={`/trips/${t.id}`} className="group grid items-center gap-6 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] md:gap-12">
        <div className="relative aspect-[3/2] overflow-hidden rounded-[9px] bg-ink-100">
          <TripCover trip={t} full />
          <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-ink-900/10 ring-inset" />
        </div>
        <div className="min-w-0">
          <p className="eyebrow !text-brand-600">{featured ? 'Cover Story · 本期精选' : 'Most Read · 本周热读'}</p>
          <h2 className="mt-3 text-[26px] leading-[1.3] text-balance transition-colors group-hover:text-brand-700 md:text-[34px]">{t.title}</h2>
          <p className="mt-3.5 line-clamp-3 text-[15px] leading-[1.85] text-ink-500">{summary}</p>
          <div className="mt-5 flex items-center gap-2.5 text-[13px] text-ink-500">
            <Avatar user={t.author} size={26} />
            <span className="text-ink-800">{t.author.nickname || t.author.username}</span>
            {t.start_date && (
              <>
                <span aria-hidden className="text-ink-300">
                  ·
                </span>
                <span className="font-num">{dateRange(t.start_date, t.end_date)}</span>
              </>
            )}
          </div>
          <dl className="mt-6 grid grid-cols-3 border-t border-ink-200 pt-4">
            {stats.map((s, i) => (
              <div key={s.l} className={cn('min-w-0', i > 0 && 'border-l border-ink-200 pl-4')}>
                <dt className="eyebrow">{s.l}</dt>
                <dd className="mt-1.5 flex items-baseline gap-1">
                  <span className="font-num text-[28px] leading-none text-ink-900">{s.v}</span>
                  <span className="text-xs text-ink-400">{s.u}</span>
                </dd>
              </div>
            ))}
          </dl>
          <span className="mt-6 inline-flex items-center gap-1.5 border-b border-ink-900 pb-0.5 text-sm text-ink-900">
            阅读全文
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" strokeWidth={1.75} />
          </span>
        </div>
      </Link>
    </section>
  )
}

/** 右栏：热门打卡地 / 避雷榜（编号的细线列表） */
function SidePlaces() {
  const hot = useQuery({ queryKey: ['places', 'hot-side'], queryFn: () => api.places.list({ sort: 'hot', page_size: 5 }) })
  const avoid = useQuery({ queryKey: ['places', 'avoid-side'], queryFn: () => api.places.list({ sort: 'avoid', page_size: 5 }) })
  const block = (eyebrow: string, title: string, items: typeof hot.data, to: string, variant: 'compact' | 'avoid') =>
    !!items?.items.length && (
      <section>
        <SectionHead
          eyebrow={eyebrow}
          title={title}
          className="border-ink-900"
          extra={
            <Link to={to} className="inline-flex items-center gap-0.5 pb-0.5 text-xs text-ink-400 transition-colors hover:text-ink-900">
              全部
              <ArrowRight className="size-3" strokeWidth={1.75} />
            </Link>
          }
        />
        <ol className="divide-y divide-ink-200 border-b border-ink-200">
          {items.items.map((p, i) => (
            <li key={p.id}>
              <PlaceRow place={p} rank={i + 1} variant={variant} />
            </li>
          ))}
        </ol>
      </section>
    )
  if (!hot.data?.items.length && !avoid.data?.items.length) return null
  return (
    <aside className="min-w-0 space-y-12 lg:border-l lg:border-ink-200 lg:pl-10">
      {block('Most Visited', '热门打卡地', hot.data, '/places?sort=hot', 'compact')}
      {block('Caution', '避雷榜', avoid.data, '/places?sort=avoid', 'avoid')}
      <p className="text-xs leading-relaxed text-ink-400">
        榜单统计自公开旅程里的打卡评价：推荐、一般、踩雷，每一票都来自真实到访的人。
      </p>
    </aside>
  )
}

export default function DiscoverPage() {
  const user = useAuth((s) => s.user)
  const [tab, setTab] = useState<Tab>('latest')
  const [phase, setPhase] = useState<Phase | ''>('')
  const q = useInfiniteQuery({
    queryKey: ['trips', tab, phase],
    queryFn: ({ pageParam }) => api.trips.list({ tab, phase, page: pageParam, page_size: 20 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.page_size < last.total ? last.page + 1 : undefined),
    enabled: tab !== 'following' || !!user,
  })
  const trips = flattenPages(q.data?.pages)

  return (
    <>
      <Masthead />
      <CoverStory />
      <div className="mx-auto grid max-w-6xl gap-14 px-4 pt-12 pb-16 md:px-6 md:pt-16 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-10">
        <section className="min-w-0" aria-labelledby="journal-title">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div>
              <p className="eyebrow">The Journal · 旅程</p>
              <h2 id="journal-title" className="mt-1 text-[22px] md:text-[26px]">
                大家的旅程
              </h2>
            </div>
            <FilterLinks<Phase | ''>
              label="类型"
              value={phase}
              onChange={setPhase}
              options={phaseOptions}
              className="hidden sm:flex"
            />
          </div>
          <TabBar<Tab>
            value={tab}
            onChange={setTab}
            className="mt-4"
            options={[
              { value: 'latest', label: '最新' },
              { value: 'hot', label: '热门' },
              { value: 'featured', label: '精选' },
              { value: 'following', label: '关注' },
            ]}
          />
          <FilterLinks<Phase | ''> label="类型" value={phase} onChange={setPhase} options={phaseOptions} className="mt-3 sm:hidden" />
          <div className="mt-7">
            {tab === 'following' && !user ? (
              <Empty
                title="登录后查看关注的人的旅程"
                desc="关注喜欢的旅行者，他们发布新旅程时会出现在这里"
                action={
                  <Link to="/login" className={buttonClass()}>
                    去登录
                  </Link>
                }
              />
            ) : q.isLoading ? (
              <TripGridSkeleton />
            ) : q.isLoadingError ? (
              <LoadError error={q.error} onRetry={() => q.refetch()} />
            ) : trips.length === 0 ? (
              <Empty
                icon={<Compass className="size-11" />}
                title={tab === 'following' ? '关注的人还没有公开的旅程' : '这里还没有公开的旅程'}
                desc="写下第一段旅程，成为这一期的封面"
                action={
                  user && (
                    <Link to="/trips/new" className={buttonClass()}>
                      创建旅程
                    </Link>
                  )
                }
              />
            ) : (
              <>
                <TripGrid trips={trips} />
                {q.hasNextPage && <MoreButton loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />}
              </>
            )}
          </div>
        </section>
        <SidePlaces />
      </div>
    </>
  )
}
