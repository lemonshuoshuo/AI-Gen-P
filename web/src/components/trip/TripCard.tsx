import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Heart, Link2, Lock, MessageCircle } from 'lucide-react'
import type { TripCard as Trip } from '@/api/types'
import { Postmark, cityShort } from '@/components/editorial'
import { cn } from '@/lib/cn'
import { dayjs, fmtCount, fmtDate } from '@/lib/format'
import { phases, tripStatuses } from '@/lib/meta'

/** 里程的短写法：邮戳和小字里用（0.9 / 12.3 / 1,280） */
export function kmShort(km: number) {
  if (km < 10) return km.toFixed(1)
  if (km < 100) return String(Math.round(km))
  return Math.round(km).toLocaleString()
}

type CoverTrip = Pick<Trip, 'id' | 'cover_url' | 'cover_thumb_url' | 'title' | 'cities'> &
  Partial<Pick<Trip, 'days' | 'distance_km' | 'start_date' | 'created_at'>>

/**
 * 没有照片时的封面：近黑底 + 超大宋体地名 + 细线邮戳。
 * 按 id 在横排（左下）与竖排（右侧，像书脊）之间交替，一整排封面不至于千篇一律。
 * landscape：横幅比例（3:2 等）只用横排
 */
function TypeCover({ trip, className, landscape }: { trip: CoverTrip; className?: string; landscape?: boolean }) {
  const cities = (trip.cities ?? []).map(cityShort)
  const lead = cities[0]
  const rest = cities.slice(1, 4)
  const days = trip.days ?? 0
  const km = trip.distance_km ?? 0
  const date = trip.start_date || trip.created_at
  const vertical = !landscape && !!lead && lead.length <= 5 && trip.id % 2 === 1
  const stamp =
    days > 0
      ? { value: String(days).padStart(2, '0'), unit: days > 1 ? 'DAYS' : 'DAY' }
      : km > 0
        ? { value: kmShort(km), unit: 'KM' }
        : { value: date ? dayjs(date).format('MM') : '—', unit: date ? dayjs(date).format('YYYY') : 'TRIP' }
  const ring = ['TripHub', km > 0 && days > 0 && `${kmShort(km)} km`, date && dayjs(date).format('YYYY.MM.DD')].filter(Boolean).join(' · ')
  const n = lead?.length ?? 0
  // 字号按容器宽度（cqw）：两个字的地名约占三分之二宽
  const size = vertical ? Math.min(30, 96 / Math.max(n, 1)) : n <= 2 ? 31 : n === 3 ? 25 : n === 4 ? 19 : n <= 6 ? 13.5 : 10
  const tail = rest.length ? `${rest.join(' · ')}${cities.length > 4 ? ' 等' : ''}` : date ? dayjs(date).format('YYYY.MM') : ''
  return (
    <div role="img" aria-label={trip.title} className={cn('@container relative size-full overflow-hidden bg-surface text-ink-900 select-none', className)}>
      {/* 1px 细边：排版封面与页面底色之间的分界 */}
      <span aria-hidden className="pointer-events-none absolute inset-0 ring-1 ring-ink-200 ring-inset" />
      <span
        aria-hidden
        className={cn('absolute w-[30cqw] -rotate-[8deg] text-ink-500', vertical ? 'bottom-[9cqw] left-[7cqw]' : 'top-[6cqw] right-[6cqw]')}
      >
        <Postmark className="w-full" value={stamp.value} unit={stamp.unit} ring={`${ring} · `} />
      </span>
      {lead ? (
        vertical ? (
          <div className="absolute top-[max(7cqw,3.25rem)] right-[8cqw] flex h-[calc(100%-14cqw)] flex-row-reverse items-start gap-[3cqw]">
            <span className="font-display leading-none tracking-[0.06em] [writing-mode:vertical-rl]" style={{ fontSize: `${size}cqw` }}>
              {lead}
            </span>
            {tail && (
              <span className="mt-[1cqw] flex items-center gap-[2cqw] text-[max(10px,3.1cqw)] tracking-[0.3em] text-ink-500 [writing-mode:vertical-rl]">
                <span className="h-[10cqw] w-px bg-current opacity-60" />
                {tail}
              </span>
            )}
          </div>
        ) : (
          <div className="absolute inset-x-[7.5cqw] bottom-[7.5cqw]">
            <div className="font-display leading-[0.95] tracking-[0.02em]" style={{ fontSize: `${size}cqw` }}>
              {lead}
            </div>
            {tail && (
              <div className="mt-[4cqw] flex items-center gap-[2.5cqw]">
                <span className="h-px w-[9cqw] shrink-0 bg-current opacity-40" />
                <span className="min-w-0 truncate text-[max(10px,3.2cqw)] tracking-[0.16em] text-ink-500">{tail}</span>
              </div>
            )}
          </div>
        )
      ) : (
        <div className="font-display absolute inset-x-[7.5cqw] bottom-[7.5cqw] line-clamp-3 text-[10cqw] leading-[1.15]">{trip.title}</div>
      )}
    </div>
  )
}

/** 默认用缩略图（列表卡片）；full 用原图（横幅）。没有照片时是排版封面（近黑 + 宋体地名 + 细线邮戳） */
export function TripCover({
  trip,
  className,
  full,
  landscape,
}: {
  trip: CoverTrip
  className?: string
  full?: boolean
  /** 横幅比例的容器：排版封面只用横排 */
  landscape?: boolean
}) {
  if (trip.cover_url)
    return (
      <img
        src={full ? trip.cover_url : trip.cover_thumb_url || trip.cover_url}
        alt={trip.title}
        loading="lazy"
        decoding="async"
        className={cn('size-full object-cover', className)}
      />
    )
  return <TypeCover trip={trip} className={className} landscape={landscape} />
}

/** 封面左上角的小标签：照片上的暗色毛玻璃细线胶囊；compact 在窄卡片上只留图标 / 圆点（文字给读屏） */
function CoverTag({ children, mark, compact }: { children: ReactNode; mark?: ReactNode; compact?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full bg-black/55 px-2.5 text-[11px] leading-none tracking-[0.08em] text-white/90 ring-1 ring-white/12 backdrop-blur-md ring-inset',
        compact && '@max-[15rem]:w-6 @max-[15rem]:justify-center @max-[15rem]:px-0',
      )}
      title={compact && typeof children === 'string' ? children : undefined}
    >
      {mark}
      <span className={cn(compact && '@max-[15rem]:sr-only')}>{children}</span>
    </span>
  )
}

const dot = (cls: string) => <span aria-hidden className={cn('size-[5px] shrink-0 rounded-full', cls)} />

export function TripCard({ trip, showAuthor = true, className }: { trip: Trip; showAuthor?: boolean; className?: string }) {
  const phase = phases[trip.phase] ?? phases.finished
  const cities = trip.cities ?? []
  const where = cities.length
    ? `${cities.slice(0, 3).map(cityShort).join(' · ')}${cities.length > 3 ? ` 等${cities.length}城` : ''}`
    : '目的地待定'
  const km = trip.distance_km
  const facts = [
    showAuthor ? trip.author.nickname || trip.author.username : trip.start_date ? fmtDate(trip.start_date) : `${trip.visited_count || trip.waypoint_count} 个打卡点`,
    trip.days > 0 && `${trip.days} 天`,
    km > 0 && `${kmShort(km)} km`,
  ].filter(Boolean)
  return (
    <Link to={`/trips/${trip.id}`} className={cn('group block min-w-0 focus-visible:outline-offset-4', className)}>
      <div className="@container relative aspect-[4/5] overflow-hidden bg-surface">
        <div className="size-full transition-transform duration-700 ease-out group-hover:scale-[1.03]">
          <TripCover trip={trip} />
        </div>
        <div className="absolute top-3 left-3 flex max-w-[80%] flex-wrap gap-1.5">
          {/* 审核中 / 已隐藏的旅程只有成员和管理员能看到（如「我的旅程」） */}
          {trip.status === 'pending' && <CoverTag mark={dot('bg-amber-500')}>{tripStatuses.pending.label}</CoverTag>}
          {trip.status === 'hidden' && <CoverTag mark={dot('bg-brand-500')}>{tripStatuses.hidden.label}</CoverTag>}
          {trip.featured && <CoverTag mark={dot('bg-white/80')}>精选</CoverTag>}
          {trip.phase !== 'finished' && (
            <CoverTag mark={dot(trip.phase === 'ongoing' ? 'bg-brand-500' : 'border border-white/70 bg-transparent')}>{phase.label}</CoverTag>
          )}
          {trip.together && <CoverTag mark={dot('bg-pink-500')}>我们一起</CoverTag>}
          {trip.visibility !== 'public' && (
            <CoverTag
              compact
              mark={
                trip.visibility === 'private' ? <Lock className="size-2.5" strokeWidth={1.5} /> : <Link2 className="size-2.5" strokeWidth={1.5} />
              }
            >
              {trip.visibility === 'private' ? '私密' : '链接可见'}
            </CoverTag>
          )}
        </div>
      </div>

      <div className="@container pt-4">
        <h3 className="line-clamp-2 text-[1.15rem] leading-[1.28] font-normal text-ink-900 @[14rem]:text-[1.3rem] @[20rem]:text-[1.45rem]">{trip.title}</h3>
        {/* 说明文字对：地点（亮）+ 作者 / 天数 / 里程（灰） */}
        <p className="mt-2.5 truncate text-[13px] text-ink-900">{where}</p>
        <div className="caption mt-0.5 flex items-baseline gap-3">
          <span className="min-w-0 truncate">{facts.join(' · ')}</span>
          <span className="font-num ml-auto hidden shrink-0 items-center gap-3 text-[13px] text-ink-400 @[14rem]:flex">
            <span className="inline-flex items-center gap-1" title="喜欢">
              <Heart className="size-3" strokeWidth={1.5} />
              {fmtCount(trip.like_count)}
            </span>
            {trip.comment_count > 0 && (
              <span className="inline-flex items-center gap-1" title="评论">
                <MessageCircle className="size-3" strokeWidth={1.5} />
                {fmtCount(trip.comment_count)}
              </span>
            )}
          </span>
        </div>
      </div>
    </Link>
  )
}

// 列数按网格自身宽度（而不是窗口宽度）决定
// grid：列表页（手机两列，宽屏四列）；journal：首页（手机一列大图，宽屏三列，中间一列错落下沉）
const gridCls = {
  grid: 'grid grid-cols-2 gap-x-3 gap-y-12 @2xl:grid-cols-3 @2xl:gap-x-6 @2xl:gap-y-16 @6xl:grid-cols-4 @6xl:gap-x-8',
  journal:
    'grid grid-cols-1 gap-y-14 @xl:grid-cols-2 @xl:gap-x-6 @4xl:grid-cols-3 @4xl:gap-x-8 @4xl:gap-y-24 @4xl:pb-28 @4xl:[&>*:nth-child(3n+2)]:translate-y-28',
}

export function TripGrid({ trips, showAuthor, layout = 'grid' }: { trips: Trip[]; showAuthor?: boolean; layout?: keyof typeof gridCls }) {
  return (
    <div className="@container">
      <div className={gridCls[layout]}>
        {trips.map((t, i) => (
          <div key={t.id} className="animate-slide-up [animation-fill-mode:both]" style={{ animationDelay: `${Math.min(i % 12, 8) * 70}ms` }}>
            <TripCard trip={t} showAuthor={showAuthor} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function TripGridSkeleton({ n = 8, layout = 'grid' }: { n?: number; layout?: keyof typeof gridCls }) {
  return (
    <div className="@container" aria-busy="true" aria-label="加载中">
      <div className={gridCls[layout]}>
        {Array.from({ length: n }).map((_, i) => (
          <div key={i}>
            <div className="aspect-[4/5] animate-pulse bg-surface" />
            <div className="space-y-2.5 pt-4">
              <div className="h-5 w-4/5 animate-pulse rounded-sm bg-ink-100" />
              <div className="h-2.5 w-2/5 animate-pulse rounded-sm bg-ink-100" />
              <div className="h-2.5 w-1/3 animate-pulse rounded-sm bg-ink-100" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
