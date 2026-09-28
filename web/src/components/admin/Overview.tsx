import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { api, errorMessage } from '@/api'
import { Button, Empty, PageLoader } from '@/components/ui'
import { cn } from '@/lib/cn'
import { dayjs, fmtCount } from '@/lib/format'
import { insecureContext } from '@/lib/geo'
import { LabelRow, PanelHeader, tidyBytes } from './common'
import { TrendChart } from './TrendChart'

/** 「12.3 MB」拆成数字和单位，单位用小字 */
function splitUnit(s: string): [string, string | undefined] {
  const m = s.match(/^([\d.]+)\s*(\S+)?$/)
  return m ? [m[1], m[2]] : [s, undefined]
}

/** 大号细字 Cormorant 数字 + 极小标签；细线由外层网格负责 */
function Figure({
  label,
  en,
  value,
  unit,
  sub,
  className,
}: {
  label: string
  en: string
  value: string
  unit?: string
  sub?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0 border-b border-ink-200 pt-5 pb-7 md:pt-6 md:pb-9', className)}>
      <p className="eyebrow">
        {en} · {label}
      </p>
      <p className="mt-6 flex items-baseline gap-1.5 md:mt-10">
        <span className="font-num text-[3.25rem] leading-[0.85] font-light text-ink-900 md:text-[4.75rem]">{value}</span>
        {unit && <span className="font-num text-lg text-ink-500">{unit}</span>}
      </p>
      <p className="caption mt-4 min-h-5 truncate">{sub}</p>
    </div>
  )
}

/** 今日新增：灰色标签 + 象牙白数字（玉青只留给「推荐」） */
const Today = ({ n }: { n: number }) =>
  n > 0 ? (
    <span className="text-ink-500">
      今日 <span className="font-num text-[15px] text-ink-900">+{n}</span>
    </span>
  ) : (
    <span>今日暂无新增</span>
  )

/** 待办条目：细线分隔的一行，朱砂小点 + 大号数字，右侧「去处理 →」 */
function TodoRow({ to, children, action }: { to: string; children: ReactNode; action: string }) {
  return (
    <Link to={to} className="group flex items-center gap-4 py-5 text-[15px] text-ink-700 transition-colors duration-300 hover:text-ink-900">
      <span className="size-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />
      <span className="min-w-0 flex-1">{children}</span>
      <span className="inline-flex shrink-0 items-center gap-2 text-[13px] text-ink-500 transition-colors duration-300 group-hover:text-ink-900">
        {action}
        <ArrowRight className="size-4" strokeWidth={1.25} />
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
  const todoCount = (pending.data ? 1 : 0) + (data.pending_trips > 0 ? 1 : 0)
  const [storage, storageUnit] = splitUnit(tidyBytes(data.storage_bytes))

  return (
    <div>
      <PanelHeader eyebrow={`Overview · ${dayjs().format('YYYY.MM.DD')}`} title="概览" desc="站点整体运行数据" />

      {hasTodo && (
        <section className="animate-slide-up mb-16 [animation-delay:60ms] [animation-fill-mode:backwards] md:mb-24" aria-label="待办">
          <LabelRow label="To do · 待办" tone="brand" count={String(todoCount).padStart(2, '0')} />
          <div className="mt-2 divide-y divide-ink-200 border-b border-ink-200">
            {!!pending.data && (
              <TodoRow to="/admin/reports" action="去处理">
                有 <span className="font-num mx-1 text-[1.75rem] leading-none font-light text-ink-900">{pending.data}</span> 条举报等待处理
              </TodoRow>
            )}
            {data.pending_trips > 0 && (
              <TodoRow to="/admin/trips?status=pending" action="去审核">
                有 <span className="font-num mx-1 text-[1.75rem] leading-none font-light text-ink-900">{data.pending_trips}</span>{' '}
                段公开旅程等待审核
              </TodoRow>
            )}
          </div>
        </section>
      )}

      {insecureContext && (
        <div className="mb-16 border-l border-amber-500 py-1 pl-5 text-[13.5px] leading-relaxed text-ink-600 md:mb-24">
          <p className="eyebrow !text-amber-700">HTTP · 未启用 HTTPS</p>
          <p className="mt-2 max-w-3xl">
            当前通过 HTTP 访问：手机浏览器会禁止定位（我到了打卡、记录 GPS 轨迹、附近推荐），系统分享和屏幕常亮也不可用。邀请用户使用前，请按部署文档「启用
            HTTPS」配置域名证书。
          </p>
        </div>
      )}

      {/* 数据：大号细字数字，竖细线分隔，行间横细线 */}
      <section className="animate-slide-up [animation-delay:120ms] [animation-fill-mode:backwards]" aria-label="数据">
        <LabelRow label="Figures · 数据" count="06" />
        <div className="grid grid-cols-2 border-t border-ink-200 xl:grid-cols-3 [&>*:nth-child(even)]:max-xl:border-l [&>*:nth-child(even)]:max-xl:pl-5 xl:[&>*:not(:nth-child(3n+1))]:border-l xl:[&>*:not(:nth-child(3n+1))]:pl-8">
          <Figure label="注册用户" en="Members" value={fmtCount(data.users)} sub={<Today n={data.today.users} />} />
          <Figure
            label="旅程"
            en="Journeys"
            value={fmtCount(data.trips)}
            sub={
              <>
                公开 <span className="font-num text-[15px]">{fmtCount(data.public_trips)}</span>
                {data.pending_trips > 0 && (
                  <>
                    {' · '}待审 <span className="font-num text-[15px]">{fmtCount(data.pending_trips)}</span>
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
          <Figure label="评论" en="Comments" value={fmtCount(data.comments)} sub={<Today n={data.today.comments} />} />
          <Figure label="打卡地" en="Places" value={fmtCount(data.places)} />
          <Figure label="照片" en="Photos" value={fmtCount(data.photos)} />
          <Figure label="存储占用" en="Storage" value={storage} unit={storageUnit} />
        </div>
      </section>

      <section className="mt-20 md:mt-28">
        {data.trend.length ? (
          <TrendChart trend={data.trend} />
        ) : (
          <>
            <LabelRow label="Last 14 days · 近 14 天" />
            <Empty title="暂无趋势数据" />
          </>
        )}
      </section>

      {/* 系统诊断入口：细线标签行 + 大号宋体问句，右侧「去检测 →」 */}
      <section className="mt-20 md:mt-28">
        <LabelRow label="Diagnostics · 系统诊断" />
        <Link
          to="/admin/diagnostics"
          className="group mt-8 grid gap-x-10 gap-y-5 border-b border-ink-200 pb-10 md:mt-12 xl:grid-cols-12 xl:items-end"
        >
          <p className="text-display-md font-normal text-ink-800 transition-colors duration-300 [font-feature-settings:'halt'] group-hover:text-ink-900 xl:col-span-7">
            搜索、路线或 AI 不可用？
          </p>
          <div className="flex items-end justify-between gap-8 xl:col-span-5">
            <p className="max-w-sm text-[13.5px] leading-[1.8] text-ink-500">
              一键检测高德 Key、AI 模型与天地图的配置，并给出修复步骤。
            </p>
            <span className="inline-flex shrink-0 items-center gap-2 text-[13px] text-ink-900">
              去检测
              <ArrowRight className="size-4 text-ink-500 transition-colors duration-300 group-hover:text-ink-900" strokeWidth={1.25} />
            </span>
          </div>
        </Link>
      </section>
    </div>
  )
}
