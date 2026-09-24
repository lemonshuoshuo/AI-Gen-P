import { useState } from 'react'
import type { AdminStats } from '@/api/types'
import { Segmented } from '@/components/ui'
import { cn } from '@/lib/cn'
import { dayjs } from '@/lib/format'

type Metric = 'users' | 'trips' | 'comments'
const metrics: { value: Metric; label: string }[] = [
  { value: 'users', label: '新用户' },
  { value: 'trips', label: '新旅程' },
  { value: 'comments', label: '新评论' },
]

/** 取一个「好看」的刻度步长（1/2/5 × 10^n），保证至少为 1 */
function niceStep(max: number, ticks = 4) {
  const raw = Math.max(1, max / ticks)
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw
  return Math.max(1, step)
}

/** 近 14 天趋势：单序列柱状图，可切换指标，悬停显示数值 */
export function TrendChart({ trend }: { trend: AdminStats['trend'] }) {
  const [metric, setMetric] = useState<Metric>('users')
  const label = metrics.find((m) => m.value === metric)!.label
  const values = trend.map((d) => d[metric])
  const total = values.reduce((a, b) => a + b, 0)
  const step = niceStep(Math.max(0, ...values))
  const top = Math.max(step, Math.ceil(Math.max(0, ...values) / step) * step)
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
  const today = dayjs().format('YYYY-MM-DD')

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">近 14 天{label}</h3>
          <p className="text-xs text-ink-400">
            合计 <span className="font-semibold text-ink-700 tabular-nums">{total}</span>
          </p>
        </div>
        <Segmented<Metric> size="sm" value={metric} onChange={setMetric} options={metrics} />
      </div>

      <div className="mt-5 flex gap-2">
        {/* Y 轴刻度 */}
        <div className="relative h-44 w-7 shrink-0 text-right text-[10px] text-ink-400 tabular-nums">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 translate-y-1/2" style={{ bottom: `${(t / top) * 100}%` }}>
              {t}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative h-44">
            {/* 网格线 */}
            {ticks.map((t) => (
              <div
                key={t}
                className={cn('absolute inset-x-0 border-t', t === 0 ? 'border-ink-300' : 'border-dashed border-ink-100')}
                style={{ bottom: `${(t / top) * 100}%` }}
              />
            ))}
            {/* 柱子 */}
            <div className="absolute inset-0 flex items-end gap-0.5 sm:gap-1.5">
              {trend.map((d, i) => {
                const v = d[metric]
                // 两端的提示框向内对齐，避免超出卡片
                const align = i < 2 ? 'left-0' : i > trend.length - 3 ? 'right-0' : 'left-1/2 -translate-x-1/2'

                return (
                  <div
                    key={d.date}
                    tabIndex={0}
                    aria-label={`${d.date} ${label} ${v}`}
                    className="group relative flex h-full flex-1 items-end justify-center outline-none"
                  >
                    <div
                      className="w-full max-w-7 rounded-t-[4px] bg-brand-400 transition-colors group-hover:bg-brand-600 group-focus-visible:bg-brand-600"
                      style={{ height: `${(v / top) * 100}%` }}
                    />
                    <div
                      className={cn(
                        'pointer-events-none absolute z-10 rounded-lg bg-ink-900 px-2 py-1 text-[11px] whitespace-nowrap text-white opacity-0 shadow-float transition group-hover:opacity-100 group-focus-visible:opacity-100',
                        align,
                      )}
                      style={{ bottom: `calc(${(v / top) * 100}% + 6px)` }}
                    >
                      {dayjs(d.date).format('M月D日')} · {label} <b className="tabular-nums">{v}</b>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          {/* X 轴 */}
          <div className="mt-1.5 flex gap-0.5 text-center text-[10px] text-ink-400 sm:gap-1.5">
            {trend.map((d, i) => (
              <span
                key={d.date}
                className={cn('flex-1 truncate', (trend.length - 1 - i) % 2 === 1 && 'invisible sm:visible')}
              >
                {d.date === today ? '今天' : dayjs(d.date).format('MM-DD')}
              </span>
            ))}
          </div>
        </div>
      </div>

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-xs text-ink-400 select-none hover:text-ink-700">查看数据表</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="border-b border-ink-100 text-ink-400">
                <th className="py-1.5 text-left font-medium">日期</th>
                {metrics.map((m) => (
                  <th key={m.value} className="py-1.5 text-right font-medium">
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...trend].reverse().map((d) => (
                <tr key={d.date} className="border-b border-ink-50 text-ink-700">
                  <td className="py-1.5">{d.date}</td>
                  <td className="py-1.5 text-right">{d.users}</td>
                  <td className="py-1.5 text-right">{d.trips}</td>
                  <td className="py-1.5 text-right">{d.comments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
