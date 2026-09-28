import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Footprints as FootprintsIcon, Plus } from 'lucide-react'
import { api } from '@/api'
import { FootprintStats, FootprintTimeline } from '@/components/three/FootprintStats'
import { FootprintsView } from '@/components/three/FootprintsView'
import { Empty, LoadError, PageLoader, buttonClass } from '@/components/ui'
import { useAuth } from '@/stores/auth'

export default function FootprintsPage() {
  const user = useAuth((s) => s.user)!
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['my-footprints'], queryFn: api.me.footprints })
  if (isLoading) return <PageLoader />
  if (!data) return <LoadError title="足迹加载失败" error={error} onRetry={() => refetch()} />
  const empty = data.stats.waypoints === 0
  const name = user.nickname || user.username
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <header className="mb-6 sm:mb-8">
        <p className="eyebrow">Footprints · 足迹</p>
        <h1 className="mt-2 text-[28px] leading-tight sm:text-[36px]">我的足迹</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">
          {data.stats.first_date ? (
            <>
              从 <span className="font-num text-ink-700">{data.stats.first_date.slice(0, 4)}</span> 年开始，{name} 已经走过{' '}
              <span className="font-num text-ink-700">{data.stats.cities}</span> 座城市
            </>
          ) : (
            '每一次打卡都会点亮一片地方'
          )}
        </p>
      </header>
      {empty ? (
        <Empty
          icon={<FootprintsIcon className="size-11" />}
          title="还没有足迹"
          desc="创建旅程并打卡，或上传带位置的照片，去过的省份和城市就会被点亮"
          action={
            <Link to="/trips/new" className={buttonClass()}>
              <Plus className="size-4" strokeWidth={1.75} />
              记录第一段旅程
            </Link>
          }
        />
      ) : (
        <>
          <FootprintStats data={data} />
          <div className="mt-6">
            <FootprintsView data={data} />
          </div>
          <section className="mt-12">
            <p className="eyebrow">Timeline · 时间线</p>
            <h2 className="mt-1.5 mb-4 text-[22px]">旅程时间线</h2>
            <FootprintTimeline data={data} />
          </section>
        </>
      )}
    </div>
  )
}
