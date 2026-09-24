import { Link } from 'react-router'
import { MapPin } from 'lucide-react'
import { isAvoided } from '@/api'
import type { Place } from '@/api/types'
import { CategoryChip, Stars } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDistance } from '@/lib/geo'
import { categoryOf } from '@/lib/meta'

export function recommendRate(p: Pick<Place, 'recommend_count' | 'neutral_count' | 'avoid_count'>) {
  const total = p.recommend_count + p.neutral_count + p.avoid_count
  return total ? Math.round((p.recommend_count / total) * 100) : null
}

export function VerdictBar({ place, className }: { place: Place; className?: string }) {
  const total = place.recommend_count + place.neutral_count + place.avoid_count
  if (!total) return null
  const pct = (n: number) => `${(n / total) * 100}%`
  return (
    <div className={cn('flex h-1.5 overflow-hidden rounded-full bg-ink-100', className)}>
      <div className="bg-emerald-500" style={{ width: pct(place.recommend_count) }} />
      <div className="bg-amber-400" style={{ width: pct(place.neutral_count) }} />
      <div className="bg-red-500" style={{ width: pct(place.avoid_count) }} />
    </div>
  )
}

export function PlaceRow({ place, rank }: { place: Place; rank?: number }) {
  const rate = recommendRate(place)
  const Icon = categoryOf(place.category).icon
  // 与服务端 MinAvoidWarn 一致：至少 2 人踩雷且踩雷多于推荐才提示慎去（一个人的评价不算）
  const avoid = isAvoided(place)
  return (
    <Link
      to={`/places/${place.id}`}
      className="flex items-center gap-3 rounded-2xl bg-white p-3 shadow-card transition hover:shadow-float"
    >
      {rank != null && (
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-lg text-xs font-bold',
            rank <= 3 ? 'bg-brand-gradient text-white' : 'bg-ink-100 text-ink-500',
          )}
        >
          {rank}
        </span>
      )}
      <div className="relative size-14 shrink-0 overflow-hidden rounded-xl bg-ink-100">
        {place.cover_url ? (
          <img src={place.cover_thumb_url || place.cover_url} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center" style={{ color: categoryOf(place.category).color }}>
            <Icon className="size-6" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-semibold">{place.name}</span>
          {avoid && <span className="shrink-0 rounded bg-red-50 px-1 text-[11px] font-medium text-red-600">⚠️ 慎去</span>}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-400">
          {place.rating_count > 0 && <Stars value={place.rating_avg} size={11} />}
          {place.avg_cost > 0 && <span>¥{Math.round(place.avg_cost)}/人</span>}
          <span className="truncate">
            <MapPin className="mr-0.5 inline size-3" />
            {place.district || place.city}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <CategoryChip category={place.category} className="whitespace-nowrap" />
          <span className="whitespace-nowrap text-ink-500">{place.checkin_count} 人打卡</span>
          {rate != null && (
            <span className={cn('whitespace-nowrap', rate >= 60 ? 'text-emerald-600' : 'text-amber-600')}>推荐率 {rate}%</span>
          )}
          {place.distance_m != null && <span className="ml-auto whitespace-nowrap text-ink-400">{formatDistance(place.distance_m)}</span>}
        </div>
      </div>
    </Link>
  )
}
