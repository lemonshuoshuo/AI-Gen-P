import { useRef } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Route, type LucideIcon } from 'lucide-react'
import { api, type LegMode, type TravelMode, type TripLeg, type TripLegs, type Waypoint } from '@/api'
import { LEG_MODE_ICONS, LEG_MODE_LABELS } from '@/components/map/layers'
import { isLodging, legBetween, legIndex, type PlanGroups } from '@/components/trip/plan'
import { cn } from '@/lib/cn'
import { fmtMinutes } from '@/lib/format'
import { formatDistance, haversine } from '@/lib/geo'
import { bySeq } from '@/lib/trip'
import { ChoiceChip } from './Choice'

/** 旅程偏好的出行方式（trip.travel_mode） */
export const travelModes: { value: TravelMode; label: string; icon: LucideIcon; hint: string }[] = [
  { value: 'auto', label: '自动', icon: Route, hint: '每段按距离推荐：近的步行，稍远骑行，更远开车' },
  { value: 'walking', label: '步行', icon: LEG_MODE_ICONS.walking, hint: '每段都按步行规划' },
  { value: 'riding', label: '骑行', icon: LEG_MODE_ICONS.riding, hint: '每段都按骑行（共享单车）规划' },
  { value: 'transit', label: '公交', icon: LEG_MODE_ICONS.transit, hint: '公交地铁；很近的路段按步行' },
  { value: 'driving', label: '自驾', icon: LEG_MODE_ICONS.driving, hint: '每段都按开车规划' },
]

const POLL_MS = 4000

/**
 * 每天路线的各段（GET /trips/:id/legs）。查询键带上计划点的顺序、类型、天数和坐标：排序、增删、拖动标记、
 * 改天数后自动重新计算，计算期间先显示上一次的结果。geometry：带真实道路的折线。
 * 服务端还没算完（pending > 0）时每 4 秒再取一次，直到算完或连续几次没有进展
 */
export function useTripLegs(
  tripId: number | undefined,
  waypoints: Waypoint[],
  mode: TravelMode | undefined,
  /** paused：暂不请求（如修改还没保存完），但继续显示上一次的结果 */
  opts: { geometry?: boolean; enabled?: boolean; paused?: boolean } = {},
) {
  const planned = waypoints.filter((w) => w.planned).sort(bySeq)
  const sig = planned.map((w) => `${w.id}:${w.kind === 'lodging' ? 'L' : ''}${w.day}:${w.lng.toFixed(5)},${w.lat.toFixed(5)}`).join('|')
  const usable = !!tripId && (opts.enabled ?? true) && planned.length >= 2
  const enabled = usable && !opts.paused
  const polls = useRef(new Map<string, { at: number; last: number; stale: number; next: number | false }>())
  return useQuery({
    queryKey: ['legs', tripId, mode ?? '', !!opts.geometry, sig],
    queryFn: ({ signal }) => api.trips.legs(tripId!, mode, signal, opts.geometry),
    enabled,
    staleTime: 10 * 60_000,
    // 停用后（计划点不足两个）不再沿用上一次的结果；暂停时照常显示上一次的
    placeholderData: usable ? keepPreviousData : undefined,
    retry: false,
    refetchInterval: (q) => {
      const data = q.state.data as TripLegs | undefined
      const pending = data?.pending ?? 0
      if (!pending) return false
      const rec = polls.current.get(q.queryHash)
      // 同一次结果只统计一次（这个函数可能被多次调用）
      if (rec && rec.at === q.state.dataUpdatedAt) return rec.next
      const stale = rec && pending >= rec.last ? rec.stale + 1 : 0
      const next = stale >= 3 || q.state.dataUpdateCount > 12 ? false : POLL_MS
      polls.current.set(q.queryHash, { at: q.state.dataUpdatedAt, last: pending, stale, next })
      return next
    },
  })
}

/** 一段路：出行方式图标、用时和路程（估算的标「约」）；没有数据时是一条安静的细线 */
export function LegLine({ leg, className, loading }: { leg?: TripLeg; className?: string; loading?: boolean }) {
  if (!leg)
    return (
      <div className={cn('flex h-5 items-center gap-2 text-[11px] tracking-wide text-ink-400', className)}>
        {loading ? '计算路程…' : null}
      </div>
    )
  const Icon = LEG_MODE_ICONS[leg.mode] ?? LEG_MODE_ICONS.walking
  return (
    <div
      className={cn('flex min-w-0 items-center gap-1.5 text-[11px] tracking-wide text-ink-500', className)}
      title={leg.estimated ? '按直线距离估算，仅供参考' : '高德路径规划'}
    >
      <Icon className="size-3.5 shrink-0 text-ink-700" strokeWidth={1.5} />
      <span className="truncate">
        {LEG_MODE_LABELS[leg.mode] ?? '步行'} {leg.estimated ? '约 ' : ''}
        <span className="font-num text-[13px] text-ink-800">{fmtMinutes(leg.duration_s)}</span>
        <span className="mx-1.5 text-ink-300">·</span>
        <span className="font-num text-[13px]">{formatDistance(leg.distance_m)}</span>
      </span>
    </div>
  )
}

/** 出行方式：自动 / 步行 / 骑行 / 公交 / 自驾（保存为旅程的 travel_mode） */
export function TravelModePicker({
  value,
  onChange,
  disabled,
  loading,
  className,
}: {
  value: TravelMode
  onChange: (m: TravelMode) => void
  disabled?: boolean
  loading?: boolean
  className?: string
}) {
  return (
    <div role="radiogroup" aria-label="出行方式" className={cn('flex flex-wrap gap-1.5', className)}>
      {travelModes.map((m) => (
        <ChoiceChip
          key={m.value}
          size="sm"
          selected={value === m.value}
          disabled={disabled}
          onClick={() => value !== m.value && onChange(m.value)}
          icon={<m.icon className="size-3.5" strokeWidth={1.5} />}
          title={m.hint}
          loading={loading && value === m.value}
        >
          {m.label}
        </ChoiceChip>
      ))}
    </div>
  )
}

/* ---------------- 草稿里的路段 ---------------- */

const SPEED: Record<LegMode, number> = { walking: 1.2, riding: 4, transit: 6, driving: 8 }
const EXTRA_S: Record<LegMode, number> = { walking: 0, riding: 120, transit: 600, driving: 180 }

/**
 * 按直线距离估算一段路（与服务端 legs 的估算规则一致）：路程取直线的 1.3 倍（驾车 1.4 倍）；步行 1.2 米/秒，骑行 4 米/秒另加 2 分钟，
 * 公交地铁 6 米/秒另加 10 分钟，驾车 8 米/秒另加 3 分钟；直线 50 公里以上的公交地铁 / 驾车按 20 米/秒
 */
export function estimateLeg(a: Waypoint, b: Waypoint, mode: TravelMode, day: number): TripLeg {
  const straight = haversine([a.lng, a.lat], [b.lng, b.lat])
  const rec: LegMode = straight <= 1200 ? 'walking' : straight <= 4000 ? 'riding' : mode === 'transit' ? 'transit' : 'driving'
  const m: LegMode = mode === 'auto' ? rec : mode === 'transit' && straight <= 1000 ? 'walking' : mode
  const dist = straight * (m === 'driving' ? 1.4 : 1.3)
  const speed = (m === 'transit' || m === 'driving') && straight >= 50_000 ? 20 : SPEED[m]
  return {
    from_id: a.id,
    to_id: b.id,
    day,
    mode: m,
    recommended_mode: rec,
    distance_m: Math.round(dist),
    duration_s: Math.round(dist / speed + EXTRA_S[m]),
    straight_m: Math.round(straight),
    estimated: true,
  }
}

export interface DayTotal {
  day: number
  distance_m: number
  duration_s: number
  /** 有估算的路段 */
  estimated: boolean
}

/**
 * 草稿的每天路线的各段：服务端（按已保存的计划）算好的路段直接用（含真实道路），草稿里新连起来的两点先按直线估算，
 * 保存后再换成高德路线。另算每天的合计（同服务端 legs.days：不含停留游玩时间）
 */
export function planLegs(g: PlanGroups, server: TripLeg[] | undefined, mode: TravelMode): { legs: TripLeg[]; totals: Map<number, DayTotal> } {
  const idx = legIndex(server)
  const legs: TripLeg[] = []
  const totals = new Map<number, DayTotal>()
  const chain = (list: Waypoint[], day: number) => {
    const t: DayTotal = { day, distance_m: 0, duration_s: 0, estimated: false }
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]
      const b = list[i]
      if (a.id === b.id) continue
      // 同一家酒店连住：没有路段（同服务端）
      if (isLodging(a) && isLodging(b) && haversine([a.lng, a.lat], [b.lng, b.lat]) < 50) continue
      const l = legBetween(idx, a, b) ?? estimateLeg(a, b, mode, day)
      legs.push(l)
      t.distance_m += l.distance_m
      t.duration_s += l.duration_s
      t.estimated ||= l.estimated
    }
    totals.set(day, t)
  }
  for (const d of g.days) chain([d.start, ...d.stops.filter((w) => w.planned), d.end].filter((w): w is Waypoint => !!w), d.day)
  if (g.dayCount === 0) chain(g.pool.filter((w) => w.planned), 0)
  return { legs, totals }
}
