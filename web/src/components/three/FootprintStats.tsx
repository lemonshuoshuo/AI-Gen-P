// 足迹的统计数字和时间线：不依赖地图 / deck.gl，页面可以先显示这些，地图按需加载
import { Link } from 'react-router'
import type { Footprints } from '@/api/types'
import { cn } from '@/lib/cn'
import { dateRange } from '@/lib/format'
import { formatKm } from '@/lib/geo'

/** 里程拆成数字 + 单位，数字用大号 Fraunces */
function km(v: number): [string, string] {
  if (!v) return ['0', '公里']
  if (v < 1) return [String(Math.round(v * 1000)), '米']
  if (v < 100) return [v.toFixed(1), '公里']
  return [Math.round(v).toLocaleString(), '公里']
}

export function FootprintStats({ data, className, dark }: { data: Footprints; className?: string; dark?: boolean }) {
  const s = data.stats
  const [dist, distUnit] = km(s.distance_km)
  const items: { label: string; value: string | number; unit?: string }[] = [
    { label: '旅程', value: s.trips, unit: '段' },
    { label: '城市', value: s.cities, unit: '座' },
    { label: '省份', value: s.provinces, unit: '个' },
    { label: '打卡点', value: s.waypoints, unit: '处' },
    { label: '里程', value: dist, unit: distUnit },
    { label: '在路上', value: s.days, unit: '天' },
  ]
  return (
    <div
      className={cn(
        'grid grid-cols-3 border-y sm:grid-cols-6',
        dark ? 'border-white/12' : 'border-ink-200',
        className,
      )}
    >
      {items.map((i, k) => (
        <div
          key={i.label}
          className={cn(
            'min-w-0 px-3 py-3.5 sm:px-4',
            k % 3 !== 0 && 'border-l',
            k >= 3 && 'border-t sm:border-t-0',
            k === 3 && 'sm:border-l',
            dark ? 'border-white/12' : 'border-ink-200',
          )}
        >
          <div className="flex items-baseline gap-1">
            <span className={cn('font-num truncate text-[1.6rem] leading-none font-medium tracking-tight', k === 1 && !dark && 'text-brand-500')}>
              {i.value}
            </span>
            {i.unit && <span className={cn('shrink-0 text-xs', dark ? 'text-white/45' : 'text-ink-400')}>{i.unit}</span>}
          </div>
          <div className={cn('mt-1.5 text-xs tracking-wide', dark ? 'text-white/50' : 'text-ink-400')}>{i.label}</div>
        </div>
      ))}
    </div>
  )
}

export function FootprintTimeline({ data }: { data: Footprints }) {
  const trips = [...data.trips].sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))
  if (!trips.length) return null
  return (
    <ol className="relative border-l border-ink-200 pl-6">
      {trips.map((t) => (
        <li key={t.id} className="relative">
          <span className="absolute top-1/2 -left-[29px] size-2.5 -translate-y-1/2 rounded-full border border-ink-900 bg-paper" />
          <Link to={`/trips/${t.id}`} className="group flex items-center gap-4 border-b border-ink-200 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="font-num text-xs tracking-wide text-ink-400">{dateRange(t.start_date, t.end_date) || '未设置日期'}</p>
              <p className="font-display mt-1 truncate text-[16px] text-ink-900 transition-colors group-hover:text-brand-600">{t.title}</p>
              <p className="mt-0.5 text-xs text-ink-400">
                <span className="font-num text-ink-600">{t.path.length}</span> 个地点 · {formatKm(t.distance_km)}
              </p>
            </div>
            {(t.cover_thumb_url || t.cover_url) && (
              <img
                src={t.cover_thumb_url || t.cover_url}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-14 w-20 shrink-0 rounded-md object-cover ring-1 ring-ink-900/5"
              />
            )}
          </Link>
        </li>
      ))}
    </ol>
  )
}
