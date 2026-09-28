import { Link } from 'react-router'
import { isAvoided } from '@/api'
import type { Place } from '@/api/types'
import { pad2 } from '@/components/editorial'
import { CategoryChip } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDistance } from '@/lib/geo'
import { categoryOf, verdicts } from '@/lib/meta'

export function recommendRate(p: Pick<Place, 'recommend_count' | 'neutral_count' | 'avoid_count'>) {
  const total = p.recommend_count + p.neutral_count + p.avoid_count
  return total ? Math.round((p.recommend_count / total) * 100) : null
}

/** 推荐 / 一般 / 踩雷 的比例细条（玉青 / 赭黄 / 朱砂），各段之间留 1px 纸色 */
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
    <div className={cn('flex h-[3px] gap-px', className)} role="img" aria-label={`推荐 ${place.recommend_count}，一般 ${place.neutral_count}，踩雷 ${place.avoid_count}`}>
      {parts.map((p, i) => (
        <div key={i} style={{ width: `${(p.n / total) * 100}%`, background: p.c }} />
      ))}
    </div>
  )
}

/** 地点缩略图：有照片用照片，没有时是细线框里的分类图标 */
function PlaceThumb({ place, className }: { place: Place; className?: string }) {
  const c = categoryOf(place.category)
  const Icon = c.icon
  return (
    <div className={cn('relative shrink-0 overflow-hidden rounded-md bg-surface', className)}>
      {place.cover_url ? (
        <img src={place.cover_thumb_url || place.cover_url} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center" style={{ color: c.color, background: c.color + '0f' }}>
          <Icon className="size-[42%]" strokeWidth={1.25} />
        </div>
      )}
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-ink-900/10 ring-inset" />
    </div>
  )
}

/**
 * 打卡地列表行（杂志目录式：Cormorant 序号 + 宋体地名 + 细线分隔，放在 divide-y 的列表里）。
 * compact：首页侧栏的排行；avoid：避雷榜，右侧显示踩雷人数
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
  const where = place.district || place.city

  if (variant !== 'row')
    return (
      <Link to={`/places/${place.id}`} className="group flex items-baseline gap-3.5 py-3.5">
        {rank != null && (
          <span
            className={cn(
              'font-num w-8 shrink-0 text-[26px] leading-none font-light italic',
              rank <= 3 ? 'text-ink-900' : 'text-ink-300',
            )}
          >
            {pad2(rank)}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="font-display block truncate text-[15.5px] leading-snug text-ink-900 transition-colors group-hover:text-brand-700">
            {place.name}
          </span>
          <span className="mt-1 flex items-center gap-1.5 text-xs text-ink-400">
            <CategoryChip category={place.category} className="shrink-0" />
            {where && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{where}</span>
              </>
            )}
          </span>
        </span>
        {variant === 'avoid' ? (
          <span className="shrink-0 text-right">
            <span className="font-num block text-[17px] leading-none text-brand-600">
              <span className="mr-0.5 text-[11px]">{verdicts.avoid.mark}</span>
              {place.avoid_count}
            </span>
            <span className="mt-1 block text-[10.5px] tracking-wider text-ink-400">人踩雷</span>
          </span>
        ) : (
          <span className="shrink-0 text-right">
            <span className="font-num block text-[17px] leading-none text-ink-900">{place.checkin_count}</span>
            <span className="mt-1 block text-[10.5px] tracking-wider text-ink-400">人打卡</span>
          </span>
        )}
      </Link>
    )

  return (
    <Link to={`/places/${place.id}`} className="group flex items-center gap-3.5 py-5 sm:gap-5">
      {rank != null && (
        <span
          className={cn(
            'font-num w-8 shrink-0 self-start pt-1 text-[28px] leading-none font-light italic sm:w-12 sm:text-[38px]',
            rank <= 3 ? 'text-ink-900' : 'text-ink-300',
          )}
        >
          {pad2(rank)}
        </span>
      )}
      <PlaceThumb place={place} className="size-14 sm:size-[72px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-[16.5px] leading-snug text-ink-900 transition-colors group-hover:text-brand-700 sm:text-[19px]">
            {place.name}
          </h3>
          {avoid && (
            <span className="shrink-0 rounded-[3px] border border-brand-300 px-1 py-px text-[10.5px] tracking-wider text-brand-600">
              {verdicts.avoid.mark} 慎去
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-400">
          <CategoryChip category={place.category} className="whitespace-nowrap" />
          {where && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{where}</span>
            </>
          )}
          {place.avg_cost > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="whitespace-nowrap">
                人均 <span className="font-num text-ink-600">¥{Math.round(place.avg_cost)}</span>
              </span>
            </>
          )}
          {place.rating_count > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="whitespace-nowrap">
                <span className="font-num text-ink-600">{place.rating_avg.toFixed(1)}</span> 分
              </span>
            </>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-3 text-xs text-ink-500">
          <span className="whitespace-nowrap">
            <span className="font-num text-ink-800">{place.checkin_count}</span> 人打卡
          </span>
          {place.avoid_count > 0 && (
            <span className={cn('whitespace-nowrap', avoid ? 'text-brand-600' : 'text-ink-400')}>
              <span className="text-[10px]">{verdicts.avoid.mark}</span> <span className="font-num">{place.avoid_count}</span> 踩雷
            </span>
          )}
          {place.distance_m != null && <span className="ml-auto whitespace-nowrap text-ink-400">{formatDistance(place.distance_m)}</span>}
        </div>
      </div>
      <div className="w-14 shrink-0 text-right sm:w-20">
        {rate != null ? (
          <>
            <div className="font-num text-[22px] leading-none text-ink-900 sm:text-[28px]">
              {rate}
              <span className="text-[12px] sm:text-[14px]">%</span>
            </div>
            <div className="mt-1 text-[10.5px] tracking-wider text-ink-400">推荐率</div>
            <VerdictBar place={place} className="mt-2" />
          </>
        ) : (
          <div className="text-[11px] tracking-wider text-ink-300">暂无评价</div>
        )}
      </div>
    </Link>
  )
}
