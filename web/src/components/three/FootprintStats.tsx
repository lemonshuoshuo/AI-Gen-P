// 足迹的统计数字、时间线和照片：不依赖地图 / deck.gl，页面可以先显示这些，地图按需加载
import { useState, type CSSProperties } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import type { Footprints } from '@/api/types'
import { Postmark, cityShort } from '@/components/editorial'
import { cn } from '@/lib/cn'
import { dayjs, fmtDate } from '@/lib/format'
import { formatKm } from '@/lib/geo'
import { useThemeScope } from '@/theme'

/** 里程拆成数字 + 单位（数字用主题的大数字档 text-num） */
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
 * 一行统计：主题的大数字档（font-num text-num），标签在上、单位在旁，统计之间用竖细线分隔。
 * dark：放在照片 / 夜色地图上时用当前主题的深色令牌（局部强制深色）
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
  const scope = useThemeScope('dark')
  const line = 'border-line'
  return (
    <div {...(dark ? scope : undefined)} className={cn('grid grid-cols-2 border-t sm:grid-cols-3 lg:grid-cols-6', line, className)}>
      {items.map((i, k) => (
        <div
          key={i.label}
          className={cn(
            'min-w-0 pt-3 pr-3 pb-5 sm:pb-6',
            // 手机两列、平板三列、桌面一行六列：列之间竖细线，行之间横细线
            k % 2 === 1 && 'border-l pl-3',
            k >= 2 && 'border-t',
            k % 3 === 0 ? 'sm:border-l-0 sm:pl-0' : 'sm:border-l sm:pl-5',
            k >= 3 ? 'sm:border-t' : 'sm:border-t-0',
            k > 0 && 'lg:border-l lg:pl-5',
            'lg:border-t-0',
            line,
          )}
        >
          <p className="flex items-center gap-1.5 text-xs tracking-[0.08em] text-ink-500">
            {accent && k === 1 && <span className={cn('size-1.5 shrink-0 rounded-full bg-current', accent)} aria-hidden />}
            {i.label}
          </p>
          <div className="mt-3 flex items-baseline gap-1">
            <span className="font-num text-num whitespace-nowrap text-ink-900">{i.value}</span>
            {i.unit && <span className="shrink-0 text-xs text-ink-500">{i.unit}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 页头的数字：城市、省份、里程、在路上的天数。
 * 一行四格（手机上也是一行、单位并进标签），每一格上方是细线 + 一行小标签（中文亮、英文灰），下面是主题的大数字档（text-num）
 */
export function FootprintNumerals({ data, className }: { data: Footprints; className?: string }) {
  const s = data.stats
  const [dist, distUnit] = km(s.distance_km)
  const items = [
    { label: '城市', short: '城市', en: 'Cities', value: String(s.cities), unit: '座' },
    { label: '省份', short: '省份', en: 'Provinces', value: String(s.provinces), unit: '个' },
    { label: '里程', short: distUnit, en: 'Distance', value: dist, unit: distUnit },
    { label: '在路上', short: '天数', en: 'Days', value: String(s.days), unit: '天' },
  ]
  return (
    <div className={cn('grid grid-cols-4', className)}>
      {items.map((it, k) => (
        <div
          key={it.label}
          style={stagger(k, 120)}
          className={cn(
            'animate-slide-up min-w-0 border-t border-ink-200 pt-3 pr-2 pb-5 sm:pr-4 md:pr-6 md:pb-6 xl:pr-8',
            k > 0 && 'border-l pl-2.5 sm:pl-4 md:pl-6 xl:pl-8',
            k === 3 && 'pr-0 sm:pr-0 md:pr-0 xl:pr-0',
          )}
        >
          <p className="flex items-baseline justify-between gap-3">
            <span className="text-[12px] text-ink-900 sm:text-[13px]">
              <span className="sm:hidden">{it.short}</span>
              <span className="max-sm:hidden">{it.label}</span>
            </span>
            <span className="eyebrow max-lg:hidden">{it.en}</span>
          </p>
          <p className="mt-3 flex min-w-0 items-baseline gap-1.5 sm:mt-4">
            <span
              className={cn(
                'font-num text-num whitespace-nowrap text-ink-900',
                // 手机上一格只有约 70px 宽：位数多的里程（如 3,304）用小一档（区块标题的字号），保证放得下
                it.value.length > 4 && 'max-sm:text-[length:var(--text-h2)]',
              )}
            >
              {it.value}
            </span>
            <span className="shrink-0 text-xs text-ink-500 max-sm:hidden">{it.unit}</span>
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

/** 一行旅程（时间线）需要的数据：足迹页来自足迹数据，情侣空间来自一起的旅程列表 */
export interface TripRowData {
  id: number
  title: string
  start_date: string | null
  end_date: string | null
  cover: string
  cities: string[]
  places: number
  distance_km: number
  /** 打卡路线（经纬度）：没有封面时画成一条细线 */
  path: [number, number][]
}

/** 足迹数据 → 时间线的行（按出发日期从新到旧） */
export function footprintRows(data: Footprints): TripRowData[] {
  return [...data.trips]
    .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))
    .map((t) => ({
      id: t.id,
      title: t.title,
      start_date: t.start_date,
      end_date: t.end_date,
      cover: t.cover_url || t.cover_thumb_url,
      cities: tripCities(data, t.id),
      places: data.points.filter((p) => p.trip_id === t.id).length || t.path.length,
      distance_km: t.distance_km,
      path: t.path,
    }))
}

/** 照片加载完再淡入（700ms），加载前是 surface 底色，不会「啪」地跳出来 */
function FadeImg({ src, alt = '', className }: { src: string; alt?: string; className?: string }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      ref={(el) => {
        // 已在缓存里的图片可能在挂上 onLoad 之前就加载完了
        if (el?.complete && el.naturalWidth > 0 && !loaded) setLoaded(true)
      }}
      onLoad={() => setLoaded(true)}
      className={cn('transition-[opacity,transform] duration-700 ease-out', loaded ? 'opacity-100' : 'opacity-0', className)}
    />
  )
}

/** 路线的细线：按经纬度等距投影到 4:3 的画框里，只作为排版封面的底纹 */
function PathSketch({ path }: { path: [number, number][] }) {
  if (path.length < 2) return null
  const W = 400
  const H = 300
  const lat0 = (path.reduce((s, p) => s + p[1], 0) / path.length) * (Math.PI / 180)
  const pts = path.map(([x, y]) => [x * Math.cos(lat0), -y] as const)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  // 画在画框的左上部（右上角是邮戳，下方是地名），像一张小小的路线图
  const box = { x: 20, y: 30, w: 250, h: 150 }
  const k = Math.min(box.w / (x1 - x0 || 1e-9), box.h / (y1 - y0 || 1e-9))
  const ox = box.x + (box.w - (x1 - x0) * k) / 2
  const oy = box.y + (box.h - (y1 - y0) * k) / 2
  const xy = pts.map(([x, y]) => [ox + (x - x0) * k, oy + (y - y0) * k])
  const [sx, sy] = xy[0]
  const [ex, ey] = xy[xy.length - 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full" fill="none" aria-hidden>
      <polyline
        points={xy.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}
        className="stroke-ink-400"
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={sx} cy={sy} r={2.5} className="fill-ink-500" />
      <circle cx={ex} cy={ey} r={4} className="stroke-ink-500" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** 排版封面上的地名：最大是旅程封面的展示字号（text-hero，≤ 60px），字越多越小，保证一行放得下 */
const leadSize = (n: number) =>
  n <= 2 ? 'text-[length:var(--text-hero)]' : n === 3 ? 'text-[length:var(--text-h1)]' : 'text-[length:var(--text-h2)]'

/** 旅程时间线：一行一段旅程——左侧年份（大数字档）和日期，中间标题（区块标题的字号），右侧封面（没有封面时是展示字体的地名 + 路线细线 + 邮戳） */
export function TripRows({ rows }: { rows: TripRowData[] }) {
  if (!rows.length) return null
  return (
    <ol className="border-b border-ink-200">
      {rows.map((t, i) => {
        const cities = t.cities
        const d = dateParts(t.start_date, t.end_date)
        const days = t.start_date ? Math.max(1, dayjs(t.end_date ?? t.start_date).diff(dayjs(t.start_date), 'day') + 1) : null
        const lead = cities[0] ?? t.title.slice(0, 2)
        return (
          <li key={t.id} className="border-t border-ink-200">
            <Link
              to={`/trips/${t.id}`}
              className="group grid gap-x-8 gap-y-5 py-8 md:grid-cols-12 md:py-12"
              aria-label={`${t.title}，${d.year} ${d.range}`}
            >
              <div className="flex items-baseline gap-4 md:col-span-3 md:flex-col md:gap-3">
                <span className="font-num text-[13px] text-ink-400">{pad2(i + 1)}</span>
                <span className="font-num text-num text-ink-900">{d.year}</span>
                <span className="font-num text-[13px] tracking-wide text-ink-500">{d.range}</span>
              </div>
              <div className="flex min-w-0 flex-col md:col-span-5">
                <h3 className="font-display text-[length:var(--text-h2)] leading-snug font-normal text-ink-900">{t.title}</h3>
                {cities.length > 0 && <p className="mt-4 text-[13px] text-ink-900">{cities.join(' · ')}</p>}
                <p className={cn('caption', cities.length ? 'mt-0.5' : 'mt-4')}>
                  <span className="font-num">{t.places}</span> 个地点 · <span className="font-num">{formatKm(t.distance_km)}</span>
                </p>
                <span className="mt-auto hidden items-center gap-1 pt-8 text-[13px] text-ink-700 transition-colors group-hover:text-ink-900 md:inline-flex">
                  查看这段旅程
                  <ArrowUpRight className="size-3.5 transition-transform duration-500 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" strokeWidth={1.4} />
                </span>
              </div>
              <div className="max-md:order-first md:col-span-4">
                {t.cover ? (
                  <div className="aspect-[4/3] overflow-hidden rounded-image bg-surface">
                    <FadeImg src={t.cover} className="size-full object-cover group-hover:scale-[1.03]" />
                  </div>
                ) : (
                  // 没有封面：展示字体的地名（ink-700，不压过标题）+ 路线细线 + 邮戳，上方一条细线（不画整圈边框，不像空卡片）
                  <div className="relative flex aspect-[4/3] flex-col justify-end overflow-hidden border-t border-ink-200 pb-1 transition-colors duration-500 group-hover:border-ink-400">
                    <PathSketch path={t.path} />
                    <Postmark
                      className="absolute top-4 right-0 w-24 -rotate-[8deg] text-ink-500 md:w-28"
                      value={days ? String(days).padStart(2, '0') : String(t.places)}
                      unit={days ? (days > 1 ? 'DAYS' : 'DAY') : 'STOPS'}
                      ring={`TripHub · ${d.year} · ${Math.round(t.distance_km).toLocaleString()} km · `}
                    />
                    <p className={cn('font-display relative text-ink-700', leadSize(lead.length), 'leading-none')}>{lead}</p>
                    {cities.length > 1 && (
                      <p className="relative mt-4 flex items-center gap-3 text-xs tracking-[0.12em] text-ink-500">
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

/** 足迹页的旅程时间线 */
export function FootprintTimeline({ data }: { data: Footprints }) {
  return <TripRows rows={footprintRows(data)} />
}

// 照片的不对称网格（桌面 12 栏）：第一张是 5 栏宽的主图，其余按固定的节奏错落，像杂志的跨页而不是一排缩略图
const MOMENT_LAYOUT = [
  'lg:col-span-5',
  'lg:col-span-3 lg:col-start-7 lg:mt-24',
  'lg:col-span-3 lg:mt-48',
  'lg:col-span-3 lg:col-start-2 lg:mt-16',
  'lg:col-span-4 lg:col-start-6 lg:mt-40',
  'lg:col-span-3 lg:col-start-10 lg:mt-8',
  'lg:col-span-4 lg:col-start-1 lg:mt-12',
  'lg:col-span-3 lg:col-start-7 lg:mt-32',
]

/** 足迹里的照片：不对称的竖幅照片，说明文字在下方（地点亮、城市与日期灰） */
export function FootprintMoments({ data, limit = 8 }: { data: Footprints; limit?: number }) {
  const shots = data.points.filter((p) => p.photo_thumb_url).slice(-limit).reverse()
  if (!shots.length) return null
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-10 md:gap-x-6 lg:grid-cols-12 lg:gap-x-8 lg:gap-y-12">
      {shots.map((p, i) => (
        <li
          key={`${p.trip_id}-${p.waypoint_id ?? i}-${p.name}`}
          className={cn(
            // 手机 / 平板：第一张占满两栏，其余两栏错落
            i === 0 ? 'col-span-2' : i % 2 === 0 && 'mt-12 md:mt-20',
            MOMENT_LAYOUT[i % MOMENT_LAYOUT.length],
          )}
        >
          <Link to={`/trips/${p.trip_id}`} className="group block">
            <div className={cn('overflow-hidden rounded-image bg-surface', i === 0 ? 'aspect-[4/5] max-lg:aspect-[3/2]' : 'aspect-[4/5]')}>
              <FadeImg src={p.photo_thumb_url!} alt={p.name} className="size-full object-cover group-hover:scale-[1.03]" />
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
