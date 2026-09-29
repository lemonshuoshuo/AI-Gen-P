import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { MapMouseEvent } from 'maplibre-gl'
import { ArrowLeft, Box, Crosshair, Eye, Heart, Loader2, Mountain, Play, Star, Trash2, UserPlus, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, isNotFound, type Phase, type TripDetail, type TripMember, type Visibility, type Waypoint, type WaypointInput } from '@/api'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { FitOnce, RouteSegments, fitTo } from '@/components/map/layers'
import { ArrangeDialog } from '@/components/editor/ArrangeDialog'
import { ChoiceChip } from '@/components/editor/Choice'
import { RoutePlanner, poolName, type PickTarget, type PlanTab } from '@/components/editor/DayPlanner'
import { MapPicker, geoPickUnsupported } from '@/components/editor/MapPicker'
import { PhotoImporter } from '@/components/editor/PhotoImporter'
import { planLegs, useTripLegs } from '@/components/editor/RouteLegs'
import { SaveButton } from '@/components/editor/SaveButton'
import {
  ChangesDialog,
  CoEditHint,
  ConflictDialog,
  DraftStatus,
  LeaveDialog,
  PresenceBadge,
  RemoteNotice,
  RestoreDialog,
  SyncedNote,
} from '@/components/editor/SyncUI'
import { TrackPanel } from '@/components/editor/TrackPanel'
import { diffPlan, isNew } from '@/components/editor/planDraft'
import { PlanEditorProvider, usePlanEditor, usePlanEditorCtx, useUnsavedWarning } from '@/components/editor/usePlanEditor'
import { PlanMarkers, planMarkerItems } from '@/components/trip/PlanMarkers'
import { actualSegments, groupPlan, isLodging, plannedSegments, stopLabels, type PlanGroups } from '@/components/trip/plan'
import { Avatar, Button, Empty, Field, Input, LoadError, PageLoader, Select, Switch, Textarea, buttonClass, confirmDialog } from '@/components/ui'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { phases, visibilities } from '@/lib/meta'
import { bySeq, visitedInOrder } from '@/lib/trip'
import { useAuth } from '@/stores/auth'

type Panel = 'route' | 'info' | 'photos' | 'track' | 'members'
type LngLat = [number, number]

function MapClick({ enabled, onClick }: { enabled: boolean; onClick: (p: LngLat) => void }) {
  const map = useMap()
  const cb = useRef(onClick)
  cb.current = onClick
  useEffect(() => {
    if (!map || !enabled) return
    const h = (e: MapMouseEvent) => cb.current([e.lngLat.lng, e.lngLat.lat])
    map.getCanvas().style.cursor = 'crosshair'
    map.on('click', h)
    return () => {
      map.off('click', h)
      map.getCanvas().style.cursor = ''
    }
  }, [map, enabled])
  return null
}

function FlyTo({ target }: { target: LngLat | null }) {
  const map = useMap()
  useEffect(() => {
    if (map && target) map.flyTo({ center: target, zoom: Math.max(map.getZoom(), 14), duration: 700 })
  }, [map, target])
  return null
}

/** 切换「全部 / 第 N 天 / 想去」时把地图缩放到那一部分 */
function FitTab({ points, tabKey }: { points: LngLat[]; tabKey: string }) {
  const map = useMap()
  const last = useRef(tabKey)
  const pts = useRef(points)
  pts.current = points
  useEffect(() => {
    if (!map || last.current === tabKey) return
    last.current = tabKey
    if (pts.current.length) fitTo(map, pts.current, { padding: 70, maxZoom: 15, duration: 700 })
  }, [map, tabKey])
  return null
}

/** 地图上的胶囊按钮：玻璃底 + 细线；按下时为强调色边框 + 底色 */
const mapChip = (on: boolean) =>
  cn(
    'inline-flex h-10 items-center gap-1.5 rounded-full border px-4 text-[13px] tracking-[0.02em] transition-colors duration-300',
    on ? 'border-brand-500 bg-brand-100 text-ink-900' : 'glass border-ink-900/15 text-ink-800 hover:border-ink-900/45 hover:text-ink-900',
  )

/** 地图左上角：点选地点、3D 视角（倾斜地图看路线的起伏走向） */
function MapTools({
  pickMode,
  picking,
  onTogglePick,
  targetLabel,
  compact,
}: {
  pickMode: boolean
  picking: boolean
  onTogglePick: () => void
  /** 点选的地点加到哪里，如「第 2 天」 */
  targetLabel: string
  /** 手机上展开编辑框时地图很矮：只留「在地图上点选」 */
  compact?: boolean
}) {
  const map = useMap()
  const desktop = useIsDesktop()
  const [tilted, setTilted] = useState(false)
  useEffect(() => {
    if (!map) return
    const sync = () => setTilted(map.getPitch() > 15)
    sync()
    map.on('pitchend', sync)
    return () => {
      map.off('pitchend', sync)
    }
  }, [map])
  const toggleTilt = () => {
    if (!map) return
    const next = !tilted
    setTilted(next)
    map.easeTo(next ? { pitch: 55, bearing: -15, duration: 1100 } : { pitch: 0, bearing: 0, duration: 900 })
  }
  return (
    <div className="absolute top-4 left-4 z-10 flex max-w-[calc(100%-7.5rem)] flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onTogglePick} aria-pressed={pickMode} className={mapChip(pickMode)}>
          {pickMode ? <X className="size-4" strokeWidth={1.5} /> : <Crosshair className="size-4" strokeWidth={1.5} />}
          {pickMode ? '取消点选' : '在地图上点选'}
        </button>
        {!compact && (
          <button
            type="button"
            onClick={toggleTilt}
            aria-pressed={tilted}
            title={tilted ? '回到平面视角' : '倾斜地图，立体地看路线'}
            className={mapChip(tilted)}
          >
            <Mountain className="size-4" strokeWidth={1.5} />
            3D 视角
          </button>
        )}
      </div>
      {/* 宽屏上候选面板会盖住这条提示：选了位置后不再显示 */}
      {pickMode && !(picking && desktop) && (
        <p className="glass animate-fade-in max-w-xs rounded-2xl border border-ink-900/15 px-4 py-2 text-xs leading-relaxed text-ink-700">
          {picking ? '点地图上的其他位置，可以重新选择' : `点击地图上的景点、店铺或任意位置，选好后加到${targetLabel}`}
        </p>
      )}
    </div>
  )
}

/** 面板里的小节头：一条细线 + 一行小字（左标签、右计数） */
function PanelHead({ eyebrow, count, aside }: { eyebrow: string; count?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-ink-200 pt-3.5 pb-1">
      <p className="flex items-baseline gap-3">
        <span className="eyebrow !text-ink-900">{eyebrow}</span>
        {count != null && <span className="caption !text-xs">{count}</span>}
      </p>
      {aside && <div className="caption shrink-0 !text-xs">{aside}</div>}
    </div>
  )
}

/** 面板页签：选中为强调色下划线 + 实心小圆点 + 淡底色 */
function PanelTabs({ value, onChange, options }: { value: Panel; onChange: (p: Panel) => void; options: { value: Panel; label: string; count?: number }[] }) {
  return (
    <div role="tablist" aria-label="编辑内容" className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto border-b border-ink-200">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative flex h-10 shrink-0 items-center gap-1.5 rounded-t-md px-3 text-[13.5px] tracking-[0.02em] transition-colors duration-200',
              on ? 'bg-brand-50 font-medium text-ink-900' : 'text-ink-500 hover:text-ink-900',
            )}
          >
            {on && <span aria-hidden className="size-1.5 rounded-full bg-brand-500" />}
            {o.label}
            {o.count ? <span className={cn('font-num text-[13px]', on ? 'text-ink-700' : 'text-ink-400')}>{o.count}</span> : null}
            <span aria-hidden className={cn('absolute inset-x-0 -bottom-px h-0.5 rounded-full', on ? 'bg-brand-500' : 'bg-transparent')} />
          </button>
        )
      })}
    </div>
  )
}

/* ---------------- 旅程信息 ---------------- */
const parseTags = (v: string) =>
  v
    .split(/[\s,，#]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10)

/** 旅程信息：直接改草稿，和路线一起保存 */
function InfoPanel({ trip, onSave }: { trip: TripDetail; onSave: () => void }) {
  const editor = usePlanEditorCtx()
  const set = editor.setInfo
  // 标签输入框保留用户输入的原样（如末尾的空格），草稿里存解析后的数组；草稿从别处变了（放弃修改、载入对方的版本）时跟着变
  const tagKey = trip.tags.join(' ')
  const [tags, setTags] = useState(tagKey)
  const [seenTags, setSeenTags] = useState(tagKey)
  if (seenTags !== tagKey) {
    setSeenTags(tagKey)
    if (parseTags(tags).join(' ') !== tagKey) setTags(tagKey)
  }
  const infoDirty = editor.changes.some((c) => c.kind === 'trip')

  return (
    <div className="space-y-10">
      <section className="space-y-5">
        <PanelHead eyebrow="Basics · 基本信息" aside={infoDirty ? <span className="text-brand-600">有未保存的修改</span> : undefined} />
        <Field label="标题">
          <Input value={trip.title} onChange={(e) => set({ title: e.target.value })} maxLength={100} className="font-display h-12 text-[18px]" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="开始日期">
            <Input type="date" value={trip.start_date ?? ''} onChange={(e) => set({ start_date: e.target.value || null })} />
          </Field>
          <Field label="结束日期">
            <Input
              type="date"
              value={trip.end_date ?? ''}
              min={trip.start_date ?? undefined}
              onChange={(e) => set({ end_date: e.target.value || null })}
            />
          </Field>
        </div>
        <p className="-mt-2 text-xs text-ink-400">设置了日期时按日期分天；没有日期也可以在「路线」里直接设置玩几天</p>
        <div>
          <span className="mb-2 block text-xs font-medium tracking-[0.06em] text-ink-500">旅程状态</span>
          <div role="radiogroup" aria-label="旅程状态" className="flex flex-wrap gap-1.5">
            {(Object.keys(phases) as Phase[]).map((p) => (
              <ChoiceChip key={p} selected={trip.phase === p} onClick={() => set({ phase: p })}>
                {phases[p].label}
              </ChoiceChip>
            ))}
          </div>
        </div>
      </section>
      {trip.is_owner && (
        <section className="space-y-5">
          <PanelHead eyebrow="Sharing · 谁能看到" />
          <div>
            <span className="mb-2 block text-xs font-medium tracking-[0.06em] text-ink-500">谁可以看</span>
            <div role="radiogroup" aria-label="谁可以看" className="flex flex-wrap gap-1.5">
              {(['private', 'unlisted', 'public'] as Visibility[]).map((v) => (
                <ChoiceChip key={v} selected={trip.visibility === v} onClick={() => set({ visibility: v })}>
                  {visibilities[v].label}
                </ChoiceChip>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-ink-400">
              {visibilities[trip.visibility].desc}
              {trip.status === 'pending' && <span className="mt-0.5 block text-amber-700">公开申请审核中，通过后才会出现在发现广场</span>}
              {trip.status === 'hidden' && <span className="mt-0.5 block text-brand-600">已被管理员隐藏，改为公开也不会显示</span>}
            </p>
          </div>
          <Field
            label="旅行中实时公开位置"
            hint={
              trip.live_share ? (
                <span className="text-amber-700">已开启：能看到这段旅程的人可以实时看到你们的打卡、照片和 GPS 轨迹；私密旅程仍只有成员可见</span>
              ) : (
                '关闭时（默认），旅行中其他人只能看到计划路线；你们的打卡、照片和 GPS 轨迹在旅程结束后才公开'
              )
            }
          >
            <Switch checked={trip.live_share} onChange={(v) => set({ live_share: v })} />
          </Field>
        </section>
      )}
      <section className="space-y-5">
        <PanelHead eyebrow="Journal · 游记" />
        <Field label="一句话简介">
          <Textarea value={trip.summary} onChange={(e) => set({ summary: e.target.value })} maxLength={500} className="font-display min-h-20 text-[16px]" />
        </Field>
        <Field label="游记正文" hint="支持 Markdown：## 标题、**加粗**、- 列表">
          <Textarea
            value={trip.content}
            onChange={(e) => set({ content: e.target.value })}
            className="min-h-56 leading-7"
            placeholder="写写这段旅程的故事、整体攻略、预算、交通建议…"
          />
        </Field>
        <Field label="标签" hint="空格分隔，如：情侣 美食 周末游">
          <Input
            value={tags}
            onChange={(e) => {
              setTags(e.target.value)
              set({ tags: parseTags(e.target.value) })
            }}
          />
        </Field>
      </section>
      <div className="space-y-2 border-t border-ink-200 pt-5">
        <Button block variant={editor.dirty ? 'primary' : 'outline'} loading={editor.saving} onClick={onSave}>
          {editor.dirty ? `保存全部修改（${editor.changes.length} 处）` : '全部已保存'}
        </Button>
        <p className="text-center text-[11.5px] text-ink-400">旅程信息和路线一起保存；保存前只在你这里</p>
      </div>
    </div>
  )
}

/* ---------------- 照片 ---------------- */
function PhotosPanel({ trip, refresh }: { trip: TripDetail; refresh: () => void }) {
  const qc = useQueryClient()
  const key = ['trip', String(trip.id)]
  // 正在删除的照片：立即从列表里去掉，进行中不能再点
  const [removing, setRemoving] = useState<ReadonlySet<number>>(() => new Set())
  const setCover = async (url: string) => {
    try {
      const t = await api.trips.update(trip.id, { cover_url: url })
      qc.setQueryData(key, t)
      invalidateTripLists(qc)
      toast.success('已设为封面')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const remove = async (id: number) => {
    if (removing.has(id)) return
    if (!(await confirmDialog({ title: '删除这张照片？', danger: true, okText: '删除' }))) return
    setRemoving((s) => new Set(s).add(id))
    qc.setQueryData<TripDetail>(key, (t) => (t ? { ...t, photos: t.photos.filter((p) => p.id !== id) } : t))
    try {
      await api.photos.remove(id)
    } catch (e) {
      // 已经删掉了（连点、同行的人先删了）按成功处理
      if (!isNotFound(e)) toast.error(errorMessage(e))
    } finally {
      setRemoving((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
      refresh()
    }
  }
  const assign = async (id: number, wid: number) => {
    qc.setQueryData<TripDetail>(key, (t) => (t ? { ...t, photos: t.photos.map((p) => (p.id === id ? { ...p, waypoint_id: wid || null } : p)) } : t))
    try {
      await api.photos.update(id, { waypoint_id: wid })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      refresh()
    }
  }
  // 还没保存的新地点没有 ID，不能关联照片
  const sorted = trip.waypoints.filter((w) => !isNew(w)).sort(bySeq)
  const photos = trip.photos.filter((p) => !removing.has(p.id))
  return (
    <div className="space-y-8">
      <PhotoImporter tripId={trip.id} onDone={refresh} defaultAuto={trip.phase !== 'planning'} compact={photos.length > 0} />
      {photos.length > 0 && (
        <>
          <PanelHead eyebrow="Photos · 照片" count={`${photos.length} 张`} />
          <div className="grid grid-cols-2 gap-x-3 gap-y-6">
            {photos.map((p) => {
              const isCover = trip.cover_url === p.url
              return (
                <figure key={p.id} className="min-w-0">
                  <div className="group relative aspect-[4/5] overflow-hidden bg-ink-100">
                    <img
                      src={p.thumb_url}
                      alt=""
                      loading="lazy"
                      className="size-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.03]"
                    />
                    {isCover && (
                      <span className="eyebrow absolute top-2 left-2 rounded-full bg-black/55 px-2 py-0.5 !text-[10px] !text-white backdrop-blur">
                        Cover · 封面
                      </span>
                    )}
                  </div>
                  <figcaption className="mt-2.5 space-y-1.5">
                    <Select
                      value={p.waypoint_id ?? 0}
                      onChange={(e) => assign(p.id, Number(e.target.value))}
                      className="h-9 rounded-md pl-2.5 text-xs"
                      aria-label="关联打卡点"
                    >
                      <option value={0}>未关联打卡点</option>
                      {sorted.map((w, i) => (
                        <option key={w.id} value={w.id}>
                          {isLodging(w) ? '住宿' : i + 1}. {w.name}
                        </option>
                      ))}
                    </Select>
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        disabled={isCover}
                        onClick={() => setCover(p.url)}
                        className="flex h-9 items-center gap-1.5 text-xs text-ink-500 transition-colors hover:text-ink-900 disabled:text-ink-400"
                      >
                        <Star className={cn('size-3.5', isCover && 'fill-ink-400')} strokeWidth={1.5} />
                        {isCover ? '当前封面' : '设为封面'}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(p.id)}
                        className="-mr-2 flex size-9 items-center justify-center rounded-full text-ink-400 transition-colors hover:text-brand-600"
                        aria-label="删除照片"
                      >
                        <Trash2 className="size-3.5" strokeWidth={1.25} />
                      </button>
                    </div>
                  </figcaption>
                </figure>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/* ---------------- 成员 ---------------- */
function MembersPanel({ trip }: { trip: TripDetail }) {
  const me = useAuth((s) => s.user)
  const qc = useQueryClient()
  const nav = useNavigate()
  const mkey = ['members', trip.id]
  const { data: members = [], refetch } = useQuery({ queryKey: mkey, queryFn: () => api.trips.members(trip.id) })
  const [name, setName] = useState('')
  const [removing, setRemoving] = useState<ReadonlySet<number>>(() => new Set())
  const invite = async (username: string) => {
    try {
      await api.trips.invite(trip.id, username)
      toast.success('邀请已发送')
      setName('')
      refetch()
      qc.invalidateQueries({ queryKey: ['trip', String(trip.id)] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const remove = async (m: TripMember) => {
    if (removing.has(m.user.id)) return
    const self = m.user.id === me?.id
    const who = m.user.nickname || m.user.username
    const ok = await confirmDialog(
      self
        ? { title: '退出这段旅程？', desc: '退出后将不能再编辑；如果是私密旅程也将无法查看。需要作者重新邀请才能再加入。', danger: true, okText: '退出' }
        : m.status === 'pending'
          ? { title: `撤回对 ${who} 的邀请？`, danger: true, okText: '撤回' }
          : { title: `移除共同作者 ${who}？`, desc: 'TA 添加的打卡点和照片会保留；再次加入需要重新邀请。', danger: true, okText: '移除' },
    )
    if (!ok) return
    setRemoving((s) => new Set(s).add(m.user.id))
    // 立即从列表里去掉
    if (!self) qc.setQueryData<TripMember[]>(mkey, (list) => list?.filter((x) => x.user.id !== m.user.id))
    try {
      await api.trips.removeMember(trip.id, m.user.id)
    } catch (e) {
      // 已经不在了（连点、对方已退出）按成功处理
      if (!isNotFound(e)) {
        toast.error(errorMessage(e))
        refetch()
        setRemoving((s) => {
          const n = new Set(s)
          n.delete(m.user.id)
          return n
        })
        return
      }
    }
    // 自己退出后这段旅程不再出现在「我的旅程」里；移除情侣后也不再算「一起」的旅程
    invalidateTripLists(qc)
    if (self) {
      toast.success('已退出这段旅程')
      // 退出后已无权编辑，私密旅程连详情也看不到（404）：回「我的旅程」，不回详情页。
      // 离开后再移除缓存，否则当前页会重新请求并得到 403 / 404；也不再刷新成员列表
      await nav('/me/trips', { replace: true })
      qc.removeQueries({ queryKey: ['trip', String(trip.id)] })
      qc.removeQueries({ queryKey: mkey })
      return
    }
    toast.success(m.status === 'pending' ? '已撤回邀请' : '已移除')
    setRemoving((s) => {
      const n = new Set(s)
      n.delete(m.user.id)
      return n
    })
    refetch()
    // 预览页的成员头像、「我们一起」标记
    qc.invalidateQueries({ queryKey: ['trip', String(trip.id)] })
  }
  const partner = me?.partner
  const partnerIn = partner && members.some((m) => m.user.id === partner.id)
  return (
    <div className="space-y-8">
      <p className="text-[14px] leading-[1.8] text-ink-500">共同作者可以一起编辑路线、打卡、上传照片。和情侣一起的旅程会出现在「我们」的足迹里。</p>
      {trip.is_owner && partner && !partnerIn && (
        <button
          type="button"
          onClick={() => invite(partner.username)}
          className="group flex w-full items-center gap-4 border-y border-ink-200 py-4 text-left transition-colors hover:border-pink-400"
        >
          <Avatar user={partner} size={40} />
          <span className="flex-1 text-[14px] text-ink-700">
            把 <span className="font-display text-[17px] text-ink-900">{partner.nickname || partner.username}</span> 加入这段旅程
          </span>
          <Heart className="size-4 text-pink-500 transition-colors group-hover:fill-pink-500" strokeWidth={1.5} />
        </button>
      )}
      {trip.is_owner && (
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="输入对方用户名" aria-label="用户名" />
          <Button
            variant={name.trim() ? 'primary' : 'outline'}
            disabled={!name.trim()}
            onClick={() => invite(name.trim())}
            icon={<UserPlus className="size-4" strokeWidth={1.5} />}
          >
            邀请
          </Button>
        </div>
      )}
      <div>
        <PanelHead eyebrow="Members · 成员" count={members.length ? `${members.length} 人` : undefined} />
        <ul className="divide-y divide-ink-200 border-b border-ink-200">
          {members.map((m) => (
            <li key={m.user.id} className={cn('flex items-center gap-4 py-4', removing.has(m.user.id) && 'opacity-50')}>
              <Avatar user={m.user} size={40} />
              <div className="min-w-0 flex-1 text-[13px] leading-[1.45]">
                <Link
                  to={`/u/${m.user.username}`}
                  className="font-display block truncate text-[18px] leading-snug text-ink-900 transition-colors hover:text-ink-600"
                >
                  {m.user.nickname || m.user.username}
                </Link>
                <div className="caption">
                  {m.role === 'owner' ? '作者' : m.status === 'pending' ? '已邀请，等待接受' : '共同作者'}
                  <span className="mx-1.5 text-ink-300">·</span>
                  <span className="font-num text-[14px]">Lv.{m.user.level}</span>
                </div>
              </div>
              {m.role !== 'owner' && (trip.is_owner || m.user.id === me?.id) && (
                <Button size="sm" variant="outline" loading={removing.has(m.user.id)} onClick={() => remove(m)}>
                  {m.user.id === me?.id ? '退出' : '移除'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** 当前页签在地图上要看的点：某一天为当天的游玩点和出发 / 结束的住宿 */
function tabPoints(g: PlanGroups, tab: PlanTab, all: Waypoint[]): LngLat[] {
  const pts = (list: (Waypoint | null)[]) => list.filter((w): w is Waypoint => !!w).map((w) => [w.lng, w.lat] as LngLat)
  if (tab === 'pool') return pts(g.pool)
  if (typeof tab === 'number') {
    const d = g.days.find((x) => x.day === tab)
    return d ? pts([d.start, ...d.stops, d.end]) : []
  }
  return pts(all)
}

/* ---------------- 页面 ---------------- */
// 切换到另一段旅程时整页重新挂载，编辑状态不会串到另一段旅程
export default function TripEditPage() {
  const { id } = useParams()
  return <TripEditor key={id} />
}

function TripEditor() {
  const { id } = useParams()
  const tripId = Number(id)
  const nav = useNavigate()
  const [params] = useSearchParams()
  const qc = useQueryClient()
  const meId = useAuth((s) => s.user?.id ?? 0)
  const editor = usePlanEditor(tripId)
  const { query, key } = editor
  // 页面显示和编辑的都是本机的草稿；query.data 是服务端的版本
  const trip = editor.trip
  const [panel, setPanel] = useState<Panel>((params.get('panel') as Panel) || 'route')
  const [tab, setTab] = useState<PlanTab>('all')
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [pickTarget, setPickTarget] = useState<PickTarget | null>(null)
  // 地图选点：点击的位置（打开候选面板）
  const [pickPoint, setPickPoint] = useState<LngLat | null>(null)
  const [flyTarget, setFlyTarget] = useState<LngLat | null>(null)
  const [arrangeOpen, setArrangeOpen] = useState<false | 'pool' | 'all'>(false)
  const [changesOpen, setChangesOpen] = useState(false)
  const [hintClosed, setHintClosed] = useState(false)
  const desktop = useIsDesktop()
  // 待滚动到的地点：新加的点要等列表渲染出这一行才能滚过去
  const scrollTo = useRef<number | null>(null)

  // 没有依赖数组：每次渲染后检查，直到这一行出现
  useEffect(() => {
    const id = scrollTo.current
    if (id == null) return
    const el = document.getElementById(`wp-${id}`)
    if (!el) return
    scrollTo.current = null
    el.scrollIntoView({ behavior: 'smooth', block: desktop ? 'center' : 'start' })
  })

  // 保存时某一项出错：选中它，切到路线
  useEffect(() => {
    if (editor.errorId == null) return
    setSelected(editor.errorId)
    setPanel('route')
    setTab('all')
    scrollTo.current = editor.errorId
  }, [editor.errorId])

  // 有未保存的修改时离开：保存并离开 / 不保存 / 继续编辑（站内跳转）；关闭标签页时浏览器提醒，草稿也暂存在本机
  // 已经保存好、主动离开（出发）时不再拦
  const leaving = useRef(false)
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => !leaving.current && editor.dirty && currentLocation.pathname !== nextLocation.pathname,
  )
  useUnsavedWarning(editor.dirty || editor.saving)

  const base = editor.base
  const waypoints = useMemo(() => trip?.waypoints ?? [], [trip])
  const groups = useMemo(() => groupPlan(waypoints, trip?.days ?? 0), [waypoints, trip?.days])
  const labels = useMemo(() => stopLabels(groups), [groups])
  // 路段按已保存的计划向服务端要（真实道路）；草稿里新连起来的两点先按直线估算，保存后再换成真实道路
  const legsQ = useTripLegs(trip?.id, base?.waypoints ?? [], trip?.travel_mode, { geometry: true })
  const planned = useMemo(() => planLegs(groups, legsQ.data?.legs, trip?.travel_mode ?? 'auto'), [groups, legsQ.data, trip?.travel_mode])
  const focus = tab === 'all' ? null : tab
  const segments = useMemo(() => {
    const plan = plannedSegments(groups, planned.legs, { focus })
    if (!trip || trip.phase === 'planning') return plan
    // 旅行中 / 已完成：计划路线照常按天显示，走过的部分再叠一条实线
    return [...plan, ...actualSegments(visitedInOrder(waypoints), planned.legs)]
  }, [groups, planned, focus, trip, waypoints])
  const markers = useMemo(() => planMarkerItems(groups, labels, { focus }), [groups, labels, focus])
  const allPts = useMemo(() => waypoints.map((w) => [w.lng, w.lat] as LngLat), [waypoints])
  const tabPts = useMemo(() => tabPoints(groups, tab, waypoints), [groups, tab, waypoints])
  const restoreChanges = useMemo(() => (editor.restore ? diffPlan(editor.restore.base, editor.restore.draft) : []), [editor.restore])

  const doSaveRef = useRef<() => Promise<boolean>>(async () => false)
  // Ctrl / ⌘ + S 保存
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void doSaveRef.current()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  if (!trip) {
    if (query.isLoading || query.data) return <PageLoader />
    return <LoadError className="min-h-[60vh]" error={query.error} notFoundTitle="旅程不存在或无权编辑" onRetry={() => query.refetch()} />
  }
  // 刷新失败（网络不好）时保留编辑中的内容；404 说明旅程已删除或不再可见
  if (isNotFound(query.error)) return <LoadError className="min-h-[60vh]" error={query.error} notFoundTitle="旅程不存在或无权编辑" onRetry={() => query.refetch()} />
  if (!trip.can_edit) return <Empty className="min-h-[60vh]" title="你没有编辑权限" />

  const planning = trip.phase === 'planning'
  const pName = poolName(trip)
  const near = trip.waypoints.length ? ([trip.waypoints[trip.waypoints.length - 1].lng, trip.waypoints[trip.waypoints.length - 1].lat] as LngLat) : null
  // 地图点选：没有指定时加到当前页签（全部 → 想去）
  const defaultTarget: PickTarget = { kind: 'stop', day: typeof tab === 'number' ? tab : 0 }
  const targetLabel = (t: PickTarget | null) =>
    !t ? '' : t.kind === 'lodging' ? (t.night === 0 ? '出发前一晚的住宿' : `第 ${t.night} 晚的住宿`) : t.day === 0 ? `「${pName}」` : `第 ${t.day} 天`
  const addFlags: WaypointInput = trip.phase === 'finished' ? { planned: false } : { planned: true, status: 'todo' }

  const select = (w: Waypoint, fly = true) => {
    setSelected(w.id)
    if (fly) setFlyTarget([w.lng, w.lat])
  }
  const onAdded = (w: Waypoint, openEditor = false) => {
    select(w)
    if (openEditor) setEditing(w.id)
    // 手机上列表在地图下方：把新加的点滚到地图下面
    scrollTo.current = w.id
    toast.success(w.planned ? `已加入${w.day > 0 ? `第 ${w.day} 天` : `「${pName}」`}：${w.name || '新地点'}` : `已打卡：${w.name}`, {
      description: w.planned ? '点「保存」后同行的人才能看到' : undefined,
    })
  }

  const endPick = () => {
    setPickPoint(null)
    setPickTarget(null)
  }
  const startPick = (t: PickTarget) => {
    const same = pickTarget && JSON.stringify(pickTarget) === JSON.stringify(t)
    if (same) return endPick()
    setPickPoint(null)
    setPickTarget(t)
    setPanel('route')
    // 手机上地图在上方：滚回顶部，能看到地图
    if (!desktop) window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const chooseAt = (target: PickTarget, input: WaypointInput, openEditor: boolean) => {
    if (target.kind === 'lodging') editor.setLodging(target.night, { ...input, category: 'hotel' })
    else void editor.addStop(input, target.day, addFlags).then((w) => w && onAdded(w, openEditor))
  }
  // 旧逻辑（服务端没有 /geo/pick 或用户选择直接用坐标）：不带名称，保存时服务端逆地理补全地址并自动命名；打开编辑框让用户填写真正的名字
  const pickByCoords = (p: LngLat) => {
    const t = pickTarget ?? defaultTarget
    endPick()
    chooseAt(t, { lng: p[0], lat: p[1] }, true)
  }
  // 地图点击：列出那里的景区 / 店铺 / 社区地点，选好后再加入；面板打开时再点地图会换一个位置
  const onMapClick = (p: LngLat) => {
    if (geoPickUnsupported()) pickByCoords(p)
    else setPickPoint(p)
  }

  const onTab = (t: PlanTab) => {
    setTab(t)
    setEditing(null)
    if (pickTarget?.kind === 'stop') setPickTarget(null)
  }

  const doSave = async (): Promise<boolean> => {
    const before = editor.base
    if (!editor.dirty) {
      toast('没有需要保存的修改', { description: '全部修改都已保存' })
      return true
    }
    if (!trip.title.trim()) {
      setPanel('info')
      toast.error('请填写旅程的标题')
      return false
    }
    const r = await editor.save()
    if (!r.ok) return false
    // 新地点有了正式的 ID：选中、编辑中的那一行跟着换
    if (r.idMap?.size) {
      setSelected((cur) => (cur != null && r.idMap!.has(cur) ? r.idMap!.get(cur)! : cur))
      setEditing((cur) => (cur != null && r.idMap!.has(cur) ? r.idMap!.get(cur)! : cur))
    }
    const kept = r.kept?.length ? `${r.kept.map((w) => `「${w.name}」`).join('、')}已经打卡或有照片，保留了没有删除。` : ''
    toast.success(planning ? '计划已保存' : '已保存', {
      description: kept || (planning ? '同行的人现在就能看到；准备好了再点「出发」' : '同行的人现在就能看到'),
      action: planning ? { label: '我的旅程', onClick: () => nav('/me/trips') } : undefined,
    })
    const after = qc.getQueryData<TripDetail>(key)
    // 站点开启了「公开旅程需审核」：改为公开后进入审核
    if (after?.status === 'pending' && before?.status !== 'pending')
      toast('公开需要审核', { description: '管理员审核通过后才会出现在发现广场，在此之前只有你和共同作者能看到' })
    return true
  }
  doSaveRef.current = doSave

  const go = async () => {
    // 出发前先把没保存的内容保存好
    if (editor.dirty && !(await doSave())) return
    leaving.current = true
    nav(`/trips/${trip.id}/go`)
  }

  const stopCount = trip.waypoints.filter((w) => !isLodging(w)).length
  const tabs: { value: Panel; label: string; count?: number }[] = [
    { value: 'route', label: '路线', count: stopCount },
    { value: 'info', label: '信息' },
    // 规划中用不上照片和轨迹：出发后再出现
    ...(planning
      ? []
      : [
          { value: 'photos' as const, label: '照片', count: trip.photos.length },
          { value: 'track' as const, label: '轨迹' },
        ]),
    { value: 'members', label: '成员' },
  ]
  const activePanel: Panel = tabs.some((t) => t.value === panel) ? panel : 'route'
  // 3D 预览：沿计划路线飞一遍（至少两个地点才有路线）
  const canPreview = stopCount >= 2
  // 手机上展开编辑框：地图变矮，只留点选按钮
  const compact = editing !== null && !desktop
  const saveState = editor.saveState
  const count = editor.changes.length
  const discard = async () => {
    const ok = await confirmDialog({ title: `放弃 ${count} 处修改？`, desc: '回到最后一次保存的样子，这些修改会被丢掉。', danger: true, okText: '放弃修改' })
    if (ok) {
      editor.discard()
      setChangesOpen(false)
      toast('已放弃修改')
    }
  }

  return (
    <PlanEditorProvider editor={editor}>
      <div className="md:grid md:h-full md:grid-cols-[minmax(420px,540px)_1fr]">
        <div className="sticky top-15 z-20 border-b border-ink-200 md:static md:order-2 md:h-full md:border-b-0">
          {/* 手机上展开编辑框时地图变矮，给表单留出空间 */}
          <BaseMap
            className={cn('md:h-full', compact ? 'h-[30vh] min-h-[240px] [&_.maplibregl-ctrl-group]:hidden' : 'h-[38vh]')}
            kindSwitcher={!compact}
            locate={!compact}
          >
            <RouteSegments segments={segments} idPrefix="edit" />
            <PlanMarkers
              items={markers}
              selectedId={selected}
              draggable
              onMove={(w, p) => editor.move(w, p)}
              onSelect={(w) => {
                setSelected(w.id)
                setPanel('route')
                // 选中的点不在当前页签里：切到它所在的那一天
                if (!isLodging(w) && tab !== 'all' && (tab === 'pool' ? w.day !== 0 : w.day !== tab)) setTab(w.day === 0 ? 'pool' : w.day)
                scrollTo.current = w.id
              }}
            />
            <MapClick enabled={!!pickTarget} onClick={onMapClick} />
            <FitOnce points={allPts} fitKey={`${trip.id}-${allPts.length > 0}`} />
            <FitTab points={tabPts} tabKey={String(tab)} />
            <FlyTo target={flyTarget} />
            <MapTools
              compact={compact}
              pickMode={!!pickTarget}
              picking={!!pickPoint}
              targetLabel={targetLabel(pickTarget ?? defaultTarget)}
              onTogglePick={() => (pickTarget ? endPick() : startPick(defaultTarget))}
            />
            {pickPoint && (
              <MapPicker
                point={pickPoint}
                onClose={() => setPickPoint(null)}
                onFallback={pickByCoords}
                onChoose={(input, openEditor) => {
                  const t = pickTarget ?? defaultTarget
                  endPick()
                  chooseAt(t, input, openEditor)
                }}
              />
            )}
          </BaseMap>
        </div>

        <div className="flex min-h-0 flex-col md:order-1 md:border-r md:border-ink-200">
          <header className="px-4 pt-4 md:px-8 md:pt-6">
            <div className="flex items-center gap-1.5">
              <Link
                to={`/trips/${trip.id}`}
                className="-ml-2.5 flex size-10 items-center justify-center rounded-full text-ink-600 transition-colors hover:bg-ink-900/[0.06] hover:text-ink-900"
                aria-label="返回旅程"
              >
                <ArrowLeft className="size-[18px]" strokeWidth={1.25} />
              </Link>
              <p className="eyebrow min-w-0 flex-1 truncate">
                <span className="hidden sm:inline">Editing · </span>
                {phases[trip.phase].label}
              </p>
              <Link
                to={`/trips/${trip.id}`}
                className={buttonClass({ size: 'sm', variant: 'ghost', className: 'h-10 w-10 px-0 md:h-9 md:w-9' })}
                title="预览旅程页"
                aria-label="预览旅程页"
              >
                <Eye className="size-4" strokeWidth={1.5} />
              </Link>
              <Link
                to={`/trips/${trip.id}/replay?plan=1`}
                onClick={(e) => {
                  if (canPreview) return
                  e.preventDefault()
                  toast('先添加至少两个地点，再来 3D 预览路线')
                }}
                aria-disabled={!canPreview}
                className={buttonClass({ size: 'sm', variant: 'ghost', className: cn('h-10 w-10 px-0 md:h-9 md:w-9', !canPreview && 'opacity-50') })}
                title="沿计划路线 3D 飞行预览"
                aria-label="3D 预览"
              >
                <Box className="size-4" strokeWidth={1.5} />
              </Link>
              {/* 保存 / 出发：宽屏在这里，手机在底部的操作条 */}
              <div className="hidden items-center gap-1.5 md:flex">
                <SaveButton state={saveState} count={count} busy={editor.saving} onSave={() => void doSave()} />
                {trip.phase !== 'finished' && (
                  <Button size="sm" variant="accent" className="h-9" icon={<Play className="size-3.5" strokeWidth={1.5} />} onClick={go}>
                    出发
                  </Button>
                )}
              </div>
            </div>
            <h1 className="font-display mt-4 line-clamp-2 text-[24px] leading-[1.15] text-ink-900 md:mt-5 md:text-[32px]">
              {trip.title.trim() || '未命名旅程'}
            </h1>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
              <DraftStatus state={saveState} count={count} onShow={() => setChangesOpen(true)} onDiscard={() => void discard()} className="mr-auto" />
              <PresenceBadge editors={editor.editors} />
            </div>
            {(editor.notice || editor.synced || (editor.editors.length > 0 && !hintClosed)) && (
              <div className="mt-3 space-y-2">
                {editor.notice && editor.incoming && (
                  <RemoteNotice
                    by={editor.notice.by}
                    at={editor.notice.at}
                    meId={meId}
                    onView={editor.viewIncoming}
                    onDismiss={editor.dismissNotice}
                  />
                )}
                {!editor.notice && <SyncedNote synced={editor.synced} onDone={editor.clearSynced} />}
                {!editor.notice && editor.editors.length > 0 && !hintClosed && <CoEditHint editors={editor.editors} onClose={() => setHintClosed(true)} />}
              </div>
            )}
            <div className="mt-5 md:mt-6">
              <PanelTabs value={activePanel} onChange={setPanel} options={tabs} />
            </div>
          </header>

          {/* 手机上整页滚动（列表不是滚动容器，scrollIntoView 才能把行滚到吸顶地图的下方） */}
          <div className="flex-1 px-4 pt-6 pb-28 md:overflow-y-auto md:px-8 md:pt-6 md:pb-10">
            {activePanel === 'route' && (
              <RoutePlanner
                trip={trip}
                groups={groups}
                labels={labels}
                legs={planned.legs}
                totals={planned.totals}
                legsLoading={legsQ.isFetching || (legsQ.data?.pending ?? 0) > 0}
                tab={tab}
                onTab={onTab}
                selected={selected}
                onSelect={(w) => select(w)}
                editing={editing}
                onEdit={(id) => {
                  setEditing(id)
                  if (id != null) scrollTo.current = id
                }}
                onPick={startPick}
                pickTarget={pickTarget}
                onAdded={(w) => onAdded(w)}
                onArrange={(scope) => setArrangeOpen(scope ?? 'pool')}
                city={trip.cities[0]}
                near={near}
              />
            )}
            {activePanel === 'info' && <InfoPanel trip={trip} onSave={() => void doSave()} />}
            {activePanel === 'photos' && (
              <PhotosPanel
                trip={trip}
                refresh={() => {
                  invalidateTripLists(qc)
                  void query.refetch()
                }}
              />
            )}
            {activePanel === 'track' && <TrackPanel trip={trip} />}
            {activePanel === 'members' && <MembersPanel trip={trip} />}
          </div>
        </div>

        {/* 手机：底部固定的保存状态和出发 */}
        <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-ink-200 bg-paper px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] md:hidden">
          <div className="min-w-0 flex-1 truncate text-[12px] text-ink-500" aria-live="polite">
            {saveState === 'saving' ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
                正在保存…
              </span>
            ) : count > 0 ? (
              <button type="button" onClick={() => setChangesOpen(true)} className="inline-flex max-w-full items-center gap-1.5 text-ink-900">
                <span aria-hidden className={cn('size-2 shrink-0 rounded-full', saveState === 'error' ? 'bg-red-600' : 'bg-brand-500')} />
                <span className="truncate">
                  {saveState === 'error' ? '没保存成功 · ' : ''}未保存的修改 <span className="font-num text-[13px]">{count}</span> 处
                </span>
              </button>
            ) : (
              '全部已保存'
            )}
          </div>
          <SaveButton state={saveState} count={count} busy={editor.saving} onSave={() => void doSave()} />
          {trip.phase !== 'finished' && (
            <Button variant="accent" className="h-10" icon={<Play className="size-3.5" strokeWidth={1.5} />} onClick={go}>
              出发
            </Button>
          )}
        </div>
      </div>
      {arrangeOpen && (
        <ArrangeDialog
          trip={trip}
          open={!!arrangeOpen}
          initialScope={arrangeOpen}
          onClose={() => setArrangeOpen(false)}
          onApplied={() => {
            setArrangeOpen(false)
            setTab('all')
          }}
        />
      )}
      <ChangesDialog
        open={changesOpen}
        changes={editor.changes}
        saving={editor.saving}
        onClose={() => setChangesOpen(false)}
        onDiscard={() => void discard()}
        onSave={() => void doSave().then((ok) => ok && setChangesOpen(false))}
      />
      <ConflictDialog
        conflict={editor.conflict}
        base={editor.base}
        draft={editor.trip}
        meId={meId}
        saving={editor.saving}
        onClose={editor.closeConflict}
        onLoadTheirs={() => {
          editor.loadTheirs()
          toast.success('已载入最新的版本')
        }}
        onOverwrite={() =>
          void editor.overwrite().then((r) => {
            if (r.ok) toast.success('已用你的版本覆盖', { description: '同行的人会看到你保存的这一版' })
          })
        }
      />
      <RestoreDialog
        open={!!editor.restore}
        savedAt={editor.restore?.savedAt ?? 0}
        changes={restoreChanges}
        onRestore={() => {
          editor.restoreDraft()
          toast.success('已恢复上次的修改', { description: '确认没问题后点「保存」' })
        }}
        onDrop={editor.dropRestore}
      />
      <LeaveDialog
        open={blocker.state === 'blocked'}
        count={count}
        saving={editor.saving}
        onCancel={() => blocker.reset?.()}
        onDiscard={() => {
          editor.discard()
          blocker.proceed?.()
        }}
        onSave={() =>
          void doSave().then((ok) => {
            if (ok) blocker.proceed?.()
            else blocker.reset?.()
          })
        }
      />
    </PlanEditorProvider>
  )
}
