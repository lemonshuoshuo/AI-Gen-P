import type { MouseEvent, ReactNode } from 'react'
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
 * 印章式序号（与地图上的 markerHtml 一致）：已到达为象牙白实心，计划中为虚线空心，跳过为淡灰；
 * 右下角小圆点是分类色
 */
export function WaypointNumber({ w, label, className }: { w: Waypoint; label: string; className?: string }) {
  const skipped = w.status === 'skipped'
  const todo = w.planned && w.status === 'todo'
  return (
    <span
      className={cn(
        'font-num relative flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full px-1.5 text-[13px] leading-none font-medium transition-shadow duration-300',
        skipped
          ? 'border border-ink-300 text-ink-400'
          : todo
            ? 'border border-dashed border-ink-700 bg-paper text-ink-900'
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
          'inline-flex items-center gap-1 rounded-full border border-brand-300 px-2 py-0.5 text-xs tracking-wide whitespace-nowrap text-brand-700',
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
      <span className="font-num text-[13px]">{stats.checkin_count}</span>&nbsp;人打卡
      {rate != null && (
        <>
          &nbsp;·&nbsp;推荐率&nbsp;<span className="font-num text-[13px]">{rate}%</span>
        </>
      )}
    </span>
  )
}

const quietBtn =
  'inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-xs tracking-[0.04em] text-ink-500 transition-colors hover:bg-ink-900/[0.06] hover:text-ink-900 sm:h-8'

/** 地点的照片：第一张整栏大图（3:2），其余两两并排竖图；图片下方两行说明 */
function StopPhotos({ photos, onPhoto, name }: { photos: Photo[]; onPhoto?: (p: Photo) => void; name: string }) {
  const [first, ...rest] = photos
  const shown = rest.slice(0, 4)
  const more = rest.length - shown.length
  const open = (p: Photo) => (e: MouseEvent) => {
    e.stopPropagation()
    onPhoto?.(p)
  }
  return (
    // 手机上照片向左探出到序号栏，占满整个内容宽度
    <div className="mt-8 -ml-[3.25rem] space-y-3 md:mt-10 md:ml-0">
      <figure>
        <button
          type="button"
          onClick={open(first)}
          className="group/ph block aspect-[3/2] w-full overflow-hidden bg-ink-100"
          aria-label={first.caption || `查看「${name}」的照片`}
        >
          <img
            src={first.url}
            alt={first.caption}
            loading="lazy"
            className="size-full object-cover transition-transform duration-700 ease-out group-hover/ph:scale-[1.03]"
          />
        </button>
        {(first.caption || first.taken_at) && (
          <figcaption className="mt-3 text-[13px] leading-[1.45]">
            {first.caption && <span className="block text-ink-900">{first.caption}</span>}
            {first.taken_at && <span className="font-num block text-[14px] text-ink-500">{fmtTime(first.taken_at, 'YYYY.MM.DD HH:mm')}</span>}
          </figcaption>
        )}
      </figure>
      {shown.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {shown.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={open(p)}
              className="group/ph relative block aspect-[4/5] overflow-hidden bg-ink-100"
              aria-label={i === shown.length - 1 && more > 0 ? `还有 ${more} 张` : p.caption || '查看照片'}
            >
              <img
                src={p.thumb_url}
                alt={p.caption}
                loading="lazy"
                className="size-full object-cover transition-transform duration-700 ease-out group-hover/ph:scale-[1.03]"
              />
              {i === shown.length - 1 && more > 0 && (
                <span className="font-num absolute inset-0 flex items-center justify-center bg-black/55 text-3xl font-light text-white">
                  +{more}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 行程里的一站：像高端旅行指南一样排版——左栏印章序号，右栏小字元信息、大号宋体地名、灰色备注、整栏大图；
 * 项目间细线由外层列表负责
 */
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
  const name = w.name || '未命名地点'
  return (
    <div
      id={`wp-${w.id}`}
      onClick={onSelect}
      className="group/wp relative grid cursor-pointer scroll-mt-24 grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 py-10 md:grid-cols-[3.5rem_minmax(0,1fr)] md:gap-x-6 md:py-14"
    >
      {/* 选中：左侧一条象牙白细线 + 印章外圈 */}
      <span
        aria-hidden
        className={cn(
          'absolute top-10 bottom-10 -left-4 w-px bg-ink-900 transition-opacity duration-500 md:top-14 md:bottom-14 lg:-left-5',
          selected ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div className="flex items-start pt-1">
        <WaypointNumber
          w={w}
          label={label}
          className={cn(
            'h-8 min-w-8 text-sm',
            selected ? 'shadow-[0_0_0_4px_var(--color-paper),0_0_0_5px_var(--color-ink-900)]' : 'group-hover/wp:shadow-[0_0_0_4px_var(--color-paper),0_0_0_5px_var(--color-ink-300)]',
          )}
        />
      </div>
      <div className={cn('min-w-0', skipped && 'opacity-60')}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-500">
          <CategoryChip category={w.category} />
          {time && <span className="font-num text-[13px] tracking-wide">{time}</span>}
          {showStatus && w.planned && w.status !== 'todo' && (
            <span className={cn('tracking-wide', w.status === 'visited' ? 'text-emerald-700' : 'text-ink-400')}>{st.label}</span>
          )}
          {showStatus && w.planned && w.status === 'todo' && <span className="tracking-wide text-sky-600">{st.label}</span>}
          {showStatus && !w.planned && <span className="tracking-wide text-violet-600">计划外</span>}
          <VerdictBadge verdict={w.verdict} />
        </div>
        <h3
          className={cn(
            'mt-3 text-[28px] leading-[1.14] text-ink-900 md:mt-4 md:text-[40px]',
            skipped && 'line-through decoration-ink-300 decoration-1',
          )}
        >
          {/* 整行可点：名称做成按钮，键盘也能选中（回车 / 空格触发的点击冒泡到整行的 onSelect）；
              删除线不会延伸到按钮里，要单独加 */}
          {onSelect ? (
            <button type="button" aria-pressed={selected} className={cn('text-left', skipped && 'line-through decoration-ink-300 decoration-1')}>
              {name}
            </button>
          ) : (
            name
          )}
        </h3>
        {(address || w.cost > 0 || w.rating > 0 || w.place_stats) && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-500">
            {address && <span className="min-w-0 truncate">{address}</span>}
            {w.cost > 0 && (
              <span>
                人均 <span className="font-num text-[14px]">¥{w.cost}</span>
              </span>
            )}
            {w.rating > 0 && <Stars value={w.rating} size={12} />}
            <PlaceStatsBadge stats={w.place_stats} className="!py-0" />
          </div>
        )}
        {w.note && (
          <p
            className={cn(
              'mt-6 max-w-xl text-[15px] leading-[1.9] whitespace-pre-wrap',
              w.verdict === 'avoid' ? 'border-l border-brand-500 pl-4 text-ink-700' : 'text-ink-500',
            )}
          >
            {w.note}
          </p>
        )}
        {photos.length > 0 && <StopPhotos photos={photos} onPhoto={onPhoto} name={name} />}
        <div className="-ml-3 mt-5 flex flex-wrap items-center gap-0.5 md:mt-6" onClick={(e) => e.stopPropagation()}>
          <NavigateMenu
            variant="ghost"
            className="h-10 rounded-full px-3 text-xs sm:h-8"
            target={{ lng: w.lng, lat: w.lat, name: w.name || '目的地', address: w.address }}
          />
          {w.place_id && (
            <Link to={`/places/${w.place_id}`} className={quietBtn}>
              大家怎么说
              <ArrowUpRight className="size-3.5" strokeWidth={1.5} />
            </Link>
          )}
          {onComment && (
            <button type="button" onClick={onComment} className={quietBtn}>
              <MessageCircle className="size-3.5" strokeWidth={1.5} />
              评论
            </button>
          )}
          {actions}
        </div>
      </div>
    </div>
  )
}
