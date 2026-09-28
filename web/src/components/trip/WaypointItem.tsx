import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { ArrowUpRight, MessageCircle } from 'lucide-react'
import { isAvoided } from '@/api'
import type { Photo, PlaceStats, Waypoint } from '@/api/types'
import { recommendRate } from '@/components/place/PlaceCard'
import { CategoryChip, Stars, VerdictBadge } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fmtTime } from '@/lib/format'
import { categoryOf, waypointStatus } from '@/lib/meta'
import { NavigateMenu } from './NavigateMenu'

/**
 * 印章式序号（与地图上的 markerHtml 一致）：已到达为墨色实心，计划中为虚线空心，跳过为淡灰；
 * 右下角小圆点是分类色
 */
export function WaypointNumber({ w, label, className }: { w: Waypoint; label: string; className?: string }) {
  const skipped = w.status === 'skipped'
  const todo = w.planned && w.status === 'todo'
  return (
    <span
      className={cn(
        'font-num relative flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full px-1.5 text-[13px] leading-none font-medium',
        skipped
          ? 'border border-ink-300 bg-ink-100 text-ink-400'
          : todo
            ? 'border-[1.5px] border-dashed border-ink-900 bg-surface text-ink-900'
            : 'bg-ink-900 text-paper',
        className,
      )}
    >
      {label}
      {!skipped && (
        <span
          aria-hidden
          className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-[1.5px] ring-paper"
          style={{ background: categoryOf(w.category).color }}
        />
      )}
    </span>
  )
}

/** 关联地点的社区统计：多人踩雷时朱砂提示，否则 2 人以上打卡时显示打卡人数和推荐率 */
export function PlaceStatsBadge({ stats, className }: { stats?: PlaceStats | null; className?: string }) {
  if (!stats) return null
  if (isAvoided(stats))
    return (
      <span
        title={`社区 ${stats.checkin_count} 人打卡，${stats.avoid_count} 人踩雷`}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm bg-brand-50 px-1.5 py-0.5 text-xs font-medium tracking-wide whitespace-nowrap text-brand-600 ring-1 ring-brand-200 ring-inset',
          className,
        )}
      >
        <span className="text-[10px] leading-none">✕</span>
        {stats.avoid_count} 人踩雷
      </span>
    )
  if (stats.checkin_count < 2) return null
  const rate = recommendRate(stats)
  return (
    <span
      title="社区公开打卡统计"
      className={cn(
        'inline-flex items-center py-0.5 text-xs tracking-wide whitespace-nowrap',
        rate != null && rate >= 60 ? 'text-emerald-700' : 'text-ink-500',
        className,
      )}
    >
      <span className="font-num">{stats.checkin_count}</span>&nbsp;人打卡
      {rate != null && (
        <>
          &nbsp;·&nbsp;推荐率&nbsp;<span className="font-num">{rate}%</span>
        </>
      )}
    </span>
  )
}

const quietBtn =
  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs tracking-wide text-ink-500 transition-colors hover:bg-ink-900/5 hover:text-ink-900'

/** 行程里的一站：像旅行指南一样排版（印章序号、宋体地名、灰色备注、项目间细线由外层列表负责） */
export function WaypointItem({
  w,
  label,
  photos = [],
  selected,
  onSelect,
  onPhoto,
  onComment,
  actions,
  showStatus,
}: {
  w: Waypoint
  label: string
  photos?: Photo[]
  selected?: boolean
  onSelect?: () => void
  onPhoto?: (p: Photo) => void
  onComment?: () => void
  actions?: ReactNode
  showStatus?: boolean
}) {
  const st = waypointStatus[w.status]
  const skipped = w.status === 'skipped'
  const address = [w.district, w.address].filter(Boolean).join(' · ') || w.city
  const time = w.arrived_at ? fmtTime(w.arrived_at) : w.planned_at ? `计划 ${fmtTime(w.planned_at)}` : ''
  return (
    <div
      id={`wp-${w.id}`}
      onClick={onSelect}
      className={cn(
        'relative -mx-3 flex cursor-pointer gap-3.5 rounded-lg px-3 py-4 transition-colors sm:gap-4',
        selected ? 'bg-surface shadow-card' : 'hover:bg-white/60',
      )}
    >
      {selected && <span aria-hidden className="absolute top-4 bottom-4 left-0 w-[2px] rounded-full bg-brand-500" />}
      <WaypointNumber w={w} label={label} className="mt-0.5" />
      <div className={cn('min-w-0 flex-1', skipped && 'opacity-60')}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className={cn('font-display text-[17px] leading-snug text-ink-900', skipped && 'line-through decoration-ink-300')}>
            {/* 整行可点：名称做成按钮，键盘也能选中（回车 / 空格触发的点击冒泡到整行的 onSelect）；
                删除线不会延伸到按钮里，要单独加 */}
            {onSelect ? (
              <button type="button" className={cn('text-left', skipped && 'line-through decoration-ink-300')}>
                {w.name || '未命名地点'}
              </button>
            ) : (
              w.name || '未命名地点'
            )}
          </h4>
          <VerdictBadge verdict={w.verdict} />
          {showStatus && w.planned && w.status !== 'todo' && (
            <span className={cn('text-xs tracking-wide', w.status === 'visited' ? 'text-emerald-700' : 'text-ink-400')}>
              {st.label}
            </span>
          )}
          {showStatus && w.planned && w.status === 'todo' && <span className="text-xs tracking-wide text-sky-600">{st.label}</span>}
          {showStatus && !w.planned && <span className="text-xs tracking-wide text-violet-600">计划外</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-400">
          <CategoryChip category={w.category} />
          {address && <span className="min-w-0 truncate">{address}</span>}
          {time && <span className="font-num tracking-wide">{time}</span>}
          {w.cost > 0 && (
            <span>
              人均 <span className="font-num">¥{w.cost}</span>
            </span>
          )}
          {w.rating > 0 && <Stars value={w.rating} size={11} />}
          <PlaceStatsBadge stats={w.place_stats} className="!py-0" />
        </div>
        {w.note && (
          <p
            className={cn(
              'mt-2.5 text-[14px] leading-7 whitespace-pre-wrap',
              w.verdict === 'avoid' ? 'border-l-2 border-brand-400 pl-3 text-ink-700' : 'text-ink-500',
            )}
          >
            {w.note}
          </p>
        )}
        {photos.length > 0 && (
          <div className="scrollbar-none mt-3 flex gap-1.5 overflow-x-auto">
            {photos.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onPhoto?.(p)
                }}
                className="size-[76px] shrink-0 overflow-hidden rounded-md bg-ink-100 ring-1 ring-ink-900/5 transition-opacity hover:opacity-90"
                aria-label={p.caption || '查看照片'}
              >
                <img src={p.thumb_url} alt={p.caption} loading="lazy" className="size-full object-cover" />
              </button>
            ))}
          </div>
        )}
        <div className="-ml-2 mt-2 flex flex-wrap items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <NavigateMenu variant="ghost" target={{ lng: w.lng, lat: w.lat, name: w.name || '目的地', address: w.address }} />
          {w.place_id && (
            <Link to={`/places/${w.place_id}`} className={quietBtn}>
              大家怎么说
              <ArrowUpRight className="size-3" strokeWidth={1.75} />
            </Link>
          )}
          {onComment && (
            <button type="button" onClick={onComment} className={quietBtn}>
              <MessageCircle className="size-3.5" strokeWidth={1.75} />
              评论
            </button>
          )}
          {actions}
        </div>
      </div>
    </div>
  )
}
