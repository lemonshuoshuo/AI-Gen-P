import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useBlocker, useNavigate, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Map as MLMap } from 'maplibre-gl'
import {
  ArrowLeft,
  Camera,
  Check,
  CircleStop,
  CloudUpload,
  EyeOff,
  Flag,
  ListChecks,
  MapPinPlus,
  MessageCircle,
  Navigation,
  PenLine,
  Plus,
  Radio,
  SkipForward,
  Sparkles,
  TriangleAlert,
  Undo2,
  WifiOff,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, errorMessage, isNotFound, type Recommendation, type Suggestion, type TripDetail, type Waypoint } from '@/api'
import { useOutboxCount } from '@/components/OutboxSync'
import { WaypointForm } from '@/components/editor/WaypointForm'
import { describeUpdate, useRevisionPoll } from '@/components/editor/useTripSync'
import { BaseMap, mapChipClass, useMap } from '@/components/map/BaseMap'
import { FitOnce, RouteLines, UserDot, fitTo } from '@/components/map/layers'
import { CheckinPicker, type PickedPlace } from '@/components/trip/CheckinPicker'
import { NavigateMenu } from '@/components/trip/NavigateMenu'
import { PlanMarkers } from '@/components/trip/PlanMarkers'
import { WaypointNumber } from '@/components/trip/WaypointItem'
import { isLodging, nextInPlan, tripDayToday } from '@/components/trip/plan'
import { Button, CategoryChip, Empty, LoadError, Modal, PageLoader, Spinner, buttonClass, confirmDialog } from '@/components/ui'
import { useGeoTracker, type GeoFix } from '@/hooks/useGeoTracker'
import { useSite } from '@/hooks/useSite'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { fmtDuration } from '@/lib/format'
import { INSECURE_GEO_MSG, formatDistance, formatKm, getCurrentPosition, haversine } from '@/lib/geo'
import { waypointStatus } from '@/lib/meta'
import { isWeChat } from '@/lib/nav'
import {
  discard,
  enqueue,
  flushOutbox,
  isRetryable,
  listOutbox,
  newClientId,
  sendItem,
  type CheckinBody,
  type CheckinItem,
  type PhotoItem,
  type SkipItem,
} from '@/lib/outbox'
import { compressImage } from '@/lib/image'
import { actualPath, bySeq, plannedPath, trackSegments } from '@/lib/trip'
import { useAuth } from '@/stores/auth'

function Follow({ pos, enabled }: { pos: [number, number] | null; enabled: boolean }) {
  const map = useMap()
  const first = useRef(true)
  const wasEnabled = useRef(enabled)
  useEffect(() => {
    // 看完全程后重新打开跟随：拉近到街道级别，而不是停在全程的缩放级别
    const resumed = enabled && !wasEnabled.current
    wasEnabled.current = enabled
    if (!map || !pos || !enabled) return
    const zoom = first.current ? 16 : resumed ? Math.max(map.getZoom(), 15) : map.getZoom()
    map.easeTo({ center: pos, zoom, duration: first.current ? 0 : 600 })
    first.current = false
  }, [map, pos, enabled])
  return null
}

function useTicker(active: boolean) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => set((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [active])
}

const coarsePointer = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

// 「我到了」只用新鲜、足够准的定位：持续定位可能还停在之前的位置（进出隧道、锁屏后），误差太大会匹配到别的地点
const FIX_MAX_AGE = 30_000 // 毫秒
const FIX_MAX_ACC = 100 // 米
const isFresh = (f: GeoFix) => Date.now() - f.t <= FIX_MAX_AGE && f.accuracy <= FIX_MAX_ACC

// 来源只用小圆点区分：计划为黛青（计划路线色），大家推荐为绿，其余为灰（AI 为空心灰圈），文字保持灰色
const sourceLabel: Record<Suggestion['source'], { label: string; cls: string }> = {
  plan: { label: '计划中', cls: 'bg-sky-500' },
  community: { label: '大家推荐', cls: 'bg-emerald-500' },
  amap: { label: '附近', cls: 'bg-ink-400' },
  ai: { label: 'AI 推荐', cls: 'border border-ink-500' },
}

/** 面板里的次要操作：一格一个图标 + 小字，格子之间是竖细线（没有胶囊边框），高 64px 方便户外点按 */
function ToolCell({
  icon,
  children,
  onClick,
  pressed,
  active,
  tone,
}: {
  icon: ReactNode
  children: ReactNode
  onClick: () => void
  pressed?: boolean
  /** 正在加载（如推荐中） */
  active?: boolean
  /** rec：正在记录轨迹（朱砂，表示进行中的状态） */
  tone?: 'rec'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={cn(
        'group flex h-16 min-w-0 flex-col items-center justify-center gap-1.5 px-1 transition-colors duration-300 focus-visible:bg-ink-900/[0.06] focus-visible:outline-none',
        tone === 'rec' ? 'text-brand-600 hover:text-brand-700' : pressed ? 'text-ink-900' : 'text-ink-700 hover:bg-ink-900/[0.03] hover:text-ink-900',
      )}
    >
      {active ? <Spinner className="size-5" /> : icon}
      <span className="max-w-full truncate text-[11px] leading-none tracking-[0.06em]">{children}</span>
    </button>
  )
}

/** 点地图标记或行程清单弹出的地点面板：导航、打卡、跳过、看大家的评价 */
function StopSheet({
  w,
  label,
  distM,
  onCheckin,
  onSkip,
  onUnskip,
  onEdit,
}: {
  w: Waypoint
  label: string
  distM: number | null
  onCheckin: () => void
  onSkip: () => void
  onUnskip: () => void
  onEdit: () => void
}) {
  const { data: place } = useQuery({
    queryKey: ['place', String(w.place_id)],
    queryFn: () => api.places.get(w.place_id!),
    enabled: w.place_id != null,
  })
  const st = waypointStatus[w.status]
  const todo = w.planned && w.status === 'todo'
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <WaypointNumber w={w} label={label} />
        <CategoryChip category={w.category} />
        {w.planned ? (
          <span className={cn('rounded-full px-2 py-0.5 text-xs tracking-wide', st.cls)}>{st.label}</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs tracking-wide text-ink-500">
            <span className="size-1.5 rounded-full border border-ink-500" aria-hidden />
            计划外
          </span>
        )}
        {distM != null && (
          <span className="ml-auto text-xs text-ink-500">
            距离 <span className="font-num text-[13px] text-ink-900">{formatDistance(distM)}</span>
          </span>
        )}
      </div>
      {w.address && <p className="caption mt-4 leading-relaxed">{w.address}</p>}
      {w.note && <p className="mt-4 border-l border-ink-300 pl-4 text-sm leading-relaxed whitespace-pre-wrap text-ink-700">{w.note}</p>}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <NavigateMenu target={{ lng: w.lng, lat: w.lat, name: w.name, address: w.address }} distanceM={distM} size="md" variant="outline" />
        {w.place_id != null && (
          // 新标签页打开：离开旅行模式会中断 GPS 轨迹记录
          <a
            href={`/places/${w.place_id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-700 transition-colors hover:text-ink-900"
          >
            <MessageCircle className="size-4" strokeWidth={1.4} />
            大家怎么说
            {place && (place.rating_avg > 0 || place.recommend_count > 0 || place.avoid_count > 0) && (
              <span className={cn('font-num text-xs', place.avoid_count > place.recommend_count ? 'text-red-600' : 'text-ink-400')}>
                {[
                  place.rating_avg > 0 && `★ ${place.rating_avg.toFixed(1)}`,
                  place.recommend_count > 0 && `◎ ${place.recommend_count}`,
                  place.avoid_count > 0 && `✕ ${place.avoid_count}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </a>
        )}
      </div>
      <div className="mt-6 grid grid-cols-2 gap-2 border-t border-ink-200 pt-5">
        {todo && (
          <>
            <Button size="lg" block icon={<Check className="size-4" strokeWidth={1.5} />} onClick={onCheckin}>
              我到了
            </Button>
            <Button size="lg" block variant="outline" icon={<SkipForward className="size-4" strokeWidth={1.5} />} onClick={onSkip}>
              跳过
            </Button>
          </>
        )}
        {w.status === 'skipped' && (
          <Button size="lg" block variant="outline" icon={<Undo2 className="size-4" strokeWidth={1.5} />} onClick={onUnskip}>
            恢复为待前往
          </Button>
        )}
        {w.status === 'visited' ? (
          <Button size="lg" block variant="outline" icon={<PenLine className="size-4" strokeWidth={1.5} />} className="col-span-2" onClick={onEdit}>
            写点评
          </Button>
        ) : (
          <Button size="lg" block variant="ghost" icon={<PenLine className="size-4" strokeWidth={1.5} />} className={cn(todo && 'col-span-2')} onClick={onEdit}>
            编辑
          </Button>
        )}
      </div>
    </div>
  )
}

export default function TravelModePage() {
  const { id } = useParams()
  const tripId = Number(id)
  const nav = useNavigate()
  const qc = useQueryClient()
  const key = ['trip', id]
  const me = useAuth((s) => s.user)
  const { data: trip, isLoading, error, fetchStatus, refetch } = useQuery({ queryKey: key, queryFn: () => api.trips.get(id!) })
  const { data: track } = useQuery({ queryKey: ['track', tripId], queryFn: () => api.trips.track(tripId), enabled: !!trip })
  const { data: site } = useSite()
  const geo = useGeoTracker(tripId)
  const pending = useOutboxCount(me?.id, tripId)
  useTicker(geo.recording)
  // 同行的人改了行程（加了地点、打了卡）：约 10 秒内自动刷新。本机还有没发出去的打卡时先不刷新（会盖掉本地的标记）
  useRevisionPoll(trip?.id, trip?.revision, (r) => {
    if (pending > 0) return
    const before = qc.getQueryData<TripDetail>(key)
    void refetch().then((res) => {
      if (!res.data || !r.updated_by || r.updated_by.id === me?.id) return
      const text = describeUpdate(before, res.data, r.updated_by)
      if (text) toast(text, { id: `trip-sync-${res.data.id}` })
    })
  })

  // 记录轨迹时离开旅行模式（返回、浏览器后退等）先确认：离开会停止记录，已记录的部分会保存
  const blocker = useBlocker(({ currentLocation, nextLocation }) => geo.recording && currentLocation.pathname !== nextLocation.pathname)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    const b = blocker
    void confirmDialog({
      title: '正在记录轨迹',
      desc: '离开旅行模式会停止记录 GPS 轨迹，已记录的部分会保存。',
      okText: '停止记录并离开',
      danger: true,
    }).then(async (ok) => {
      if (!ok) return b.reset()
      await geo.stop()
      qc.invalidateQueries({ queryKey: ['track', tripId] })
      b.proceed()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state])
  useEffect(() => {
    if (geo.resumed) toast('已恢复轨迹记录（中断期间的轨迹未记录）')
  }, [geo.resumed])

  const [follow, setFollow] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(true)
  const [checking, setChecking] = useState(false)
  // 跳过 / 加入推荐进行中：户外网络慢时连点会重复提交（跳过两站、同一个点插入两次）
  const [skipping, setSkipping] = useState(false)
  const [addingSug, setAddingSug] = useState<Suggestion | null>(null)
  const [review, setReview] = useState<Waypoint | null>(null)
  const [savingReview, setSavingReview] = useState(false)
  const [rec, setRec] = useState<Recommendation | null>(null)
  const [recLoading, setRecLoading] = useState(false)
  const [showList, setShowList] = useState(false)
  // fix：打开选点时用的定位，「就用当前位置」也按它打卡
  const [picker, setPicker] = useState<{ here: [number, number]; far: { name: string; distance: number } | null; fix: GeoFix } | null>(null)
  const [stopId, setStopId] = useState<number | null>(null)
  const [wxTip, setWxTip] = useState(isWeChat)
  const photoInput = useRef<HTMLInputElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  // 推荐请求序号：只采用最新一次的结果（AI 推荐可能要几十秒，旧的结果晚到时丢弃）
  const recReq = useRef(0)

  const sorted = useMemo(() => (trip ? [...trip.waypoints].sort(bySeq) : []), [trip])
  const planned = useMemo(() => plannedPath(sorted), [sorted])
  const actual = useMemo(() => actualPath(sorted), [sorted])
  const segments = useMemo(
    () => [...trackSegments(track), ...geo.livePaths.filter((s) => s.length > 1)],
    [track, geo.livePaths],
  )
  // 与服务端推荐的 next_planned 一致：从最后打卡的计划点往后找，路过没打卡的点不会一直挡在前面
  // 住宿参与顺序：当天的点都去过后，下一站是今晚的住宿；已经过去的那些晚的住宿不再算
  const next = trip ? nextInPlan(sorted, tripDayToday(trip.start_date)) : null
  // 序号只给游玩点（住宿是床的方章，不编号）
  const labelOf = useMemo(() => new Map(sorted.filter((w) => !isLodging(w)).map((w, i) => [w.id, String(i + 1)])), [sorted])
  const markers = useMemo(() => sorted.map((w) => ({ w, label: labelOf.get(w.id) })), [sorted, labelOf])
  // 地点面板里显示的点：从最新的 sorted 里取，打卡 / 跳过后状态随之更新
  const stop = sorted.find((w) => w.id === stopId) ?? null
  const nextDist = next && geo.fix ? haversine(geo.fix.gcj, [next.lng, next.lat]) : null
  const visited = sorted.filter((w) => w.status === 'visited').length
  // 住宿不是打卡点：不计入计划进度
  const plannedTotal = sorted.filter((w) => w.planned && !isLodging(w)).length
  const plannedDone = sorted.filter((w) => w.planned && !isLodging(w) && w.status !== 'todo').length

  // 网络不好（请求失败或离线暂停）：旅程可能是上次加载的数据
  const netDown = fetchStatus === 'paused' || (error instanceof ApiError && (error.status === 0 || error.status >= 500))
  const stale = !!error || fetchStatus === 'paused'

  if (isLoading) return <PageLoader />
  // 全屏页面没有顶栏和底部导航：出错时要给出返回入口
  if (!trip || isNotFound(error))
    return (
      <LoadError
        className="min-h-dvh"
        error={error}
        title={netDown ? '网络不佳，暂时无法加载旅程' : undefined}
        desc={error ? undefined : '请检查网络连接'}
        notFoundTitle="旅程不存在或无权访问"
        onRetry={() => refetch()}
        back={
          <Link to="/" className={buttonClass({ variant: 'outline' })}>
            回到首页
          </Link>
        }
      />
    )
  if (!trip.can_edit)
    return (
      <Empty
        className="min-h-dvh"
        title="只有旅程成员可以使用旅行模式"
        desc={trip.invite_pending ? '你还没有接受同行邀请，在旅程页接受后就能一起打卡、记录轨迹' : '如果你收到了同行邀请，请先在「通知」中接受'}
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link to={`/trips/${trip.id}`} className={buttonClass()}>
              查看旅程
            </Link>
            <Link to="/notifications" className={buttonClass({ variant: 'outline' })}>
              去通知
            </Link>
          </div>
        }
      />
    )

  const refresh = () => qc.invalidateQueries({ queryKey: key })
  // 旅程开始 / 结束后：「我的旅程」列表和顶部「旅行中」入口直接重新加载（旅行模式下它们都没有挂载）
  const tripListsChanged = () => {
    qc.removeQueries({ queryKey: ['my-trips'] })
    void invalidateTripLists(qc)
  }
  const itemBase = (userId: number) => ({ id: newClientId(), userId, tripId: trip.id, createdAt: Date.now() })

  // 打开旅行模式不再改变旅程状态；打卡、记录轨迹时服务端会自动开始旅行，拍照需要这里先开始
  const ensureStarted = async () => {
    if (trip.phase !== 'planning') return
    try {
      qc.setQueryData(key, await api.trips.update(trip.id, { phase: 'ongoing' }))
      tripListsChanged()
    } catch {
      /* 忽略 */
    }
  }

  // 离线时先在本地把计划点标成已到达 / 跳过，「下一站」照常往后走；联网补发后以服务端为准
  const markLocal = (wid: number, status: 'visited' | 'skipped', arrivedAt?: string) =>
    qc.setQueryData<TripDetail>(key, (t) =>
      t
        ? {
            ...t,
            waypoints: t.waypoints.map((w) =>
              w.id === wid ? { ...w, status, arrived_at: status === 'visited' ? (arrivedAt ?? w.arrived_at) : null } : w,
            ),
          }
        : t,
    )

  // auto：打卡、跳过后自动刷新推荐（失败不提示；没有任何推荐时不显示推荐区）
  const recommend = async (opts?: { auto?: boolean }) => {
    const n = ++recReq.current
    setRecLoading(true)
    setSheetOpen(true)
    try {
      const r = await api.trips.recommend(trip.id, {
        ...(geo.fix ? { lng: geo.fix.wgs[0], lat: geo.fix.wgs[1], coord_type: 'wgs84' as const } : {}),
        ai: site?.ai_enabled,
      })
      if (n !== recReq.current) return
      setRec(opts?.auto && !r.suggestions.length && !r.warnings.length && !r.ai_text ? null : r)
    } catch (e) {
      if (n === recReq.current && !opts?.auto) toast.error(errorMessage(e))
    } finally {
      if (n === recReq.current) setRecLoading(false)
    }
  }

  // 先存本机再发送：网络不好时保留，联网后自动补发（服务端按 client_id 去重）
  // fix：「我到了」重新定位得到的位置，代替持续定位的 geo.fix
  const checkin = async (waypointId?: number, place?: PickedPlace, fix: GeoFix | null = geo.fix) => {
    if (!me) return
    if (!waypointId && !place && !fix) return toast.error(geo.error ?? '正在定位，请稍候…')
    const arrivedAt = new Date().toISOString() // 以点击的时刻为准，补发时也不变
    const body: CheckinBody = place
      ? {
          name: place.name,
          address: place.address,
          amap_id: place.amap_id || undefined,
          category: place.category || undefined,
          lng: place.lng,
          lat: place.lat,
          coord_type: 'gcj02',
          arrived_at: arrivedAt,
        }
      : {
          waypoint_id: waypointId ?? null,
          ...(fix ? { lng: fix.wgs[0], lat: fix.wgs[1], coord_type: 'wgs84' as const } : {}),
          arrived_at: arrivedAt,
        }
    const item: CheckinItem = { ...itemBase(me.id), kind: 'checkin', body }
    setChecking(true)
    try {
      await enqueue(item)
      const r = await sendItem(item)
      await refresh()
      // 规划中的旅程第一次打卡时服务端会自动开始旅行
      if (trip.phase === 'planning') tripListsChanged()
      // 重复打卡（连点两次、同行的人刚打过卡）：服务端原样返回之前的打卡点，不再弹点评、刷新推荐
      if (r.duplicate) {
        toast(`刚才已经打过卡了：${r.waypoint.name}`)
        return
      }
      toast.success(r.matched_plan ? `已打卡：${r.waypoint.name}` : `新的打卡点：${r.waypoint.name}（计划外）`)
      setReview(r.waypoint)
      // 到了一个地方就推荐下一站：在填写点评时后台加载，关掉点评就能看到；旧的推荐作废
      setRec(null)
      void recommend({ auto: true })
    } catch (e) {
      if (isRetryable(e)) {
        if (waypointId) markLocal(waypointId, 'visited', arrivedAt)
        toast('网络不佳，已保存在本机，联网后自动同步')
      } else await discard(item, e)
    } finally {
      setChecking(false)
    }
  }

  // 「我到了」：200 米内有计划地点就直接打卡（与服务端匹配半径一致），否则先选所在的店铺 / 景点。
  // 持续定位不够新或误差太大时先重新定位一次；仍不准就不按位置打卡，打开行程清单让用户自己选到达的地点
  const startCheckin = async () => {
    let fix = geo.fix
    if (!fix || !isFresh(fix)) {
      const tId = toast.loading('正在重新定位…')
      setChecking(true)
      try {
        const p = await getCurrentPosition(10_000)
        fix = { wgs: p.wgs, gcj: p.gcj, accuracy: p.accuracy, t: Date.now() }
      } catch (e) {
        // 定位失败（超时、权限被拒绝等）没有精度可说，直接给出原因
        toast.error(`${errorMessage(e)}，也可以在行程清单里选择到达的地点`, { id: tId })
        setShowList(true)
        return
      } finally {
        setChecking(false)
      }
      if (fix.accuracy > FIX_MAX_ACC) {
        toast.error(`定位不够准确（约 ${Math.round(fix.accuracy)} 米），请到开阔处再试，或在行程清单里选择到达的地点`, { id: tId })
        setShowList(true)
        return
      }
      toast.dismiss(tId)
    }
    const here = fix.gcj
    let nearest: { w: Waypoint; d: number } | null = null
    for (const w of sorted) {
      if (!w.planned || w.status !== 'todo') continue
      const d = haversine(here, [w.lng, w.lat])
      if (!nearest || d < nearest.d) nearest = { w, d }
    }
    if (nearest && nearest.d <= 200) return checkin(undefined, undefined, fix)
    setPicker({ here, far: nearest && nearest.d > 2000 ? { name: nearest.w.name, distance: nearest.d } : null, fix })
  }

  // 旅行中其他人能否实时看到打卡、照片和轨迹（live_share，只有作者能改）
  const toggleLiveShare = async () => {
    const on = !trip.live_share
    const ok = await confirmDialog(
      on
        ? {
            title: '实时公开你的位置？',
            desc: '开启后，能看到这段旅程的人（公开旅程为所有人）可以实时看到你们的打卡、照片和 GPS 轨迹。',
            okText: '开启',
          }
        : { title: '停止实时公开？', desc: '其他人将只能看到计划路线，打卡、照片和轨迹在旅程结束后才公开。', okText: '停止公开' },
    )
    if (!ok) return
    try {
      const t = await api.trips.update(trip.id, { live_share: on })
      qc.setQueryData(key, t)
      toast.success(on ? '已开启实时公开' : '已停止实时公开')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const unskip = async (w: Waypoint) => {
    try {
      await api.waypoints.reset(w.id)
      refresh()
      toast.success(`已恢复：${w.name}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const skip = async (w: Waypoint) => {
    if (!me || skipping) return
    const item: SkipItem = { ...itemBase(me.id), kind: 'skip', waypointId: w.id }
    setSkipping(true)
    try {
      await enqueue(item)
      await sendItem(item)
      const refreshed = refresh()
      toast(`已跳过：${w.name}`, { action: { label: '撤销', onClick: () => void unskip(w) } })
      // 正在看推荐时刷新，否则跳过的点还会作为「计划中的下一站」出现
      if (rec || recLoading) void recommend({ auto: true })
      // 「下一站」换成新的点之后才能再点：连点两下不会把后面一站也跳过
      await refreshed
    } catch (e) {
      if (isRetryable(e)) {
        markLocal(w.id, 'skipped')
        toast('网络不佳，已保存在本机，联网后自动同步')
      } else await discard(item, e)
    } finally {
      setSkipping(false)
    }
  }

  const addSuggestion = async (s: Suggestion) => {
    if (addingSug) return
    setAddingSug(s)
    try {
      // 插入到下一个计划点之前，作为新的下一站
      const seq = next ? next.seq : undefined
      await api.waypoints.create(trip.id, {
        name: s.name,
        address: s.address,
        lng: s.lng,
        lat: s.lat,
        category: s.category,
        amap_id: s.amap_id || undefined,
        planned: true,
        status: 'todo',
        seq,
        note: s.reason ? `推荐理由：${s.reason}` : '',
      })
      setRec((r) => (r ? { ...r, suggestions: r.suggestions.filter((x) => x !== s) } : r))
      toast.success(`已加入路线：${s.name}`)
      // 刷新出新的「下一站」后才能加入下一个：否则会用旧的 seq 插到同一个位置
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setAddingSug(null)
    }
  }

  const toggleRecord = async () => {
    if (geo.recording) {
      await geo.stop()
      qc.invalidateQueries({ queryKey: ['track', tripId] })
      toast.success('轨迹已保存')
    } else {
      // 定位不可用时（非 HTTPS、权限被拒绝）不开始记录，否则会「记录」一段没有任何点的轨迹
      if (geo.blocked) return toast.error(geo.error ?? INSECURE_GEO_MSG)
      geo.start(Math.floor(Date.now() / 1000))
      void ensureStarted()
      toast.success('开始记录轨迹，请保持页面打开')
    }
  }

  const finish = async () => {
    if (!(await confirmDialog({ title: '结束这次旅行？', desc: '结束后可以查看「计划 vs 实际」对比，并继续补充游记。', okText: '结束旅行' })))
      return
    if (geo.recording) await geo.stop()
    // 先补发离线保存的打卡 / 照片，「计划 vs 实际」才完整
    if (me && pending > 0) {
      const tId = toast.loading('正在同步离线保存的记录…')
      await flushOutbox(me.id)
      const left = (await listOutbox(me.id, trip.id)).length
      if (left) toast.warning(`还有 ${left} 条记录未同步，联网后会自动补传`, { id: tId })
      else toast.dismiss(tId)
    }
    try {
      await api.trips.update(trip.id, { phase: 'finished' })
      tripListsChanged()
      await refresh()
      nav(trip.waypoints.some((w) => w.planned) ? `/trips/${trip.id}/compare` : `/trips/${trip.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const uploadPhoto = async (file: File) => {
    if (!me) return
    // 拍摄时间和位置在拍完时就确定，离线补传时也不变
    const takenAt = new Date().toISOString()
    const fix = geo.fix
    const tId = toast.loading('照片上传中…')
    let item: PhotoItem | null = null
    try {
      const { blob } = await compressImage(file)
      // 拍照页面常常不会把照片存进相册：先存本机，上传失败也不会丢
      item = {
        ...itemBase(me.id),
        kind: 'photo',
        data: await blob.arrayBuffer(),
        mime: blob.type || 'image/jpeg',
        meta: {
          filename: 'photo.jpg',
          ...(fix ? { lng: fix.wgs[0], lat: fix.wgs[1], coord_type: 'wgs84' as const } : {}),
          taken_at: takenAt,
          auto_waypoint: true,
        },
      }
      await enqueue(item)
      // 先开始旅行：服务端只在旅行中才把照片算作到达了计划地点
      const r = await sendItem(item, ensureStarted)
      await refresh()
      toast.success(r.waypoint ? `照片已关联到：${r.waypoint.name}` : '照片已上传', { id: tId })
    } catch (e) {
      if (!item) toast.error(errorMessage(e), { id: tId })
      else if (isRetryable(e)) toast('照片已保存在本机，联网后自动上传', { id: tId })
      else {
        toast.dismiss(tId)
        await discard(item, e)
      }
    }
  }

  const elapsed = geo.startedAt ? Date.now() - geo.startedAt : 0

  return (
    <div className="fixed inset-0 flex flex-col bg-paper">
      {/* 顶栏 */}
      <div className="glass z-20 flex items-center gap-1.5 border-b border-ink-200 pt-[max(env(safe-area-inset-top),0.5rem)] pr-3 pb-2 pl-1.5 sm:gap-3 sm:pr-6 sm:pl-3">
        <Link
          to={`/trips/${trip.id}`}
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-ink-700 transition-colors hover:text-ink-900"
          aria-label="返回"
        >
          <ArrowLeft className="size-5" strokeWidth={1.4} />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="eyebrow flex items-center gap-1.5 !text-[10px] !leading-3">
            {trip.phase === 'ongoing' && <span className="size-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />}
            {trip.phase === 'ongoing' ? 'On the road · 旅行中' : 'Travel mode · 旅行模式'}
          </p>
          <div className="font-display mt-1 truncate text-[1.25rem] leading-tight text-ink-900 sm:text-[1.5rem]">{trip.title}</div>
          {/* 窄屏放不下时换行：标题截断，位置公开状态不截断 */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-ink-500">
            <span>
              {plannedTotal > 0 ? (
                <>
                  计划 <span className="font-num text-[13px] text-ink-900">{plannedDone}</span>
                  <span className="font-num text-[13px] text-ink-400"> / {plannedTotal}</span>
                </>
              ) : (
                <>
                  已打卡 <span className="font-num text-[13px] text-ink-900">{visited}</span>
                </>
              )}
            </span>
            {geo.recording && (
              <span className="inline-flex items-center gap-1.5 text-brand-600">
                <span className="relative flex size-1.5">
                  <span className="absolute inset-0 animate-ping rounded-full bg-brand-500/60" />
                  <span className="relative size-1.5 rounded-full bg-brand-500" />
                </span>
                <span className="font-num text-[13px]">{fmtDuration(elapsed)}</span>
                <span className="text-brand-300">·</span>
                <span className="font-num text-[13px]">{formatKm(geo.recordedKm)}</span>
              </span>
            )}
            {trip.is_owner && trip.visibility !== 'private' && trip.phase !== 'finished' && (
              <button
                type="button"
                onClick={toggleLiveShare}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap underline-offset-4 hover:underline',
                  trip.live_share ? 'text-emerald-700' : 'text-ink-500',
                )}
                title={trip.live_share ? '其他人可以实时看到你们的打卡、照片和轨迹，点击修改' : '其他人只能看到计划路线，点击修改'}
              >
                {trip.live_share ? <Radio className="size-3 shrink-0" strokeWidth={1.5} /> : <EyeOff className="size-3 shrink-0" strokeWidth={1.5} />}
                {trip.live_share ? '实时公开位置中' : '位置仅同行可见'}
              </button>
            )}
          </div>
        </div>
        {pending > 0 && (
          <button
            type="button"
            onClick={() => {
              if (me) void flushOutbox(me.id)
            }}
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-amber-500/50 px-3 text-xs text-amber-700 transition-colors hover:border-amber-500"
            title="联网后会自动同步，点击立即同步"
          >
            <CloudUpload className="size-3.5" strokeWidth={1.5} />
            <span className="font-num text-[13px]">{pending}</span>
            <span className="max-sm:hidden">条待同步</span>
          </button>
        )}
        <Button variant="outline" icon={<Flag className="size-3.5" strokeWidth={1.5} />} className="px-4" onClick={finish}>
          结束
        </Button>
      </div>

      {/* 地图 */}
      <div className="relative flex-1">
        <BaseMap
          className="absolute inset-0"
          kindSwitcher
          // 手机上双指缩放即可：缩放按钮会和右侧的跟随 / 全程按钮挤在一起（面板展开后地图很矮）
          navigation={!coarsePointer}
          options={{ dragRotate: false }}
          onReady={(m) => {
            mapRef.current = m
            // 手动拖动地图时暂停跟随，否则下一次定位又会拉回当前位置
            m.on('dragstart', () => setFollow(false))
          }}
          overlay={
            <div className="absolute top-[3.75rem] right-3 z-10 flex flex-col items-end gap-2 sm:top-14">
              <button
                type="button"
                onClick={() => setFollow((v) => !v)}
                className={cn(mapChipClass, 'w-10 px-0 sm:w-9', follow ? '!text-ink-900' : '!text-ink-500')}
                title={follow ? '跟随中' : '不跟随'}
                aria-label={follow ? '跟随中' : '不跟随'}
                aria-pressed={follow}
              >
                <Navigation className={cn('size-4', follow && 'fill-ink-900')} strokeWidth={1.4} />
              </button>
              <button
                type="button"
                disabled={!sorted.length}
                onClick={() => {
                  setFollow(false)
                  if (mapRef.current) fitTo(mapRef.current, sorted.map((w) => [w.lng, w.lat] as [number, number]))
                }}
                className={mapChipClass}
                title="查看全程"
              >
                全程
              </button>
            </div>
          }
        >
          <RouteLines planned={planned} actual={actual} track={segments} />
          <PlanMarkers items={markers} selectedId={next?.id} onSelect={(w) => setStopId(w.id)} />
          <UserDot position={geo.fix?.gcj ?? null} accuracy={geo.fix?.accuracy} />
          {!geo.fix && <FitOnce points={sorted.map((w) => [w.lng, w.lat])} fitKey={`go-${trip.id}`} />}
          <Follow pos={geo.fix?.gcj ?? null} enabled={follow} />
        </BaseMap>
        {(stale || geo.error) && (
          <div className="absolute top-3 left-3 z-10 flex max-w-[70%] flex-col items-start gap-2">
            {stale && (
              <div className="glass rounded-md border border-amber-500/35 px-3 py-2 text-xs leading-relaxed text-ink-800">
                <WifiOff className="mr-1.5 inline size-3.5 text-amber-600" strokeWidth={1.5} />
                {netDown ? '网络不佳，显示的是上次加载的数据' : `${errorMessage(error)}，显示的是上次加载的数据`}
              </div>
            )}
            {geo.error && (
              <div className="glass rounded-md border border-amber-500/35 px-3 py-2 text-xs leading-relaxed text-ink-800">
                <TriangleAlert className="mr-1.5 inline size-3.5 text-amber-600" strokeWidth={1.5} />
                {geo.error}
                {geo.blocked && <div className="mt-1 text-ink-500">仍可在「下一站」点「已到达」手动打卡</div>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部面板：深色浮层 + 细线，主操作是一枚大号朱砂胶囊 */}
      {/* 桌面上是浮在地图左下角的面板，地图占满整屏 */}
      <div className="pb-safe relative z-20 max-h-[62dvh] overflow-y-auto rounded-t-xl border-t border-ink-200 bg-surface md:absolute md:bottom-6 md:left-6 md:max-h-[calc(100dvh-8.5rem)] md:w-[27rem] md:rounded-xl md:border md:pt-5 md:shadow-float">
        {/* 拖动条只在手机上：桌面的浮动面板始终展开 */}
        <button
          type="button"
          onClick={() => setSheetOpen((v) => !v)}
          className="sticky top-0 z-10 flex h-7 w-full items-center justify-center bg-surface md:hidden"
          aria-label={sheetOpen ? '收起' : '展开'}
          aria-expanded={sheetOpen}
        >
          <span className="h-[3px] w-10 rounded-full bg-ink-300" />
        </button>

        <div className="mx-auto max-w-2xl px-4 pb-4 sm:px-6 md:px-5 md:pb-5">
          {/* 下一站：小标签行 + 大号宋体地名，不装进卡片；「已到达 / 跳过」是地名下的文字链接 */}
          {next ? (
            <section aria-label="下一站">
              <div className="flex items-baseline justify-between gap-3">
                <p className="eyebrow">{isLodging(next) ? 'Tonight · 今晚住这里' : 'Next · 下一站'}</p>
                {nextDist != null && <span className="font-num text-[13px] text-ink-500">{formatDistance(nextDist)}</span>}
              </div>
              <div className="mt-2 flex items-center gap-3">
                <WaypointNumber w={next} label={labelOf.get(next.id) ?? ''} />
                <div className="font-display min-w-0 flex-1 truncate text-[1.625rem] leading-tight text-ink-900 sm:text-[1.875rem]">{next.name}</div>
                {/* key：手动选的出行方式不带到下一站 */}
                <NavigateMenu
                  key={next.id}
                  target={{ lng: next.lng, lat: next.lat, name: next.name, address: next.address }}
                  distanceM={nextDist}
                  size="md"
                  variant="outline"
                />
              </div>
              {sheetOpen && (
                <div className="-mb-1.5 flex items-center gap-6 pl-10">
                  <button
                    type="button"
                    disabled={checking || skipping}
                    onClick={() => checkin(next.id)}
                    className="inline-flex h-11 items-center text-[13px] text-ink-700 underline decoration-ink-300 underline-offset-4 transition-colors hover:text-ink-900 hover:decoration-ink-900 disabled:opacity-40"
                  >
                    已到达
                  </button>
                  <button
                    type="button"
                    disabled={checking || skipping}
                    onClick={() => skip(next)}
                    className="inline-flex h-11 items-center gap-2 text-[13px] text-ink-700 underline decoration-ink-300 underline-offset-4 transition-colors hover:text-ink-900 hover:decoration-ink-900 disabled:opacity-40"
                  >
                    {skipping && <Spinner className="size-3.5" />}
                    跳过
                  </button>
                </div>
              )}
              {sheetOpen && next.note && <p className="mt-2 border-l border-ink-300 pl-3 text-[13px] leading-relaxed text-ink-500">{next.note}</p>}
            </section>
          ) : (
            plannedTotal > 0 && (
              <p className="border-l border-emerald-500 py-1 pl-4 text-[13.5px] leading-relaxed text-ink-700">
                <span className="font-display text-lg text-ink-900">计划的地点都走完了。</span>
                <br />
                可以结束旅行，看看计划和实际的对比。
              </p>
            )
          )}

          {wxTip && (
            <div className="mt-4 flex items-start gap-2 border-l border-amber-500 py-1 pl-3 text-xs leading-relaxed text-ink-700">
              <span className="min-w-0 flex-1">
                <span className="eyebrow mr-1.5 !text-amber-600">WeChat</span>
                当前在微信中：无法唤起导航 App，建议点右上角「···」→「在浏览器打开」使用旅行模式
              </span>
              <button type="button" onClick={() => setWxTip(false)} className="-mt-2 -mr-2 flex size-9 shrink-0 items-center justify-center text-ink-500" aria-label="关闭提示">
                <X className="size-3.5" strokeWidth={1.5} />
              </button>
            </div>
          )}

          {/* 主操作：整个面板里唯一的实心按钮 */}
          <div className={cn(next || plannedTotal > 0 ? 'mt-4 border-t border-ink-200 pt-4' : 'pt-1')}>
            <button
              type="button"
              disabled={checking}
              onClick={startCheckin}
              className="flex h-14 w-full items-center justify-center gap-2.5 rounded-full bg-brand-400 text-[15.5px] font-medium tracking-[0.06em] text-white transition-colors duration-300 hover:bg-brand-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900 active:bg-brand-300 disabled:opacity-60"
            >
              {checking ? <Spinner className="text-white" /> : <MapPinPlus className="size-5" strokeWidth={1.5} />}
              我到了，打卡
            </button>
          </div>
          {/* 次要操作：一行四格，细线分隔，图标 + 小字，不再是一堆胶囊 */}
          <div className="mt-4 grid grid-cols-4 divide-x divide-ink-200 border-y border-ink-200">
            <ToolCell icon={<Sparkles className="size-5" strokeWidth={1.25} />} onClick={() => recommend()} active={recLoading}>
              推荐下一站
            </ToolCell>
            <ToolCell icon={<Camera className="size-5" strokeWidth={1.25} />} onClick={() => photoInput.current?.click()}>
              拍照
            </ToolCell>
            <ToolCell
              icon={
                geo.recording ? (
                  <span className="relative flex size-5 items-center justify-center">
                    <span className="absolute size-2 animate-ping rounded-full bg-brand-500/60" />
                    <CircleStop className="size-5" strokeWidth={1.25} />
                  </span>
                ) : (
                  <Radio className="size-5" strokeWidth={1.25} />
                )
              }
              onClick={toggleRecord}
              tone={geo.recording ? 'rec' : undefined}
              pressed={geo.recording}
            >
              {geo.recording ? '停止记录轨迹' : '记录 GPS 轨迹'}
            </ToolCell>
            <ToolCell
              icon={
                <span className="relative">
                  <ListChecks className="size-5" strokeWidth={1.25} />
                  <span className="font-num absolute -top-1.5 -right-3 text-[11px] leading-none text-ink-500">{sorted.length}</span>
                </span>
              }
              onClick={() => setShowList((v) => !v)}
              pressed={showList}
            >
              {showList ? '收起行程' : '行程清单'}
            </ToolCell>
          </div>
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) uploadPhoto(f)
              e.target.value = ''
            }}
          />

          {sheetOpen && (
            <>
              {trip.phase === 'planning' && <p className="caption mt-3 text-center !text-xs">第一次打卡、拍照或记录轨迹时自动开始旅行</p>}
              {geo.recording && <p className="caption mt-3 text-center !text-xs">记录时请保持此页面打开（已尝试保持屏幕常亮）</p>}

              {/* 推荐结果 */}
              {(recLoading || rec) && (
                <section className="mt-6 border-t border-ink-200 pt-3" aria-label="推荐下一站">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="eyebrow">Nearby · 推荐</p>
                    {rec?.ai_used && <span className="eyebrow">AI</span>}
                  </div>
                  <h3 className="font-display mt-2 text-[1.5rem] font-normal">推荐下一站</h3>
                  {recLoading ? (
                    <div className="flex items-center gap-2 py-6 text-[13px] text-ink-500">
                      <Spinner className="size-4" />
                      {site?.ai_enabled ? 'AI 正在结合你的位置、时间和大家的评价挑选…' : '正在查找附近值得去的地方…'}
                    </div>
                  ) : (
                    rec && (
                      <div className="mt-3 space-y-3">
                        {rec.ai_text && <p className="border-l border-ink-300 py-0.5 pl-3 text-[13.5px] leading-relaxed text-ink-700">{rec.ai_text}</p>}
                        {rec.warnings.map((w) => (
                          // 新标签页打开：离开旅行模式会中断 GPS 轨迹记录
                          <Link
                            key={w.place_id}
                            to={`/places/${w.place_id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-start gap-2 border-l border-brand-500 py-1 pl-3 text-[13.5px] leading-relaxed text-ink-700 transition-colors hover:text-ink-900"
                          >
                            <span>
                              <span className="eyebrow mr-1.5 !text-brand-600">避雷</span>
                              <span className="text-ink-900">{w.name}</span>
                              <span className="font-num text-ink-500">（{formatDistance(w.distance_m)}）</span>— {w.reason}
                            </span>
                          </Link>
                        ))}
                        {rec.suggestions.length === 0 && <p className="caption py-4 text-center">附近暂时没有推荐的地点</p>}
                        <div className="divide-y divide-ink-200 border-t border-ink-200">
                          {rec.suggestions.map((s, i) => (
                            <div key={i} className="flex items-start gap-3 py-4">
                              <div className="min-w-0 flex-1">
                                <div className="font-display text-[1.125rem] leading-snug text-ink-900">{s.name}</div>
                                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                                  <CategoryChip category={s.category} />
                                  <span className="inline-flex items-center gap-1.5 text-xs tracking-wide text-ink-500">
                                    <span className={cn('size-1.5 rounded-full', sourceLabel[s.source].cls)} aria-hidden />
                                    {sourceLabel[s.source].label}
                                  </span>
                                  <span className="font-num text-[13px] text-ink-700">{formatDistance(s.distance_m)}</span>
                                </div>
                                {s.reason && <p className="caption mt-1.5 !text-xs leading-relaxed">{s.reason}</p>}
                              </div>
                              {/* 加入是文字操作，导航是图标圆钮：一行里不再有实心按钮 */}
                              <div className="flex shrink-0 items-center gap-3 self-center">
                                {s.source !== 'plan' && (
                                  <button
                                    type="button"
                                    disabled={!!addingSug}
                                    onClick={() => addSuggestion(s)}
                                    className="inline-flex h-11 items-center gap-1 text-[13px] text-ink-900 underline decoration-ink-300 underline-offset-4 transition-colors hover:decoration-ink-900 disabled:opacity-40"
                                  >
                                    {addingSug === s ? <Spinner className="size-3.5" /> : null}
                                    加入
                                    <Plus className="size-3.5" strokeWidth={1.5} aria-hidden />
                                  </button>
                                )}
                                {/* 图标圆钮：文字字号为 0，仍作为按钮的名称（导航）被读屏读出 */}
                                <NavigateMenu
                                  target={{ lng: s.lng, lat: s.lat, name: s.name, address: s.address }}
                                  distanceM={s.distance_m}
                                  size="md"
                                  variant="outline"
                                  className="size-11 !gap-0 !px-0 !text-[0px] [&_svg]:size-4"
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  )}
                </section>
              )}

              {/* 行程清单 */}
              {showList && (
                <section className="mt-6 border-t border-ink-200 pt-3" aria-label="行程清单">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="eyebrow">Itinerary · 行程</p>
                    <span className="font-num text-[13px] text-ink-400">
                      {plannedDone} / {plannedTotal || sorted.length}
                    </span>
                  </div>
                  <div className="mt-2 divide-y divide-ink-200">
                    {sorted.map((w) => (
                      <button
                        type="button"
                        key={w.id}
                        data-stop-row
                        className={cn(
                          'flex min-h-13 w-full items-center gap-3 py-2.5 text-left transition-colors hover:text-ink-900',
                          w.status === 'skipped' && 'opacity-50',
                        )}
                        onClick={() => setStopId(w.id)}
                      >
                        <WaypointNumber w={w} label={labelOf.get(w.id) ?? ''} />
                        <span className={cn('font-display min-w-0 flex-1 truncate text-[1.0625rem] text-ink-900', w.status === 'skipped' && 'line-through')}>
                          {w.name}
                        </span>
                        {w.status === 'visited' && <Check className="size-4 text-emerald-600" strokeWidth={1.5} />}
                        {!w.planned && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-ink-500">
                            <span className="size-1.5 rounded-full border border-ink-500" aria-hidden />
                            计划外
                          </span>
                        )}
                        {next?.id === w.id && <span className="eyebrow !text-[10px]">Next</span>}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>

      {picker && (
        <CheckinPicker
          open
          here={picker.here}
          far={picker.far}
          amap={!!site?.amap_search}
          onClose={() => setPicker(null)}
          onPick={(p) => {
            setPicker(null)
            // 「就用当前位置」按打开选点时的定位打卡（选了地点时用地点的坐标）
            void checkin(undefined, p ?? undefined, picker.fix)
          }}
        />
      )}

      <Modal open={!!stop} onClose={() => setStopId(null)} title={stop?.name}>
        {stop && (
          <StopSheet
            w={stop}
            label={labelOf.get(stop.id) ?? ''}
            distM={geo.fix ? haversine(geo.fix.gcj, [stop.lng, stop.lat]) : null}
            onCheckin={() => {
              setStopId(null)
              void checkin(stop.id)
            }}
            onSkip={() => {
              setStopId(null)
              void skip(stop)
            }}
            onUnskip={() => void unskip(stop)}
            onEdit={() => {
              setStopId(null)
              setReview(stop)
            }}
          />
        )}
      </Modal>

      <Modal
        open={!!review}
        onClose={() => setReview(null)}
        title={review ? (review.status === 'visited' ? `「${review.name}」怎么样？` : `编辑「${review.name}」`) : ''}
      >
        {review && (
          <>
            {review.status === 'visited' && <p className="caption mb-4">记下真实体验，帮之后来的人避雷</p>}
            <WaypointForm
              w={review}
              phase={trip.phase === 'planning' ? 'ongoing' : trip.phase}
              maxDay={Math.max(1, ...sorted.map((w) => w.day))}
              saving={savingReview}
              onCancel={() => setReview(null)}
              onSave={async (p) => {
                setSavingReview(true)
                try {
                  await api.waypoints.update(review.id, p)
                  await refresh()
                  setReview(null)
                  toast.success('已保存')
                } catch (e) {
                  toast.error(errorMessage(e))
                } finally {
                  setSavingReview(false)
                }
              }}
            />
          </>
        )}
      </Modal>
    </div>
  )
}
