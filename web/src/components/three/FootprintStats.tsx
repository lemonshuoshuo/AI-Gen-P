// 足迹的统计数字、时间线和照片：不依赖地图 / deck.gl，页面可以先显示这些，地图按需加载
import type { CSSProperties } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import type { Footprints } from '@/api/types'
import { Postmark, cityShort } from '@/components/editorial'
import { cn } from '@/lib/cn'
import { dayjs, fmtDate } from '@/lib/format'
import { formatKm } from '@/lib/geo'

/** 里程拆成数字 + 单位，数字用大号 Cormorant */
function km(v: number): [string, string] {
  if (!v) return ['0', '公里']
  if (v < 1) return [String(Math.round(v * 1000)), '米']
  if (v < 100) return [v.toFixed(1), '公里']
  return [Math.round(v).toLocaleString(), '公里']
}

const pad2 = (n: number) => String(n).padStart(2, '0')
/** 错开入场：同一组元素依次延迟 70ms */
const stagger = (k: number, base = 0): CSSProperties => ({ animationDelay: `${base + k * 70}ms`, animationFillMode: 'backwards' })

/**
 * 一行细字统计：大号细 Cormorant 数字，标签在上、单位在旁，统计之间用竖细线分隔。
 * dark：放在照片 / 夜色地图上时用白色系
 */
export function FootprintStats({
  data,
  className,
  dark,
  accent,
}: {
  data: Footprints
  className?: string
  dark?: boolean
  /** 标签前小圆点的颜色类名（如情侣空间的胭脂色）；不传时不显示 */
  accent?: string
}) {
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
  const line = dark ? 'border-white/12' : 'border-ink-200'
  return (
    <div className={cn('grid grid-cols-3 border-t sm:grid-cols-6', line, className)}>
      {items.map((i, k) => (
        <div
          key={i.label}
          className={cn(
            'min-w-0 pt-3 pb-5 sm:pb-6',
            k % 3 !== 0 ? 'border-l pl-3 sm:pl-5' : 'pr-3',
            k >= 3 && 'border-t sm:border-t-0',
            k === 3 && 'sm:border-l sm:pl-5',
            line,
          )}
        >
          <p className={cn('flex items-center gap-1.5 text-xs tracking-[0.08em]', dark ? 'text-white/55' : 'text-ink-500')}>
            {accent && k === 1 && <span className={cn('size-1.5 shrink-0 rounded-full bg-current', accent)} aria-hidden />}
            {i.label}
          </p>
          <div className="mt-3 flex items-baseline gap-1 sm:mt-4">
            <span className={cn('font-num truncate text-[2.5rem] leading-[0.9] font-light sm:text-5xl', dark ? 'text-white' : 'text-ink-900')}>
              {i.value}
            </span>
            {i.unit && <span className={cn('shrink-0 text-xs', dark ? 'text-white/45' : 'text-ink-400')}>{i.unit}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 页头的大号数字：城市、省份、里程、在路上的天数。
 * 每一格上方是细线 + 一行小标签（中文亮、英文灰），下面是超大细字 Cormorant
 */
export function FootprintNumerals({ data, className }: { data: Footprints; className?: string }) {
  const s = data.stats
  const [dist, distUnit] = km(s.distance_km)
  const items = [
    { label: '城市', en: 'Cities', value: String(s.cities), unit: '座' },
    { label: '省份', en: 'Provinces', value: String(s.provinces), unit: '个' },
    { label: '里程', en: 'Distance', value: dist, unit: distUnit },
    { label: '在路上', en: 'Days', value: String(s.days), unit: '天' },
  ]
  return (
    <div className={cn('grid grid-cols-2 lg:grid-cols-4', className)}>
      {items.map((it, k) => (
        <div
          key={it.label}
          style={stagger(k, 120)}
          className={cn(
            'animate-slide-up min-w-0 border-t border-ink-200 pt-3 pr-4 pb-9 md:pr-6 md:pb-12 xl:pr-8',
            k % 2 === 1 && 'border-l pl-4 max-lg:pr-0 md:pl-6',
            k > 0 && 'lg:border-l lg:pl-6 xl:pl-8',
            k === 3 && 'lg:pr-0',
          )}
        >
          <p className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] text-ink-900">{it.label}</span>
            <span className="eyebrow max-sm:hidden">{it.en}</span>
          </p>
          <p className="mt-7 flex min-w-0 items-baseline gap-2 md:mt-12">
            <span className="font-num truncate text-[clamp(3.25rem,8.4vw,8.25rem)] leading-[0.8] font-light tracking-[-0.02em] text-ink-900">
              {it.value}
            </span>
            <span className="shrink-0 text-xs text-ink-500">{it.unit}</span>
          </p>
        </div>
      ))}
    </div>
  )
}

/** 一段旅程去过的城市（按打卡先后，去掉「市」） */
function tripCities(data: Footprints, tripId: number) {
  const out: string[] = []
  for (const p of data.points) {
    if (p.trip_id !== tripId || !p.city) continue
    const c = cityShort(p.city)
    if (!out.includes(c)) out.push(c)
  }
  return out
}

function dateParts(start: string | null, end: string | null) {
  if (!start) return { year: '—', range: '未设置日期' }
  const a = dayjs(start)
  const b = end ? dayjs(end) : null
  const range = !b || b.isSame(a, 'day') ? a.format('MM.DD') : `${a.format('MM.DD')} — ${b.year() === a.year() ? b.format('MM.DD') : b.format('YYYY.MM.DD')}`
  return { year: a.format('YYYY'), range }
}

/** 旅程时间线：一行一段旅程——左侧年份和日期，中间标题，右侧封面（没有封面时是大号宋体地名 + 细线邮戳） */
export function FootprintTimeline({ data }: { data: Footprints }) {
  const trips = [...data.trips].sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))
  if (!trips.length) return null
  return (
    <ol className="border-b border-ink-200">
      {trips.map((t, i) => {
        const cities = tripCities(data, t.id)
        const places = data.points.filter((p) => p.trip_id === t.id).length || t.path.length
        const cover = t.cover_url || t.cover_thumb_url
        const d = dateParts(t.start_date, t.end_date)
        const days = t.start_date ? Math.max(1, dayjs(t.end_date ?? t.start_date).diff(dayjs(t.start_date), 'day') + 1) : null
        return (
          <li key={t.id} className="border-t border-ink-200">
            <Link
              to={`/trips/${t.id}`}
              className="group grid gap-x-8 gap-y-5 py-8 md:grid-cols-12 md:py-12"
              aria-label={`${t.title}，${d.year} ${d.range}`}
            >
              <div className="flex items-baseline gap-4 md:col-span-3 md:flex-col md:gap-3">
                <span className="font-num text-[13px] text-ink-400">{pad2(i + 1)}</span>
                <span className="font-num text-[2rem] leading-none font-light text-ink-900 md:text-[3.25rem]">{d.year}</span>
                <span className="font-num text-[13px] tracking-wide text-ink-500">{d.range}</span>
              </div>
              <div className="flex min-w-0 flex-col md:col-span-5">
                <h3 className="font-display text-[1.875rem] leading-[1.08] font-normal text-ink-900 md:text-[2.75rem]">{t.title}</h3>
                {cities.length > 0 && <p className="mt-4 text-[13px] text-ink-900">{cities.join(' · ')}</p>}
                <p className={cn('caption', cities.length ? 'mt-0.5' : 'mt-4')}>
                  <span className="font-num">{places}</span> 个地点 · <span className="font-num">{formatKm(t.distance_km)}</span>
                </p>
                <span className="mt-auto hidden items-center gap-1 pt-8 text-[13px] text-ink-700 transition-colors group-hover:text-ink-900 md:inline-flex">
                  查看这段旅程
                  <ArrowUpRight className="size-3.5 transition-transform duration-500 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={1.4} />
                </span>
              </div>
              <div className="max-md:order-first md:col-span-4">
                {cover ? (
                  <div className="aspect-[4/3] overflow-hidden rounded-sm bg-ink-100">
                    <img
                      src={cover}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="size-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.03]"
                    />
                  </div>
                ) : (
                  // 没有封面：近黑 + 超大宋体地名 + 细线邮戳
                  <div className="relative flex aspect-[4/3] flex-col justify-end overflow-hidden rounded-sm border border-ink-200 p-5 transition-colors duration-500 group-hover:border-ink-300 md:p-6">
                    <Postmark
                      className="absolute top-4 right-4 w-20 text-ink-400 md:w-24"
                      value={days ? String(days) : String(places)}
                      unit={days ? 'DAYS' : 'STOPS'}
                      ring={`TripHub · ${d.year} · ${Math.round(t.distance_km).toLocaleString()} km · `}
                    />
                    <p className="font-display text-[3.5rem] leading-none text-ink-900 md:text-[4.25rem]">{cities[0] ?? t.title.slice(0, 2)}</p>
                    {cities.length > 1 && (
                      <p className="mt-4 flex items-center gap-3 text-xs tracking-[0.12em] text-ink-500">
                        <span className="h-px w-8 bg-ink-400" aria-hidden />
                        {cities.slice(1, 4).join(' · ')}
                        {cities.length > 4 && ' 等'}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </Link>
          </li>
        )
      })}
    </ol>
  )
}

/** 足迹里的照片：错落的竖幅照片，说明文字在下方（地点亮、城市与日期灰） */
export function FootprintMoments({ data, limit = 8 }: { data: Footprints; limit?: number }) {
  const shots = data.points.filter((p) => p.photo_thumb_url).slice(-limit).reverse()
  if (!shots.length) return null
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 md:gap-x-6 lg:grid-cols-5">
      {shots.map((p, i) => (
        <li key={`${p.trip_id}-${p.waypoint_id ?? i}-${p.name}`} className={cn(i % 2 === 1 && 'mt-12 md:mt-20', i % 5 === 2 && 'lg:mt-8')}>
          <Link to={`/trips/${p.trip_id}`} className="group block">
            <div className="aspect-[4/5] overflow-hidden rounded-sm bg-ink-100">
              <img
                src={p.photo_thumb_url}
                alt={p.name}
                loading="lazy"
                decoding="async"
                className="size-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.03]"
              />
            </div>
            <p className="mt-3 truncate text-[13px] text-ink-900">{p.name}</p>
            <p className="caption truncate">
              {[p.city && cityShort(p.city), p.date && fmtDate(p.date)].filter(Boolean).join(' · ') || p.trip_title}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  )
}
