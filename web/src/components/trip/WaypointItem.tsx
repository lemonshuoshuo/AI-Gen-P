import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Clock, MapPin, MessageCircle, Wallet } from 'lucide-react'
import type { Photo, Waypoint } from '@/api/types'
import { CategoryChip, Stars, VerdictBadge } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fmtTime } from '@/lib/format'
import { categoryOf, waypointStatus } from '@/lib/meta'
import { NavigateMenu } from './NavigateMenu'

export function WaypointNumber({ w, label, className }: { w: Waypoint; label: string; className?: string }) {
  const color = w.status === 'skipped' ? '#9895a5' : categoryOf(w.category).color
  const todo = w.planned && w.status === 'todo'
  return (
    <span
      className={cn('flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold', className)}
      style={
        todo
          ? { color, border: `2px dashed ${color}`, background: '#fff' }
          : { color: '#fff', background: color, boxShadow: `0 2px 6px ${color}55` }
      }
    >
      {label}
    </span>
  )
}

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
  const address = [w.district, w.address].filter(Boolean).join(' · ') || w.city
  return (
    <div
      onClick={onSelect}
      className={cn(
        'relative flex cursor-pointer gap-3 rounded-2xl p-3 transition',
        selected ? 'bg-brand-50 ring-2 ring-brand-200' : 'hover:bg-ink-50',
        w.status === 'skipped' && 'opacity-60',
      )}
    >
      <WaypointNumber w={w} label={label} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h4 className={cn('font-semibold', w.status === 'skipped' && 'line-through')}>{w.name || '未命名地点'}</h4>
          <CategoryChip category={w.category} />
          <VerdictBadge verdict={w.verdict} />
          {showStatus && w.planned && (
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', st.cls)}>{st.label}</span>
          )}
          {showStatus && !w.planned && (
            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">计划外</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-400">
          {address && (
            <span className="inline-flex min-w-0 items-center gap-0.5">
              <MapPin className="size-3 shrink-0" />
              <span className="truncate">{address}</span>
            </span>
          )}
          {w.rating > 0 && <Stars value={w.rating} size={12} />}
          {w.cost > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <Wallet className="size-3" />¥{w.cost}/人
            </span>
          )}
          {(w.arrived_at || w.planned_at) && (
            <span className="inline-flex items-center gap-0.5">
              <Clock className="size-3" />
              {w.arrived_at ? fmtTime(w.arrived_at) : `计划 ${fmtTime(w.planned_at)}`}
            </span>
          )}
        </div>
        {w.note && (
          <p
            className={cn(
              'mt-2 rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap',
              w.verdict === 'avoid' ? 'bg-red-50 text-red-900' : 'bg-ink-50 text-ink-700',
            )}
          >
            {w.note}
          </p>
        )}
        {photos.length > 0 && (
          <div className="scrollbar-none mt-2 flex gap-1.5 overflow-x-auto">
            {photos.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onPhoto?.(p)
                }}
                className="size-20 shrink-0 overflow-hidden rounded-xl bg-ink-100"
              >
                <img src={p.thumb_url} alt={p.caption} loading="lazy" className="size-full object-cover" />
              </button>
            ))}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <NavigateMenu target={{ lng: w.lng, lat: w.lat, name: w.name || '目的地', address: w.address }} />
          {w.place_id && (
            <Link
              to={`/places/${w.place_id}`}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-ink-100 px-2.5 text-xs font-medium text-ink-700 hover:bg-ink-200"
            >
              大家怎么说
            </Link>
          )}
          {onComment && (
            <button
              type="button"
              onClick={onComment}
              className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-ink-500 hover:bg-ink-100"
            >
              <MessageCircle className="size-3.5" />
              评论
            </button>
          )}
          {actions}
        </div>
      </div>
    </div>
  )
}
