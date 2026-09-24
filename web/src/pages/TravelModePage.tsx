import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Flag,
  ListChecks,
  MapPinPlus,
  Navigation,
  Plus,
  Radio,
  SkipForward,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Recommendation, type Suggestion, type Waypoint } from '@/api'
import { WaypointForm } from '@/components/editor/WaypointForm'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { FitOnce, RouteLines, UserDot, WaypointMarkers } from '@/components/map/layers'
import { NavigateMenu } from '@/components/trip/NavigateMenu'
import { WaypointNumber } from '@/components/trip/WaypointItem'
import { Button, CategoryChip, Empty, Modal, PageLoader, Spinner, confirmDialog } from '@/components/ui'
import { useGeoTracker } from '@/hooks/useGeoTracker'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'
import { fmtDuration } from '@/lib/format'
import { formatDistance, formatKm, haversine } from '@/lib/geo'
import { compressImage } from '@/lib/photo'
import { actualPath, bySeq, plannedPath, trackSegments } from '@/lib/trip'

function Follow({ pos, enabled }: { pos: [number, number] | null; enabled: boolean }) {
  const map = useMap()
  const first = useRef(true)
  useEffect(() => {
    if (!map || !pos || !enabled) return
    map.easeTo({ center: pos, zoom: first.current ? 16 : map.getZoom(), duration: first.current ? 0 : 600 })
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

export default function TravelModePage() {
  const { id } = useParams()
  const tripId = Number(id)
  const nav = useNavigate()
  const qc = useQueryClient()
  const key = ['trip', id]
  const { data: trip, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.trips.get(id!) })
  const { data: track } = useQuery({ queryKey: ['track', tripId], queryFn: () => api.trips.track(tripId), enabled: !!trip })
  const { data: site } = useSite()
  const geo = useGeoTracker(tripId)
  useTicker(geo.recording)

  const [follow, setFollow] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(true)
  const [checking, setChecking] = useState(false)
  const [review, setReview] = useState<Waypoint | null>(null)
  const [savingReview, setSavingReview] = useState(false)
  const [rec, setRec] = useState<Recommendation | null>(null)
  const [recLoading, setRecLoading] = useState(false)
  const [showList, setShowList] = useState(false)
  const photoInput = useRef<HTMLInputElement>(null)

  const sorted = useMemo(() => (trip ? [...trip.waypoints].sort(bySeq) : []), [trip])
  const planned = useMemo(() => plannedPath(sorted), [sorted])
  const actual = useMemo(() => actualPath(sorted), [sorted])
  const segments = useMemo(() => {
    const s = trackSegments(track)
    return geo.livePath.length > 1 ? [...s, geo.livePath] : s
  }, [track, geo.livePath])
  const next = sorted.find((w) => w.planned && w.status === 'todo') ?? null
  const nextDist = next && geo.fix ? haversine(geo.fix.gcj, [next.lng, next.lat]) : null
  const visited = sorted.filter((w) => w.status === 'visited').length
  const plannedTotal = sorted.filter((w) => w.planned).length
  const plannedDone = sorted.filter((w) => w.planned && w.status !== 'todo').length

  // 进入页面时若还在规划中，自动切换为旅行中
  useEffect(() => {
    if (trip?.can_edit && trip.phase === 'planning') {
      api.trips
        .update(trip.id, { phase: 'ongoing' })
        .then((t) => qc.setQueryData(key, t))
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.id])

  if (isLoading) return <PageLoader />
  if (error || !trip) return <Empty className="min-h-dvh" title="旅程不存在或无权访问" desc={errorMessage(error)} />
  if (!trip.can_edit) return <Empty className="min-h-dvh" title="只有旅程成员可以使用旅行模式" />

  const refresh = () => qc.invalidateQueries({ queryKey: key })

  const checkin = async (waypointId?: number) => {
    if (!geo.fix && !waypointId) return toast.error(geo.error ?? '正在定位，请稍候…')
    setChecking(true)
    try {
      const r = await api.trips.checkin(trip.id, {
        waypoint_id: waypointId ?? null,
        ...(geo.fix ? { lng: geo.fix.wgs[0], lat: geo.fix.wgs[1], coord_type: 'wgs84' as const } : {}),
      })
      await refresh()
      toast.success(r.matched_plan ? `已打卡：${r.waypoint.name} ✅` : `新的打卡点：${r.waypoint.name}（计划外）`)
      setReview(r.waypoint)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setChecking(false)
    }
  }

  const skip = async (w: Waypoint) => {
    try {
      await api.waypoints.skip(w.id)
      refresh()
      toast(`已跳过：${w.name}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const recommend = async () => {
    setRecLoading(true)
    setSheetOpen(true)
    try {
      const r = await api.trips.recommend(trip.id, {
        ...(geo.fix ? { lng: geo.fix.wgs[0], lat: geo.fix.wgs[1], coord_type: 'wgs84' as const } : {}),
        ai: site?.ai_enabled,
      })
      setRec(r)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setRecLoading(false)
    }
  }

  const addSuggestion = async (s: Suggestion) => {
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
      refresh()
      toast.success(`已加入路线：${s.name}`)
      setRec((r) => (r ? { ...r, suggestions: r.suggestions.filter((x) => x !== s) } : r))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const toggleRecord = async () => {
    if (geo.recording) {
      await geo.stop()
      qc.invalidateQueries({ queryKey: ['track', tripId] })
      toast.success('轨迹已保存')
    } else {
      geo.start(Math.floor(Date.now() / 1000))
      toast.success('开始记录轨迹，请保持页面打开')
    }
  }

  const finish = async () => {
    if (!(await confirmDialog({ title: '结束这次旅行？', desc: '结束后可以查看「计划 vs 实际」对比，并继续补充游记。', okText: '结束旅行' })))
      return
    if (geo.recording) await geo.stop()
    try {
      await api.trips.update(trip.id, { phase: 'finished' })
      await refresh()
      nav(trip.waypoints.some((w) => w.planned) ? `/trips/${trip.id}/compare` : `/trips/${trip.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const uploadPhoto = async (file: File) => {
    const tId = toast.loading('照片上传中…')
    try {
      const { blob } = await compressImage(file)
      const r = await api.photos.upload(trip.id, blob, {
        filename: 'photo.jpg',
        ...(geo.fix ? { lng: geo.fix.wgs[0], lat: geo.fix.wgs[1], coord_type: 'wgs84' as const } : {}),
        taken_at: new Date().toISOString(),
        auto_waypoint: true,
      })
      await refresh()
      toast.success(r.waypoint ? `照片已关联到：${r.waypoint.name}` : '照片已上传', { id: tId })
    } catch (e) {
      toast.error(errorMessage(e), { id: tId })
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
            </div>
          }
        >
          <RouteLines planned={planned} actual={actual} track={segments} />
          <WaypointMarkers waypoints={sorted} selectedId={next?.id} onSelect={(w) => setReview(w)} />
          <UserDot position={geo.fix?.gcj ?? null} accuracy={geo.fix?.accuracy} />
          {!geo.fix && <FitOnce points={sorted.map((w) => [w.lng, w.lat])} fitKey={`go-${trip.id}`} />}
          <Follow pos={geo.fix?.gcj ?? null} enabled={follow} />
        </BaseMap>
        {geo.error && (
          <div className="absolute top-3 left-3 z-10 max-w-[70%] rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 shadow-card">
            <TriangleAlert className="mr-1 inline size-3.5" />
            {geo.error}
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
          {sheetOpen ? <ChevronDown className="size-5 text-ink-300" /> : <ChevronUp className="size-5 text-ink-300" />}
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
                <NavigateMenu target={{ lng: next.lng, lat: next.lat, name: next.name, address: next.address }} size="sm" variant="primary" />
              </div>
              {sheetOpen && next.note && <p className="mt-2 text-xs leading-relaxed text-sky-900/70">{next.note}</p>}
              {sheetOpen && (
                <div className="mt-2 flex gap-2">
                  <Button size="xs" variant="outline" icon={<Check className="size-3.5" />} onClick={() => checkin(next.id)}>
                    已到达
                  </Button>
                  <Button size="xs" variant="ghost" icon={<SkipForward className="size-3.5" />} onClick={() => skip(next)}>
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

          {/* 主操作 */}
          <div className="mt-3 grid grid-cols-4 gap-2">
            <button
              type="button"
              disabled={checking}
              onClick={() => checkin()}
              className="bg-brand-gradient col-span-2 flex h-14 items-center justify-center gap-2 rounded-2xl font-bold text-white shadow-lg shadow-brand-500/30 disabled:opacity-60"
            >
              {checking ? <Spinner className="text-white" /> : <MapPinPlus className="size-5" />}
              我到了，打卡
            </button>
            <button
              type="button"
              onClick={recommend}
              className="flex h-14 flex-col items-center justify-center gap-0.5 rounded-2xl bg-violet-50 text-xs font-medium text-violet-700"
            >
              <Sparkles className="size-5" />
              下一站?
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
                          <Link
                            key={w.place_id}
                            to={`/places/${w.place_id}`}
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
                                <Button size="xs" icon={<Plus className="size-3.5" />} onClick={() => addSuggestion(s)}>
                                  加入
                                </Button>
                              )}
                              <NavigateMenu target={{ lng: s.lng, lat: s.lat, name: s.name, address: s.address }} />
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
                    <div
                      key={w.id}
                      className={cn('flex items-center gap-2.5 rounded-xl p-2', w.status === 'skipped' && 'opacity-50')}
                      onClick={() => setReview(w)}
                    >
                      <WaypointNumber w={w} label={String(i + 1)} />
                      <span className={cn('min-w-0 flex-1 truncate text-sm', w.status === 'skipped' && 'line-through')}>{w.name}</span>
                      {w.status === 'visited' && <Check className="size-4 text-emerald-500" />}
                      {!w.planned && <span className="text-[11px] text-violet-600">计划外</span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Modal open={!!review} onClose={() => setReview(null)} title={review ? `「${review.name}」怎么样？` : ''}>
        {review && (
          <>
            <p className="mb-3 text-sm text-ink-500">记下真实体验，帮之后来的人避雷～</p>
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
