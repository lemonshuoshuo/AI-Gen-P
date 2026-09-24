import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Car, Footprints, Loader2, TrainFront } from 'lucide-react'
import { api, type LegMode, type TripLeg, type TripLegs, type Waypoint } from '@/api'
import { Segmented } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fmtMinutes } from '@/lib/format'
import { formatDistance } from '@/lib/geo'
import { bySeq } from '@/lib/trip'

const legModes: Record<LegMode, { label: string; icon: typeof Car }> = {
  walking: { label: '步行', icon: Footprints },
  transit: { label: '公交地铁', icon: TrainFront },
  driving: { label: '驾车', icon: Car },
}

/**
 * 计划路线的路段用时（GET /trips/:id/legs）。查询键带上计划点的顺序、天数和坐标：
 * 排序、增删、拖动标记、改天数后自动重新计算；计算期间先显示上一次的结果
 */
export function useTripLegs(tripId: number | undefined, waypoints: Waypoint[], mode: LegMode) {
  const planned = waypoints.filter((w) => w.planned).sort(bySeq)
  const sig = planned.map((w) => `${w.id}:${w.day}:${w.lng.toFixed(5)},${w.lat.toFixed(5)}`).join('|')
  const enabled = !!tripId && planned.length >= 2
  return useQuery({
    queryKey: ['legs', tripId, mode, sig],
    queryFn: ({ signal }) => api.trips.legs(tripId!, mode, signal),
    enabled,
    staleTime: 10 * 60_000,
    // 停用后（旅程已完成、计划点不足两个）不再沿用上一次的结果
    placeholderData: enabled ? keepPreviousData : undefined,
    retry: false,
  })
}

/** 一段路：交通方式、用时和路程（估算的标「约」） */
export function LegLine({ leg, className }: { leg: TripLeg; className?: string }) {
  const m = legModes[leg.mode] ?? legModes.walking
  const Icon = m.icon
  return (
    <div
      className={cn('flex min-w-0 items-center gap-1 text-[11px] text-ink-400', className)}
      title={leg.estimated ? '按直线距离估算，仅供参考' : '高德路径规划'}
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">
        {`${m.label} ${leg.estimated ? '约 ' : ''}${fmtMinutes(leg.duration_s)} · ${formatDistance(leg.distance_m)}`}
      </span>
    </div>
  )
}

/** 每天路上用时合计，可切换交通方式 */
export function LegsSummary({
  data,
  mode,
  onMode,
  loading,
  error,
}: {
  data: TripLegs | undefined
  mode: LegMode
  onMode: (m: LegMode) => void
  loading?: boolean
  /** 计算失败：只安静地提示，不弹 toast */
  error?: boolean
}) {
  const days = data?.days.filter((d) => d.stops >= 2) ?? []
  return (
    <div className="rounded-2xl bg-white p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink-700">路上用时</span>
        {loading && <Loader2 className="size-3.5 animate-spin text-ink-400" />}
        <Segmented<LegMode>
          size="sm"
          className="ml-auto"
          value={mode}
          onChange={onMode}
          options={(Object.keys(legModes) as LegMode[]).map((m) => {
            const { label, icon: Icon } = legModes[m]
            return {
              value: m,
              label: (
                <span className="inline-flex items-center gap-1">
                  <Icon className="size-3" />
                  {label}
                </span>
              ),
            }
          })}
        />
      </div>
      {data ? (
        days.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs text-ink-500">
            {days.map((d) => (
              <li key={d.day}>
                <span className="font-medium text-ink-700">{d.day ? `第${d.day}天` : '未分天'}</span>
                {`：${d.stops} 站 · 路上约 ${fmtMinutes(d.duration_s)} · ${formatDistance(d.distance_m)}`}
                {d.estimated && <span className="text-ink-400">（含估算）</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-ink-400">同一天有两个以上计划点时显示路上用时</p>
        )
      ) : (
        <p className="mt-2 text-xs text-ink-400">{error ? '路段用时暂时无法计算' : '正在计算路上用时…'}</p>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
        只计算同一天相邻计划点之间的路程，不含游玩停留时间；标「约」的按直线距离估算
      </p>
    </div>
  )
}
