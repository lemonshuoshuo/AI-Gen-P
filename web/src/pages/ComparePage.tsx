import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Box, CheckCircle2, Clock, Footprints, PenLine, Share2, Sparkles, SkipForward, XCircle } from 'lucide-react'
import { api, errorMessage, type Waypoint } from '@/api'
import { rememberedShareCode } from '@/api/client'
import { BaseMap } from '@/components/map/BaseMap'
import { FitOnce, RouteLines, WaypointMarkers } from '@/components/map/layers'
import { ShareDialog } from '@/components/trip/ShareDialog'
import { Button, Card, Empty, IconButton, PageLoader, buttonClass } from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { formatKm } from '@/lib/geo'
import { categoryOf } from '@/lib/meta'
import { bySeq, trackSegments } from '@/lib/trip'

function Ring({ value }: { value: number }) {
  const r = 42
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 100 100" className="size-28 -rotate-90">
      <circle cx="50" cy="50" r={r} fill="none" stroke="#f3f2f7" strokeWidth="10" />
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke="url(#ring)"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value)}
        style={{ transition: 'stroke-dashoffset 1s ease' }}
      />
      <defs>
        <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff5a5f" />
          <stop offset="1" stopColor="#ff9a44" />
        </linearGradient>
      </defs>
    </svg>
  )
}

function WpList({ title, icon, list, tone }: { title: string; icon: React.ReactNode; list: Waypoint[]; tone: string }) {
  if (!list.length) return null
  return (
    <Card className="p-4">
      <h3 className={cn('mb-3 flex items-center gap-1.5 font-bold', tone)}>
        {icon}
        {title} <span className="text-sm font-normal text-ink-400">{list.length}</span>
      </h3>
      <div className="space-y-2">
        {list.map((w) => (
          <div key={w.id} className="flex items-center gap-2 text-sm">
            <span className="size-2 shrink-0 rounded-full" style={{ background: categoryOf(w.category).color }} />
            <span className="min-w-0 flex-1 truncate">{w.name}</span>
            {w.day > 0 && <span className="text-xs text-ink-400">第{w.day}天</span>}
          </div>
        ))}
      </div>
    </Card>
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

  return (
    <div className="mx-auto max-w-6xl px-4 py-5">
      <div className="flex items-center gap-2">
        <Link to={`/trips/${trip.id}`} className="rounded-full p-1.5 hover:bg-ink-100" aria-label="返回">
          <ArrowLeft className="size-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-ink-400">计划 vs 实际</p>
          <h1 className="truncate text-xl font-extrabold">{trip.title}</h1>
        </div>
        {!nextSteps && (
          <IconButton label="分享" onClick={() => setShare(true)}>
            <Share2 className="size-5" />
          </IconButton>
        )}
        <Link to={`/trips/${trip.id}/replay?compare=1`} className={buttonClass({ size: 'sm', variant: 'dark' })}>
          <Box className="size-4" />
          3D 对比回放
        </Link>
      </div>

      {nextSteps && (
        <Card className="mt-4 flex flex-wrap items-center gap-2 p-3">
          <span className="w-full text-sm text-ink-700 sm:w-auto">旅程结束啦，趁记忆还新鲜：</span>
          <Link to={`/trips/${trip.id}/edit?panel=info`} className={buttonClass({ size: 'sm', variant: 'dark' })}>
            <PenLine className="size-4" />
            写游记
          </Link>
          <Link to={`/trips/${trip.id}/edit`} className={buttonClass({ size: 'sm' })}>
            补充打卡评价
          </Link>
          <Button size="sm" variant="outline" icon={<Share2 className="size-4" />} onClick={() => setShare(true)}>
            {trip.is_owner && trip.visibility === 'private' ? '发布 / 分享' : '分享'}
          </Button>
          <Link to="/footprints" className={buttonClass({ size: 'sm', variant: 'ghost' })}>
            <Footprints className="size-4" />
            我的足迹
          </Link>
        </Card>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <Card className="flex items-center gap-4 p-4">
            <div className="relative">
              <Ring value={cmp.completion_rate} />
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-extrabold">{pct}%</span>
                <span className="text-[11px] text-ink-400">计划完成度</span>
              </div>
            </div>
            <div className="space-y-1.5 text-sm">
              <div>
                计划 <b>{cmp.planned.count}</b> 个点，去了 <b className="text-emerald-600">{plannedVisited.length}</b>
              </div>
              <div>
                跳过 <b className="text-ink-500">{cmp.skipped.length}</b>，新发现 <b className="text-violet-600">{cmp.extra.length}</b>
              </div>
              <div className="text-xs text-ink-500">
                {pct >= 90 ? '几乎完美执行了计划 👏' : pct >= 60 ? '大部分按计划进行，还有惊喜收获' : '随性出发，走出了自己的路线 ✨'}
              </div>
            </div>
          </Card>

          <Card className="grid grid-cols-2 gap-3 p-4 text-sm">
            <div>
              <div className="text-xs text-ink-400">计划里程</div>
              <div className="text-lg font-bold">{formatKm(cmp.planned.distance_km)}</div>
              {hasTrack && <div className="text-[11px] text-ink-400">按打卡点直线连线</div>}
            </div>
            <div>
              <div className="text-xs text-ink-400">实际里程</div>
              <div className="text-lg font-bold">
                {formatKm(actualKm)}
                {cmp.planned.distance_km > 0 && (
                  <span className={cn('ml-1 text-xs font-medium', distDiff > 0 ? 'text-amber-600' : 'text-emerald-600')}>
                    {distDiff > 0 ? '+' : ''}
                    {formatKm(Math.abs(distDiff)).replace(/^/, distDiff < 0 ? '-' : '')}
                  </span>
                )}
              </div>
              {byTrack && <div className="text-[11px] text-ink-400">按 GPS 轨迹</div>}
            </div>
          </Card>

          {cmp.days.length > 0 && (
            <Card className="p-4">
              <h3 className="mb-3 font-bold">每天的执行情况</h3>
              <div className="space-y-2.5">
                {cmp.days.map((d) => (
                  <div key={d.day} className="text-xs">
                    <div className="mb-1 flex justify-between text-ink-500">
                      <span>{d.day ? `第 ${d.day} 天` : '未分天'}</span>
                      <span>
                        计划 {d.planned} · 实到 {d.visited}
                        {d.extra > 0 && ` · 计划外 ${d.extra}`}
                      </span>
                    </div>
                    <div className="flex h-2 gap-0.5">
                      <div className="rounded-full bg-sky-200" style={{ width: `${(d.planned / maxDay) * 100}%` }} />
                    </div>
                    <div className="mt-0.5 flex h-2 gap-0.5">
                      <div className="bg-brand-gradient rounded-full" style={{ width: `${(d.visited / maxDay) * 100}%` }} />
                      {d.extra > 0 && <div className="rounded-full bg-violet-400" style={{ width: `${(d.extra / maxDay) * 100}%` }} />}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card className="overflow-hidden">
            <BaseMap className="h-[52vh] min-h-80" kindSwitcher>
              <RouteLines planned={cmp.planned.path} actual={cmp.actual.path} track={segments} idPrefix="cmp" />
              <WaypointMarkers waypoints={sorted} labels={labels} />
              <FitOnce points={allPts} fitKey={`cmp-${trip.id}`} />
            </BaseMap>
            <div className="flex flex-wrap gap-4 px-4 py-2.5 text-xs text-ink-500">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-5 border-t-2 border-dashed border-sky-500" />
                计划路线
              </span>
              <span className="flex items-center gap-1.5">
                <span className="bg-brand-gradient inline-block h-1 w-5 rounded" />
                实际路线
              </span>
              {segments.length > 0 && (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-1 w-5 rounded bg-violet-500" />
                  GPS 轨迹
                </span>
              )}
              <span>✓ 已完成 · + 计划外 · × 跳过 · ? 未去</span>
            </div>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2">
            <WpList title="按计划完成" icon={<CheckCircle2 className="size-4" />} list={plannedVisited} tone="text-emerald-600" />
            <WpList title="计划外的新发现" icon={<Sparkles className="size-4" />} list={cmp.extra} tone="text-violet-600" />
            <WpList title="跳过的地点" icon={<SkipForward className="size-4" />} list={cmp.skipped} tone="text-ink-500" />
            <WpList title="没来得及去" icon={<XCircle className="size-4" />} list={cmp.todo} tone="text-amber-600" />
          </div>

          {cmp.time_diffs.length > 0 && (
            <Card className="p-4">
              <h3 className="mb-3 flex items-center gap-1.5 font-bold">
                <Clock className="size-4" />
                时间偏差
              </h3>
              <div className="space-y-2">
                {cmp.time_diffs.map((d) => (
                  <div key={d.waypoint_id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{d.name}</span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-medium',
                        Math.abs(d.delta_minutes) <= 15
                          ? 'bg-emerald-50 text-emerald-700'
                          : d.delta_minutes > 0
                            ? 'bg-amber-50 text-amber-700'
                            : 'bg-sky-50 text-sky-700',
                      )}
                    >
                      {Math.abs(d.delta_minutes) <= 15
                        ? '准时'
                        : `${d.delta_minutes > 0 ? '晚' : '早'}到 ${Math.abs(d.delta_minutes) >= 60 ? `${(Math.abs(d.delta_minutes) / 60).toFixed(1)} 小时` : `${Math.abs(d.delta_minutes)} 分钟`}`}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
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
