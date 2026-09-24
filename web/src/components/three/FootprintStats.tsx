// 足迹的统计数字和时间线：不依赖地图 / deck.gl，页面可以先显示这些，地图按需加载
import { Link } from 'react-router'
import type { Footprints } from '@/api/types'
import { cn } from '@/lib/cn'
import { fmtDate } from '@/lib/format'
import { formatKm } from '@/lib/geo'

export function FootprintStats({ data, className, dark }: { data: Footprints; className?: string; dark?: boolean }) {
  const s = data.stats
  const items = [
    { label: '旅程', value: s.trips },
    { label: '城市', value: s.cities },
    { label: '省份', value: s.provinces },
    { label: '打卡点', value: s.waypoints },
    { label: '里程', value: formatKm(s.distance_km) },
    { label: '天', value: s.days },
  ]
  return (
    <div className={cn('grid grid-cols-3 gap-2 sm:grid-cols-6', className)}>
      {items.map((i) => (
        <div key={i.label} className={cn('rounded-2xl px-3 py-2.5', dark ? 'bg-white/8 ring-1 ring-white/10' : 'bg-white shadow-card')}>
          <div className="truncate text-lg font-extrabold tabular-nums">{i.value}</div>
          <div className={cn('text-xs', dark ? 'text-white/50' : 'text-ink-400')}>{i.label}</div>
        </div>
      ))}
    </div>
  )
}

export function FootprintTimeline({ data }: { data: Footprints }) {
  const trips = [...data.trips].sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))
  if (!trips.length) return null
  return (
    <div className="relative space-y-3 pl-5">
      <div className="absolute top-2 bottom-2 left-1.5 w-0.5 rounded bg-gradient-to-b from-brand-400 to-orange-300" />
      {trips.map((t) => (
        <Link key={t.id} to={`/trips/${t.id}`} className="relative flex items-center gap-3 rounded-2xl bg-white p-3 shadow-card hover:shadow-float">
          <span className="absolute top-1/2 -left-[18px] size-3 -translate-y-1/2 rounded-full border-2 border-white bg-brand-500 shadow" />
          {t.cover_url && (
            <img src={t.cover_thumb_url || t.cover_url} alt="" loading="lazy" decoding="async" className="size-12 rounded-xl object-cover" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{t.title}</div>
            <div className="text-xs text-ink-400">
              {fmtDate(t.start_date) || '未设置日期'} · {t.path.length} 个地点 · {formatKm(t.distance_km)}
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}
