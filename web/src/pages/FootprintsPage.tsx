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
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">我的足迹</h1>
          <p className="mt-1 text-sm text-ink-500">
            {data.stats.first_date
              ? `从 ${data.stats.first_date.slice(0, 4)} 年开始，${user.nickname || user.username} 已经走过 ${data.stats.cities} 座城市`
              : '每一次打卡都会点亮一片地方'}
          </p>
        </div>
      </div>
      {empty ? (
        <Empty
          icon={<FootprintsIcon className="size-12" />}
          title="还没有足迹"
          desc="创建旅程并打卡，或上传带位置的照片，去过的省份和城市就会被点亮"
          action={
            <Link to="/trips/new" className={buttonClass()}>
              <Plus className="size-4" />
              记录第一段旅程
            </Link>
          }
        />
      ) : (
        <>
          <FootprintStats data={data} className="mt-5" />
          <div className="mt-5">
            <FootprintsView data={data} />
          </div>
          <h2 className="mt-8 mb-3 text-lg font-bold">旅程时间线</h2>
          <FootprintTimeline data={data} />
        </>
      )}
    </div>
  )
}
