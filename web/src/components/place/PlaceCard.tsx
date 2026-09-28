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

/** 推荐 / 一般 / 踩雷 的比例细条（玉青 / 赭黄 / 朱砂），各段之间留 1px 底色 */
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
    { n: place.recommend_count, c: verdicts.recommend.color },
    { n: place.neutral_count, c: verdicts.neutral.color },
    { n: place.avoid_count, c: verdicts.avoid.color },
  ].filter((p) => p.n > 0)
  return (
    <div className={cn('flex h-px gap-px', className)} role="img" aria-label={`推荐 ${place.recommend_count}，一般 ${place.neutral_count}，踩雷 ${place.avoid_count}`}>
      {parts.map((p, i) => (
        <div key={i} style={{ width: `${(p.n / total) * 100}%`, background: p.c }} />
      ))}
    </div>
  )
}

/** 地点缩略图：有照片用照片（悬停缓慢放大），没有时是细线框里的分类图标 */
function PlaceThumb({ place, className }: { place: Place; className?: string }) {
  const c = categoryOf(place.category)
  const Icon = c.icon
  return (
    <div className={cn('relative shrink-0 overflow-hidden bg-surface', className)}>
      {place.cover_url ? (
        <img
          src={place.cover_thumb_url || place.cover_url}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.03]"
        />
      ) : (
        <div className="flex size-full items-center justify-center text-ink-400 ring-1 ring-ink-200 ring-inset">
          <Icon className="size-[34%]" strokeWidth={1} />
        </div>
      )}
    </div>
  )
}

/** 分类 · 区县（灰色小字） */
function placeMeta(place: Place) {
  return [categoryOf(place.category).label, place.district || place.city].filter(Boolean).join(' · ')
}

/**
 * 打卡地列表行（细线 + 排版：Cormorant 细字大序号 + 宋体地名 + 灰色说明，放在 divide-y 的列表里）。
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
          'group grid items-baseline gap-x-4 py-6 md:py-7',
          rank != null ? 'grid-cols-[3rem_minmax(0,1fr)_auto] md:grid-cols-[4.5rem_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]',
        )}
      >
        {rank != null && (
          <span className="font-num text-[2.5rem] leading-none font-light text-ink-400 transition-colors duration-300 group-hover:text-ink-900 md:text-[3.25rem]">
            {pad2(rank)}
          </span>
        )}
        <span className="min-w-0">
          <span className="font-display block truncate text-[1.5rem] leading-tight text-ink-900 md:text-[1.9rem]">{place.name}</span>
          <span className="caption mt-1.5 block truncate">{placeMeta(place)}</span>
        </span>
        {variant === 'avoid' ? (
          <span className="shrink-0 text-right">
            <span className="font-num block text-[1.9rem] leading-none font-light text-brand-600 md:text-[2.25rem]">{place.avoid_count}</span>
            <span className="caption mt-1.5 block">
              <span className="text-[10px] text-brand-600">{verdicts.avoid.mark}</span> 人踩雷
            </span>
          </span>
        ) : (
          <span className="shrink-0 text-right">
            <span className="font-num block text-[1.9rem] leading-none font-light text-ink-900 md:text-[2.25rem]">{place.checkin_count}</span>
            <span className="caption mt-1.5 block">人打卡</span>
          </span>
        )}
      </Link>
    )

  return (
    <Link to={`/places/${place.id}`} className="group flex items-center gap-4 py-6 sm:gap-6 md:py-7">
      {rank != null && (
        <span
          className={cn(
            'font-num w-9 shrink-0 self-start text-[2.25rem] leading-none font-light transition-colors duration-300 group-hover:text-ink-900 sm:w-16 sm:text-[3.5rem]',
            rank <= 3 ? 'text-ink-700' : 'text-ink-400',
          )}
        >
          {pad2(rank)}
        </span>
      )}
      <PlaceThumb place={place} className="size-16 sm:size-24" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <h3 className="truncate text-[1.35rem] leading-tight font-normal text-ink-900 sm:text-[1.85rem]">{place.name}</h3>
          {avoid && (
            <span className="shrink-0 rounded-full border border-brand-400/60 px-2 py-0.5 text-[10.5px] tracking-wider text-brand-600">
              {verdicts.avoid.mark} 慎去
            </span>
          )}
        </div>
        {/* 说明文字对：分类与区县（亮）+ 打卡、人均、评分、踩雷（灰） */}
        <p className="mt-2 truncate text-[13px] text-ink-900">{placeMeta(place)}</p>
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
            <span className={cn('whitespace-nowrap', avoid && 'text-brand-600')}>
              <span className="text-[10px]">{verdicts.avoid.mark}</span> <span className="font-num">{place.avoid_count}</span> 踩雷
            </span>
          )}
          {place.distance_m != null && <span className="whitespace-nowrap">{formatDistance(place.distance_m)}</span>}
        </p>
      </div>
      <div className="w-16 shrink-0 text-right sm:w-28">
        {rate != null ? (
          <>
            <div className="font-num text-[2rem] leading-none font-light text-ink-900 sm:text-[3rem]">
              {rate}
              <span className="text-[0.5em] text-ink-500">%</span>
            </div>
            <div className="caption mt-1.5">推荐率</div>
            <VerdictBar place={place} className="mt-2.5" />
          </>
        ) : (
          <div className="caption">暂无评价</div>
        )}
      </div>
      <ArrowUpRight
        className="hidden size-4 shrink-0 self-start text-ink-300 transition-colors duration-300 group-hover:text-ink-900 md:block"
        strokeWidth={1.25}
      />
    </Link>
  )
}
