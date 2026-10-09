import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Box, Footprints, PenLine, Share2 } from 'lucide-react'
import { api, errorMessage, type Waypoint } from '@/api'
import { rememberedShareCode } from '@/api/client'
import { BaseMap } from '@/components/map/BaseMap'
import { useTripLegs } from '@/components/editor/RouteLegs'
import { FitOnce, RouteLines, RouteSegments } from '@/components/map/layers'
import { PlanMarkers, planMarkerItems } from '@/components/trip/PlanMarkers'
import { actualSegments, dayTone, groupPlan, isLodging, plannedSegments } from '@/components/trip/plan'
import { CjkWords } from '@/components/trip/CjkWords'
import { Reveal } from '@/components/trip/Reveal'
import { ShareDialog } from '@/components/trip/ShareDialog'
import { Button, Empty, PageLoader, buttonClass } from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { formatKm } from '@/lib/geo'
import { categoryOf } from '@/lib/meta'
import { bySeq, trackSegments, visitedInOrder } from '@/lib/trip'

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 区块头：一条细线，下面一行小字（左侧标签 + 灰色计数，右侧补充） */
function LabelRow({ eyebrow, count, aside, className }: { eyebrow: string; count?: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-t border-ink-200 pt-4', className)}>
      <p className="flex min-w-0 items-baseline gap-4">
        <span className="eyebrow !text-ink-900">{eyebrow}</span>
        {count != null && <span className="caption">{count}</span>}
      </p>
      {aside && <div className="caption">{aside}</div>}
    </div>
  )
}

/** 地点清单：一张主题卡片（th-card），标签行 + 卡片标题 + 细线列表（空清单不单独成块，由外层收成一行） */
function WpList({
  eyebrow,
  title,
  mark,
  list,
  tone,
  className,
}: {
  eyebrow: string
  title: string
  mark: string
  list: Waypoint[]
  tone: string
  className?: string
}) {
  return (
    <section className={cn('th-card min-w-0 p-5 md:p-6', className)}>
      <p className="flex items-baseline justify-between gap-3">
        <span className="eyebrow">{eyebrow}</span>
        <span className="font-num text-[14px] text-ink-500">{list.length}</span>
      </p>
      <h3 className="mt-3 flex items-baseline gap-2.5 text-[length:var(--text-card)] leading-snug text-ink-900">
        <span className={cn('font-sans text-[15px] font-semibold', tone)}>{mark}</span>
        {title}
      </h3>
      <ul className="mt-4 divide-y divide-line border-t border-line">
        {list.map((w) => (
          <li key={w.id} className="flex items-center gap-3 py-2.5">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: categoryOf(w.category).css }} />
            <span className="font-display min-w-0 flex-1 truncate text-[15.5px] text-ink-800">{w.name}</span>
            {w.day > 0 && <span className="eyebrow shrink-0 !text-[10px]">Day {pad2(w.day)}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 大号统计：主题的大数字（font-num text-num）+ 小号单位与标签 */
function BigNum({ label, value, unit, note, extra, className }: { label: string; value: ReactNode; unit?: string; note?: ReactNode; extra?: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 py-6 md:py-8', className)}>
      <p className="eyebrow">{label}</p>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-2 md:mt-4">
        <span className="font-num text-num tracking-[-0.01em] whitespace-nowrap text-ink-900">
          {value}
        </span>
        {unit && <span className="text-xs text-ink-500">{unit}</span>}
        {extra}
      </div>
      {note && <p className="caption mt-3">{note}</p>}
    </div>
  )
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
  // 计划路线（虚线，每天一色）与实际走过的路线（实线）都按实际道路画
  const legs = useTripLegs(trip?.id, trip?.waypoints ?? [], trip?.travel_mode, { geometry: true })
  const groups = useMemo(() => groupPlan(trip?.waypoints ?? [], trip?.days ?? 0), [trip])
  const routeSegs = useMemo(
    () => (trip ? [...plannedSegments(groups, legs.data?.legs, { icons: false }), ...actualSegments(visitedInOrder(trip.waypoints), legs.data?.legs)] : []),
    [trip, groups, legs.data],
  )
  // 标记：游玩点用对比的记号（✓ + × ?），住宿是床的方章
  const markers = useMemo(
    () => planMarkerItems(groups, new Map()).map((m) => (isLodging(m.w) ? m : { ...m, pool: false, label: labels[m.w.id] ?? '' })),
    [groups, labels],
  )
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
  const [diffKmN, diffKmU] = km(Math.abs(distDiff))
  const surprise = cmp.extra.length > 0
  const verdict =
    pct >= 100
      ? surprise
        ? '完美地执行了计划，路上还有意外收获。'
        : '完美地执行了计划。'
      : pct >= 90
        ? '几乎完美地执行了计划。'
        : pct >= 60
          ? surprise
            ? '大部分按计划进行，路上还有意外收获。'
            : '大部分按计划进行。'
          : '随性出发，走出了自己的路线。'

  // 四份清单：有内容的才成块，空的收成一行细线小字
  const lists = [
    { key: 'done', eyebrow: 'Done · 完成', title: '按计划完成', short: '按计划完成', mark: '✓', list: plannedVisited, tone: 'text-emerald-700' },
    { key: 'extra', eyebrow: 'Discovered · 新发现', title: '计划外的新发现', short: '新发现', mark: '+', list: cmp.extra, tone: 'text-violet-600' },
    { key: 'skipped', eyebrow: 'Skipped · 跳过', title: '跳过的地点', short: '跳过', mark: '×', list: cmp.skipped, tone: 'text-ink-500' },
    { key: 'todo', eyebrow: 'Missed · 未去', title: '没来得及去', short: '未去', mark: '?', list: cmp.todo, tone: 'text-amber-700' },
  ]
  const filled = lists.filter((l) => l.list.length > 0)
  const empty = lists.filter((l) => !l.list.length)
  const listSpan = ['', 'lg:col-span-6', 'lg:col-span-6', 'lg:col-span-4', 'lg:col-span-3'][filled.length]

  const counts: { label: string; value: number; dot?: string }[] = [
    { label: '计划地点', value: cmp.planned.count },
    { label: '按计划去了', value: plannedVisited.length, dot: 'bg-emerald-500' },
    { label: '跳过', value: cmp.skipped.length, dot: 'bg-ink-400' },
    { label: '计划外的新发现', value: cmp.extra.length, dot: 'bg-violet-500' },
  ]

  return (
    <div className="mx-auto max-w-[90rem] px-4 pt-6 pb-24 md:px-8 md:pt-10 md:pb-36">
      {/* 顶栏：返回 + 操作 */}
      <div className="flex items-center justify-between gap-3">
        <Link
          to={`/trips/${trip.id}`}
          className="group -ml-1 inline-flex h-10 items-center gap-2 text-[13px] text-ink-600 transition-colors hover:text-ink-900"
        >
          <ArrowLeft className="size-4 transition-transform duration-300 group-hover:-translate-x-0.5" strokeWidth={1.25} />
          回到旅程
        </Link>
        <div className="flex shrink-0 items-center gap-2">
          {!nextSteps && (
            <Button variant="outline" aria-label="分享" icon={<Share2 className="size-4" strokeWidth={1.5} />} onClick={() => setShare(true)}>
              <span className="hidden sm:inline">分享</span>
            </Button>
          )}
          <Link to={`/trips/${trip.id}/replay?compare=1`} className={buttonClass({ variant: 'outline' })}>
            <Box className="size-4" strokeWidth={1.5} />
            <span className="hidden sm:inline">3D 对比回放</span>
            <span className="sm:hidden">3D 回放</span>
          </Link>
        </div>
      </div>

      <header className="mt-10 md:mt-14">
        <p className="eyebrow animate-fade-in">Plan vs Actual · 计划与实际</p>
        <h1 className="text-display-lg animate-slide-up mt-4 max-w-[20ch] text-balance text-ink-900">
          <CjkWords text={trip.title} />
        </h1>
      </header>

      {nextSteps && (
        <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-4 border-y border-ink-200 py-5 md:mt-12">
          <p className="flex min-w-0 flex-1 basis-full items-baseline gap-4 text-[14px] text-ink-600 lg:basis-auto">
            <span className="eyebrow !text-ink-900">Afterwards</span>
            旅程结束啦，趁记忆还新鲜：
          </p>
          <div className="flex flex-wrap gap-2">
            <Link to={`/trips/${trip.id}/edit?panel=info`} className={buttonClass({ variant: 'primary' })}>
              <PenLine className="size-4" strokeWidth={1.5} />
              写游记
            </Link>
            <Link to={`/trips/${trip.id}/edit`} className={buttonClass({ variant: 'outline' })}>
              补充打卡评价
            </Link>
            <Button variant="outline" icon={<Share2 className="size-4" strokeWidth={1.5} />} onClick={() => setShare(true)}>
              {trip.is_owner && trip.visibility === 'private' ? '发布 / 分享' : '分享'}
            </Button>
            <Link to="/footprints" className={buttonClass({ variant: 'ghost' })}>
              <Footprints className="size-4" strokeWidth={1.5} />
              我的足迹
            </Link>
          </div>
        </div>
      )}

      {/* 完成度：大数字百分比（font-num text-num）+ 一条进度条 */}
      <section className="mt-16 md:mt-24">
        <LabelRow
          eyebrow="Completion · 计划完成度"
          count={`${plannedVisited.length} / ${cmp.planned.count}`}
          aside={cmp.extra.length > 0 ? `另有 ${cmp.extra.length} 个计划外` : undefined}
        />
        <div className="mt-6 grid gap-y-10 md:mt-8 lg:grid-cols-12 lg:gap-x-8">
          <div className="min-w-0 lg:col-span-7">
            <p className="font-num text-num animate-slide-up flex items-baseline text-ink-900" aria-label={`完成 ${pct}%`}>
              {pct}
              <span className="ml-1 text-[length:var(--text-h2)] text-ink-500">%</span>
            </p>
            <div className="mt-6 md:mt-8">
              <div className="relative h-1.5 rounded-full bg-ink-200">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-brand-600 transition-[width] duration-[1400ms] ease-out-expo"
                  style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                />
              </div>
              <div className="font-num mt-2.5 flex justify-between text-[13px] text-ink-500">
                <span>0</span>
                <span>50</span>
                <span>100</span>
              </div>
            </div>
          </div>
          <div className="min-w-0 lg:col-span-4 lg:col-start-9 lg:self-end">
            <p className="font-display text-[length:var(--text-h2)] leading-[1.4] text-ink-800">{verdict}</p>
            <dl className="mt-8 divide-y divide-ink-200 border-y border-ink-200">
              {counts.map((c) => (
                <div key={c.label} className="flex items-baseline justify-between gap-4 py-3">
                  <dt className="flex items-center gap-2.5 text-[13px] text-ink-500">
                    <span className={cn('size-1.5 rounded-full', c.dot ?? 'bg-ink-900')} aria-hidden />
                    {c.label}
                  </dt>
                  <dd className="font-num text-[length:var(--text-h2)] leading-none text-ink-900">{c.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* 里程 */}
      <Reveal as="section" className="mt-20 md:mt-28">
        <LabelRow eyebrow="Distance · 里程" aside={byTrack ? '实际里程按 GPS 轨迹' : undefined} />
        <div className="grid grid-cols-2 md:grid-cols-3">
          <BigNum label="Planned · 计划里程" value={plannedKmN} unit={plannedKmU} note={hasTrack ? '按打卡点直线连线' : undefined} className="pr-4" />
          <BigNum label="Actual · 实际里程" value={actualKmN} unit={actualKmU} className="border-l border-ink-200 pl-4 md:pl-8" />
          {cmp.planned.distance_km > 0 && (
            <BigNum
              label="Difference · 差值"
              value={
                <>
                  <span className="text-ink-500">{distDiff > 0 ? '+' : distDiff < 0 ? '−' : ''}</span>
                  {diffKmN}
                </>
              }
              unit={diffKmU}
              note={distDiff > 0 ? '比计划多走了一些' : distDiff < 0 ? '比计划少走了一些' : '与计划一致'}
              className="col-span-2 border-t border-ink-200 md:col-span-1 md:border-t-0 md:border-l md:pl-8"
            />
          )}
        </div>
      </Reveal>

      {/* 地图 */}
      <Reveal as="section" className="mt-16 md:mt-24">
        <LabelRow
          eyebrow="Route · 路线对照"
          count={`${sorted.length} 个地点`}
          aside={
            <span className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] tracking-[0.06em]">
              <span className="flex items-center gap-2">
                <span className="inline-block h-0.5 w-5 bg-brand-500" />
                实际路线
              </span>
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-0.5" aria-hidden>
                  {[1, 2, 3].map((d) => (
                    <span key={d} className={cn('inline-block w-2 border-t-2 border-dashed', dayTone(d).border)} />
                  ))}
                </span>
                计划路线{groups.dayCount > 1 ? ' · 每天一色' : ''}
              </span>
              {segments.length > 0 && (
                <span className="flex items-center gap-2">
                  <span className="inline-block h-0.5 w-5 bg-[var(--route-track)]" />
                  GPS 轨迹
                </span>
              )}
            </span>
          }
        />
        <figure className="mt-8 md:mt-10">
          <div className="-mx-4 overflow-hidden border-y border-ink-200 md:mx-0 md:rounded-image md:border-0 md:ring-1 md:ring-line">
            <BaseMap className="h-[60svh] min-h-80 md:h-[72vh]" kindSwitcher>
              <RouteLines track={segments} idPrefix="cmp" />
              <RouteSegments segments={routeSegs} idPrefix="cmp-legs" icons={false} />
              <PlanMarkers items={markers} />
              <FitOnce points={allPts} fitKey={`cmp-${trip.id}`} />
            </BaseMap>
          </div>
          <figcaption className="caption mt-3">✓ 已完成 · + 计划外 · × 跳过 · ? 未去</figcaption>
        </figure>
      </Reveal>

      {/* 清单：有内容的才成块；空的收成一行（跳过 0 · 未去 0 …） */}
      <div className="mt-16 md:mt-24">
        {filled.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-12 lg:gap-4">
            {filled.map((l) => (
              <WpList key={l.key} eyebrow={l.eyebrow} title={l.title} mark={l.mark} list={l.list} tone={l.tone} className={listSpan} />
            ))}
          </div>
        )}
        {empty.length > 0 && (
          <p className={cn('flex flex-wrap items-baseline gap-x-6 gap-y-2 border-t border-ink-200 pt-4', filled.length > 0 && 'mt-10 md:mt-14')}>
            <span className="eyebrow">Also · 其余</span>
            {empty.map((l) => (
              <span key={l.key} className="caption">
                {l.short} <span className="font-num text-[15px] text-ink-900">0</span>
              </span>
            ))}
          </p>
        )}
      </div>

      {/* 每天的执行情况 */}
      {cmp.days.length > 0 && (
        <Reveal as="section" className="mt-20 md:mt-28">
          <LabelRow
            eyebrow="By Day · 每天的执行情况"
            count={`${cmp.days.length} 天`}
            aside={
              <span className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] tracking-[0.06em]">
                <span className="flex items-center gap-2">
                  <span className="h-1 w-4 rounded-full bg-sky-500" />
                  计划
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-1 w-4 rounded-full bg-brand-600" />
                  实到
                </span>
                <span className="flex items-center gap-2">
                  <span className="h-1 w-4 rounded-full bg-violet-500" />
                  计划外
                </span>
              </span>
            }
          />
          <ul className="mt-6 divide-y divide-ink-200 border-b border-ink-200">
            {cmp.days.map((d) => (
              <li key={d.day} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-4 py-5 md:grid-cols-[8rem_minmax(0,1fr)_14rem] md:gap-x-8">
                <span className="flex items-baseline gap-2">
                  {d.day ? (
                    <>
                      <span className="eyebrow !text-[10px]">Day</span>
                      <span className="font-num text-[length:var(--text-h2)] leading-none text-ink-900">{pad2(d.day)}</span>
                    </>
                  ) : (
                    <span className="font-display text-[length:var(--text-card)] text-ink-700">未分天</span>
                  )}
                </span>
                <div className="space-y-1.5">
                  <div className="h-1 overflow-hidden rounded-full bg-ink-200">
                    <div className="h-full rounded-full bg-sky-500" style={{ width: `${(d.planned / maxDay) * 100}%` }} />
                  </div>
                  <div className="flex h-1 gap-0.5 overflow-hidden rounded-full bg-ink-200">
                    <div className="h-full rounded-full bg-brand-600" style={{ width: `${(d.visited / maxDay) * 100}%` }} />
                    {d.extra > 0 && <div className="h-full rounded-full bg-violet-500" style={{ width: `${(d.extra / maxDay) * 100}%` }} />}
                  </div>
                </div>
                <span className="col-span-2 mt-3 text-[13px] text-ink-500 md:col-span-1 md:mt-0 md:text-right">
                  计划 <span className="font-num text-[16px] text-ink-900">{d.planned}</span>
                  <span className="mx-2 text-ink-300">·</span>
                  实到 <span className="font-num text-[16px] text-ink-900">{d.visited}</span>
                  {d.extra > 0 && (
                    <>
                      <span className="mx-2 text-ink-300">·</span>
                      计划外 <span className="font-num text-[16px] text-ink-900">{d.extra}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
      )}

      {cmp.time_diffs.length > 0 && (
        <Reveal as="section" className="mt-20 md:mt-28">
          <LabelRow eyebrow="Timing · 时间偏差" count={`${cmp.time_diffs.length} 处`} />
          <h2 className="text-display-md mt-6 text-ink-900 md:mt-8">比计划早到还是晚到</h2>
          <ul className="mt-6 divide-y divide-ink-200 border-y border-ink-200 md:mt-8 lg:w-2/3">
            {cmp.time_diffs.map((d) => {
              const m = Math.abs(d.delta_minutes)
              const onTime = m <= 15
              return (
                <li key={d.waypoint_id} className="flex items-baseline gap-4 py-4">
                  <span className="font-display min-w-0 flex-1 truncate text-[length:var(--text-card)] text-ink-800">{d.name}</span>
                  <span
                    className={cn(
                      'shrink-0 text-[13px] tracking-wide',
                      onTime ? 'text-emerald-700' : d.delta_minutes > 0 ? 'text-amber-700' : 'text-sky-600',
                    )}
                  >
                    {onTime ? (
                      '准时'
                    ) : (
                      <>
                        {d.delta_minutes > 0 ? '晚' : '早'}到{' '}
                        <span className="font-num text-[16px]">{m >= 60 ? (m / 60).toFixed(1) : m}</span> {m >= 60 ? '小时' : '分钟'}
                      </>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </Reveal>
      )}

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
