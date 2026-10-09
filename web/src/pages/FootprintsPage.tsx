import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { api } from '@/api'
import { FootprintMoments, FootprintNumerals, FootprintTimeline } from '@/components/three/FootprintStats'
import { FootprintsView } from '@/components/three/FootprintsView'
import { LoadError, PageLoader, buttonClass } from '@/components/ui'
import { useAuth } from '@/stores/auth'

/** 细线标签行：一条 border-t，左侧小标签 + 灰色计数，右侧说明 */
function LabelRow({ label, count, extra }: { label: string; count?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-ink-200 pt-3 pb-1">
      <p className="flex min-w-0 items-baseline gap-3">
        <span className="eyebrow !text-ink-800">{label}</span>
        {count != null && <span className="text-[13px] text-ink-400">{count}</span>}
      </p>
      {extra}
    </div>
  )
}

export default function FootprintsPage() {
  const user = useAuth((s) => s.user)!
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['my-footprints'], queryFn: api.me.footprints })
  if (isLoading) return <PageLoader />
  if (!data) return <LoadError title="足迹加载失败" error={error} onRetry={() => refetch()} />
  const s = data.stats
  const empty = s.waypoints === 0
  const name = user.nickname || user.username
  const since = s.first_date?.slice(0, 4)
  const until = s.last_date?.slice(0, 4)
  const photos = data.points.filter((p) => p.photo_thumb_url).length

  return (
    <div className="mx-auto max-w-[90rem] px-4 pt-10 pb-24 md:px-8 md:pt-16 md:pb-36">
      <header className="animate-slide-up">
        <LabelRow
          label="Footprints · 足迹"
          count={since ? <span className="font-num">{since === until || !until ? since : `${since} — ${until}`}</span> : undefined}
          extra={
            !empty && (
              <span className="text-[13px] text-ink-400">
                <span className="font-num text-ink-700">{s.trips}</span> 段旅程 · <span className="font-num text-ink-700">{s.waypoints}</span> 处打卡
              </span>
            )
          }
        />
        <div className="mt-8 grid gap-x-8 gap-y-4 md:mt-12 lg:grid-cols-12 lg:items-end">
          <h1 className="text-display-lg lg:col-span-7">我的足迹</h1>
          <div className="lg:col-span-4 lg:col-start-9 lg:pb-1.5">
            <p className="text-[15px] leading-[1.8] text-ink-900">
              {since ? (
                <>
                  从 <span className="font-num">{since}</span> 年开始，{name} 已经走过 <span className="font-num">{s.cities}</span> 座城市。
                </>
              ) : (
                '每一次打卡，都会点亮地图上的一片地方。'
              )}
            </p>
            <p className="caption mt-1 max-w-sm leading-[1.8]">
              {empty ? '创建旅程并打卡，或上传带位置的照片，去过的省份和城市就会被点亮。' : '去过的省份立起来，城市亮成光柱；放大到城市，看见每一次打卡和照片。'}
            </p>
          </div>
        </div>
      </header>

      {empty ? (
        <section className="animate-slide-up mt-12 border-t border-ink-200 pt-14 pb-8 text-center md:mt-16 md:pt-20 [animation-delay:120ms] [animation-fill-mode:backwards]">
          <p className="font-num text-num text-ink-400">0</p>
          <p className="text-display-md mt-5 text-ink-900">还没有足迹</p>
          <p className="caption mt-2">第一次打卡，地图上就会亮起第一座城市</p>
          <Link to="/trips/new" className={buttonClass({ size: 'lg', className: 'mt-10' })}>
            记录第一段旅程
            <ArrowRight className="size-4" strokeWidth={1.5} />
          </Link>
        </section>
      ) : (
        <>
          <FootprintNumerals data={data} className="mt-10 md:mt-16" />

          <section className="animate-fade-in mt-10 md:mt-16" aria-label="足迹地图">
            <FootprintsView data={data} bleed height="h-[68svh] min-h-[26rem] md:h-[80vh] md:min-h-[36rem]" />
          </section>

          {photos > 0 && (
            <section className="mt-24 md:mt-36">
              <LabelRow label="Moments · 照片" count={<><span className="font-num">{photos}</span> 张</>} />
              <h2 className="text-display-md mt-8 mb-10 font-normal md:mt-12 md:mb-16">路上看见的</h2>
              <FootprintMoments data={data} />
            </section>
          )}

          <section className="mt-24 md:mt-36">
            <LabelRow label="Timeline · 时间线" count={<><span className="font-num">{s.trips}</span> 段旅程</>} />
            <h2 className="text-display-md mt-8 mb-10 font-normal md:mt-12 md:mb-14">旅程时间线</h2>
            <FootprintTimeline data={data} />
          </section>
        </>
      )}
    </div>
  )
}
