import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowRight, Compass, Footprints, Heart, Route, Sparkles, TriangleAlert } from 'lucide-react'
import { api, type Phase } from '@/api'
import { PlaceRow } from '@/components/place/PlaceCard'
import { TripGrid, TripGridSkeleton } from '@/components/trip/TripCard'
import { Button, Empty, Segmented, TabBar } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { useAuth } from '@/stores/auth'

type Tab = 'featured' | 'latest' | 'hot' | 'following'

function Hero() {
  const user = useAuth((s) => s.user)
  const { data: site } = useSite()
  const nav = useNavigate()
  return (
    <section className="bg-night relative overflow-hidden text-white">
      <div
        className="pointer-events-none absolute -top-32 right-0 size-[480px] rounded-full opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(circle,#ff5a5f,transparent 60%)' }}
      />
      <div
        className="pointer-events-none absolute -bottom-48 left-10 size-[420px] rounded-full opacity-30 blur-3xl"
        style={{ background: 'radial-gradient(circle,#7c5cff,transparent 60%)' }}
      />
      <div className="relative mx-auto max-w-6xl px-4 py-10 md:py-14">
        <h1 className="text-3xl leading-tight font-extrabold md:text-5xl">
          规划路线，按图出发
          <br />
          <span className="text-brand-300">把走过的地方都点亮</span>
        </h1>
        <p className="mt-3 max-w-xl text-sm text-white/60 md:text-base">
          记录每个打卡点的真实体验，推荐或避雷一目了然；一键引用别人的路线，旅途中智能推荐下一站。
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button size="lg" onClick={() => nav(user ? '/trips/new' : '/register')} icon={<Route className="size-5" />}>
            开始规划旅程
          </Button>
          {site?.ai_enabled && (
            <Button
              size="lg"
              variant="outline"
              className="border-white/20 bg-white/10 text-white hover:bg-white/20"
              onClick={() => nav(user ? '/trips/new?ai=1' : '/register')}
              icon={<Sparkles className="size-5" />}
            >
              AI 帮我规划
            </Button>
          )}
        </div>
        <div className="mt-8 grid max-w-3xl grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { icon: Route, t: '计划 vs 实际', to: '/trips/new' },
            { icon: TriangleAlert, t: '打卡地避雷', to: '/places?sort=avoid' },
            { icon: Footprints, t: '3D 足迹', to: '/footprints' },
            { icon: Heart, t: '我们的足迹', to: '/together' },
          ].map((x) => (
            <Link
              key={x.t}
              to={x.to}
              className="flex items-center gap-2 rounded-2xl bg-white/5 px-3 py-2.5 text-sm ring-1 ring-white/10 transition hover:bg-white/10"
            >
              <x.icon className="size-4 text-brand-300" />
              {x.t}
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}

function SidePlaces() {
  const hot = useQuery({ queryKey: ['places', 'hot-side'], queryFn: () => api.places.list({ sort: 'hot', page_size: 5 }) })
  const avoid = useQuery({ queryKey: ['places', 'avoid-side'], queryFn: () => api.places.list({ sort: 'avoid', page_size: 5 }) })
  const block = (title: string, icon: React.ReactNode, items: typeof hot.data, to: string) =>
    !!items?.items.length && (
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 font-semibold">
            {icon}
            {title}
          </h3>
          <Link to={to} className="flex items-center text-xs text-ink-400 hover:text-brand-600">
            更多 <ArrowRight className="size-3" />
          </Link>
        </div>
        <div className="space-y-2.5">
          {items.items.map((p, i) => (
            <PlaceRow key={p.id} place={p} rank={i + 1} />
          ))}
        </div>
      </div>
    )
  if (!hot.data?.items.length && !avoid.data?.items.length) return null
  return (
    <aside className="space-y-8">
      {block('热门打卡地', <Compass className="size-4 text-brand-500" />, hot.data, '/places?sort=hot')}
      {block('避雷榜', <TriangleAlert className="size-4 text-red-500" />, avoid.data, '/places?sort=avoid')}
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
  const trips = q.data?.pages.flatMap((p) => p.items) ?? []

  return (
    <>
      <Hero />
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-6 lg:grid-cols-[1fr_320px]">
        <section className="min-w-0">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <TabBar<Tab>
              value={tab}
              onChange={setTab}
              options={[
                { value: 'latest', label: '最新' },
                { value: 'hot', label: '热门' },
                { value: 'featured', label: '精选' },
                { value: 'following', label: '关注' },
              ]}
              className="border-none"
            />
            <Segmented<Phase | ''>
              size="sm"
              value={phase}
              onChange={setPhase}
              options={[
                { value: '', label: '全部' },
                { value: 'finished', label: '游记' },
                { value: 'planning', label: '路线攻略' },
                { value: 'ongoing', label: '旅行中' },
              ]}
            />
          </div>
          <div className="mt-4">
            {tab === 'following' && !user ? (
              <Empty title="登录后查看关注的人的旅程" action={<Link to="/login"><Button>去登录</Button></Link>} />
            ) : q.isLoading ? (
              <TripGridSkeleton />
            ) : trips.length === 0 ? (
              <Empty
                icon={<Compass className="size-12" />}
                title={tab === 'following' ? '关注的人还没有公开的旅程' : '还没有公开的旅程'}
                desc="成为第一个分享旅程的人吧"
                action={
                  user && (
                    <Link to="/trips/new">
                      <Button>创建旅程</Button>
                    </Link>
                  )
                }
              />
            ) : (
              <>
                <TripGrid trips={trips} />
                {q.hasNextPage && (
                  <div className="mt-6 flex justify-center">
                    <Button variant="outline" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                      加载更多
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
        <SidePlaces />
      </div>
    </>
  )
}
