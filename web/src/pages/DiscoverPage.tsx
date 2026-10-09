import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowRight, ArrowUpRight, MapPin } from 'lucide-react'
import { api, type Phase, type TripCard as Trip } from '@/api'
import { EmptyNote, FilterLinks, LabelRow, MoreButton, Reveal, SectionHead, TextLink, cityShort, pad2 } from '@/components/editorial'
import { RouteSketch } from '@/components/editorial/RouteSketch'
import { PlaceRow } from '@/components/place/PlaceCard'
import { TripCover, TripGrid, TripGridSkeleton, kmShort } from '@/components/trip/TripCard'
import { LoadError, buttonClass } from '@/components/ui'
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

const tabOptions: { value: Tab; label: string }[] = [
  { value: 'latest', label: '最新' },
  { value: 'hot', label: '热门' },
  { value: 'featured', label: '精选' },
  { value: 'following', label: '关注' },
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
  { t: '计划 vs 实际', d: '路线逐站对照，看看哪里临时改了主意', to: '/trips/new' },
  { t: '打卡地避雷', d: '多人踩雷的地方，出发前就知道', to: '/places?sort=avoid' },
  { t: '3D 足迹', d: '点亮走过的城市，重温每一段路', to: '/footprints' },
  { t: '我们', d: '情侣、闺蜜、家人……每个空间一张共同的足迹地图', to: '/together' },
]

type CoverData = {
  /** 首屏整幅大图：精选 / 热门里第一篇有封面照片的旅程 */
  hero: Trip | null
  heroFeatured: boolean
  /** 本期封面：精选（没有时取最热）里第一篇、且不是首屏那一篇 */
  story: Trip | null
  storyFeatured: boolean
}

/**
 * 首屏与本期封面各取一篇，互不重复：首屏已经是照片封面时，「本期封面」换成下一篇，
 * 一打开页面不会连续看到同一段旅程三次
 */
function useCover() {
  return useQuery({
    queryKey: ['trips', 'cover-story'],
    queryFn: async (): Promise<CoverData> => {
      const featured = (await api.trips.list({ tab: 'featured', page_size: 8 })).items
      const hot = featured.length < 2 || !featured.some((t) => t.cover_url) ? (await api.trips.list({ tab: 'hot', page_size: 8 })).items : []
      const hero = featured.find((t) => t.cover_url) ?? hot.find((t) => t.cover_url) ?? null
      const pool = [...featured.map((t) => ({ t, featured: true })), ...hot.map((t) => ({ t, featured: false }))].filter((x) => x.t.id !== hero?.id)
      return {
        hero,
        heroFeatured: !!hero && featured.some((t) => t.id === hero.id),
        story: pool[0]?.t ?? null,
        storyFeatured: pool[0]?.featured ?? false,
      }
    },
    staleTime: 5 * 60_000,
  })
}

/** 行程的一行事实：作者 · 天数 · 里程 · 城市 */
function tripFacts(t: Trip) {
  return [
    t.author.nickname || t.author.username,
    t.days > 0 && `${t.days} 天`,
    t.distance_km > 0 && `${kmShort(t.distance_km)} km`,
    t.cities.length > 0 && t.cities.slice(0, 3).map(cityShort).join(' · '),
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * 照片首屏从页面最顶端开始：顶栏（半透明毛玻璃、吸顶）直接压在照片上。
 * 只在顶栏紧挨着主内容时这样做；上方有公告 / 旅行中提示条时照片从提示条下方开始，不遮住它们
 */
function useUnderHeader(enabled: boolean) {
  const ref = useRef<HTMLElement>(null)
  const [pull, setPull] = useState(0)
  useLayoutEffect(() => {
    const sec = ref.current
    const main = sec?.closest('main')
    const shell = main?.parentElement
    if (!enabled || !sec || !main || !shell) {
      setPull(0)
      return
    }
    const measure = () => {
      const prev = main.previousElementSibling
      const first = main.firstElementChild === sec || main.firstElementChild?.firstElementChild === sec
      setPull(first && prev instanceof HTMLElement && prev.tagName === 'HEADER' ? prev.offsetHeight : 0)
    }
    measure()
    const mo = new MutationObserver(measure)
    mo.observe(shell, { childList: true })
    return () => mo.disconnect()
  }, [enabled])
  return [ref, pull] as const
}

/**
 * 首屏：有封面照片时整幅出血（100vw × 88vh，顶栏压在照片上），超大宋体标题压在照片上，左下角是照片说明；
 * 没有照片时是纯排版：近黑底上的超大标题 + 象牙白细线路线图
 */
function Opening({ cover, pending }: { cover: CoverData | undefined; pending: boolean }) {
  const user = useAuth((s) => s.user)
  const { data: site } = useSite()
  const now = dayjs()
  const hero = cover?.hero ?? null
  const photo = !!hero
  const [loaded, setLoaded] = useState(false)
  const [ref, pull] = useUnderHeader(photo)

  const ctas = (
    <div className="flex flex-wrap gap-2.5">
      <Link to={user ? '/trips/new' : '/register'} className={buttonClass({ size: 'lg', className: photo ? 'bg-white text-black hover:bg-white/85' : undefined })}>
        开始规划旅程
        <ArrowRight className="size-4" strokeWidth={1.5} />
      </Link>
      {site?.ai_enabled ? (
        <Link
          to={user ? '/trips/new?ai=1' : '/register'}
          className={buttonClass({ variant: 'outline', size: 'lg', className: photo ? 'border-white/40 text-white hover:border-white' : undefined })}
        >
          让 AI 先拟一版
        </Link>
      ) : (
        <Link
          to="/places"
          className={buttonClass({ variant: 'outline', size: 'lg', className: photo ? 'border-white/40 text-white hover:border-white' : undefined })}
        >
          看看打卡地
        </Link>
      )}
    </div>
  )

  // 手机底部导航里没有「打卡地」：首屏按钮下方放一个清楚的入口（宽屏顶栏里有）
  const placesEntry = (
    <nav aria-label="打卡地" className={cn('mt-5 flex flex-wrap items-center gap-x-1 gap-y-2 md:hidden', photo ? 'text-white/80' : 'text-ink-600')}>
      <Link
        to="/places"
        className={cn(
          'mr-1 inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-medium',
          photo ? 'border-white/45 text-white' : 'border-ink-300 text-ink-900',
        )}
      >
        <MapPin className="size-3.5" strokeWidth={1.75} />
        打卡地
      </Link>
      {(
        [
          ['hot', '热门'],
          ['rating', '高分'],
          ['avoid', '避雷榜'],
        ] as const
      ).map(([sort, label]) => (
        <Link key={sort} to={`/places?sort=${sort}`} className="inline-flex h-9 items-center px-2.5 text-[13px] underline decoration-current/30 underline-offset-4">
          {label}
        </Link>
      ))}
    </nav>
  )

  const headline = (
    <h1
      className={cn(
        "text-display-xl animate-slide-up font-normal [font-feature-settings:'halt']",
        photo ? 'text-white [text-shadow:0_1px_40px_rgb(0_0_0/0.25)]' : 'text-ink-900',
      )}
    >
      <span className="inline-block">规划路线，</span>
      <span className="inline-block">按图出发；</span>
      <br />
      <span className="inline-block">把走过的地方，</span>
      <span className="inline-block">都点亮。</span>
    </h1>
  )

  return (
    // 手机上底部导航是固定的：首屏高度减去顶栏和底部导航，按钮不被挡住
    <section
      ref={ref}
      className={cn(
        'relative isolate flex flex-col overflow-hidden',
        photo
          ? 'mt-[calc(var(--pull)*-1)] min-h-[calc(100svh-9rem+var(--pull))] pt-(--pull) md:min-h-[calc(88svh+var(--pull))]'
          : 'md:min-h-[calc(88svh-3.75rem)]',
      )}
      style={{ '--pull': `${pull}px` } as CSSProperties}
    >
      {hero && (
        <>
          <img
            src={hero.cover_url}
            alt=""
            onLoad={() => setLoaded(true)}
            className={cn(
              'absolute inset-0 -z-10 size-full scale-[1.04] object-cover transition-[opacity,scale] duration-[1600ms] ease-out-expo',
              loaded ? 'scale-100 opacity-100' : 'opacity-0',
            )}
          />
          {/* 极淡的遮罩：顶部一小段压暗给顶栏，底部渐暗给照片说明；中间保留照片本来的明暗 */}
          <div aria-hidden className="absolute inset-x-0 top-0 -z-10 h-56 bg-linear-to-b from-black/45 to-transparent" />
          <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-t from-black/70 via-black/20 to-black/5" />
          {/* 标题背后一团很淡的暗影（不是整层压暗）：浅色天空上白字也有足够对比 */}
          <div
            aria-hidden
            className="absolute inset-0 -z-10"
            style={{ background: 'radial-gradient(ellipse 85% 50% at 38% 46%, rgb(0 0 0 / 0.34), rgb(0 0 0 / 0.12) 60%, transparent 85%)' }}
          />
        </>
      )}

      <div className="mx-auto flex w-full max-w-[90rem] flex-1 flex-col px-4 md:px-8">
        {/* 顶部小字：期号 · 日期（照片上是白色） */}
        <div className={cn('flex items-center justify-between gap-4 pt-5 text-[12px] tracking-[0.14em] uppercase md:pt-6', photo ? 'text-white/75' : 'text-ink-400')}>
          <span>
            <span className={photo ? 'text-white' : 'text-ink-800'}>
              Issue <span className="font-num text-[13px]">{pad2(issueNo(now))}</span>
            </span>{' '}
            · 旅行志
          </span>
          <span className="hidden md:inline">{site?.name || 'TripHub'} · Travel Journal</span>
          <span>
            <span className="font-num text-[13px]">{now.format('YYYY.MM.DD')}</span> · {weekdays[now.day()]}
          </span>
        </div>

        {photo ? (
          <>
            <div className="flex flex-1 flex-col justify-center py-16">
              {headline}
              <p className="font-display mt-5 text-[1.25rem] text-white/80 italic md:mt-6 md:text-[1.5rem]">Plan the route. Light up the map.</p>
            </div>
            <div className="grid gap-8 pb-8 md:grid-cols-12 md:items-end md:pb-10">
              {/* 照片说明：两行式（亮 + 灰），整行链接到这段旅程 */}
              <Link to={`/trips/${hero.id}`} className="group block md:col-span-6">
                <p className="text-[13px] text-white">
                  <span className="tracking-[0.12em] uppercase">{cover?.heroFeatured ? 'Featured' : 'Most Read'}</span>
                  <span className="mx-2 text-white/50">·</span>
                  <span className="underline decoration-white/0 underline-offset-4 transition-colors group-hover:decoration-white/70">{hero.title}</span>
                </p>
                <p className="mt-0.5 text-[13px] text-white/65">{tripFacts(hero)}</p>
              </Link>
              <div className="md:col-span-6 md:justify-self-end">
                {ctas}
                {placesEntry}
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col justify-center gap-12 pt-14 pb-12 md:gap-10 md:pt-12 md:pb-10">
            {headline}
            <div className={cn('grid items-end gap-12 transition-opacity duration-700 md:grid-cols-12 md:gap-8', pending ? 'opacity-0' : 'animate-fade-in')}>
              <div className="md:col-span-5 lg:col-span-4">
                <p className="font-display text-[1.25rem] text-ink-700 italic md:text-[1.4rem]">Plan the route. Light up the map.</p>
                <p className="mt-4 max-w-sm text-[14.5px] leading-[1.85] text-ink-500">
                  每个打卡点都有真实的体验记录，推荐与避雷一目了然；看中别人的路线，一键引用，旅途中再为你推荐下一站。
                </p>
                <div className="mt-8">
                  {ctas}
                  {placesEntry}
                </div>
              </div>
              {/* 线描与图注同宽、左缘对齐 */}
              <figure className="w-full max-w-[22rem] md:col-span-6 md:col-start-7 md:justify-self-end lg:col-span-5 lg:col-start-8">
                <RouteSketch />
                <figcaption className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-ink-200 pt-3">
                  <span>
                    <span className="block text-[13px] text-ink-900">Fig. 1 江南五日</span>
                    <span className="caption block">上海至黄山，走到第三天</span>
                  </span>
                  <span className="caption flex items-center gap-4">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-px w-5 bg-ink-900" />
                      已走过
                    </span>
                    <span className="inline-flex items-center gap-2">
                      <span className="w-5 border-t border-dashed border-ink-500" />
                      计划中
                    </span>
                  </span>
                </figcaption>
              </figure>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * 本期封面：左边是封面（有照片用照片，没有时是排版封面——题字地名有字号上限），
 * 右边是标题、导语与大数字（font-num text-num）
 */
function CoverStory({ trip: t, featured }: { trip: Trip; featured: boolean }) {
  const cities = (t.cities ?? []).map(cityShort)
  const summary =
    t.summary ||
    [
      cities.length ? `从${cities[0]}出发` : '一段旅程',
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
    <Reveal as="section" className="mx-auto max-w-[90rem] px-4 pt-24 md:px-8 md:pt-36" aria-labelledby="cover-title">
      <LabelRow
        label={featured ? 'Cover Story · 本期封面' : 'Most Read · 本周热读'}
        count={`No. ${String(t.id).padStart(3, '0')}`}
        extra={
          <Link to={`/trips/${t.id}`} className="inline-flex h-10 items-center gap-1.5 text-[13px] text-ink-500 transition-colors hover:text-ink-900 md:h-8">
            阅读全文
            <ArrowRight className="size-3.5" strokeWidth={1.5} />
          </Link>
        }
      />
      <Link to={`/trips/${t.id}`} className="group grid gap-x-8 gap-y-8 pt-8 md:pt-10 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7">
          <div className="@container relative aspect-[3/2] overflow-hidden rounded-image bg-surface">
            <div className="size-full transition-transform duration-700 ease-out group-hover:scale-[1.02]">
              <TripCover trip={t} full landscape />
            </div>
          </div>
          {cities.length > 1 && (
            <p className="mt-4 flex items-center gap-4 text-[13px] tracking-[0.2em] text-ink-500">
              <span className="h-px w-12 bg-ink-400" />
              {cities.slice(0, 5).join(' · ')}
              {cities.length > 5 && ' 等'}
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-col lg:col-span-5 lg:pt-2">
          <h2
            id="cover-title"
            className="text-display-md font-normal text-balance [font-feature-settings:'halt'] [font-variant-numeric:lining-nums] transition-colors duration-300 group-hover:text-ink-700"
          >
            {t.title}
          </h2>
          <p className="mt-6 line-clamp-4 max-w-md text-[15px] leading-[1.9] text-pretty text-ink-600">{summary}</p>
          <p className="mt-6">
            <span className="block text-[13px] text-ink-900">{t.author.nickname || t.author.username}</span>
            <span className="caption font-num block">{t.start_date ? dateRange(t.start_date, t.end_date) : dayjs(t.created_at).format('YYYY.MM.DD')}</span>
          </p>
          <dl className="mt-8 grid grid-cols-3 border-t border-ink-200 pt-5">
            {stats.map((s, i) => (
              <div key={s.l} className={cn('min-w-0', i > 0 && 'border-l border-ink-200 pl-4 md:pl-6')}>
                <dt className="eyebrow">{s.l}</dt>
                <dd className="mt-3 flex items-baseline gap-1.5">
                  <span className="font-num text-num text-ink-900">{s.v}</span>
                  <span className="text-xs text-ink-500">{s.u}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Link>
    </Reveal>
  )
}

/** 热门打卡地 / 避雷榜：两张主题卡片里的编号列表，两栏并排 */
function PlaceLists() {
  const hot = useQuery({ queryKey: ['places', 'hot-side'], queryFn: () => api.places.list({ sort: 'hot', page_size: 5 }) })
  const avoid = useQuery({ queryKey: ['places', 'avoid-side'], queryFn: () => api.places.list({ sort: 'avoid', page_size: 5 }) })
  const block = (eyebrow: string, title: string, items: typeof hot.data, to: string, variant: 'compact' | 'avoid', delay: number) =>
    !!items?.items.length && (
      <Reveal delay={delay} className="min-w-0">
        <SectionHead
          eyebrow={eyebrow}
          count={pad2(items.total)}
          title={title}
          extra={
            <Link to={to} className="inline-flex h-10 items-center gap-1 text-[13px] text-ink-500 transition-colors hover:text-ink-900 md:h-8">
              全部
              <ArrowRight className="size-3.5" strokeWidth={1.5} />
            </Link>
          }
        />
        <ol className="th-card mt-6 divide-y divide-line px-5 md:mt-8 md:px-6">
          {items.items.map((p, i) => (
            <li key={p.id}>
              <PlaceRow place={p} rank={i + 1} variant={variant} />
            </li>
          ))}
        </ol>
      </Reveal>
    )
  if (!hot.data?.items.length && !avoid.data?.items.length) return null
  return (
    <section className="mx-auto max-w-[90rem] px-4 pt-28 md:px-8 md:pt-40" aria-label="打卡地榜单">
      <div className="grid gap-20 lg:grid-cols-2 lg:gap-8">
        {block('Most Visited · 热门打卡地', '去的人最多', hot.data, '/places?sort=hot', 'compact', 0)}
        {block('Caution · 避雷榜', '先避开这些', avoid.data, '/places?sort=avoid', 'avoid', 120)}
      </div>
      <p className="caption mt-8 max-w-xl">榜单统计自公开旅程里的打卡评价：推荐、一般、踩雷，每一票都来自真实到访的人。</p>
    </section>
  )
}

/** 栏目索引：四张主题卡片（th-card：手帐虚线纸片、山野 / 晴海实心卡、夜航细线），序号 + 标题 + 一句说明 */
function Index() {
  return (
    <Reveal as="section" className="mx-auto max-w-[90rem] px-4 pt-28 md:px-8 md:pt-40" aria-label="栏目">
      <LabelRow label="Index · 本期栏目" count={pad2(sections.length)} />
      <nav className="mt-6 grid gap-3 sm:grid-cols-2 md:mt-10 lg:grid-cols-4 lg:gap-4">
        {sections.map((x, i) => (
          <Link
            key={x.t}
            to={x.to}
            className="th-card group flex min-h-40 flex-col justify-between gap-8 p-5 transition-[border-color,box-shadow] duration-300 hover:border-ink-300 hover:shadow-float md:min-h-48 md:p-6"
          >
            <span className="flex items-start justify-between">
              <span className="font-num text-[length:var(--text-h2)] leading-none text-ink-400 transition-colors duration-300 group-hover:text-brand-600">
                {pad2(i + 1)}
              </span>
              <ArrowUpRight className="size-4 text-ink-400 transition-colors duration-300 group-hover:text-ink-900" strokeWidth={1.5} />
            </span>
            <span>
              <span className="font-display block text-[length:var(--text-card)] leading-tight text-ink-900">{x.t}</span>
              <span className="caption mt-1.5 block max-w-[16rem]">{x.d}</span>
            </span>
          </Link>
        ))}
      </nav>
    </Reveal>
  )
}

export default function DiscoverPage() {
  const user = useAuth((s) => s.user)
  const [tab, setTab] = useState<Tab>('latest')
  const [phase, setPhase] = useState<Phase | ''>('')
  const cover = useCover()
  const q = useInfiniteQuery({
    queryKey: ['trips', tab, phase],
    queryFn: ({ pageParam }) => api.trips.list({ tab, phase, page: pageParam, page_size: 20 }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.page_size < last.total ? last.page + 1 : undefined),
    enabled: tab !== 'following' || !!user,
  })
  const all = flattenPages(q.data?.pages)
  const total = q.data?.pages[0]?.total
  // 默认视图里不再重复首屏照片和本期封面那两篇（筛选、换排序时照常列出全部）
  const shownAbove = new Set([cover.data?.hero?.id, cover.data?.story?.id].filter((x): x is number => x != null))
  const rest = tab === 'latest' && !phase ? all.filter((t) => !shownAbove.has(t.id)) : all
  const trips = rest.length ? rest : all

  return (
    <div className="[font-variant-numeric:lining-nums]">
      <Opening cover={cover.data} pending={cover.isPending} />
      {cover.data?.story && <CoverStory trip={cover.data.story} featured={cover.data.storyFeatured} />}

      <section className="mx-auto max-w-[90rem] px-4 pt-28 md:px-8 md:pt-40" aria-labelledby="journal-title">
        <LabelRow
          label="The Journal · 旅程"
          count={total != null ? `${total} 篇` : undefined}
          extra={<FilterLinks<Phase | ''> label="类型" value={phase} onChange={setPhase} options={phaseOptions} className="-mr-3" />}
        />
        <div className="mt-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-4 md:mt-12">
          <h2 id="journal-title" className="text-display-md font-normal">
            大家的旅程
          </h2>
          <FilterLinks<Tab> label="排序" value={tab} onChange={setTab} options={tabOptions} className="text-[14px] md:-mr-3" />
        </div>
        <div className="mt-10 md:mt-16">
          {tab === 'following' && !user ? (
            <EmptyNote
              title="登录后，看看你关注的人。"
              desc="关注喜欢的旅行者，他们发布新旅程时会出现在这里。"
              action={<TextLink to="/login">去登录</TextLink>}
            />
          ) : q.isLoading ? (
            <TripGridSkeleton n={6} layout="journal" />
          ) : q.isLoadingError ? (
            <LoadError error={q.error} onRetry={() => q.refetch()} />
          ) : trips.length === 0 ? (
            <EmptyNote
              title={tab === 'following' ? '关注的人还没有公开的旅程。' : '这里还没有公开的旅程。'}
              desc="写下第一段旅程，成为这一期的封面。"
              action={user && <TextLink to="/trips/new">创建旅程</TextLink>}
            />
          ) : (
            <>
              <TripGrid trips={trips} layout="journal" />
              {q.hasNextPage && <MoreButton loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()} />}
            </>
          )}
        </div>
      </section>

      <PlaceLists />
      <Index />
      <div className="h-24 md:h-40" />
    </div>
  )
}
