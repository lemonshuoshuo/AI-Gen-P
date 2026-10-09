import { useState } from 'react'
import type { AdminStats } from '@/api/types'
import { cn } from '@/lib/cn'
import { dayjs } from '@/lib/format'
import { LabelRow, TextTabs } from './common'

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

/**
 * 近 14 天趋势：象牙白细柱，只有「今天」那一根是朱砂色（当前状态）；
 * 指标用文字切换，悬停 / 聚焦显示数值
 */
export function TrendChart({ trend }: { trend: AdminStats['trend'] }) {
  const [metric, setMetric] = useState<Metric>('users')
  const label = metrics.find((m) => m.value === metric)!.label
  const values = trend.map((d) => d[metric])
  const total = values.reduce((a, b) => a + b, 0)
  const peak = Math.max(0, ...values)
  const step = niceStep(peak)
  const top = Math.max(step, Math.ceil(peak / step) * step)
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
  // 服务端按北京时间分桶，最后一天就是今天；浏览器时区不同时不能用本地日期
  const today = trend[trend.length - 1]?.date
  // 只标注峰值那一根柱子的数字（其余靠悬停提示和数据表）
  const peakIndex = peak > 0 ? values.lastIndexOf(peak) : -1

  return (
    <div className="animate-slide-up [animation-delay:180ms] [animation-fill-mode:backwards]">
      <LabelRow
        label="Last 14 days · 近 14 天"
        extra={<TextTabs label="指标" value={metric} onChange={setMetric} options={metrics} className="-mr-3 ml-0" />}
      />

      <div className="mt-8 flex flex-wrap items-end justify-between gap-x-10 gap-y-4 md:mt-12">
        <h2 className="text-display-md font-normal">{label}</h2>
        <p className="flex items-baseline gap-3">
          <span className="text-[13px] text-ink-500">合计</span>
          <span className="font-num text-num text-ink-900">{total}</span>
        </p>
      </div>

      <div className="mt-10 flex gap-4 md:mt-14">
        {/* Y 轴刻度 */}
        <div className="font-num relative h-52 w-6 shrink-0 text-right text-[12px] text-ink-400 md:h-60">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: `${(t / top) * 100}%` }}>
              {t}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative h-52 md:h-60">
            {/* 网格线：底线稍亮，其余是极淡的细线 */}
            {ticks.map((t) => (
              <div
                key={t}
                className={cn('absolute inset-x-0 border-t', t === 0 ? 'border-ink-300' : 'border-ink-200/70')}
                style={{ bottom: `${(t / top) * 100}%` }}
              />
            ))}
            {/* 柱子 */}
            <div className="absolute inset-0 flex items-end">
              {trend.map((d, i) => {
                const v = d[metric]
                const h = (v / top) * 100
                const isToday = d.date === today
                // 两端的提示框向内对齐，避免超出版心
                const align = i < 2 ? 'left-0' : i > trend.length - 3 ? 'right-0' : 'left-1/2 -translate-x-1/2'
                return (
                  <div
                    key={d.date}
                    tabIndex={0}
                    aria-label={`${d.date} ${label} ${v}`}
                    className="group relative flex h-full flex-1 items-end justify-center outline-none"
                  >
                    {/* 悬停时整列一道极淡的竖线，便于对准 */}
                    <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-ink-200 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100" />
                    <div
                      className={cn(
                        'relative w-1 rounded-t-[2px] transition-colors duration-300 sm:w-1.5',
                        isToday ? 'bg-brand-600' : 'bg-ink-700 group-hover:bg-ink-900 group-focus-visible:bg-ink-900',
                      )}
                      style={{ height: `${h}%`, minHeight: v > 0 ? 2 : 0 }}
                    />
                    {i === peakIndex && (
                      <span
                        className="font-num pointer-events-none absolute -translate-y-2 text-[15px] leading-none text-ink-900 transition-opacity group-hover:opacity-0"
                        style={{ bottom: `${h}%` }}
                      >
                        {v}
                      </span>
                    )}
                    <div
                      className={cn(
                        'pointer-events-none absolute z-10 rounded-sm bg-surface-2 px-2.5 py-1.5 text-[12px] whitespace-nowrap text-ink-900 opacity-0 ring-1 ring-ink-200 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100',
                        align,
                      )}
                      style={{ bottom: `calc(${h}% + 20px)` }}
                    >
                      <span className="text-ink-500">{dayjs(d.date).format('M月D日')} · </span>
                      {label} <span className="font-num text-[14px]">{v}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
          {/* X 轴 */}
          <div className="font-num mt-3 flex text-center text-[12px] text-ink-400">
            {trend.map((d, i) => (
              <span
                key={d.date}
                className={cn(
                  'min-w-0 flex-1 whitespace-nowrap',
                  d.date === today && 'text-ink-900',
                  // 手机上隔一天标一个日期，避免挤在一起
                  i % 2 === (trend.length - 1) % 2 ? '' : 'max-sm:invisible',
                )}
              >
                {d.date === today ? (
                  <span className="font-sans text-[11px]">今天</span>
                ) : (
                  <>
                    <span className="sm:hidden">{dayjs(d.date).date()}</span>
                    <span className="hidden sm:inline">{dayjs(d.date).format('MM.DD')}</span>
                  </>
                )}
              </span>
            ))}
          </div>
        </div>
      </div>

      <details className="group/table mt-10">
        <summary className="inline-flex h-10 cursor-pointer list-none items-center gap-2 text-[13px] tracking-wide text-ink-900 select-none [&::-webkit-details-marker]:hidden">
          <span className="underline decoration-ink-300 underline-offset-4 transition-colors duration-300 hover:decoration-ink-900">
            查看数据表
          </span>
          <span aria-hidden className="text-ink-500 transition-transform duration-300 group-open/table:rotate-90">
            →
          </span>
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-y border-ink-200">
                <th className="eyebrow py-3 text-left !font-medium">日期</th>
                {metrics.map((m) => (
                  <th key={m.value} className="eyebrow py-3 text-right !font-medium">
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-num">
              {[...trend].reverse().map((d) => (
                <tr key={d.date} className="border-b border-ink-200 text-ink-700">
                  <td className="py-2.5">{d.date}</td>
                  <td className="py-2.5 text-right">{d.users}</td>
                  <td className="py-2.5 text-right">{d.trips}</td>
                  <td className="py-2.5 text-right">{d.comments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
