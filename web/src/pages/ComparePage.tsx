import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Box, Footprints, PenLine, Share2 } from 'lucide-react'
import { api, errorMessage, type Waypoint } from '@/api'
import { rememberedShareCode } from '@/api/client'
import { BaseMap } from '@/components/map/BaseMap'
import { FitOnce, RouteLines, WaypointMarkers } from '@/components/map/layers'
import { ShareDialog } from '@/components/trip/ShareDialog'
import { Button, Empty, IconButton, PageLoader, buttonClass } from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { formatKm } from '@/lib/geo'
import { categoryOf } from '@/lib/meta'
import { bySeq, trackSegments } from '@/lib/trip'

/** 完成度：一圈朱砂细线，中间是大号 Fraunces 百分比 */
function Ring({ value }: { value: number }) {
  const r = 46
  const c = 2 * Math.PI * r
  const v = Math.min(1, Math.max(0, value))
  return (
    <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
      <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-ink-200)" strokeWidth="1" />
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke="var(--color-brand-500)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - v)}
        style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.16, 1, 0.3, 1)' }}
      />
    </svg>
  )
}

function Section({
  eyebrow,
  title,
  aside,
  children,
  className,
}: {
  eyebrow: string
  title?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={className}>
      <div className="flex items-end justify-between gap-3 border-b border-ink-200 pb-2.5">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          {title && <h2 className="mt-1 text-[18px] leading-snug">{title}</h2>}
        </div>
        {aside && <div className="shrink-0 text-xs tracking-wide text-ink-400">{aside}</div>}
      </div>
      {children}
    </section>
  )
}

function WpList({
  eyebrow,
  title,
  mark,
  list,
  tone,
}: {
  eyebrow: string
  title: string
  mark: string
  list: Waypoint[]
  tone: string
}) {
  if (!list.length) return null
  return (
    <Section
      eyebrow={eyebrow}
      title={
        <span className="flex items-baseline gap-2">
          <span className={cn('font-sans text-sm', tone)}>{mark}</span>
          {title}
        </span>
      }
      aside={<span className="font-num text-sm text-ink-500">{list.length}</span>}
    >
      <ul className="divide-y divide-ink-100">
        {list.map((w) => (
          <li key={w.id} className="flex items-center gap-2.5 py-2 text-sm">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: categoryOf(w.category).color }} />
            <span className="font-display min-w-0 flex-1 truncate text-[15px] text-ink-800">{w.name}</span>
            {w.day > 0 && (
              <span className="font-num shrink-0 text-[11px] tracking-[0.14em] text-ink-400 uppercase">
                Day {String(w.day).padStart(2, '0')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  )
}

function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-num text-ink-900', className)}>{children}</span>
}

export default function ComparePage() {
  const { id } = useParams()
  const qc = useQueryClient()
  const [share, setShare] = useState(false)
  const tripQ = useQuery({ queryKey: ['trip', id], queryFn: () => api.trips.get(id!) })
  const cmpQ = useQuery({ queryKey: ['compare', id], queryFn: () => api.trips.compare(Number(id)) })
  const trackQ = useQuery({
    queryKey: ['track', Number(id)],
    queryFn: () => api.trips.track(Number(id)),
    enabled: !!tripQ.data?.has_track,
  })
  const trip = tripQ.data
  const cmp = cmpQ.data
  const segments = useMemo(() => trackSegments(trackQ.data), [trackQ.data])
  const labels = useMemo(() => {
    if (!cmp) return {}
    const l: Record<number, string> = {}
    cmp.visited.forEach((w) => (l[w.id] = w.planned ? '✓' : '+'))
    cmp.extra.forEach((w) => (l[w.id] = '+'))
    cmp.skipped.forEach((w) => (l[w.id] = '×'))
    cmp.todo.forEach((w) => (l[w.id] = '?'))
    return l
  }, [cmp])
  useDocumentTitle(trip && `${trip.title} · 计划 vs 实际`)

  if (tripQ.isLoading || cmpQ.isLoading) return <PageLoader />
  if (!trip || !cmp) return <Empty className="min-h-[60vh]" title="无法加载对比" desc={errorMessage(tripQ.error ?? cmpQ.error)} />

  const sorted = [...trip.waypoints].sort(bySeq)
  const plannedVisited = cmp.visited.filter((w) => w.planned)
  const pct = Math.round(cmp.completion_rate * 100)
  const maxDay = Math.max(1, ...cmp.days.map((d) => Math.max(d.planned, d.visited + d.extra)))
  const allPts = sorted.map((w) => [w.lng, w.lat] as [number, number])
  // 实际里程与服务端 distance_km 规则一致：轨迹常只覆盖部分行程，取两者较大者（GPS 轨迹 / 打卡点连线）；
  // 差值也用显示出来的这个数，计划里程始终是打卡点之间的直线距离
  const hasTrack = cmp.actual.track_distance_km > 0
  const actualKm = Math.max(cmp.actual.track_distance_km, cmp.actual.distance_km)
  const byTrack = hasTrack && cmp.actual.track_distance_km >= cmp.actual.distance_km
  const distDiff = actualKm - cmp.planned.distance_km
  // 旅程结束后给作者的下一步：写游记、补评价、分享；其他情况在顶栏放一个分享按钮
  const nextSteps = trip.can_edit && trip.phase === 'finished'

  const km = (v: number) => formatKm(v).split(' ')
  const [plannedKmN, plannedKmU] = km(cmp.planned.distance_km)
  const [actualKmN, actualKmU] = km(actualKm)
  const verdict =
    pct >= 90 ? '几乎完美地执行了计划。' : pct >= 60 ? '大部分按计划进行，路上还有意外收获。' : '随性出发，走出了自己的路线。'

  return (
    <div className="mx-auto max-w-6xl px-4 pt-6 pb-14 md:pt-10">
      <div className="flex items-start gap-2">
        <Link
          to={`/trips/${trip.id}`}
          className="-ml-1.5 mt-0.5 rounded-full p-1.5 text-ink-600 transition-colors hover:bg-ink-900/5 hover:text-ink-900"
          aria-label="返回旅程"
        >
          <ArrowLeft className="size-5" strokeWidth={1.5} />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Plan vs Actual · 计划与实际</p>
          <h1 className="mt-2 text-[26px] leading-tight md:text-[34px]">{trip.title}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-1">
          {!nextSteps && (
            <IconButton label="分享" onClick={() => setShare(true)}>
              <Share2 className="size-[18px]" strokeWidth={1.75} />
            </IconButton>
          )}
          <Link to={`/trips/${trip.id}/replay?compare=1`} className={buttonClass({ size: 'sm', variant: 'dark' })}>
            <Box className="size-4" strokeWidth={1.75} />
            <span className="hidden sm:inline">3D 对比回放</span>
            <span className="sm:hidden">3D</span>
          </Link>
        </div>
      </div>

      {nextSteps && (
        <div className="mt-6 flex flex-wrap items-center gap-2 rounded-xl border border-ink-200 bg-white/70 px-4 py-3">
          <span className="w-full text-sm text-ink-600 sm:mr-2 sm:w-auto">
            <span className="eyebrow mr-2">Afterwards</span>旅程结束啦，趁记忆还新鲜：
          </span>
          <Link to={`/trips/${trip.id}/edit?panel=info`} className={buttonClass({ size: 'sm', variant: 'primary' })}>
            <PenLine className="size-4" strokeWidth={1.75} />
            写游记
          </Link>
          <Link to={`/trips/${trip.id}/edit`} className={buttonClass({ size: 'sm', variant: 'outline' })}>
            补充打卡评价
          </Link>
          <Button
            size="sm"
            variant="outline"
            icon={<Share2 className="size-4" strokeWidth={1.75} />}
            onClick={() => setShare(true)}
          >
            {trip.is_owner && trip.visibility === 'private' ? '发布 / 分享' : '分享'}
          </Button>
          <Link to="/footprints" className={buttonClass({ size: 'sm', variant: 'ghost' })}>
            <Footprints className="size-4" strokeWidth={1.75} />
            我的足迹
          </Link>
        </div>
      )}

      <div className="mt-8 grid gap-10 lg:grid-cols-[360px_1fr] lg:gap-12">
        <div className="space-y-10">
          {/* 完成度 */}
          <section className="border-t border-ink-900 pt-5">
            <p className="eyebrow">Completion · 计划完成度</p>
            <div className="mt-4 flex items-center gap-6">
              <div className="relative size-32 shrink-0">
                <Ring value={cmp.completion_rate} />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="font-num text-[2.6rem] leading-none font-[450] tracking-tight text-ink-900">
                    {pct}
                    <span className="ml-0.5 align-top text-base text-brand-500">%</span>
                  </span>
                </div>
              </div>
              <dl className="min-w-0 flex-1 divide-y divide-ink-100 text-sm text-ink-500">
                <div className="flex items-baseline justify-between py-1.5">
                  <dt>计划地点</dt>
                  <dd>
                    <Num className="text-base">{cmp.planned.count}</Num>
                  </dd>
                </div>
                <div className="flex items-baseline justify-between py-1.5">
                  <dt>按计划去了</dt>
                  <dd>
                    <Num className="text-base text-emerald-700">{plannedVisited.length}</Num>
                  </dd>
                </div>
                <div className="flex items-baseline justify-between py-1.5">
                  <dt>跳过</dt>
                  <dd>
                    <Num className="text-base text-ink-500">{cmp.skipped.length}</Num>
                  </dd>
                </div>
                <div className="flex items-baseline justify-between py-1.5">
                  <dt>计划外的新发现</dt>
                  <dd>
                    <Num className="text-base text-violet-600">{cmp.extra.length}</Num>
                  </dd>
                </div>
              </dl>
            </div>
            <p className="font-display mt-4 text-[15px] leading-relaxed text-ink-600">{verdict}</p>
          </section>

          {/* 里程 */}
          <section className="border-t border-ink-900 pt-5">
            <p className="eyebrow">Distance · 里程</p>
            <div className="mt-4 grid grid-cols-2 divide-x divide-ink-200">
              <div className="pr-4">
                <div className="flex items-baseline gap-1">
                  <span className="font-num text-[2rem] leading-none font-[450] tracking-tight">{plannedKmN}</span>
                  <span className="text-xs text-ink-400">{plannedKmU}</span>
                </div>
                <div className="mt-2 text-[11px] tracking-[0.12em] text-ink-400">计划里程</div>
                {hasTrack && <div className="mt-0.5 text-[11px] text-ink-400">按打卡点直线连线</div>}
              </div>
              <div className="pl-4">
                <div className="flex flex-wrap items-baseline gap-x-1">
                  <span className="font-num text-[2rem] leading-none font-[450] tracking-tight">{actualKmN}</span>
                  <span className="text-xs text-ink-400">{actualKmU}</span>
                  {cmp.planned.distance_km > 0 && (
                    <span className={cn('font-num ml-1 text-xs', distDiff > 0 ? 'text-amber-700' : 'text-emerald-700')}>
                      {distDiff > 0 ? '+' : distDiff < 0 ? '−' : ''}
                      {formatKm(Math.abs(distDiff))}
                    </span>
                  )}
                </div>
                <div className="mt-2 text-[11px] tracking-[0.12em] text-ink-400">实际里程</div>
                {byTrack && <div className="mt-0.5 text-[11px] text-ink-400">按 GPS 轨迹</div>}
              </div>
            </div>
          </section>

          {cmp.days.length > 0 && (
            <section className="border-t border-ink-900 pt-5">
              <div className="flex items-baseline justify-between">
                <p className="eyebrow">By Day · 每天的执行情况</p>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] tracking-wide text-ink-400">
                <span className="flex items-center gap-1.5">
                  <span className="h-1 w-3 rounded-full bg-sky-300" />
                  计划
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1 w-3 rounded-full bg-brand-500" />
                  实到
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1 w-3 rounded-full bg-violet-300" />
                  计划外
                </span>
              </div>
              <ul className="mt-3 divide-y divide-ink-100">
                {cmp.days.map((d) => (
                  <li key={d.day} className="py-2.5">
                    <div className="mb-1.5 flex items-baseline justify-between text-xs text-ink-500">
                      <span className="font-num text-[11px] tracking-[0.16em] text-ink-400 uppercase">
                        {d.day ? `Day ${String(d.day).padStart(2, '0')}` : '未分天'}
                      </span>
                      <span>
                        计划 <Num>{d.planned}</Num> · 实到 <Num>{d.visited}</Num>
                        {d.extra > 0 && (
                          <>
                            {' '}
                            · 计划外 <Num>{d.extra}</Num>
                          </>
                        )}
                      </span>
                    </div>
                    <div className="h-1 rounded-full bg-ink-100">
                      <div className="h-full rounded-full bg-sky-300" style={{ width: `${(d.planned / maxDay) * 100}%` }} />
                    </div>
                    <div className="mt-1 flex h-1 gap-0.5 rounded-full bg-ink-100">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${(d.visited / maxDay) * 100}%` }} />
                      {d.extra > 0 && (
                        <div className="h-full rounded-full bg-violet-300" style={{ width: `${(d.extra / maxDay) * 100}%` }} />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="min-w-0 space-y-10">
          <figure className="overflow-hidden rounded-xl border border-ink-200 bg-white">
            <BaseMap className="h-[52vh] min-h-80" kindSwitcher>
              <RouteLines planned={cmp.planned.path} actual={cmp.actual.path} track={segments} idPrefix="cmp" />
              <WaypointMarkers waypoints={sorted} labels={labels} />
              <FitOnce points={allPts} fitKey={`cmp-${trip.id}`} />
            </BaseMap>
            <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-ink-200 px-4 py-2.5 text-[11px] tracking-wide text-ink-500">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-[3px] w-5 rounded-full bg-brand-500" />
                实际路线
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-5 border-t-[2px] border-dashed border-sky-500" />
                计划路线
              </span>
              {segments.length > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-[3px] w-5 rounded-full bg-amber-500" />
                  GPS 轨迹
                </span>
              )}
              <span className="font-sans text-ink-400 sm:ml-auto">✓ 已完成 · + 计划外 · × 跳过 · ? 未去</span>
            </figcaption>
          </figure>

          <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
            <WpList eyebrow="Done" title="按计划完成" mark="✓" list={plannedVisited} tone="text-emerald-700" />
            <WpList eyebrow="Discovered" title="计划外的新发现" mark="+" list={cmp.extra} tone="text-violet-600" />
            <WpList eyebrow="Skipped" title="跳过的地点" mark="×" list={cmp.skipped} tone="text-ink-400" />
            <WpList eyebrow="Missed" title="没来得及去" mark="?" list={cmp.todo} tone="text-amber-700" />
          </div>

          {cmp.time_diffs.length > 0 && (
            <Section eyebrow="Timing · 时间偏差" title="比计划早到还是晚到">
              <ul className="divide-y divide-ink-100">
                {cmp.time_diffs.map((d) => {
                  const m = Math.abs(d.delta_minutes)
                  const onTime = m <= 15
                  return (
                    <li key={d.waypoint_id} className="flex items-center gap-3 py-2.5 text-sm">
                      <span className="font-display min-w-0 flex-1 truncate text-[15px] text-ink-800">{d.name}</span>
                      <span
                        className={cn(
                          'shrink-0 text-xs tracking-wide',
                          onTime ? 'text-emerald-700' : d.delta_minutes > 0 ? 'text-amber-700' : 'text-sky-600',
                        )}
                      >
                        {onTime ? (
                          '准时'
                        ) : (
                          <>
                            {d.delta_minutes > 0 ? '晚' : '早'}到{' '}
                            <span className="font-num">{m >= 60 ? (m / 60).toFixed(1) : m}</span> {m >= 60 ? '小时' : '分钟'}
                          </>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </Section>
          )}
        </div>
      </div>

      <ShareDialog
        trip={trip}
        shareCode={rememberedShareCode(trip.id)}
        open={share}
        onClose={() => setShare(false)}
        onUpdated={(t) => {
          qc.setQueryData(['trip', id], t)
          invalidateTripLists(qc)
        }}
      />
    </div>
  )
}
