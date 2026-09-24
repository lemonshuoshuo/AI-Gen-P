import { Link } from 'react-router'
import { Eye, GitFork, Heart, Lock, Link2, MapPin, MessageCircle, Star } from 'lucide-react'
import type { TripCard as Trip } from '@/api/types'
import { Avatar, UserName } from '@/components/ui'
import { cn } from '@/lib/cn'
import { dateRange, fmtCount } from '@/lib/format'
import { formatKm } from '@/lib/geo'
import { phases } from '@/lib/meta'

const gradients = [
  'linear-gradient(135deg,#ff9a9e 0%,#fad0c4 100%)',
  'linear-gradient(135deg,#a18cd1 0%,#fbc2eb 100%)',
  'linear-gradient(135deg,#84fab0 0%,#8fd3f4 100%)',
  'linear-gradient(135deg,#fccb90 0%,#d57eeb 100%)',
  'linear-gradient(135deg,#4facfe 0%,#00f2fe 100%)',
  'linear-gradient(135deg,#43e97b 0%,#38f9d7 100%)',
  'linear-gradient(135deg,#fa709a 0%,#fee140 100%)',
]

export function TripCover({ trip, className }: { trip: Pick<Trip, 'id' | 'cover_url' | 'title' | 'cities'>; className?: string }) {
  if (trip.cover_url)
    return <img src={trip.cover_url} alt={trip.title} loading="lazy" className={cn('size-full object-cover', className)} />
  return (
    <div
      className={cn('flex size-full items-center justify-center p-4 text-center', className)}
      style={{ background: gradients[trip.id % gradients.length] }}
    >
      <span className="line-clamp-2 text-lg font-bold text-white drop-shadow">{trip.cities?.slice(0, 3).join(' · ') || trip.title}</span>
    </div>
  )
}

export function TripCard({ trip, showAuthor = true }: { trip: Trip; showAuthor?: boolean }) {
  const phase = phases[trip.phase] ?? phases.finished
  return (
    <Link
      to={`/trips/${trip.id}`}
      className="group block overflow-hidden rounded-2xl bg-white shadow-card transition hover:-translate-y-0.5 hover:shadow-float"
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-ink-100">
        <TripCover trip={trip} className="transition duration-500 group-hover:scale-105" />
        <div className="absolute inset-x-0 top-0 flex flex-wrap gap-1.5 p-2.5">
          {trip.featured && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-400 px-2 py-0.5 text-[11px] font-bold text-white shadow">
              <Star className="size-3 fill-white" />
              精选
            </span>
          )}
          {trip.phase !== 'finished' && (
            <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold shadow-sm', phase.cls)}>{phase.label}</span>
          )}
          {trip.together && (
            <span className="bg-love-gradient rounded-full px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm">💕 一起</span>
          )}
          {trip.visibility !== 'public' && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-ink-900/70 px-2 py-0.5 text-[11px] text-white">
              {trip.visibility === 'private' ? <Lock className="size-3" /> : <Link2 className="size-3" />}
              {trip.visibility === 'private' ? '私密' : '链接可见'}
            </span>
          )}
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 pt-8 pb-2 text-xs text-white/90">
          <div className="flex items-center gap-2">
            {trip.cities?.length > 0 && (
              <span className="inline-flex min-w-0 items-center gap-0.5 truncate">
                <MapPin className="size-3 shrink-0" />
                {trip.cities.slice(0, 3).join(' · ')}
                {trip.cities.length > 3 && ` 等${trip.cities.length}城`}
              </span>
            )}
            <span className="ml-auto shrink-0">
              {trip.days > 0 && `${trip.days}天`}
              {trip.distance_km > 0 && ` · ${formatKm(trip.distance_km)}`}
            </span>
          </div>
        </div>
      </div>
      <div className="p-3">
        <h3 className="line-clamp-2 min-h-[2.75rem] leading-snug font-semibold text-ink-900">{trip.title}</h3>
        <div className="mt-1 flex items-center gap-2 text-xs text-ink-400">
          {trip.start_date && <span>{dateRange(trip.start_date, trip.end_date)}</span>}
          <span>{trip.visited_count || trip.waypoint_count} 个打卡点</span>
        </div>
        <div className="mt-2.5 flex items-center gap-2 text-xs text-ink-500">
          {showAuthor && (
            <>
              <Avatar user={trip.author} size={22} />
              <UserName user={trip.author} className="max-w-[45%] text-xs" link={false} />
            </>
          )}
          <span className="ml-auto flex items-center gap-2.5">
            <span className="inline-flex items-center gap-0.5">
              <Heart className="size-3.5" />
              {fmtCount(trip.like_count)}
            </span>
            {trip.comment_count > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <MessageCircle className="size-3.5" />
                {fmtCount(trip.comment_count)}
              </span>
            )}
            {trip.fork_count > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <GitFork className="size-3.5" />
                {fmtCount(trip.fork_count)}
              </span>
            )}
            {!showAuthor && (
              <span className="inline-flex items-center gap-0.5">
                <Eye className="size-3.5" />
                {fmtCount(trip.view_count)}
              </span>
            )}
          </span>
        </div>
      </div>
    </Link>
  )
}

export function TripGrid({ trips, showAuthor }: { trips: Trip[]; showAuthor?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
      {trips.map((t) => (
        <TripCard key={t.id} trip={t} showAuthor={showAuthor} />
      ))}
    </div>
  )
}

export function TripGridSkeleton({ n = 8 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl bg-white shadow-card">
          <div className="aspect-[4/3] animate-pulse bg-ink-100" />
          <div className="space-y-2 p-3">
            <div className="h-4 w-4/5 animate-pulse rounded bg-ink-100" />
            <div className="h-3 w-2/5 animate-pulse rounded bg-ink-100" />
          </div>
        </div>
      ))}
    </div>
  )
}
