import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  Bookmark,
  Box,
  EyeOff,
  Flag,
  GitCompareArrows,
  GitFork,
  Heart,
  Hourglass,
  Link2,
  Lock,
  Map as MapIcon,
  MoreHorizontal,
  Navigation,
  PenLine,
  Play,
  Radio,
  Route,
  Share2,
  Trash2,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, errorMessage, isNotFound, type DayLegs, type Photo, type TripDetail, type Waypoint } from '@/api'
import { rememberShareCode, rememberedShareCode } from '@/api/client'
import { CommentSection } from '@/components/comments/CommentSection'
import { Markdown } from '@/components/Markdown'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { useTripLegs } from '@/components/editor/RouteLegs'
import { PresenceBadge } from '@/components/editor/SyncUI'
import { describeUpdate, useRevisionPoll } from '@/components/editor/useTripSync'
import { FitOnce, RouteLines, RouteSegments } from '@/components/map/layers'
import { ReportDialog } from '@/components/report/ReportDialog'
import { CjkWords } from '@/components/trip/CjkWords'
import { PhotoViewer } from '@/components/trip/PhotoViewer'
import { Reveal } from '@/components/trip/Reveal'
import { ShareDialog, ShareSheet } from '@/components/trip/ShareDialog'
import { PlanMarkers, planMarkerItems } from '@/components/trip/PlanMarkers'
import { WaypointItem } from '@/components/trip/WaypointItem'
import { actualSegments, dayTone, groupPlan, isLodging, plannedSegments, stopLabels, type PlanGroups } from '@/components/trip/plan'
import {
  Avatar,
  Button,
  Empty,
  LoadError,
  Menu,
  MenuItem,
  Modal,
  PageLoader,
  Switch,
  Tag,
  buttonClass,
  confirmDialog,
} from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useRequireAuth } from '@/hooks/useRequireAuth'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { dateRange, dayjs, fmtCount, fmtMinutes, fmtTime, fromNow } from '@/lib/format'
import { formatDistance, formatKm } from '@/lib/geo'
import { phases, tripStatuses, verdicts } from '@/lib/meta'
import { AMAP_MAX_STOPS, amapMultiRoute } from '@/lib/nav'
import { allPoints, bySeq, photosByWaypoint, trackSegments, visitedInOrder } from '@/lib/trip'
import { useAuth } from '@/stores/auth'

/** refit：FitOnce 重新缩放（如轨迹加载完）后再飞一次，选中的地点不会被全程视野盖掉 */
function FlyToSelected({ w, refit }: { w: Waypoint | null; refit?: string }) {
  const map = useMap()
  useEffect(() => {
    if (map && w)
      map.flyTo({
        center: [w.lng, w.lat],
        zoom: Math.max(map.getZoom(), 15),
        duration: 900,
      })
  }, [map, w, refit])
  return null
}

/** 被邀请成为共同作者、尚未接受时（接受前可预览旅程）；只有作者能发邀请，所以邀请人就是作者 */
function InviteBanner({ trip, queryKey }: { trip: TripDetail; queryKey: string[] }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const m = useMutation({
    mutationFn: (accept: boolean) =>
      accept ? api.trips.acceptInvite(trip.id) : api.trips.declineInvite(trip.id).then(() => null),
    onSuccess: (detail) => {
      qc.invalidateQueries({ queryKey: ['me', 'invites'] })
      qc.invalidateQueries({ queryKey: ['notifications'] })
      if (detail) {
        qc.setQueryData(queryKey, detail)
        qc.invalidateQueries({ queryKey: ['my-trips'] })
        toast.success('已加入旅程，一起规划吧')
        return
      }
      toast.success('已拒绝邀请')
      // 拒绝后非公开的旅程就看不到了
      if (trip.visibility === 'public') qc.invalidateQueries({ queryKey })
      else nav('/me/trips')
    },
    onError: (e) => {
      toast.error(errorMessage(e))
      if (e instanceof ApiError && e.status === 404) qc.invalidateQueries({ queryKey })
    },
  })
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-y border-ink-200 py-4">
      <Users className="size-4 shrink-0 text-sky-600" strokeWidth={1.5} />
      <span className="min-w-0 flex-1 text-[14px] text-ink-700">
        <span className="font-display text-[17px] text-ink-900">{trip.author.nickname || trip.author.username}</span>{' '}
        邀请你一起编辑这段旅程
      </span>
      <div className="flex gap-2">
        <Button variant="ghost" loading={m.isPending && !m.variables} disabled={m.isPending} onClick={() => m.mutate(false)}>
          拒绝
        </Button>
        <Button loading={m.isPending && m.variables} disabled={m.isPending} onClick={() => m.mutate(true)}>
          接受
        </Button>
      </div>
    </div>
  )
}

/** 引用路线：原作者标记为「踩雷」的地点默认不复制（与服务端 include_avoid 缺省一致），可以选择一并复制 */
function ForkDialog({ trip, onClose }: { trip: TripDetail; onClose: () => void }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [includeAvoid, setIncludeAvoid] = useState(false)
  const [forking, setForking] = useState(false)
  // 服务端不复制跳过的点；旅行中未开启实时公开的旅程对非成员只返回计划（没有评价），这里为 0
  const avoidCount = trip.waypoints.filter((w) => w.verdict === 'avoid' && w.status !== 'skipped').length
  const close = () => {
    if (!forking) onClose()
  }
  const fork = async () => {
    setForking(true)
    try {
      const t = await api.trips.fork(trip.id, { include_avoid: includeAvoid })
      invalidateTripLists(qc)
      toast.success(avoidCount > 0 && !includeAvoid ? `已引用到你的旅程，已跳过 ${avoidCount} 个踩雷地点` : '已引用到你的旅程')
      nav(`/trips/${t.id}/edit`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setForking(false)
    }
  }
  return (
    <Modal
      open
      onClose={close}
      title="引用这条路线？"
      footer={
        <>
          <Button variant="ghost" disabled={forking} onClick={close}>
            取消
          </Button>
          <Button loading={forking} onClick={fork}>
            一键引用
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-500">
        会把这段旅程的打卡点复制成你自己的「计划路线」（私密），可以自由修改，出发时按图打卡。
      </p>
      {avoidCount > 0 && (
        <div className="mt-5 space-y-2 border-t border-ink-200 pt-4">
          <Switch
            checked={includeAvoid}
            onChange={setIncludeAvoid}
            label={<span className="text-left">{`同时复制 ${avoidCount} 个原作者标记为「踩雷」的地点`}</span>}
          />
          <p className="pl-12 text-xs leading-relaxed text-ink-400">默认不复制；复制时会在备注里注明原作者踩雷</p>
        </div>
      )}
    </Modal>
  )
}

/* ---------------- 排版积木 ---------------- */

const pad2 = (n: number) => String(n).padStart(2, '0')
/** 封面上的地名：去掉「市 / 地区 / 自治州 / 盟」等后缀，「台州市」→「台州」 */
function cityShort(name: string) {
  const m = name.match(/^(.{2,}?)(?:[^族]{0,6}族)*自治[州县旗]$/)
  if (m) return m[1]
  const s = name.replace(/(特别行政区|地区|市|盟)$/, '')
  return s.length >= 2 ? s : name
}

/** 说明文字对：第一行亮、第二行灰（onPhoto：压在照片上时用白色） */
function CaptionPair({ top, bottom, onPhoto, className }: { top: ReactNode; bottom?: ReactNode; onPhoto?: boolean; className?: string }) {
  return (
    <div className={cn('min-w-0 text-[13px] leading-[1.45]', className)}>
      <div className={cn('truncate', onPhoto ? 'text-white' : 'text-ink-900')}>{top}</div>
      {bottom && <div className={cn('truncate', onPhoto ? 'text-white/60' : 'text-ink-500')}>{bottom}</div>}
    </div>
  )
}

/** 区块头（Exemplar 的样式）：一条细线，下面一行小字——左侧标签 + 灰色计数，右侧补充；再往下是大标题 */
function SectionHead({
  eyebrow,
  count,
  aside,
  title,
  id,
}: {
  eyebrow: string
  count?: ReactNode
  aside?: ReactNode
  title?: ReactNode
  id?: string
}) {
  return (
    <header>
      <div className="flex items-baseline justify-between gap-4 border-t border-ink-200 pt-4">
        <p className="flex min-w-0 items-baseline gap-4">
          <span className="eyebrow !text-ink-900">{eyebrow}</span>
          {count != null && <span className="caption">{count}</span>}
        </p>
        {aside && <div className="caption shrink-0">{aside}</div>}
      </div>
      {title && (
        <h2 id={id} className="text-display-lg mt-10 text-ink-900 md:mt-14">
          {title}
        </h2>
      )}
    </header>
  )
}

/** 大号统计：细字 Cormorant 数字 + 小号单位与标签，之间用竖细线分隔 */
function BigStat({
  label,
  value,
  unit,
  sub,
  className,
}: {
  label: string
  value: ReactNode
  unit?: string
  sub?: ReactNode
  className?: string
}) {
  // 「3,103 公里」这类长数字缩小一号，避免手机上单位被挤到下一行
  const long = (typeof value === 'string' || typeof value === 'number') && String(value).length >= 5
  return (
    <div className={cn('min-w-0 border-ink-200 py-6 pr-3 md:py-8 md:pr-6', className)}>
      <p className="eyebrow">{label}</p>
      <div className="mt-4 flex flex-wrap items-baseline gap-x-2 md:mt-5">
        <span
          className={cn(
            'font-num leading-[0.85] font-light tracking-[-0.01em] whitespace-nowrap text-ink-900',
            long ? 'text-[2.25rem] sm:text-[2.75rem] lg:text-[3.25rem]' : 'text-[2.75rem] sm:text-[3.25rem] lg:text-[3.75rem]',
          )}
        >
          {value}
        </span>
        {unit && <span className="text-xs whitespace-nowrap text-ink-500">{unit}</span>}
        {sub}
      </div>
    </div>
  )
}

/** 邮戳：双圈 + 沿圈小字 + 中间天数；左侧四道波浪注销线 */
function CoverPostmark({ ring, value, unit, className }: { ring: string; value: string; unit: string; className?: string }) {
  const id = `pm${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const r = 38
  const circ = 2 * Math.PI * r
  return (
    <svg viewBox="-70 0 170 100" className={className} aria-hidden fill="none" stroke="currentColor">
      <defs>
        <path id={id} d={`M ${50 - r} 50 a ${r} ${r} 0 1 1 ${2 * r} 0 a ${r} ${r} 0 1 1 ${-2 * r} 0`} />
      </defs>
      {[36, 45, 54, 63].map((y) => (
        <path key={y} d={`M -68 ${y} q 7 -4.5 14 0 t 14 0 t 14 0 t 14 0`} strokeWidth={0.6} strokeLinecap="round" />
      ))}
      <circle cx={50} cy={50} r={48} strokeWidth={0.6} />
      <circle cx={50} cy={50} r={31} strokeWidth={0.4} />
      <text fill="currentColor" stroke="none" fontFamily="var(--font-num)" fontSize={6.2} letterSpacing={1} style={{ textTransform: 'uppercase' }}>
        <textPath href={`#${id}`} textLength={circ - 6} lengthAdjust="spacing">
          {ring}
        </textPath>
      </text>
      <text x={50} y={55} textAnchor="middle" fill="currentColor" stroke="none" fontFamily="var(--font-num)" fontSize={19} fontWeight={300}>
        {value}
      </text>
      <text x={50} y={65} textAnchor="middle" fill="currentColor" stroke="none" fontFamily="var(--font-sans)" fontSize={4.4} letterSpacing={1.2}>
        {unit}
      </text>
    </svg>
  )
}

/** 封面照片：加载完成后在 2.4 秒里从 1.06 缓缓落到原大 */
function CoverImage({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <img
      ref={(el) => {
        if (el?.complete && el.naturalWidth) setLoaded(true)
      }}
      src={src}
      alt={alt}
      onLoad={() => setLoaded(true)}
      className={cn(
        'absolute inset-0 size-full object-cover transition-[scale,opacity] duration-[2400ms] ease-out-expo',
        loaded ? 'scale-100 opacity-100' : 'scale-[1.06] opacity-0',
      )}
    />
  )
}

const phaseEyebrow = {
  planning: 'Route Plan',
  ongoing: 'On the Road',
  finished: 'Travelogue',
} as const

const dayDate = (start: string | null, day: number) =>
  start && day > 0
    ? dayjs(start)
        .add(day - 1, 'day')
        .format('M月D日')
    : ''
const dayWeek = (start: string | null, day: number) =>
  start && day > 0
    ? dayjs(start)
        .add(day - 1, 'day')
        .format('dddd')
    : ''

/* ---------------- 封面 ---------------- */
function Cover({ trip, onScroll }: { trip: TripDetail; onScroll: () => void }) {
  const phase = phases[trip.phase]
  const places = trip.cities.map(cityShort)
  const dates = dateRange(trip.start_date, trip.end_date)
  const who = [trip.author, ...trip.members].map((u) => u.nickname || u.username).join(' & ')
  const onPhoto = !!trip.cover_url
  const kicker = (
    <p className={cn('eyebrow animate-fade-in', onPhoto && '!text-white/75')}>
      {phaseEyebrow[trip.phase]} <span className="mx-1.5 opacity-60">·</span> {phase.label}
    </p>
  )
  const captions = (
    <div className={cn('grid grid-cols-2 gap-x-6 gap-y-5 border-t pt-5 md:grid-cols-4', onPhoto ? 'border-white/20' : 'border-ink-200')}>
      <CaptionPair
        onPhoto={onPhoto}
        top={places.length ? places.join(' · ') : '目的地待定'}
        bottom={trip.provinces.length ? trip.provinces.join(' · ') : phase.label}
      />
      <CaptionPair
        onPhoto={onPhoto}
        top={dates ? <span className="font-num text-[14px]">{dates}</span> : '日期待定'}
        bottom={trip.days ? `${trip.days} 天` : '随时出发'}
      />
      <CaptionPair onPhoto={onPhoto} top={who} bottom={trip.members.length ? '共同记录' : '作者'} className="hidden md:block" />
      <button
        type="button"
        onClick={onScroll}
        className={cn(
          'group hidden items-start justify-end gap-3 text-right md:flex',
          onPhoto ? 'text-white' : 'text-ink-900',
        )}
      >
        <CaptionPair onPhoto={onPhoto} top="行程" bottom={`${trip.waypoint_count} 个地点`} />
        <ArrowDown className="mt-0.5 size-4 transition-transform duration-500 group-hover:translate-y-1" strokeWidth={1.25} />
      </button>
    </div>
  )

  if (trip.cover_url)
    return (
      <section className="relative isolate flex h-[80svh] min-h-[500px] flex-col overflow-hidden bg-ink-100 md:h-[calc(92svh-3.75rem)] md:min-h-[620px]">
        <CoverImage src={trip.cover_url} alt={trip.title} />
        <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-black/5" />
        <div className="relative mx-auto flex w-full max-w-[90rem] flex-1 flex-col justify-end px-4 pb-7 md:px-8 md:pb-10">
          {kicker}
          <h1
            className="text-display-lg animate-slide-up mt-4 max-w-[16em] text-balance text-white [animation-fill-mode:backwards] md:mt-5"
            style={{ animationDelay: '120ms' }}
          >
            <CjkWords text={trip.title} />
          </h1>
          <div className="animate-fade-in mt-10 [animation-fill-mode:backwards] md:mt-16" style={{ animationDelay: '360ms' }}>
            {captions}
          </div>
        </div>
      </section>
    )

  // 没有照片：近黑 + 超大宋体地名 + 细线邮戳
  const first = places[0]
  const last = places.length > 1 ? places[places.length - 1] : null
  const via = places.slice(1, -1)
  // 按最长的地名定字号：两个字的城市在手机上也能撑满一行（约 165px），宽屏封顶
  const longest = Math.max(first?.length ?? 1, last?.length ?? 0)
  const gutter = 'var(--cover-gutter)'
  // 地名是装饰：比以前小很多，手机上不超过屏宽的约 1/4
  const nameSize = `min(${last ? '5.5rem' : '7rem'}, ${last ? '18vw' : '22vw'}, calc((100vw - ${gutter}) / ${longest} * 0.92))`
  const days = trip.days ? pad2(trip.days) : '—'
  const ring = `TripHub · ${dates || dayjs(trip.created_at).format('YYYY')} · ${phaseEyebrow[trip.phase]} · `
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto flex min-h-[calc(64svh-3.75rem)] max-w-[90rem] flex-col px-4 pt-8 pb-7 [--cover-gutter:2rem] md:min-h-[540px] md:px-8 md:pt-12 md:pb-10 md:[--cover-gutter:4rem]">
        <div className="flex items-start justify-between gap-6">
          {kicker}
          <CoverPostmark ring={ring} value={days} unit="DAYS" className="animate-fade-in -mt-1 w-36 shrink-0 text-ink-400 md:w-56" />
        </div>
        <div className="flex flex-1 flex-col justify-center py-4 md:py-10">
          {first ? (
            <div
              aria-hidden
              className="font-display animate-slide-up leading-[0.92] font-light tracking-[-0.02em] text-ink-900 [animation-fill-mode:backwards]"
              style={{ fontSize: nameSize }}
            >
              <p>{first}</p>
              {last && (
                <>
                  <div className="my-4 flex items-center gap-4 md:my-6 md:gap-6">
                    <span className="h-px flex-1 bg-ink-300" />
                    {via.length > 0 && (
                      <span className="eyebrow max-w-[60%] shrink truncate !tracking-[0.2em]">via {via.join(' · ')}</span>
                    )}
                    <span className="h-px w-10 bg-ink-300 md:w-28" />
                  </div>
                  <p className="text-right">{last}</p>
                </>
              )}
            </div>
          ) : (
            <p aria-hidden className="text-display-xl text-ink-300">
              {dayjs(trip.created_at).format('YYYY')}
            </p>
          )}
        </div>
        <h1
          className="text-display-lg animate-slide-up max-w-[13em] text-balance text-ink-900 [animation-fill-mode:backwards]"
          style={{ animationDelay: '140ms' }}
        >
          <CjkWords text={trip.title} />
        </h1>
        <div className="mt-8 md:mt-12">{captions}</div>
      </div>
    </section>
  )
}

/* ---------------- 行程 ---------------- */
/**
 * 按天排版的行程：每天的游玩点（每天各自编号，与地图上的标记一致），当晚的住宿排在当天最后（床的方章、不编号），
 * 出发前一晚的住宿在第 1 天最前；没有安排到某天的点单独成一节
 */
function Itinerary({
  trip,
  groups,
  labels,
  totals,
  selected,
  onSelect,
  onPhoto,
  onComment,
  renderActions,
}: {
  trip: TripDetail
  groups: PlanGroups
  labels: Map<number, string>
  totals: Map<number, DayLegs>
  selected: Waypoint | null
  onSelect: (w: Waypoint) => void
  onPhoto: (p: Photo) => void
  onComment: (w: Waypoint) => void
  renderActions?: (w: Waypoint) => ReactNode
}) {
  const byWp = photosByWaypoint(trip.photos)
  const hasPlan = trip.waypoints.some((w) => w.planned && !isLodging(w))
  const sections: { day: number; items: { w: Waypoint; caption?: string }[] }[] = []
  for (const d of groups.days) {
    const items: { w: Waypoint; caption?: string }[] = []
    const eve = d.day === 1 ? groups.lodging.get(0) : undefined
    if (eve) items.push({ w: eve, caption: '出发前一晚' })
    for (const w of d.stops) items.push({ w })
    if (d.end) items.push({ w: d.end, caption: `第 ${d.day} 晚 · 住宿` })
    for (const w of groups.extraLodging.filter((x) => x.day === d.day)) items.push({ w, caption: `第 ${d.day} 晚 · 住宿` })
    if (items.length) sections.push({ day: d.day, items })
  }
  if (groups.pool.length) sections.push({ day: 0, items: groups.pool.map((w) => ({ w })) })
  // 每天有照片的第一站用整栏横幅，之后的站用竖幅并左右交替
  const plates = new Map<number, 'wide' | 'left' | 'right'>()
  for (const { items } of sections) {
    let k = 0
    for (const { w } of items) {
      if (!byWp.get(w.id)?.length) continue
      plates.set(w.id, k === 0 ? 'wide' : k % 2 ? 'right' : 'left')
      k++
    }
  }
  if (!trip.waypoints.length)
    return (
      <Empty
        className="border-t border-ink-200"
        icon={<MapIcon className="size-9" strokeWidth={1.25} />}
        title="还没有打卡点"
        desc="路线规划好之后，行程会像旅行指南一样排在这里"
      />
    )
  return (
    <div className="space-y-16 md:space-y-24">
      {sections.map(({ day, items }) => {
        const t = totals.get(day)
        const stops = items.filter((i) => !isLodging(i.w)).length
        return (
          <section key={day} aria-label={day > 0 ? `第 ${day} 天` : '未分天'}>
            {(sections.length > 1 || day > 0) && (
              <Reveal as="header" className="flex items-end gap-4 border-b border-ink-200 pb-4 md:gap-6 md:pb-5">
                {day > 0 ? (
                  <>
                    <span className="font-num text-[3rem] leading-[0.74] font-light tracking-[-0.02em] text-ink-900 md:text-[4rem]">{pad2(day)}</span>
                    <div className="min-w-0 pb-0.5 text-[13px] leading-[1.45]">
                      <p className="truncate text-ink-900">
                        <span className={cn('mr-2 inline-block size-2 translate-y-[-1px] rounded-full', dayTone(day).bg)} aria-hidden />
                        <span className="eyebrow !text-ink-900">Day {pad2(day)}</span>
                        {trip.start_date && <span className="ml-3">{dayDate(trip.start_date, day)}</span>}
                      </p>
                      <p className="text-ink-500">
                        {trip.start_date ? dayWeek(trip.start_date, day) : `第 ${day} 天`}
                        {t && t.duration_s > 0 && (
                          <span className="whitespace-nowrap">
                            {' · '}路上{t.estimated ? '约' : ''} <span className="font-num text-[14px] text-ink-700">{fmtMinutes(t.duration_s)}</span>
                            {' · '}
                            <span className="font-num text-[14px]">{formatDistance(t.distance_m)}</span>
                          </span>
                        )}
                      </p>
                    </div>
                  </>
                ) : (
                  <span className="font-display text-[1.5rem] leading-none text-ink-700 md:text-[1.75rem]">
                    {trip.phase === 'planning' ? '还没安排到某天' : '未分天'}
                  </span>
                )}
                <span className="caption ml-auto shrink-0 pb-0.5">
                  <span className="font-num text-[14px]">{stops}</span> 个地点
                </span>
              </Reveal>
            )}
            <div className="divide-y divide-ink-200">
              {items.map(({ w, caption }) => (
                <WaypointItem
                  key={w.id}
                  w={w}
                  label={labels.get(w.id) ?? ''}
                  caption={caption}
                  photos={byWp.get(w.id)}
                  plate={plates.get(w.id)}
                  selected={selected?.id === w.id}
                  onSelect={() => onSelect(w)}
                  onPhoto={onPhoto}
                  onComment={() => onComment(w)}
                  actions={renderActions?.(w)}
                  showStatus={hasPlan && trip.phase !== 'planning' && !isLodging(w)}
                />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/** 链接式操作：小图标 + 带细下划线的文字，整块至少 40px 高方便手指点 */
const linkAction = 'group/la inline-flex h-10 items-center gap-2 text-[13px] text-ink-900'
const linkText = 'underline decoration-ink-300 underline-offset-4 transition-colors duration-300 group-hover/la:decoration-ink-900'

/** 地图上的胶囊按钮：玻璃底 + 细线；主操作为象牙白实心 */
const mapChip = 'inline-flex h-10 items-center gap-1.5 rounded-full px-4 text-[13px] tracking-[0.02em] transition-colors duration-300'
const mapChipGlass = 'glass border border-ink-900/15 text-ink-800 hover:border-ink-900/45 hover:text-ink-900'
const mapChipSolid = 'bg-ink-900 text-paper hover:bg-ink-700'

interface MapActionDef {
  key: string
  label: string
  icon: typeof Box
  to?: string
  href?: string
  title?: string
  solid?: boolean
  onClick?: () => void
}

/** 地图操作：站内链接或外部导航链接；text 给文字加下划线样式，arrow 在末尾加「→」 */
function MapAction({ a, className, text, arrow }: { a: MapActionDef; className: string; text?: string; arrow?: boolean }) {
  const Icon = a.icon
  const inner = (
    <>
      <Icon className={cn('size-4 shrink-0', text && 'size-3.5 text-ink-500')} strokeWidth={1.5} />
      <span className={text}>{a.label}</span>
      {arrow && <span className="text-ink-500">→</span>}
    </>
  )
  return a.href ? (
    <a href={a.href} target="_blank" rel="noreferrer" title={a.title} onClick={a.onClick} className={className}>
      {inner}
    </a>
  ) : (
    <Link to={a.to!} title={a.title} className={className}>
      {inner}
    </Link>
  )
}

/** 沿途影像：不对称网格（大图 7 栏 + 竖图 4 栏错落），图片下方两行说明 */
const galleryLayout = [
  'col-span-2 lg:col-span-7 aspect-[3/2]',
  'col-span-1 lg:col-span-4 lg:col-start-9 aspect-[4/5] lg:mt-40',
  'col-span-1 lg:col-span-5 lg:col-start-2 aspect-[4/5]',
  'col-span-2 lg:col-span-6 lg:col-start-7 aspect-[3/2] lg:mt-24',
]
/** 落单的最后一张：居中的竖幅（Exemplar 式的居中图版） */
const galleryLast = 'col-span-2 lg:col-span-6 lg:col-start-4 aspect-[4/5]'
const GALLERY_MAX = 12

// 同一路由内切换到另一段旅程（「引用自」链接、浏览器前进 / 后退）时整页重新挂载，
// 避免选中的打卡点、评论目标 / 草稿、照片查看器等状态串到另一段旅程
export default function TripDetailPage() {
  const { id, code } = useParams()
  return <TripDetailView key={id ?? `s:${code}`} />
}

function TripDetailView() {
  const { id, code } = useParams()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const qc = useQueryClient()
  const requireAuth = useRequireAuth()
  const key = ['trip', id ?? `s:${code}`]
  const {
    data: trip,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: key,
    queryFn: async () => {
      if (!code) return api.trips.get(id!)
      const t = await api.trips.byShare(code)
      rememberShareCode(t.id, code)
      return t
    },
  })
  const { data: track } = useQuery({
    queryKey: ['track', trip?.id],
    queryFn: () => api.trips.track(trip!.id),
    enabled: !!trip?.has_track,
  })
  // 行程改了（同行的人新加了地点、打了卡）：成员约 10 秒内、其他人约 30 秒内自动刷新，不用重新打开页面
  const myId = useAuth((s) => s.user?.id)
  const { editors } = useRevisionPoll(
    trip?.id,
    trip?.revision,
    (r) => {
      const before = qc.getQueryData<TripDetail>(key)
      void refetch().then((res) => {
        if (res.data?.has_track) void qc.invalidateQueries({ queryKey: ['track', res.data.id] })
        if (!res.data || !r.updated_by || r.updated_by.id === myId) return
        const text = describeUpdate(before, res.data, r.updated_by)
        if (text) toast(text, { id: `trip-sync-${res.data.id}` })
      })
    },
    { interval: trip?.can_edit ? 10_000 : 30_000 },
  )
  const [selected, setSelected] = useState<Waypoint | null>(null)
  const [viewer, setViewer] = useState<{ list: Photo[]; i: number } | null>(null)
  const [share, setShare] = useState(false)
  const [report, setReport] = useState(false)
  const [commentWp, setCommentWp] = useState<number | null>(null)
  const [shareWp, setShareWp] = useState<Waypoint | null>(null)
  const [forkOpen, setForkOpen] = useState(false)
  const mapBoxRef = useRef<HTMLDivElement>(null)

  // 打卡点分享链接（?wp=打卡点ID）：打开时选中该地点并滚动到行程里的位置（每个链接只处理一次，后台刷新不再跳）
  const wpParam = Number(params.get('wp')) || null
  const deepLinked = useRef('')
  useEffect(() => {
    if (!trip || !wpParam || deepLinked.current === `${trip.id}-${wpParam}`) return
    deepLinked.current = `${trip.id}-${wpParam}`
    const w = trip.waypoints.find((x) => x.id === wpParam)
    if (!w) return
    setSelected(w)
    document.getElementById(`wp-${w.id}`)?.scrollIntoView({ block: 'center' })
  }, [trip, wpParam])

  const patch = (p: Partial<TripDetail>) => qc.setQueryData<TripDetail>(key, (t) => (t ? { ...t, ...p } : t))

  const like = useMutation({
    mutationFn: () => api.trips.like(trip!.id, !trip!.liked),
    onSuccess: (r) => patch({ liked: r.liked, like_count: r.like_count }),
    onError: (e) => toast.error(errorMessage(e)),
  })
  const fav = useMutation({
    mutationFn: () => api.trips.favorite(trip!.id, !trip!.favorited),
    onSuccess: (r) => {
      patch({ favorited: r.favorited, fav_count: r.fav_count })
      qc.invalidateQueries({ queryKey: ['my-favorites'] })
      toast.success(r.favorited ? '已收藏' : '已取消收藏')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const segments = useMemo(() => trackSegments(track), [track])
  const sorted = useMemo(() => (trip ? [...trip.waypoints].sort(bySeq) : []), [trip])
  const fitPoints = useMemo(() => (trip ? allPoints(trip.waypoints, segments) : []), [trip, segments])
  // 按天规划：每天的路线（前一晚住宿 → 当天游玩点 → 当晚住宿）按实际道路画，每天一种颜色
  const groups = useMemo(() => groupPlan(trip?.waypoints ?? [], trip?.days ?? 0), [trip])
  const labels = useMemo(() => stopLabels(groups), [groups])
  const legs = useTripLegs(trip?.id, trip?.waypoints ?? [], trip?.travel_mode, { geometry: true })
  const totals = useMemo(() => new Map((legs.data?.days ?? []).map((d) => [d.day, d])), [legs.data])
  const routeSegs = useMemo(() => {
    if (!trip) return []
    const visited = visitedInOrder(trip.waypoints)
    const planned = plannedSegments(groups, legs.data?.legs, { icons: visited.length < 2 })
    if (visited.length < 2) return planned
    // 走过的路线为实线；计划路线（有计划时）淡淡地留作对照
    const plannedAny = trip.waypoints.some((w) => w.planned && !isLodging(w))
    return [...(plannedAny ? planned.map((s) => ({ ...s, dim: true, mode: undefined })) : []), ...actualSegments(visited, legs.data?.legs)]
  }, [trip, groups, legs.data])
  const markers = useMemo(() => planMarkerItems(groups, labels), [groups, labels])
  useDocumentTitle(trip?.title)

  if (isLoading) return <PageLoader />
  // 后台刷新失败（网络、服务器错误）时保留已加载的内容；404 说明旅程已删除或不再可见
  if (!trip || isNotFound(error))
    return (
      <LoadError
        className="min-h-[60vh]"
        error={error}
        notFoundTitle="旅程不存在或无权查看"
        onRetry={() => refetch()}
        back={
          <Button variant="outline" onClick={() => nav('/')}>
            回到首页
          </Button>
        }
      />
    )

  const remove = async () => {
    if (
      !(await confirmDialog({
        title: '删除这段旅程？',
        desc: '打卡点、照片、轨迹和评论都会被删除，无法恢复。',
        danger: true,
        okText: '删除',
      }))
    )
      return
    try {
      await api.trips.remove(trip.id)
      toast.success('已删除')
      // 列表直接丢掉重新加载，避免已删除的卡片闪一下；返回键也不再回到已删除的旅程
      qc.removeQueries({ queryKey: ['my-trips'] })
      invalidateTripLists(qc)
      await nav('/me/trips', { replace: true })
      // 离开后再移除详情缓存，否则当前页会重新请求并得到 404
      qc.removeQueries({ queryKey: key })
      qc.removeQueries({ queryKey: ['trip', String(trip.id)] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  // 住宿不是打卡点：不计入计划点数、完成度和路线一览
  const hasPlan = trip.waypoints.some((w) => w.planned && !isLodging(w))
  // 「我的收藏」只列出公开旅程和自己参与的旅程：通过分享链接看到的旅程收藏后找不到，不提供收藏（已收藏的仍可取消）
  const canFavorite = trip.favorited || trip.can_edit || (trip.visibility === 'public' && trip.status === 'normal')
  // 单个打卡点的分享链接：「链接可见」的旅程要带分享码，私密旅程不提供
  const knownCode = trip.share_code ?? code ?? rememberedShareCode(trip.id)
  const shareBase =
    trip.visibility === 'public' ? `/trips/${trip.id}` : trip.visibility === 'unlisted' && knownCode ? `/s/${knownCode}` : null
  const fitKey = `${trip.id}-${fitPoints.length}`
  const hasActual = trip.waypoints.some((w) => w.status === 'visited')
  // 「已打卡/计划」只数计划内的点（与计划 vs 实际页一致，不会超过 100%）；计划外的另记为 +N
  const showProgress = hasPlan && trip.phase !== 'planning'
  const plannedTotal = trip.waypoints.filter((w) => w.planned && !isLodging(w)).length
  const plannedVisited = trip.waypoints.filter((w) => w.planned && !isLodging(w) && w.status === 'visited').length
  const extraVisited = trip.waypoints.filter((w) => !w.planned && w.status === 'visited').length
  const remaining = sorted.filter((w) => w.status === 'todo' && !isLodging(w))
  // 高德一次最多规划 AMAP_MAX_STOPS 站：站数更多时导航接下来的这几站，并在按钮上说明，不再悄悄跳过中间的站
  const navStops = remaining.length ? remaining : sorted.filter((w) => !isLodging(w))
  const navTruncated = navStops.length > AMAP_MAX_STOPS
  const navAll = amapMultiRoute(navStops.map((w) => ({ lng: w.lng, lat: w.lat, name: w.name })))
  const navHint = navTruncated
    ? `高德一次最多规划 ${AMAP_MAX_STOPS} 站，这条路线${remaining.length ? '还剩' : '共'} ${navStops.length} 站` +
      (trip.can_edit && remaining.length ? '；到达并打卡后再点，可继续导航后面的站' : '')
    : undefined
  // 沿途影像只放行程里没出现过的照片（没关联地点的、或每站超出 5 张的），不再把同一批照片整幅重复一遍
  const byWpAll = photosByWaypoint(trip.photos)
  const shownInItinerary = new Set<number>()
  for (const w of trip.waypoints) for (const p of (byWpAll.get(w.id) ?? []).slice(0, 5)) shownInItinerary.add(p.id)
  const gallery = trip.photos.filter((p) => !shownInItinerary.has(p.id))
  const wpById = new Map(trip.waypoints.map((w) => [w.id, w]))
  const km = formatKm(trip.distance_km)
  const canPlanPreview = plannedTotal >= 2
  const authors = [trip.author, ...trip.members]
  // 地图的操作：3D 回放 / 3D 预览 / 整条路线导航（宽屏压在地图上，窄屏放在地图下方）
  const mapActions: MapActionDef[] = [
    ...(hasActual ? [{ key: 'replay', to: `/trips/${trip.id}/replay`, icon: Box, label: '3D 回放', solid: true }] : []),
    ...(canPlanPreview
      ? [{ key: 'plan', to: `/trips/${trip.id}/replay?plan=1`, icon: Box, label: '3D 预览', title: '沿计划路线 3D 飞行预览', solid: !hasActual }]
      : []),
    ...(sorted.length > 1
      ? [
          {
            key: 'nav',
            href: navAll,
            icon: Navigation,
            label: navTruncated ? `导航${remaining.length ? '接下来' : '前'} ${AMAP_MAX_STOPS} 站` : '整条路线导航',
            title: navHint,
            onClick: () => navHint && toast(navHint),
          },
        ]
      : []),
  ]
  const legend = hasPlan || hasActual || segments.length > 0
  // 一眼看完的路线：地点名按顺序连起来
  const routeNames = sorted.filter((w) => !isLodging(w)).map((w) => w.name || '未命名地点')
  const ROUTE_MAX = 12

  // 查看器里始终可以翻看全部照片
  const openPhoto = (p: Photo, list = trip.photos) =>
    setViewer({
      list,
      i: Math.max(
        0,
        list.findIndex((x) => x.id === p.id),
      ),
    })

  // 窄屏时地图在行程上方且不吸顶：从列表选中地点时把地图滚回视野；宽屏地图常驻可见则不滚动
  const selectAndShow = (w: Waypoint) => {
    setSelected(w)
    const el = mapBoxRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 60) // 60px = 吸顶 header (h-15)
    if (visible < r.height / 2) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const scrollToItinerary = () => document.getElementById('itinerary')?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <article className="pb-16 md:pb-24">
      <Cover trip={trip} onScroll={scrollToItinerary} />

      {/* 数字 + 简介 */}
      <div className="mx-auto max-w-[90rem] px-4 md:px-8">
        <Reveal className="grid grid-cols-2 border-b border-ink-200 md:grid-cols-4">
          <BigStat label="Days · 天数" value={trip.days || '–'} unit={trip.days ? '天' : undefined} />
          <BigStat
            className="border-l pl-4 md:pl-8"
            label={showProgress ? 'Checked · 已打卡/计划' : 'Stops · 地点'}
            value={
              showProgress ? (
                <>
                  {plannedVisited}
                  <span className="mx-0.5 text-ink-300">/</span>
                  {plannedTotal}
                </>
              ) : (
                trip.waypoint_count
              )
            }
            sub={
              showProgress && extraVisited > 0 ? (
                <span className="font-num text-sm text-violet-600" title="计划外的打卡">
                  +{extraVisited}
                </span>
              ) : undefined
            }
          />
          <BigStat
            className="border-t md:border-t-0 md:border-l md:pl-8"
            label="Distance · 里程"
            value={km.split(' ')[0]}
            unit={km.split(' ')[1]}
          />
          <BigStat className="border-t border-l pl-4 md:border-t-0 md:pl-8" label="Cities · 城市" value={trip.cities.length} unit="座" />
        </Reveal>

        <div className="grid gap-y-14 py-14 md:py-24 lg:grid-cols-12 lg:gap-x-8">
          {/* 左：同行的人与出处 */}
          <Reveal className="lg:col-span-4">
            <p className="eyebrow">Travellers · 同行</p>
            {/* 头像叠放 + 宋体名字：不用等级、管理员这类论坛徽章 */}
            <div className="mt-7 flex -space-x-3">
              {authors.map((u) => (
                <Link key={u.id} to={`/u/${u.username}`} className="rounded-full transition-transform duration-500 hover:-translate-y-0.5">
                  <Avatar user={u} size={52} ring />
                </Link>
              ))}
            </div>
            <p className="font-display mt-6 text-[22px] leading-[1.35] text-ink-900 md:text-[26px]">
              {authors.map((u, i) => (
                <span key={u.id}>
                  {i > 0 && <span className="mx-2 text-ink-400">&amp;</span>}
                  <Link
                    to={`/u/${u.username}`}
                    className="underline decoration-transparent underline-offset-[6px] transition-colors hover:decoration-ink-300"
                  >
                    {u.nickname || u.username}
                  </Link>
                </span>
              ))}
            </p>
            <p className="caption mt-2">
              {trip.members.length ? '共同记录' : '作者'}
              <span className="mx-1.5 text-ink-300">·</span>
              {trip.published_at ? `发布于 ${fromNow(trip.published_at)}` : `更新于 ${fromNow(trip.updated_at)}`}
              <span className="mx-1.5 text-ink-300">·</span>
              <span className="font-num text-[14px]">{fmtCount(trip.view_count)}</span> 浏览
            </p>
            {(trip.featured || trip.together || trip.status !== 'normal' || (trip.can_edit && trip.visibility !== 'public')) && (
              <div className="mt-6 flex flex-wrap items-center gap-2">
                {trip.featured && <Tag className="border-brand-300 text-brand-600">精选</Tag>}
                {trip.together && (
                  <Tag className="gap-1.5">
                    <Heart className="size-3 fill-pink-500 text-pink-500" strokeWidth={1.5} />
                    我们一起
                  </Tag>
                )}
                {trip.status === 'hidden' && <Tag className="border-brand-300 text-brand-600">已被管理员隐藏</Tag>}
                {trip.status === 'pending' && <Tag className="border-amber-300 text-amber-700">{tripStatuses.pending.label}</Tag>}
                {trip.can_edit && trip.visibility !== 'public' && (
                  <button
                    type="button"
                    onClick={() => setShare(true)}
                    className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2 py-0.5 text-xs tracking-wide text-ink-600 transition-colors hover:border-ink-600 hover:text-ink-900"
                    title="设置分享"
                  >
                    {trip.visibility === 'private' ? (
                      <Lock className="size-3" strokeWidth={1.5} />
                    ) : (
                      <Link2 className="size-3" strokeWidth={1.5} />
                    )}
                    {trip.visibility === 'private' ? '私密' : '链接可见'}
                  </button>
                )}
              </div>
            )}
            {trip.forked_from && (
              <p className="caption mt-5">
                <GitFork className="mr-1.5 inline size-3.5 align-[-2px]" strokeWidth={1.5} />
                引用自{' '}
                <Link
                  to={`/trips/${trip.forked_from.id}`}
                  className="font-display text-[15px] text-ink-900 underline decoration-ink-300 underline-offset-4 transition-colors hover:decoration-ink-900"
                >
                  {trip.forked_from.title}
                </Link>
                （{trip.forked_from.author.nickname || trip.forked_from.author.username}）
              </p>
            )}
          </Reveal>

          {/* 右：简介、路线一览、操作 */}
          <Reveal className="min-w-0 lg:col-span-7 lg:col-start-6" delay={80}>
            {trip.summary && (
              <p className="font-display mb-10 text-[24px] leading-[1.55] text-ink-800 md:text-[32px] md:leading-[1.45]">
                {trip.summary}
              </p>
            )}
            {routeNames.length > 1 && (
              <div className="mb-10">
                <p className="eyebrow">Route · 路线一览</p>
                <p className="font-display mt-4 text-[19px] leading-[1.75] text-ink-600 md:text-[22px]">
                  {routeNames.slice(0, ROUTE_MAX).map((n, i) => (
                    <span key={i}>
                      {i > 0 && <span className="mx-2 font-sans text-[0.7em] text-ink-400 md:mx-3">—</span>}
                      <span
                        className={cn(
                          'whitespace-nowrap',
                          (i === 0 || i === Math.min(routeNames.length, ROUTE_MAX) - 1) && 'text-ink-900',
                        )}
                      >
                        {n}
                      </span>
                    </span>
                  ))}
                  {routeNames.length > ROUTE_MAX && <span className="ml-3 font-sans text-sm text-ink-400">等 {routeNames.length} 处</span>}
                </p>
              </div>
            )}
            {trip.tags.length > 0 && (
              <div className="mb-8 flex flex-wrap gap-x-4 gap-y-1">
                {trip.tags.map((t) => (
                  <Link
                    key={t}
                    to={`/search?tag=${encodeURIComponent(t)}`}
                    className="text-[13px] tracking-wide text-ink-500 transition-colors hover:text-ink-900"
                  >
                    #{t}
                  </Link>
                ))}
              </div>
            )}

            {trip.invite_pending && (
              <div className="mb-8">
                <InviteBanner trip={trip} queryKey={key} />
              </div>
            )}
            {trip.can_edit && trip.status === 'pending' && (
              <p className="mb-8 flex items-start gap-3 border-l border-amber-500 py-1 pl-4 text-[13.5px] leading-relaxed text-ink-700">
                <Hourglass className="mt-0.5 size-4 shrink-0 text-amber-600" strokeWidth={1.5} />
                <span>公开申请审核中：管理员通过后才会出现在发现广场，在此之前只有你和共同作者能看到。</span>
              </p>
            )}

            {/* 操作栏：链接式的文字操作（下划线 + 等高数字），只保留「分享」一个细线胶囊 */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-200 pt-4 sm:gap-x-6">
              <button
                type="button"
                aria-pressed={trip.liked}
                className={linkAction}
                onClick={() => requireAuth(() => like.mutate())}
              >
                <Heart className={cn('size-3.5', trip.liked ? 'fill-brand-500 text-brand-500' : 'text-ink-500')} strokeWidth={1.5} />
                <span className={linkText}>{trip.liked ? '已赞' : '点赞'}</span>
                {trip.like_count > 0 && <span className="font-num text-[15px] text-ink-500">{trip.like_count}</span>}
              </button>
              {canFavorite && (
                <button
                  type="button"
                  aria-pressed={trip.favorited}
                  className={linkAction}
                  onClick={() => requireAuth(() => fav.mutate())}
                >
                  <Bookmark className={cn('size-3.5', trip.favorited ? 'fill-ink-900 text-ink-900' : 'text-ink-500')} strokeWidth={1.5} />
                  <span className={linkText}>{trip.favorited ? '已收藏' : '收藏'}</span>
                </button>
              )}
              {!trip.is_owner && trip.waypoints.length > 0 && (
                <button type="button" className={linkAction} onClick={() => requireAuth(() => setForkOpen(true))}>
                  <GitFork className="size-3.5 text-ink-500" strokeWidth={1.5} />
                  <span className={linkText}>引用路线</span>
                </button>
              )}
              {hasPlan && hasActual && (
                <Link to={`/trips/${trip.id}/compare`} className={linkAction}>
                  <GitCompareArrows className="size-3.5 text-ink-500" strokeWidth={1.5} />
                  <span className={linkText}>计划 vs 实际</span>
                </Link>
              )}
              {/* 手机上「分享」也是文字链接，和其他操作排在同一行，不单独换行成一个胶囊 */}
              <button type="button" className={cn(linkAction, 'sm:hidden')} onClick={() => setShare(true)}>
                <Share2 className="size-3.5 text-ink-500" strokeWidth={1.5} />
                <span className={linkText}>分享</span>
              </button>
              <div className="flex items-center gap-1 sm:ml-auto">
                <Button
                  variant="outline"
                  className="hidden sm:inline-flex"
                  icon={<Share2 className="size-4" strokeWidth={1.5} />}
                  onClick={() => setShare(true)}
                >
                  分享
                </Button>
                <Menu
                  trigger={(t, open) => (
                    <Button variant="ghost" className="w-10 px-0" onClick={t} aria-label="更多" aria-expanded={open}>
                      <MoreHorizontal className="size-4" strokeWidth={1.5} />
                    </Button>
                  )}
                >
                  {(close) => (
                    <>
                      {!trip.is_owner && (
                        <MenuItem icon={<Flag className="size-4" strokeWidth={1.5} />} onClick={() => (close(), requireAuth(() => setReport(true)))}>
                          举报
                        </MenuItem>
                      )}
                      {trip.is_owner && (
                        <MenuItem icon={<Trash2 className="size-4" strokeWidth={1.5} />} danger onClick={() => (close(), remove())}>
                          删除旅程
                        </MenuItem>
                      )}
                    </>
                  )}
                </Menu>
              </div>
            </div>

            {trip.can_edit && (
              <div className="mt-10 border-t border-ink-200 pt-6">
                <div className="flex items-baseline gap-4">
                  <p className="eyebrow !text-ink-900">Your Trip · 你的旅程</p>
                  <span className="caption">{phases[trip.phase].label}</span>
                </div>
                {/* 同行的人正在编辑：先说一声，免得两个人同时改 */}
                {editors.some((e) => e.user.id !== myId) && (
                  <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <PresenceBadge editors={editors.filter((e) => e.user.id !== myId)} />
                    <span className="text-[12.5px] text-ink-500">现在去编辑也可以，保存时会先看到双方各改了什么</span>
                  </div>
                )}
                <p className="mt-3 max-w-xl text-[14px] leading-[1.8] text-ink-500">
                  {trip.phase === 'planning' && '规划好路线后就可以出发，路上一键打卡、实时记录轨迹。'}
                  {trip.phase === 'ongoing' && '旅行进行中：到了就打卡，还能推荐下一站。'}
                  {trip.phase === 'finished' && '旅程已结束：补充评价、写写游记，留给之后的自己和别人。'}
                </p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {trip.phase !== 'finished' && (
                    <Link to={`/trips/${trip.id}/go`} className={buttonClass({ variant: 'accent' })}>
                      {trip.phase === 'ongoing' ? (
                        <Route className="size-4" strokeWidth={1.5} />
                      ) : (
                        <Play className="size-4" strokeWidth={1.5} />
                      )}
                      {trip.phase === 'ongoing' ? '继续旅行' : '出发，按路线走'}
                    </Link>
                  )}
                  <Link
                    to={`/trips/${trip.id}/edit`}
                    className={buttonClass({ variant: trip.phase === 'finished' ? 'primary' : 'outline' })}
                  >
                    <PenLine className="size-4" strokeWidth={1.5} />
                    编辑{trip.phase === 'planning' ? '路线' : '旅程'}
                  </Link>
                  {canPlanPreview && (
                    <Link to={`/trips/${trip.id}/replay?plan=1`} className={buttonClass({ variant: 'ghost' })}>
                      <Box className="size-4" strokeWidth={1.5} />
                      3D 预览
                    </Link>
                  )}
                </div>
                {/* 旅行中其他人能看到什么（live_share 只有作者能改，在编辑页「信息」里） */}
                {trip.is_owner && trip.phase === 'ongoing' && trip.visibility !== 'private' && (
                  <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-ink-500">
                    {trip.live_share ? (
                      <Radio className="mt-px size-3.5 shrink-0 text-emerald-600" strokeWidth={1.5} />
                    ) : (
                      <EyeOff className="mt-px size-3.5 shrink-0" strokeWidth={1.5} />
                    )}
                    <span>
                      {trip.live_share
                        ? '旅行中：已开启实时公开位置，能看到这段旅程的人可以实时看到你们的打卡、照片和轨迹'
                        : '旅行中：其他人只能看到计划路线，打卡、照片和轨迹在旅程结束后才公开'}
                      <Link
                        to={`/trips/${trip.id}/edit?panel=info`}
                        className="ml-2 text-ink-900 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-900"
                      >
                        修改
                      </Link>
                    </span>
                  </p>
                )}
              </div>
            )}
          </Reveal>
        </div>
      </div>

      {/* 行程 + 地图：窄屏地图在行程上方（整幅出血）；宽屏地图在右侧吸顶 */}
      <div className="mx-auto max-w-[90rem] lg:grid lg:grid-cols-12 lg:gap-x-8 lg:px-8">
        <div ref={mapBoxRef} className="scroll-mt-15 lg:col-span-5 lg:col-start-8 lg:row-start-1">
          <div className="lg:sticky lg:top-[5.25rem]">
            <div className="relative overflow-hidden border-y border-ink-200 lg:rounded-sm lg:border-0 lg:ring-1 lg:ring-ink-200">
              <BaseMap
                className="h-[58svh] lg:h-[calc(100dvh-7rem)]"
                kindSwitcher
                locate
                overlay={
                  // 宽屏：玻璃胶囊压在地图上；窄屏改为地图下方的一行文字链接，不挡路线和标记
                  mapActions.length > 0 && (
                    <div className="absolute bottom-4 left-4 z-10 hidden max-w-[calc(100%-5rem)] flex-wrap gap-2 lg:flex">
                      {mapActions.map((a) => (
                        <MapAction key={a.key} a={a} className={cn(mapChip, a.solid ? mapChipSolid : mapChipGlass)} />
                      ))}
                    </div>
                  )
                }
              >
                <RouteLines track={segments} />
                <RouteSegments segments={routeSegs} idPrefix="trip" />
                <PlanMarkers items={markers} selectedId={selected?.id} onSelect={setSelected} />
                <FitOnce points={fitPoints} fitKey={fitKey} />
                <FlyToSelected w={selected} refit={fitKey} />
              </BaseMap>
              {mapActions.length > 0 && (
                <div className="flex flex-nowrap items-center gap-x-6 overflow-x-auto border-t border-ink-200 px-4 whitespace-nowrap md:px-8 lg:hidden">
                  {mapActions.map((a) => (
                    <MapAction key={a.key} a={a} className={linkAction} text={linkText} arrow />
                  ))}
                </div>
              )}
              {legend && (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-ink-200 px-4 py-2.5 text-[11px] tracking-[0.06em] text-ink-500 md:px-8 lg:glass lg:absolute lg:top-4 lg:left-4 lg:rounded-full lg:border lg:border-ink-900/15 lg:px-4 lg:py-2">
                  {hasPlan && (
                    <span className="flex items-center gap-2">
                      <span className="flex items-center gap-0.5" aria-hidden>
                        {[1, 2, 3].map((d) => (
                          <span key={d} className={cn('inline-block w-2 border-t-2 border-dashed', dayTone(d).border)} />
                        ))}
                      </span>
                      {groups.dayCount > 1 ? '计划路线 · 每天一色' : '计划路线'}
                    </span>
                  )}
                  {hasActual && (
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-0.5 w-5 bg-brand-500" />
                      实际路线
                    </span>
                  )}
                  {segments.length > 0 && (
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-px w-5 bg-amber-500" />
                      GPS 轨迹
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <section id="itinerary" className="min-w-0 scroll-mt-20 px-4 pt-16 md:px-8 lg:col-span-7 lg:row-start-1 lg:px-0 lg:pt-0">
          <SectionHead
            eyebrow="Itinerary · 行程"
            count={trip.waypoints.length > 0 ? `${trip.waypoints.length} 个地点` : undefined}
            aside={trip.days ? `${trip.days} 天` : undefined}
            title={trip.phase === 'planning' ? '路线安排' : '行程与打卡'}
          />
          <div className="mt-14 md:mt-20">
            <Itinerary
              trip={trip}
              groups={groups}
              labels={labels}
              totals={totals}
              selected={selected}
              onSelect={selectAndShow}
              onPhoto={(p) => openPhoto(p)}
              onComment={(w) => {
                setCommentWp(w.id)
                document.getElementById('comments')?.scrollIntoView({ behavior: 'smooth' })
              }}
              renderActions={
                shareBase
                  ? (w) => (
                      <button
                        type="button"
                        onClick={() => setShareWp(w)}
                        className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-xs tracking-[0.04em] text-ink-500 transition-colors hover:bg-ink-900/[0.06] hover:text-ink-900 sm:h-8"
                      >
                        <Share2 className="size-3.5" strokeWidth={1.5} />
                        分享
                      </button>
                    )
                  : undefined
              }
            />
          </div>
        </section>
      </div>

      {trip.content && (
        <section className="mx-auto mt-24 max-w-[90rem] px-4 md:mt-36 md:px-8">
          <SectionHead eyebrow="Journal · 游记" title="旅途手记" />
          <div className="mt-12 lg:grid lg:grid-cols-12 lg:gap-x-8">
            <div className="prose-trip text-[15.5px] lg:col-span-7 lg:col-start-5 lg:text-[16px]">
              {/* Markdown 渲染库只有写了游记的旅程才加载，且不阻塞地图和行程 */}
              <Markdown fallback={<p className="whitespace-pre-wrap">{trip.content}</p>}>{trip.content}</Markdown>
            </div>
          </div>
        </section>
      )}

      {gallery.length > 0 && (
        <section className="mx-auto mt-24 max-w-[90rem] px-4 md:mt-36 md:px-8">
          <SectionHead
            eyebrow={gallery.length < 3 ? 'More Photographs · 更多照片' : 'Photographs · 照片'}
            count={`${gallery.length} 张`}
            // 只剩一两张时不再配超大标题，只留细线标签行
            title={gallery.length >= 3 ? '沿途影像' : undefined}
            aside={
              <button type="button" onClick={() => openPhoto(gallery[0])} className="text-ink-900 transition-colors hover:text-ink-600">
                全部 {trip.photos.length} 张 →
              </button>
            }
          />
          <div className="mt-12 grid grid-cols-2 gap-x-3 gap-y-12 md:mt-16 md:gap-x-6 md:gap-y-20 lg:grid-cols-12 lg:gap-x-8 lg:gap-y-28">
            {gallery.slice(0, GALLERY_MAX).map((p, i) => {
              const w = p.waypoint_id ? wpById.get(p.waypoint_id) : undefined
              const more = i === GALLERY_MAX - 1 && gallery.length > GALLERY_MAX ? gallery.length - GALLERY_MAX : 0
              const n = Math.min(gallery.length, GALLERY_MAX)
              let layout = galleryLayout[i % galleryLayout.length]
              // 奇数张时最后一张单独居中成一幅竖图；手机上落单的半幅图改成整幅
              if (n % 2 === 1 && i === n - 1) layout = galleryLast
              else if (i === n - 1 && i % 4 === 1) layout = layout.replace('col-span-1 ', 'col-span-2 ')
              return (
                <Reveal as="figure" key={p.id} className={cn('min-w-0', layout.replace(/aspect-\S+/, ''))} delay={(i % 2) * 80}>
                  <button
                    type="button"
                    onClick={() => openPhoto(p)}
                    className={cn('group relative block w-full overflow-hidden bg-ink-100', layout.match(/aspect-\S+/)?.[0])}
                    aria-label={more ? `还有 ${more} 张，查看全部` : p.caption || w?.name || '查看照片'}
                  >
                    <img
                      src={i % 4 === 0 || i % 4 === 3 || layout === galleryLast ? p.url : p.thumb_url}
                      alt={p.caption}
                      loading="lazy"
                      className="size-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.03]"
                    />
                    {more > 0 && (
                      <span className="font-num absolute inset-0 flex items-center justify-center bg-black/55 text-4xl font-light text-white">
                        +{more}
                      </span>
                    )}
                  </button>
                  <figcaption className="mt-3 flex items-start justify-between gap-4">
                    <CaptionPair
                      top={p.caption || w?.name || trip.title}
                      bottom={
                        [w && w.day > 0 ? `Day ${pad2(w.day)}` : '', p.taken_at ? fmtTime(p.taken_at, 'YYYY.MM.DD') : '']
                          .filter(Boolean)
                          .join(' · ') || ' '
                      }
                    />
                    <span className="font-num shrink-0 text-[13px] text-ink-400">{pad2(i + 1)}</span>
                  </figcaption>
                </Reveal>
              )
            })}
          </div>
        </section>
      )}

      <section className="mx-auto mt-24 max-w-[90rem] px-4 md:mt-36 md:px-8">
        <div className="lg:grid lg:grid-cols-12 lg:gap-x-8">
          <div className="lg:col-span-7 lg:col-start-5">
            <CommentSection
              tripId={trip.id}
              count={trip.comment_count}
              // 只改缓存里的计数：重新请求旅程详情会多记一次浏览，还要重拉全部打卡点和照片
              onCountChange={(d) =>
                qc.setQueryData<TripDetail>(key, (t) => (t ? { ...t, comment_count: Math.max(0, t.comment_count + d) } : t))
              }
              waypoints={trip.waypoints}
              waypointId={commentWp}
              onClearWaypoint={() => setCommentWp(null)}
              onJumpWaypoint={(wid) => {
                const w = wpById.get(wid)
                if (w) selectAndShow(w)
              }}
            />
          </div>
        </div>
      </section>

      <ShareDialog
        trip={trip}
        shareCode={code ?? rememberedShareCode(trip.id)}
        open={share}
        onClose={() => setShare(false)}
        onUpdated={(t) => {
          qc.setQueryData(key, t)
          invalidateTripLists(qc)
        }}
      />
      <ReportDialog target={report ? { type: 'trip', id: trip.id } : null} onClose={() => setReport(false)} />
      {forkOpen && <ForkDialog trip={trip} onClose={() => setForkOpen(false)} />}
      {shareWp && shareBase && (
        <ShareSheet
          open
          onClose={() => setShareWp(null)}
          heading="分享打卡点"
          title={`${shareWp.name} · ${trip.title}`}
          text={
            [shareWp.verdict && `${verdicts[shareWp.verdict].mark} ${verdicts[shareWp.verdict].label}`, shareWp.note.slice(0, 60)]
              .filter(Boolean)
              .join(' · ') || undefined
          }
          url={`${window.location.origin}${shareBase}?wp=${shareWp.id}`}
        />
      )}
      <PhotoViewer
        photos={viewer?.list ?? []}
        index={viewer?.i ?? null}
        onClose={() => setViewer(null)}
        captionOf={(p) => (p.waypoint_id ? wpById.get(p.waypoint_id)?.name : undefined)}
      />
    </article>
  )
}
