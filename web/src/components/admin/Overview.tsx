import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Camera, Flag, HardDrive, MapPin, MessageSquare, Route, TrendingUp, TriangleAlert, Users, type LucideIcon } from 'lucide-react'
import { api, errorMessage } from '@/api'
import { Button, Card, Empty, PageLoader } from '@/components/ui'
import { fmtBytes, fmtCount } from '@/lib/format'
import { insecureContext } from '@/lib/geo'
import { PanelHeader } from './common'
import { TrendChart } from './TrendChart'

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  today,
}: {
  icon: LucideIcon
  label: string
  value: ReactNode
  sub?: ReactNode
  today?: number
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="flex size-9 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
          <Icon className="size-4.5" />
        </span>
        {today != null && today > 0 && (
          <span className="inline-flex items-center gap-0.5 text-xs text-ink-500">
            <TrendingUp className="size-3.5 text-emerald-500" />
            今日 +{today}
          </span>
        )}
      </div>
      <div className="mt-3 text-2xl font-extrabold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-ink-400">
        {label}
        {sub && <span className="ml-1.5">· {sub}</span>}
      </div>
    </Card>
  )
}

export function Overview() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['admin', 'stats'], queryFn: api.admin.stats })
  const pending = useQuery({
    queryKey: ['admin', 'reports', 'pending-count'],
    queryFn: () => api.admin.reports({ status: 'pending', page_size: 1 }),
    select: (d) => d.total,
  })

  if (isLoading) return <PageLoader />
  if (!data)
    return (
      <Empty title="数据加载失败" desc={errorMessage(error)} action={<Button onClick={() => refetch()}>重试</Button>} />
    )

  return (
    <div>
      <PanelHeader title="概览" desc="站点整体运行数据" />
      {!!pending.data && (
        <Link
          to="/admin/reports"
          className="mb-4 flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200 transition hover:bg-amber-100"
        >
          <Flag className="size-4" />
          有 <b>{pending.data}</b> 条举报等待处理
          <span className="ml-auto text-xs text-amber-700">去处理 →</span>
        </Link>
      )}
      {insecureContext && (
        <div className="mb-4 flex items-start gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            当前通过 HTTP 访问：手机浏览器会禁止定位（我到了打卡、记录 GPS 轨迹、附近推荐），系统分享和屏幕常亮也不可用。邀请用户使用前，请按部署文档「启用 HTTPS」配置域名证书。
          </span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard icon={Users} label="注册用户" value={fmtCount(data.users)} today={data.today.users} />
        <StatCard
          icon={Route}
          label="旅程"
          value={fmtCount(data.trips)}
          sub={`公开 ${fmtCount(data.public_trips)}`}
          today={data.today.trips}
        />
        <StatCard icon={MessageSquare} label="评论" value={fmtCount(data.comments)} today={data.today.comments} />
        <StatCard icon={MapPin} label="打卡地" value={fmtCount(data.places)} />
        <StatCard icon={Camera} label="照片" value={fmtCount(data.photos)} />
        <StatCard icon={HardDrive} label="存储占用" value={fmtBytes(data.storage_bytes)} />
      </div>
      <Card className="mt-4 p-4 sm:p-5">
        {data.trend.length ? <TrendChart trend={data.trend} /> : <Empty title="暂无趋势数据" />}
      </Card>
    </div>
  )
}
