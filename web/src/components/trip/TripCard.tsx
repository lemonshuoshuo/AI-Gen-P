import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Eye, GitFork, Heart, Link2, Lock, MessageCircle } from 'lucide-react'
import type { TripCard as Trip } from '@/api/types'
import { Postmark, cityShort, mineralOf, pad2 } from '@/components/editorial'
import { Avatar } from '@/components/ui'
import { cn } from '@/lib/cn'
import { dateRange, dayjs, fmtCount } from '@/lib/format'
import { phases, tripStatuses } from '@/lib/meta'

// 纸张噪点：矿物色块上叠一层，像印刷品而不是屏幕纯色
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.09 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

/** 里程的短写法：邮戳和小字里用（0.9 / 12.3 / 1,280） */
export function kmShort(km: number) {
  if (km < 10) return km.toFixed(1)
  if (km < 100) return String(Math.round(km))
  return Math.round(km).toLocaleString()
}

type CoverTrip = Pick<Trip, 'id' | 'cover_url' | 'cover_thumb_url' | 'title' | 'cities'> &
  Partial<Pick<Trip, 'days' | 'distance_km' | 'start_date' | 'created_at'>>

/** 没有照片时的封面：矿物色纯色块 + 宋体城市名 + 邮戳（天数 / 里程） */
function MineralCover({ trip, className }: { trip: CoverTrip; className?: string }) {
  const m = mineralOf(trip.id)
  const cities = (trip.cities ?? []).map(cityShort)
  const lead = cities[0]
  const rest = cities.slice(1, 4)
  const days = trip.days ?? 0
  const km = trip.distance_km ?? 0
  const date = trip.start_date || trip.created_at
  const stamp =
    days > 0
      ? { value: pad2(days), unit: days > 1 ? 'DAYS' : 'DAY' }
      : km > 0
        ? { value: kmShort(km), unit: 'KM' }
        : { value: date ? dayjs(date).format('MM') : '—', unit: date ? dayjs(date).format('YYYY') : 'TRIP' }
  const ring = ['TripHub', km > 0 && days > 0 && `${kmShort(km)} km`, date && dayjs(date).format('YYYY.MM.DD')]
    .filter(Boolean)
    .join(' · ')
  const leadSize = !lead ? 0 : lead.length <= 2 ? 17 : lead.length === 3 ? 14.5 : lead.length === 4 ? 12 : lead.length <= 6 ? 9.5 : 7.5
  return (
    <div
      role="img"
      aria-label={trip.title}
      className={cn('@container relative size-full overflow-hidden select-none', className)}
      style={{ background: m.bg, color: m.fg }}
    >
      <span aria-hidden className="absolute inset-0 opacity-70 mix-blend-overlay" style={{ backgroundImage: GRAIN }} />
      <span className="absolute top-[4.5cqw] right-[4.5cqw] w-[31cqw] -rotate-[9deg]" style={{ color: m.stamp, opacity: 0.88 }}>
        <Postmark className="w-full" value={stamp.value} unit={stamp.unit} ring={`${ring} · `} />
      </span>
      <div className="absolute inset-x-[6.5cqw] bottom-[6cqw]">
        {lead ? (
          <>
            <div className="font-display leading-[1.04] tracking-[0.02em]" style={{ fontSize: `${leadSize}cqw` }}>
              {lead}
            </div>
            <div className="mt-[3cqw] flex items-center gap-[2.5cqw]">
              <span className="h-px w-[9cqw] shrink-0 bg-current opacity-60" />
              <span className="min-w-0 truncate text-[max(10px,3.6cqw)] tracking-[0.14em] opacity-80">
                {rest.length ? `${rest.join(' · ')}${cities.length > 4 ? ' 等' : ''}` : `No. ${String(trip.id).padStart(3, '0')}`}
              </span>
            </div>
          </>
        ) : (
          <div className="font-display line-clamp-3 text-[9cqw] leading-[1.25]">{trip.title}</div>
        )}
      </div>
    </div>
  )
}

/** 默认用缩略图（列表卡片）；full 用原图（详情页横幅）。没有照片时用矿物色封面 */
export function TripCover({ trip, className, full }: { trip: CoverTrip; className?: string; full?: boolean }) {
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
  return <MineralCover trip={trip} className={className} />
}

/** 封面左上角的细线小标签 */
function CoverTag({ children, mark, className }: { children: ReactNode; mark?: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-[3px] bg-white/92 px-1.5 py-[3px] text-[10.5px] leading-none tracking-[0.08em] text-ink-800 ring-1 ring-ink-900/10 backdrop-blur-sm',
        className,
      )}
    >
      {mark}
      {children}
    </span>
  )
}

const dot = (cls: string) => <span aria-hidden className={cn('size-[5px] shrink-0 rounded-full', cls)} />

export function TripCard({ trip, showAuthor = true }: { trip: Trip; showAuthor?: boolean }) {
  const phase = phases[trip.phase] ?? phases.finished
  const cities = trip.cities ?? []
  const where = cities.length
    ? `${cities.slice(0, 3).map(cityShort).join(' · ')}${cities.length > 3 ? ` 等${cities.length}城` : ''}`
    : '目的地待定'
  const km = trip.distance_km
  return (
    <Link to={`/trips/${trip.id}`} className="group block min-w-0 rounded-md focus-visible:outline-offset-4">
      <div className="relative aspect-[4/3] overflow-hidden rounded-[7px] bg-ink-100">
        <TripCover trip={trip} />
        {/* 1px 细边框：照片与纸面之间的分界 */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-ink-900/10 ring-inset transition-colors group-hover:ring-ink-900/30"
        />
        <div className="absolute top-2 left-2 flex max-w-[70%] flex-wrap gap-1">
          {/* 审核中 / 已隐藏的旅程只有成员和管理员能看到（如「我的旅程」） */}
          {trip.status === 'pending' && <CoverTag mark={dot('bg-amber-500')}>{tripStatuses.pending.label}</CoverTag>}
          {trip.status === 'hidden' && (
            <CoverTag mark={dot('bg-brand-500')} className="text-brand-700">
              {tripStatuses.hidden.label}
            </CoverTag>
          )}
          {trip.featured && (
            <CoverTag mark={dot('bg-brand-500')} className="text-brand-700">
              精选
            </CoverTag>
          )}
          {trip.phase !== 'finished' && (
            <CoverTag mark={dot(trip.phase === 'ongoing' ? 'bg-emerald-500' : 'border border-sky-600 bg-transparent')}>
              {phase.label}
            </CoverTag>
          )}
          {trip.together && <CoverTag mark={dot('bg-pink-500')}>我们一起</CoverTag>}
          {trip.visibility !== 'public' && (
            <CoverTag
              mark={
                trip.visibility === 'private' ? (
                  <Lock className="size-2.5" strokeWidth={1.75} />
                ) : (
                  <Link2 className="size-2.5" strokeWidth={1.75} />
                )
              }
            >
              {trip.visibility === 'private' ? '私密' : '链接可见'}
            </CoverTag>
          )}
        </div>
      </div>

      {/* 卡片宽度随网格变化（手机两列约 170px）：按卡片自身宽度决定显示多少信息，文字不折行 */}
      <div className="@container pt-3">
        <div className="flex items-baseline gap-2 text-[11.5px] tracking-[0.06em] text-ink-500">
          <span className="min-w-0 truncate">{where}</span>
          {(trip.days > 0 || km > 0) && (
            <span className="ml-auto shrink-0 whitespace-nowrap text-ink-400">
              {trip.days > 0 && (
                <>
                  <span className="font-num text-[12.5px] text-ink-700">{trip.days}</span> 天
                </>
              )}
              {trip.days > 0 && km > 0 && <span className="hidden @[12rem]:inline"> · </span>}
              {km > 0 && (
                <span className={cn(trip.days > 0 && 'hidden @[12rem]:inline')}>
                  <span className="font-num text-[12.5px] text-ink-700">{kmShort(km)}</span> km
                </span>
              )}
            </span>
          )}
        </div>
        <h3 className="mt-1.5 line-clamp-2 text-[15.5px] leading-[1.45] text-ink-900 transition-colors group-hover:text-brand-700 @[15rem]:text-[17px]">
          {trip.title}
        </h3>
        <div className="mt-3 flex items-center gap-2 border-t border-ink-200 pt-2.5 text-xs text-ink-500">
          {showAuthor ? (
            <>
              <Avatar user={trip.author} size={20} />
              <span className="min-w-0 truncate">{trip.author.nickname || trip.author.username}</span>
            </>
          ) : (
            <span className="font-num min-w-0 truncate text-ink-400">
              {trip.start_date ? dateRange(trip.start_date, trip.end_date) : `${trip.visited_count || trip.waypoint_count} 个打卡点`}
            </span>
          )}
          <span className="font-num ml-auto flex shrink-0 items-center gap-2.5 whitespace-nowrap text-ink-400">
            <span className="inline-flex items-center gap-1" title="喜欢">
              <Heart className="size-3.5" strokeWidth={1.5} />
              {fmtCount(trip.like_count)}
            </span>
            {trip.comment_count > 0 && (
              <span className={cn('items-center gap-1', showAuthor ? 'hidden @[14rem]:inline-flex' : 'inline-flex')} title="评论">
                <MessageCircle className="size-3.5" strokeWidth={1.5} />
                {fmtCount(trip.comment_count)}
              </span>
            )}
            {trip.fork_count > 0 && (
              <span className={cn('items-center gap-1', showAuthor ? 'hidden @[16rem]:inline-flex' : 'hidden @[13rem]:inline-flex')} title="引用">
                <GitFork className="size-3.5" strokeWidth={1.5} />
                {fmtCount(trip.fork_count)}
              </span>
            )}
            {!showAuthor && (
              <span className="inline-flex items-center gap-1" title="浏览">
                <Eye className="size-3.5" strokeWidth={1.5} />
                {fmtCount(trip.view_count)}
              </span>
            )}
          </span>
        </div>
      </div>
    </Link>
  )
}

const gridCls = 'grid grid-cols-2 gap-x-4 gap-y-9 sm:gap-x-6 sm:gap-y-11 @2xl:grid-cols-3 @5xl:grid-cols-4'

// 列数按网格自身宽度（而不是窗口宽度）决定：首页旁边有侧栏，同样的窗口宽度下可用宽度要窄得多
export function TripGrid({ trips, showAuthor }: { trips: Trip[]; showAuthor?: boolean }) {
  return (
    <div className="@container">
      <div className={gridCls}>
        {trips.map((t) => (
          <TripCard key={t.id} trip={t} showAuthor={showAuthor} />
        ))}
      </div>
    </div>
  )
}

export function TripGridSkeleton({ n = 8 }: { n?: number }) {
  return (
    <div className="@container" aria-busy="true" aria-label="加载中">
      <div className={gridCls}>
        {Array.from({ length: n }).map((_, i) => (
          <div key={i}>
            <div className="aspect-[4/3] animate-pulse rounded-[7px] bg-ink-100" />
            <div className="space-y-2.5 pt-3">
              <div className="h-2.5 w-2/5 animate-pulse rounded-sm bg-ink-100" />
              <div className="h-4 w-4/5 animate-pulse rounded-sm bg-ink-100" />
              <div className="h-px bg-ink-200" />
              <div className="h-2.5 w-1/3 animate-pulse rounded-sm bg-ink-100" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
