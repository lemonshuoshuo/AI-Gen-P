import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { isAvoided } from '@/api'
import type { Place } from '@/api/types'
import { pad2 } from '@/components/editorial'
import { cn } from '@/lib/cn'
import { formatDistance } from '@/lib/geo'
import { categoryOf, verdicts } from '@/lib/meta'

export function recommendRate(p: Pick<Place, 'recommend_count' | 'neutral_count' | 'avoid_count'>) {
  const total = p.recommend_count + p.neutral_count + p.avoid_count
  return total ? Math.round((p.recommend_count / total) * 100) : null
}

/** 推荐 / 一般 / 踩雷 的比例细条（玉青 / 赭黄 / 红，随主题），各段之间留 1px 底色；颜色用 var()，换主题不用重新渲染 */
export function VerdictBar({
  place,
  className,
}: {
  place: Pick<Place, 'recommend_count' | 'neutral_count' | 'avoid_count'>
  className?: string
}) {
  const total = place.recommend_count + place.neutral_count + place.avoid_count
  if (!total) return null
  const parts = [
    { n: place.recommend_count, c: verdicts.recommend.css },
    { n: place.neutral_count, c: verdicts.neutral.css },
    { n: place.avoid_count, c: verdicts.avoid.css },
  ].filter((p) => p.n > 0)
  return (
    <div className={cn('flex h-[3px] gap-px overflow-hidden rounded-full', className)} role="img" aria-label={`推荐 ${place.recommend_count}，一般 ${place.neutral_count}，踩雷 ${place.avoid_count}`}>
      {parts.map((p, i) => (
        <div key={i} style={{ width: `${(p.n / total) * 100}%`, background: p.c }} />
      ))}
    </div>
  )
}

/** 地点缩略图：只在有照片时出现（悬停缓慢放大，圆角随主题）；没有照片的行由序号和地名撑起，不放占位图标 */
function PlaceThumb({ place, className }: { place: Place; className?: string }) {
  if (!place.cover_url) return null
  return (
    <div className={cn('relative shrink-0 overflow-hidden rounded-image bg-surface', className)}>
      <img
        src={place.cover_thumb_url || place.cover_url}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.03]"
      />
    </div>
  )
}

/** 分类 · 区县（灰色小字） */
function placeMeta(place: Place) {
  return [categoryOf(place.category).label, place.district || place.city].filter(Boolean).join(' · ')
}

/**
 * 打卡地列表行（细线 + 排版：序号 + 地名（卡片标题字号）+ 灰色说明，放在 divide-y 的列表里）。
 * 序号、推荐率用区块标题的字号档（text-h2），地名用卡片标题（text-card），不再用超大细字。
 * compact：首页的排行；avoid：避雷榜，右侧显示踩雷人数
 */
export function PlaceRow({
  place,
  rank,
  variant = 'row',
}: {
  place: Place
  rank?: number
  variant?: 'row' | 'compact' | 'avoid'
}) {
  const rate = recommendRate(place)
  // 与服务端 MinAvoidWarn 一致：至少 2 人踩雷且踩雷多于推荐才提示慎去（一个人的评价不算）
  const avoid = isAvoided(place)

  if (variant !== 'row')
    return (
      <Link
        to={`/places/${place.id}`}
        className={cn(
          'group grid items-baseline gap-x-4 py-5 md:py-6',
          rank != null ? 'grid-cols-[2.25rem_minmax(0,1fr)_auto] md:grid-cols-[3rem_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]',
        )}
      >
        {rank != null && (
          <span className="font-num text-[length:var(--text-h2)] leading-none text-ink-400 transition-colors duration-300 group-hover:text-brand-600">
            {pad2(rank)}
          </span>
        )}
        <span className="min-w-0">
          <span className="font-display block truncate text-[length:var(--text-card)] leading-snug text-ink-900 [font-variant-numeric:lining-nums]">{place.name}</span>
          <span className="caption mt-1.5 block truncate">{placeMeta(place)}</span>
        </span>
        {variant === 'avoid' ? (
          <span className="shrink-0 text-right">
            <span className="font-num block text-[length:var(--text-h2)] leading-none text-red-600">{place.avoid_count}</span>
            <span className="caption mt-1.5 block">
              <span className="text-[10px] text-red-600">{verdicts.avoid.mark}</span> 人踩雷
            </span>
          </span>
        ) : (
          <span className="shrink-0 text-right">
            <span className="font-num block text-[length:var(--text-h2)] leading-none text-ink-900">{place.checkin_count}</span>
            <span className="caption mt-1.5 block">人打卡</span>
          </span>
        )}
      </Link>
    )

  return (
    <Link to={`/places/${place.id}`} className="group flex items-center gap-4 py-5 sm:gap-5 md:py-6">
      {rank != null && (
        <span
          className={cn(
            'font-num w-8 shrink-0 self-start pt-0.5 text-[length:var(--text-h2)] leading-none transition-colors duration-300 group-hover:text-brand-600 sm:w-11',
            rank <= 3 ? 'text-ink-700' : 'text-ink-400',
          )}
        >
          {pad2(rank)}
        </span>
      )}
      <PlaceThumb place={place} className="size-16 sm:size-20" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <h3 className="truncate text-[length:var(--text-card)] leading-snug font-normal text-ink-900 [font-variant-numeric:lining-nums]">{place.name}</h3>
          {avoid && (
            <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium tracking-wider text-red-700">
              {verdicts.avoid.mark} 慎去
            </span>
          )}
        </div>
        {/* 说明文字对：分类与区县（亮）+ 打卡、人均、评分、踩雷（灰） */}
        <p className="mt-1.5 truncate text-[13px] text-ink-900">{placeMeta(place)}</p>
        <p className="caption mt-0.5 flex flex-wrap gap-x-2.5">
          <span className="whitespace-nowrap">
            <span className="font-num">{place.checkin_count}</span> 人打卡
          </span>
          {place.avg_cost > 0 && (
            <span className="whitespace-nowrap">
              人均 <span className="font-num">¥{Math.round(place.avg_cost)}</span>
            </span>
          )}
          {place.rating_count > 0 && (
            <span className="whitespace-nowrap">
              <span className="font-num">{place.rating_avg.toFixed(1)}</span> 分
            </span>
          )}
          {place.avoid_count > 0 && (
            <span className={cn('whitespace-nowrap', avoid && 'text-red-600')}>
              <span className="text-[10px]">{verdicts.avoid.mark}</span> <span className="font-num">{place.avoid_count}</span> 踩雷
            </span>
          )}
          {place.distance_m != null && <span className="whitespace-nowrap">{formatDistance(place.distance_m)}</span>}
        </p>
      </div>
      <div className="w-16 shrink-0 text-right sm:w-24">
        {rate != null ? (
          <>
            <div className="font-num text-[length:var(--text-h2)] leading-none text-ink-900">
              {rate}
              <span className="ml-0.5 text-[0.55em] text-ink-500">%</span>
            </div>
            <div className="caption mt-1.5">推荐率</div>
            <VerdictBar place={place} className="mt-2.5" />
          </>
        ) : (
          <div className="caption">暂无评价</div>
        )}
      </div>
      <ArrowUpRight
        className="hidden size-4 shrink-0 self-start text-ink-400 transition-colors duration-300 group-hover:text-ink-900 md:block"
        strokeWidth={1.5}
      />
    </Link>
  )
}
