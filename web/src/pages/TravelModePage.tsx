import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useBlocker, useNavigate, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Map as MLMap } from 'maplibre-gl'
import {
  ArrowLeft,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  CircleStop,
  CloudUpload,
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
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { FitOnce, RouteLines, UserDot, WaypointMarkers, fitTo } from '@/components/map/layers'
import { CheckinPicker, type PickedPlace } from '@/components/trip/CheckinPicker'
import { NavigateMenu } from '@/components/trip/NavigateMenu'
import { WaypointNumber } from '@/components/trip/WaypointItem'
import { Button, CategoryChip, Empty, LoadError, Modal, PageLoader, Spinner, buttonClass, confirmDialog } from '@/components/ui'
import { useGeoTracker } from '@/hooks/useGeoTracker'
import { useSite } from '@/hooks/useSite'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { fmtDuration } from '@/lib/format'
import { INSECURE_GEO_MSG, formatDistance, formatKm, haversine } from '@/lib/geo'
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

const sourceLabel: Record<Suggestion['source'], { label: string; cls: string }> = {
  plan: { label: '计划中', cls: 'bg-sky-50 text-sky-700' },
  community: { label: '大家推荐', cls: 'bg-emerald-50 text-emerald-700' },
  amap: { label: '附近', cls: 'bg-ink-100 text-ink-600' },
  ai: { label: 'AI 推荐', cls: 'bg-violet-50 text-violet-700' },
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
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <WaypointNumber w={w} label={label} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <CategoryChip category={w.category} />
          {w.planned ? (
            <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', st.cls)}>{st.label}</span>
          ) : (
            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">计划外</span>
          )}
          {distM != null && <span className="text-xs text-ink-500">距离 {formatDistance(distM)}</span>}
        </div>
      </div>
      {w.address && <p className="text-sm text-ink-500">{w.address}</p>}
      {w.note && <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink-700">{w.note}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <NavigateMenu target={{ lng: w.lng, lat: w.lat, name: w.name, address: w.address }} distanceM={distM} size="md" variant="primary" />
        {w.place_id != null && (
          // 新标签页打开：离开旅行模式会中断 GPS 轨迹记录
          <a
            href={`/places/${w.place_id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-ink-700 hover:bg-ink-100"
          >
            <MessageCircle className="size-4" />
            大家怎么说
            {place && (place.rating_avg > 0 || place.recommend_count > 0 || place.avoid_count > 0) && (
              <span className={cn('text-xs', place.avoid_count > place.recommend_count ? 'text-red-600' : 'text-ink-400')}>
                {[
                  place.rating_avg > 0 && `★${place.rating_avg.toFixed(1)}`,
                  place.recommend_count > 0 && `👍${place.recommend_count}`,
                  place.avoid_count > 0 && `⚠️${place.avoid_count}`,
                ]
                  .filter(Boolean)
                  .join(' ')}
              </span>
            )}
          </a>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 pt-1">
        {todo && (
          <>
            <Button size="lg" block icon={<Check className="size-4" />} onClick={onCheckin}>
              我到了
            </Button>
            <Button size="lg" block variant="outline" icon={<SkipForward className="size-4" />} onClick={onSkip}>
              跳过
            </Button>
          </>
        )}
        {w.status === 'skipped' && (
          <Button size="lg" block variant="outline" icon={<Undo2 className="size-4" />} onClick={onUnskip}>
            恢复为待前往
          </Button>
        )}
        {w.status === 'visited' ? (
          <Button size="lg" block variant="outline" icon={<PenLine className="size-4" />} className="col-span-2" onClick={onEdit}>
            写点评
          </Button>
        ) : (
          <Button size="lg" block variant="ghost" icon={<PenLine className="size-4" />} className={cn(todo && 'col-span-2')} onClick={onEdit}>
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
  const [picker, setPicker] = useState<{ here: [number, number]; far: { name: string; distance: number } | null } | null>(null)
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
  const next = sorted.find((w) => w.planned && w.status === 'todo') ?? null
  // 地点面板里显示的点：从最新的 sorted 里取，打卡 / 跳过后状态随之更新
  const stop = sorted.find((w) => w.id === stopId) ?? null
  const nextDist = next && geo.fix ? haversine(geo.fix.gcj, [next.lng, next.lat]) : null
  const visited = sorted.filter((w) => w.status === 'visited').length
  const plannedTotal = sorted.filter((w) => w.planned).length
  const plannedDone = sorted.filter((w) => w.planned && w.status !== 'todo').length

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
  const checkin = async (waypointId?: number, place?: PickedPlace) => {
    if (!me) return
    if (!waypointId && !place && !geo.fix) return toast.error(geo.error ?? '正在定位，请稍候…')
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
          ...(geo.fix ? { lng: geo.fix.wgs[0], lat: geo.fix.wgs[1], coord_type: 'wgs84' as const } : {}),
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
      toast.success(r.matched_plan ? `已打卡：${r.waypoint.name} ✅` : `新的打卡点：${r.waypoint.name}（计划外）`)
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

  // 「我到了」：200 米内有计划地点就直接打卡（与服务端匹配半径一致），否则先选所在的店铺 / 景点
  const startCheckin = () => {
    if (!geo.fix) return toast.error(geo.error ?? '正在定位，请稍候…')
    const here = geo.fix.gcj
    let nearest: { w: Waypoint; d: number } | null = null
    for (const w of sorted) {
      if (!w.planned || w.status !== 'todo') continue
      const d = haversine(here, [w.lng, w.lat])
      if (!nearest || d < nearest.d) nearest = { w, d }
    }
    if (nearest && nearest.d <= 200) return checkin()
    setPicker({ here, far: nearest && nearest.d > 2000 ? { name: nearest.w.name, distance: nearest.d } : null })
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
    <div className="fixed inset-0 flex flex-col bg-ink-900">
      {/* 顶栏 */}
      <div className="glass pb-2 pt-[max(env(safe-area-inset-top),0.5rem)] z-20 flex items-center gap-2 px-3 shadow-card">
        <Link to={`/trips/${trip.id}`} className="rounded-full p-2 hover:bg-ink-100" aria-label="返回">
          <ArrowLeft className="size-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{trip.title}</div>
          <div className="text-xs text-ink-500">
            {plannedTotal > 0 ? `计划 ${plannedDone}/${plannedTotal}` : `已打卡 ${visited}`}
            {geo.recording && (
              <span className="ml-2 text-red-600">
                ● {fmtDuration(elapsed)} · {formatKm(geo.recordedKm)}
              </span>
            )}
          </div>
        </div>
        {pending > 0 && (
          <button
            type="button"
            onClick={() => {
              if (me) void flushOutbox(me.id)
            }}
            className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700"
            title="联网后会自动同步，点击立即同步"
          >
            <CloudUpload className="size-3.5" />
            {pending} 条待同步
          </button>
        )}
        <Button size="sm" variant="outline" icon={<Flag className="size-4" />} onClick={finish}>
          结束
        </Button>
      </div>

      {/* 地图 */}
      <div className="relative flex-1">
        <BaseMap
          className="absolute inset-0"
          kindSwitcher
          options={{ dragRotate: false }}
          onReady={(m) => {
            mapRef.current = m
            // 手动拖动地图时暂停跟随，否则下一次定位又会拉回当前位置
            m.on('dragstart', () => setFollow(false))
          }}
          overlay={
            <div className="absolute top-14 right-3 z-10 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setFollow((v) => !v)}
                className={cn(
                  'glass flex size-9 items-center justify-center rounded-full shadow-card',
                  follow ? 'text-sky-600' : 'text-ink-500',
                )}
                title={follow ? '跟随中' : '不跟随'}
              >
                <Navigation className={cn('size-4', follow && 'fill-sky-600')} />
              </button>
              <button
                type="button"
                disabled={!sorted.length}
                onClick={() => {
                  setFollow(false)
                  if (mapRef.current) fitTo(mapRef.current, sorted.map((w) => [w.lng, w.lat] as [number, number]))
                }}
                className="glass flex h-9 items-center justify-center rounded-full px-3 text-xs font-medium text-ink-700 shadow-card disabled:opacity-50"
                title="查看全程"
              >
                全程
              </button>
            </div>
          }
        >
          <RouteLines planned={planned} actual={actual} track={segments} />
          <WaypointMarkers waypoints={sorted} selectedId={next?.id} onSelect={(w) => setStopId(w.id)} />
          <UserDot position={geo.fix?.gcj ?? null} accuracy={geo.fix?.accuracy} />
          {!geo.fix && <FitOnce points={sorted.map((w) => [w.lng, w.lat])} fitKey={`go-${trip.id}`} />}
          <Follow pos={geo.fix?.gcj ?? null} enabled={follow} />
        </BaseMap>
        {(stale || geo.error) && (
          <div className="absolute top-3 left-3 z-10 flex max-w-[70%] flex-col items-start gap-2">
            {stale && (
              <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 shadow-card">
                <WifiOff className="mr-1 inline size-3.5" />
                {netDown ? '网络不佳，显示的是上次加载的数据' : `${errorMessage(error)}，显示的是上次加载的数据`}
              </div>
            )}
            {geo.error && (
              <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 shadow-card">
                <TriangleAlert className="mr-1 inline size-3.5" />
                {geo.error}
                {geo.blocked && <div className="mt-1 text-amber-700">仍可在「下一站」卡片点「已到达」手动打卡</div>}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部面板 */}
      <div className="pb-safe relative z-20 max-h-[62dvh] overflow-y-auto rounded-t-3xl bg-white shadow-float">
        <button
          type="button"
          onClick={() => setSheetOpen((v) => !v)}
          className="sticky top-0 z-10 flex w-full justify-center bg-white pt-2 pb-1"
          aria-label="展开或收起"
        >
          {sheetOpen ? <ChevronDown className="size-5 text-ink-400" /> : <ChevronUp className="size-5 text-ink-400" />}
        </button>

        <div className="px-4 pb-4">
          {/* 下一站 */}
          {next ? (
            <div className="rounded-2xl bg-sky-50 p-3">
              <div className="flex items-center gap-2.5">
                <WaypointNumber w={next} label={String(sorted.indexOf(next) + 1)} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-sky-700">下一站{nextDist != null && ` · 距离 ${formatDistance(nextDist)}`}</div>
                  <div className="truncate font-semibold">{next.name}</div>
                </div>
                {/* key：手动选的出行方式不带到下一站 */}
                <NavigateMenu
                  key={next.id}
                  target={{ lng: next.lng, lat: next.lat, name: next.name, address: next.address }}
                  distanceM={nextDist}
                  size="sm"
                  variant="primary"
                />
              </div>
              {sheetOpen && next.note && <p className="mt-2 text-xs leading-relaxed text-sky-900/70">{next.note}</p>}
              {sheetOpen && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <Button
                    size="lg"
                    block
                    variant="outline"
                    icon={<Check className="size-4" />}
                    disabled={checking || skipping}
                    onClick={() => checkin(next.id)}
                  >
                    已到达
                  </Button>
                  <Button
                    size="lg"
                    block
                    variant="ghost"
                    icon={<SkipForward className="size-4" />}
                    loading={skipping}
                    disabled={checking}
                    onClick={() => skip(next)}
                  >
                    跳过
                  </Button>
                </div>
              )}
            </div>
          ) : (
            plannedTotal > 0 && (
              <div className="rounded-2xl bg-emerald-50 p-3 text-sm text-emerald-800">🎉 计划的地点都走完了！可以结束旅行，看看计划和实际的对比。</div>
            )
          )}

          {wxTip && (
            <div className="mt-3 flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">当前在微信中：无法唤起导航 App，建议点右上角「···」→「在浏览器打开」使用旅行模式</span>
              <button type="button" onClick={() => setWxTip(false)} className="shrink-0 text-amber-600" aria-label="关闭提示">
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {/* 主操作 */}
          <div className="mt-3 grid grid-cols-4 gap-2">
            <button
              type="button"
              disabled={checking}
              onClick={startCheckin}
              className="bg-brand-gradient col-span-2 flex h-14 items-center justify-center gap-2 rounded-2xl font-bold text-white shadow-lg shadow-brand-500/30 disabled:opacity-60"
            >
              {checking ? <Spinner className="text-white" /> : <MapPinPlus className="size-5" />}
              我到了，打卡
            </button>
            <button
              type="button"
              onClick={() => recommend()}
              className="flex h-14 flex-col items-center justify-center gap-0.5 rounded-2xl bg-violet-50 text-xs font-medium text-violet-700"
            >
              <Sparkles className="size-5" />
              推荐下一站
            </button>
            <button
              type="button"
              onClick={() => photoInput.current?.click()}
              className="flex h-14 flex-col items-center justify-center gap-0.5 rounded-2xl bg-ink-100 text-xs font-medium text-ink-700"
            >
              <Camera className="size-5" />
              拍照
            </button>
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
              {trip.phase === 'planning' && (
                <p className="mt-1.5 text-center text-xs text-ink-400">第一次打卡、拍照或记录轨迹时自动开始旅行</p>
              )}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Button
                  variant={geo.recording ? 'danger' : 'outline'}
                  icon={geo.recording ? <CircleStop className="size-4" /> : <Radio className="size-4" />}
                  onClick={toggleRecord}
                >
                  {geo.recording ? '停止记录轨迹' : '记录 GPS 轨迹'}
                </Button>
                <Button variant="outline" icon={<ListChecks className="size-4" />} onClick={() => setShowList((v) => !v)}>
                  {showList ? '收起行程' : `行程清单 (${sorted.length})`}
                </Button>
              </div>
              {geo.recording && <p className="mt-1.5 text-center text-xs text-ink-400">记录时请保持此页面打开（已尝试保持屏幕常亮）</p>}

              {/* 推荐结果 */}
              {(recLoading || rec) && (
                <div className="mt-4">
                  <h3 className="mb-2 flex items-center gap-1.5 font-bold">
                    <Sparkles className="size-4 text-violet-500" />
                    推荐下一站
                    {rec?.ai_used && <span className="rounded bg-violet-100 px-1.5 text-[10px] text-violet-700">AI</span>}
                  </h3>
                  {recLoading ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-ink-400">
                      <Spinner />
                      {site?.ai_enabled ? 'AI 正在结合你的位置、时间和大家的评价挑选…' : '正在查找附近值得去的地方…'}
                    </div>
                  ) : (
                    rec && (
                      <div className="space-y-2">
                        {rec.ai_text && <p className="rounded-xl bg-violet-50 p-3 text-sm leading-relaxed text-violet-900">{rec.ai_text}</p>}
                        {rec.warnings.map((w) => (
                          // 新标签页打开：离开旅行模式会中断 GPS 轨迹记录
                          <Link
                            key={w.place_id}
                            to={`/places/${w.place_id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-800"
                          >
                            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                            <span>
                              <b>避雷：{w.name}</b>（{formatDistance(w.distance_m)}）— {w.reason}
                            </span>
                          </Link>
                        ))}
                        {rec.suggestions.length === 0 && <p className="py-4 text-center text-sm text-ink-400">附近暂时没有推荐的地点</p>}
                        {rec.suggestions.map((s, i) => (
                          <div key={i} className="flex items-start gap-3 rounded-xl bg-ink-50 p-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-semibold">{s.name}</span>
                                <CategoryChip category={s.category} />
                                <span className={cn('rounded px-1.5 text-[11px]', sourceLabel[s.source].cls)}>{sourceLabel[s.source].label}</span>
                              </div>
                              <p className="mt-1 text-xs text-ink-500">
                                {formatDistance(s.distance_m)} · {s.reason}
                              </p>
                            </div>
                            <div className="flex shrink-0 flex-col gap-1.5">
                              {s.source !== 'plan' && (
                                <Button
                                  size="xs"
                                  icon={<Plus className="size-3.5" />}
                                  loading={addingSug === s}
                                  disabled={!!addingSug}
                                  onClick={() => addSuggestion(s)}
                                >
                                  加入
                                </Button>
                              )}
                              <NavigateMenu target={{ lng: s.lng, lat: s.lat, name: s.name, address: s.address }} distanceM={s.distance_m} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  )}
                </div>
              )}

              {/* 行程清单 */}
              {showList && (
                <div className="mt-4 space-y-1.5">
                  {sorted.map((w, i) => (
                    <button
                      type="button"
                      key={w.id}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-xl p-2 text-left transition hover:bg-ink-50',
                        w.status === 'skipped' && 'opacity-50',
                      )}
                      onClick={() => setStopId(w.id)}
                    >
                      <WaypointNumber w={w} label={String(i + 1)} />
                      <span className={cn('min-w-0 flex-1 truncate text-sm', w.status === 'skipped' && 'line-through')}>{w.name}</span>
                      {w.status === 'visited' && <Check className="size-4 text-emerald-500" />}
                      {!w.planned && <span className="text-[11px] text-violet-600">计划外</span>}
                    </button>
                  ))}
                </div>
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
            void checkin(undefined, p ?? undefined)
          }}
        />
      )}

      <Modal open={!!stop} onClose={() => setStopId(null)} title={stop?.name}>
        {stop && (
          <StopSheet
            w={stop}
            label={String(sorted.indexOf(stop) + 1)}
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
            {review.status === 'visited' && <p className="mb-3 text-sm text-ink-500">记下真实体验，帮之后来的人避雷～</p>}
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
