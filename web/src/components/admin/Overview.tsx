import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { api, errorMessage } from '@/api'
import { Button, Empty, PageLoader } from '@/components/ui'
import { cn } from '@/lib/cn'
import { dayjs, fmtBytes, fmtCount } from '@/lib/format'
import { insecureContext } from '@/lib/geo'
import { PanelHeader } from './common'
import { TrendChart } from './TrendChart'

/** 「12.3 MB」拆成数字和单位，单位用小字 */
function splitUnit(s: string): [string, string | undefined] {
  const m = s.match(/^([\d.]+)\s*(\S+)?$/)
  return m ? [m[1], m[2]] : [s, undefined]
}

/** 大号 Cormorant 数字 + 小标签；多个之间用细线分隔（由外层网格负责） */
function Figure({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0 py-5 pr-4 pl-4 max-sm:[&:nth-child(odd)]:pl-0 sm:[&:nth-child(3n+1)]:pl-0">
      <div className="text-xs tracking-wide text-ink-500">{label}</div>
      <div className="mt-2.5 flex items-baseline gap-1">
        <span className="font-num text-[2.5rem] leading-none font-normal tracking-tight text-ink-900 md:text-[2.875rem]">{value}</span>
        {unit && <span className="font-num text-sm text-ink-400">{unit}</span>}
      </div>
      <div className="mt-2 min-h-4 truncate text-xs text-ink-400">{sub}</div>
    </div>
  )
}

/** 今日新增：玉青小字 */
const Today = ({ n }: { n: number }) =>
  n > 0 ? (
    <span className="text-emerald-700">
      今日 <span className="font-num">+{n}</span>
    </span>
  ) : (
    <span>今日暂无新增</span>
  )

/** 待办条目：细线分隔的一行，右侧箭头 */
function TodoRow({ to, children, action }: { to: string; children: ReactNode; action: string }) {
  return (
    <Link to={to} className="group flex items-center gap-3 py-3.5 text-sm text-ink-700 transition-colors hover:text-ink-900">
      <span className="size-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />
      <span className="min-w-0 flex-1">{children}</span>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-500 group-hover:text-ink-900">
        {action}
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" strokeWidth={1.5} />
      </span>
    </Link>
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

  const hasTodo = !!pending.data || data.pending_trips > 0
  const [storage, storageUnit] = splitUnit(fmtBytes(data.storage_bytes))

  return (
    <div>
      <PanelHeader eyebrow={`Overview · ${dayjs().format('YYYY.MM.DD')}`} title="概览" desc="站点整体运行数据" />

      {hasTodo && (
        <section className="mb-8" aria-label="待办">
          <p className="eyebrow !text-brand-600">To do · 待办</p>
          <div className="mt-2 divide-y divide-ink-200 border-y border-ink-200">
            {!!pending.data && (
              <TodoRow to="/admin/reports" action="去处理">
                有 <span className="font-num text-base text-ink-900">{pending.data}</span> 条举报等待处理
              </TodoRow>
            )}
            {data.pending_trips > 0 && (
              <TodoRow to="/admin/trips?status=pending" action="去审核">
                有 <span className="font-num text-base text-ink-900">{data.pending_trips}</span> 段公开旅程等待审核
              </TodoRow>
            )}
          </div>
        </section>
      )}

      {insecureContext && (
        <div className="mb-8 border-l-2 border-amber-500 py-1 pl-4 text-sm leading-relaxed text-ink-600">
          <p className="eyebrow !text-amber-700">HTTP · 未启用 HTTPS</p>
          <p className="mt-1.5">
            当前通过 HTTP 访问：手机浏览器会禁止定位（我到了打卡、记录 GPS 轨迹、附近推荐），系统分享和屏幕常亮也不可用。邀请用户使用前，请按部署文档「启用
            HTTPS」配置域名证书。
          </p>
        </div>
      )}

      {/* 统计：顶部墨线，数字之间竖细线，行间横细线 */}
      <div className="grid grid-cols-2 border-t border-ink-900 sm:grid-cols-3 [&>*]:border-b [&>*]:border-ink-200 max-sm:[&>*:nth-child(even)]:border-l sm:[&>*:not(:nth-child(3n+1))]:border-l">
        <Figure label="注册用户" value={fmtCount(data.users)} sub={<Today n={data.today.users} />} />
        <Figure
          label="旅程"
          value={fmtCount(data.trips)}
          sub={
            <>
              公开 <span className="font-num">{fmtCount(data.public_trips)}</span>
              {data.pending_trips > 0 && (
                <>
                  {' · '}待审 <span className="font-num">{fmtCount(data.pending_trips)}</span>
                </>
              )}
              {data.today.trips > 0 && (
                <>
                  {' · '}
                  <Today n={data.today.trips} />
                </>
              )}
            </>
          }
        />
        <Figure label="评论" value={fmtCount(data.comments)} sub={<Today n={data.today.comments} />} />
        <Figure label="打卡地" value={fmtCount(data.places)} />
        <Figure label="照片" value={fmtCount(data.photos)} />
        <Figure label="存储占用" value={storage} unit={storageUnit} />
      </div>

      <section className="mt-10">
        {data.trend.length ? <TrendChart trend={data.trend} /> : <Empty title="暂无趋势数据" />}
      </section>

      {/* 系统诊断入口 */}
      <Link
        to="/admin/diagnostics"
        className={cn(
          'group mt-10 flex flex-col gap-3 rounded-xl border border-ink-200 bg-white/60 px-5 py-4 transition-colors hover:border-ink-900/30 hover:bg-surface',
          'sm:flex-row sm:items-center sm:gap-6',
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Diagnostics · 系统诊断</p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-600">
            地点搜索、路线距离或 AI 生成行程不可用？一键检测高德 Key、AI 模型与天地图的配置，并给出修复步骤。
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-sm text-ink-900">
          <span className="font-display">去检测</span>
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" strokeWidth={1.5} />
        </span>
      </Link>
    </div>
  )
}
