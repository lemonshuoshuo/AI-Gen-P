import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Marker, type MapMouseEvent } from 'maplibre-gl'
import { DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowLeft, Box, Crosshair, Eye, GripVertical, Heart, Mountain, Play, Route, Star, Trash2, UserPlus, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  errorMessage,
  isNotFound,
  type GeoSearchItem,
  type LegMode,
  type Phase,
  type TripDetail,
  type TripInput,
  type TripLeg,
  type TripMember,
  type Visibility,
  type Waypoint,
  type WaypointInput,
} from '@/api'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { FitOnce, RouteLines, markerHtml } from '@/components/map/layers'
import { MapPicker, geoPickUnsupported } from '@/components/editor/MapPicker'
import { PhotoImporter } from '@/components/editor/PhotoImporter'
import { PlaceSearch, type PickSource } from '@/components/editor/PlaceSearch'
import { LegLine, LegsSummary, useTripLegs } from '@/components/editor/RouteLegs'
import { TrackPanel } from '@/components/editor/TrackPanel'
import { WaypointForm } from '@/components/editor/WaypointForm'
import { PlaceStatsBadge, WaypointNumber } from '@/components/trip/WaypointItem'
import {
  Avatar,
  Button,
  CategoryChip,
  Empty,
  Field,
  Input,
  LoadError,
  PageLoader,
  Segmented,
  Select,
  Switch,
  TabBar,
  Textarea,
  UserName,
  VerdictBadge,
  buttonClass,
  confirmDialog,
} from '@/components/ui'
import { useIsDesktop } from '@/hooks/useMediaQuery'
import { invalidateTripLists } from '@/lib/cache'
import { cn } from '@/lib/cn'
import { dayjs } from '@/lib/format'
import { phases, visibilities, waypointStatus } from '@/lib/meta'
import { actualPath, bySeq, plannedPath } from '@/lib/trip'
import { useAuth } from '@/stores/auth'

type Panel = 'route' | 'info' | 'photos' | 'track' | 'members'
type LngLat = [number, number]

/* ---------------- 地图上可拖动的打卡点（与详情页同一套印章式标记） ---------------- */
function EditableMarkers({
  waypoints,
  selectedId,
  onSelect,
  onMove,
}: {
  waypoints: Waypoint[]
  selectedId: number | null
  onSelect: (w: Waypoint) => void
  onMove: (w: Waypoint, lngLat: LngLat) => void
}) {
  const map = useMap()
  const cb = useRef({ onSelect, onMove })
  cb.current = { onSelect, onMove }
  // 选中状态通过 ref 读取：切换选中时只改写前后两个标记的内容（根元素不变，拖动和点击监听都保留）
  const selRef = useRef(selectedId)
  selRef.current = selectedId
  const markers = useRef<{ m: Marker; el: HTMLDivElement; w: Waypoint; i: number; sel: boolean }[]>([])
  useEffect(() => {
    if (!map) return
    markers.current = waypoints.map((w, i) => {
      const el = document.createElement('div')
      const sel = w.id === selRef.current
      // anchor: 'bottom' 让针尖正好在坐标上：拖动结束时 getLngLat() 就是看到的针尖位置
      el.innerHTML = markerHtml(w, String(i + 1), sel)
      el.style.cursor = 'grab'
      el.style.zIndex = sel ? '1' : ''
      const m = new Marker({ element: el, anchor: 'bottom', draggable: true }).setLngLat([w.lng, w.lat]).addTo(map)
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        cb.current.onSelect(w)
      })
      m.on('dragend', () => {
        const p = m.getLngLat()
        cb.current.onMove(w, [p.lng, p.lat])
      })
      return { m, el, w, i, sel }
    })
    return () => {
      markers.current.forEach((x) => x.m.remove())
      markers.current = []
    }
  }, [map, waypoints])
  useEffect(() => {
    for (const x of markers.current) {
      const sel = x.w.id === selectedId
      if (x.sel === sel) continue
      x.sel = sel
      x.el.innerHTML = markerHtml(x.w, String(x.i + 1), sel)
      x.el.style.zIndex = sel ? '1' : ''
    }
  }, [selectedId])
  return null
}

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

const mapChip = (on: boolean) =>
  cn(
    'inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] tracking-wide shadow-card transition-colors',
    on ? 'bg-ink-900 text-paper hover:bg-ink-700' : 'glass text-ink-800 hover:text-ink-900',
  )

/** 地图左上角：点选地点、3D 视角（倾斜地图看路线的起伏走向） */
function MapTools({ pickMode, picking, onTogglePick }: { pickMode: boolean; picking: boolean; onTogglePick: () => void }) {
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
    <div className="absolute top-3 left-3 z-10 flex max-w-[calc(100%-7.5rem)] flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onTogglePick} aria-pressed={pickMode} className={mapChip(pickMode)}>
          {pickMode ? <X className="size-4" strokeWidth={1.75} /> : <Crosshair className="size-4" strokeWidth={1.75} />}
          {pickMode ? '取消点选' : '在地图上点选'}
        </button>
        <button
          type="button"
          onClick={toggleTilt}
          aria-pressed={tilted}
          title={tilted ? '回到平面视角' : '倾斜地图，立体地看路线'}
          className={mapChip(tilted)}
        >
          <Mountain className="size-4" strokeWidth={1.75} />
          3D 视角
        </button>
      </div>
      {/* 宽屏上候选面板会盖住这条提示：选了位置后不再显示 */}
      {pickMode && !(picking && desktop) && (
        <p className="glass animate-fade-in rounded-lg px-3 py-1.5 text-xs leading-relaxed text-ink-700 shadow-card">
          {picking ? '点地图上的其他位置，可以重新选择' : '点击地图上的景点、店铺或任意位置，会列出那里可选的地点'}
        </p>
      )}
    </div>
  )
}

/* ---------------- 可排序列表项 ---------------- */
function SortableRow({
  w,
  index,
  phase,
  selected,
  editing,
  maxDay,
  onSelect,
  onEdit,
  onSave,
  onDelete,
  saving,
  leg,
}: {
  w: Waypoint
  index: number
  phase: Phase
  selected: boolean
  editing: boolean
  maxDay: number
  onSelect: () => void
  onEdit: (v: boolean) => void
  onSave: (p: WaypointInput) => void
  onDelete: () => void
  saving: boolean
  /** 从上一个计划点到这里的路段（放在这一行里，拖动时跟着这一行走） */
  leg?: TripLeg
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id })
  const st = waypointStatus[w.status]
  const statusTone = w.status === 'visited' ? 'text-emerald-700' : w.status === 'skipped' ? 'text-ink-400' : 'text-sky-600'
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'relative transition-colors',
        (selected || editing) && 'bg-surface',
        isDragging && 'z-10 rounded-lg bg-surface shadow-float',
      )}
    >
      {selected && <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[2px] rounded-full bg-brand-500" />}
      {leg && (
        <div className="flex items-center gap-1.5 pt-2 pr-3 pl-[3.6rem] text-[11px] text-ink-300">
          <span className="shrink-0">距上一站</span>
          <LegLine leg={leg} />
        </div>
      )}
      <div className="flex items-center gap-2.5 py-3 pr-1.5 pl-1" onClick={onSelect}>
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab touch-none rounded p-1 text-ink-300 transition-colors hover:text-ink-700 active:cursor-grabbing"
          aria-label="拖动排序"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="size-4" strokeWidth={1.5} />
        </button>
        <WaypointNumber w={w} label={String(index + 1)} />
        <div className="min-w-0 flex-1">
          {/* 名称做成按钮，键盘也能选中；回车 / 空格触发的点击冒泡到整行的 onSelect */}
          <button
            type="button"
            className={cn(
              'font-display block w-full truncate text-left text-[15.5px] leading-snug text-ink-900',
              w.status === 'skipped' && 'text-ink-400 line-through decoration-ink-300',
            )}
          >
            {w.name || '未命名地点'}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tracking-wide">
            {w.day > 0 && (
              <span className="font-num text-ink-500">
                第 {w.day} 天
              </span>
            )}
            <CategoryChip category={w.category} className="text-[11px]" />
            {phase !== 'planning' && w.planned && <span className={statusTone}>{st.label}</span>}
            {!w.planned && <span className="text-violet-600">计划外</span>}
            <VerdictBadge verdict={w.verdict} className="!py-0 text-[11px]" />
            <PlaceStatsBadge stats={w.place_stats} className="!py-0 text-[11px]" />
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => (e.stopPropagation(), onEdit(!editing))}
          aria-expanded={editing}
          className={cn(
            'h-7 shrink-0 rounded-md px-2.5 text-xs tracking-wide transition-colors',
            editing ? 'bg-ink-900 text-paper' : 'text-ink-500 hover:bg-ink-900/5 hover:text-ink-900',
          )}
        >
          {editing ? '收起' : '编辑'}
        </button>
        <button
          type="button"
          className="shrink-0 rounded-md p-1.5 text-ink-300 transition-colors hover:bg-brand-50 hover:text-brand-600"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          aria-label={`删除「${w.name || '未命名地点'}」`}
        >
          <Trash2 className="size-4" strokeWidth={1.5} />
        </button>
      </div>
      {editing && (
        <div className="px-2 pb-3">
          <WaypointForm w={w} phase={phase} maxDay={maxDay} saving={saving} onCancel={() => onEdit(false)} onSave={onSave} />
        </div>
      )}
    </div>
  )
}

/* ---------------- 旅程信息 ---------------- */
function InfoPanel({ trip, onSaved }: { trip: TripDetail; onSaved: (t: TripDetail) => void }) {
  const [f, setF] = useState({
    title: trip.title,
    summary: trip.summary,
    content: trip.content,
    start_date: trip.start_date ?? '',
    end_date: trip.end_date ?? '',
    phase: trip.phase,
    visibility: trip.visibility,
    live_share: trip.live_share,
    tags: trip.tags.join(' '),
  })
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const save = async () => {
    if (!f.title.trim()) return toast.error('请填写标题')
    setSaving(true)
    try {
      const body: TripInput = {
        title: f.title.trim(),
        summary: f.summary,
        content: f.content,
        start_date: f.start_date || null,
        end_date: f.end_date || null,
        phase: f.phase,
        tags: f.tags
          .split(/[\s,，#]+/)
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 10),
      }
      // 可见性和实时公开只有作者能改（共同作者提交会 403）
      if (trip.is_owner) {
        body.visibility = f.visibility
        body.live_share = f.live_share
      }
      const t = await api.trips.update(trip.id, body)
      onSaved(t)
      // 站点开启了「公开旅程需审核」：改为公开后进入审核
      if (t.status === 'pending' && trip.status !== 'pending')
        toast.success('已保存，公开需要审核', { description: '管理员审核通过后才会出现在发现广场，在此之前只有你和共同作者能看到' })
      else toast.success('已保存')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="space-y-7">
      <section className="space-y-4">
        <p className="eyebrow">Basics · 基本信息</p>
        <Field label="标题">
          <Input value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={100} className="font-display text-base" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="开始日期">
            <Input type="date" value={f.start_date} onChange={(e) => set('start_date', e.target.value)} />
          </Field>
          <Field label="结束日期">
            <Input type="date" value={f.end_date} min={f.start_date} onChange={(e) => set('end_date', e.target.value)} />
          </Field>
        </div>
        <Field label="旅程状态">
          <Segmented<Phase>
            value={f.phase}
            onChange={(v) => set('phase', v)}
            options={(Object.keys(phases) as Phase[]).map((p) => ({ value: p, label: phases[p].label }))}
          />
        </Field>
      </section>
      {trip.is_owner && (
        <section className="space-y-4 border-t border-ink-200 pt-6">
          <p className="eyebrow">Sharing · 谁能看到</p>
          <Field
            label="谁可以看"
            hint={
              <>
                {visibilities[f.visibility].desc}
                {trip.status === 'pending' && (
                  <span className="mt-0.5 block text-amber-700">公开申请审核中，通过后才会出现在发现广场</span>
                )}
                {trip.status === 'hidden' && <span className="mt-0.5 block text-brand-600">已被管理员隐藏，改为公开也不会显示</span>}
              </>
            }
          >
            <Segmented<Visibility>
              value={f.visibility}
              onChange={(v) => set('visibility', v)}
              options={(['private', 'unlisted', 'public'] as Visibility[]).map((v) => ({ value: v, label: visibilities[v].label }))}
            />
          </Field>
          <Field
            label="旅行中实时公开位置"
            hint={
              f.live_share ? (
                <span className="text-amber-700">
                  已开启：能看到这段旅程的人可以实时看到你们的打卡、照片和 GPS 轨迹；私密旅程仍只有成员可见
                </span>
              ) : (
                '关闭时（默认），旅行中其他人只能看到计划路线；你们的打卡、照片和 GPS 轨迹在旅程结束后才公开'
              )
            }
          >
            <Switch checked={f.live_share} onChange={(v) => set('live_share', v)} />
          </Field>
        </section>
      )}
      <section className="space-y-4 border-t border-ink-200 pt-6">
        <p className="eyebrow">Journal · 游记</p>
        <Field label="一句话简介">
          <Textarea value={f.summary} onChange={(e) => set('summary', e.target.value)} maxLength={500} className="min-h-16" />
        </Field>
        <Field label="游记正文" hint="支持 Markdown：## 标题、**加粗**、- 列表">
          <Textarea
            value={f.content}
            onChange={(e) => set('content', e.target.value)}
            className="min-h-56 leading-7"
            placeholder="写写这段旅程的故事、整体攻略、预算、交通建议…"
          />
        </Field>
        <Field label="标签" hint="空格分隔，如：情侣 美食 周末游">
          <Input value={f.tags} onChange={(e) => set('tags', e.target.value)} />
        </Field>
      </section>
      <Button block loading={saving} onClick={save}>
        保存旅程信息
      </Button>
    </div>
  )
}

/* ---------------- 照片 ---------------- */
function PhotosPanel({ trip, refresh }: { trip: TripDetail; refresh: () => void }) {
  const qc = useQueryClient()
  const setCover = async (url: string) => {
    try {
      const t = await api.trips.update(trip.id, { cover_url: url })
      qc.setQueryData(['trip', String(trip.id)], t)
      invalidateTripLists(qc)
      toast.success('已设为封面')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const remove = async (id: number) => {
    if (!(await confirmDialog({ title: '删除这张照片？', danger: true, okText: '删除' }))) return
    try {
      await api.photos.remove(id)
      refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const assign = async (id: number, wid: number) => {
    try {
      await api.photos.update(id, { waypoint_id: wid })
      refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const sorted = [...trip.waypoints].sort(bySeq)
  return (
    <div className="space-y-5">
      <PhotoImporter tripId={trip.id} onDone={refresh} defaultAuto={trip.phase !== 'planning'} compact={trip.photos.length > 0} />
      {trip.photos.length > 0 && (
        <>
          <p className="eyebrow">
            Photos · 照片 <span className="font-num ml-1 text-ink-500">{trip.photos.length}</span>
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3">
            {trip.photos.map((p) => {
              const isCover = trip.cover_url === p.url
              return (
                <figure key={p.id} className="min-w-0">
                  <div className="relative aspect-square overflow-hidden rounded-md bg-ink-100 ring-1 ring-ink-900/5">
                    <img src={p.thumb_url} alt="" loading="lazy" className="size-full object-cover" />
                    {isCover && (
                      <span className="absolute top-1.5 left-1.5 rounded-sm bg-ink-900/85 px-1.5 py-0.5 text-[10px] tracking-widest text-paper">
                        封面
                      </span>
                    )}
                  </div>
                  <figcaption className="mt-1.5 space-y-1">
                    <Select
                      value={p.waypoint_id ?? 0}
                      onChange={(e) => assign(p.id, Number(e.target.value))}
                      className="h-7 rounded-md pl-2 text-xs"
                      aria-label="关联打卡点"
                    >
                      <option value={0}>未关联打卡点</option>
                      {sorted.map((w, i) => (
                        <option key={w.id} value={w.id}>
                          {i + 1}. {w.name}
                        </option>
                      ))}
                    </Select>
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        disabled={isCover}
                        onClick={() => setCover(p.url)}
                        className="flex items-center gap-1 text-xs text-ink-500 transition-colors hover:text-ink-900 disabled:text-ink-300"
                      >
                        <Star className="size-3" strokeWidth={1.75} />
                        {isCover ? '当前封面' : '设为封面'}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(p.id)}
                        className="rounded p-0.5 text-ink-300 transition-colors hover:text-brand-600"
                        aria-label="删除照片"
                      >
                        <Trash2 className="size-3.5" strokeWidth={1.5} />
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
  const { data: members = [], refetch } = useQuery({ queryKey: ['members', trip.id], queryFn: () => api.trips.members(trip.id) })
  const [name, setName] = useState('')
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
    try {
      await api.trips.removeMember(trip.id, m.user.id)
      // 自己退出后这段旅程不再出现在「我的旅程」里；移除情侣后也不再算「一起」的旅程
      invalidateTripLists(qc)
      if (self) {
        toast.success('已退出这段旅程')
        // 退出后已无权编辑，私密旅程连详情也看不到（404）：回「我的旅程」，不回详情页。
        // 离开后再移除缓存，否则当前页会重新请求并得到 403 / 404；也不再刷新成员列表
        await nav('/me/trips', { replace: true })
        qc.removeQueries({ queryKey: ['trip', String(trip.id)] })
        qc.removeQueries({ queryKey: ['members', trip.id] })
        return
      }
      toast.success(m.status === 'pending' ? '已撤回邀请' : '已移除')
      refetch()
      // 预览页的成员头像、「我们一起」标记
      qc.invalidateQueries({ queryKey: ['trip', String(trip.id)] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const partner = me?.partner
  const partnerIn = partner && members.some((m) => m.user.id === partner.id)
  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-ink-500">共同作者可以一起编辑路线、打卡、上传照片。和情侣一起的旅程会出现在「我们」的足迹里。</p>
      {trip.is_owner && partner && !partnerIn && (
        <button
          type="button"
          onClick={() => invite(partner.username)}
          className="group flex w-full items-center gap-3 rounded-xl border border-pink-200 bg-pink-50/60 p-3 text-left text-pink-800 transition-colors hover:border-pink-400"
        >
          <Avatar user={partner} size={36} ring />
          <span className="flex-1 text-sm">
            把 <span className="font-display text-[15px] text-pink-900">{partner.nickname || partner.username}</span> 加入这段旅程
          </span>
          <Heart className="size-4 text-pink-500 transition-colors group-hover:fill-pink-500" strokeWidth={1.75} />
        </button>
      )}
      {trip.is_owner && (
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="输入对方用户名" aria-label="用户名" />
          <Button disabled={!name.trim()} onClick={() => invite(name.trim())} icon={<UserPlus className="size-4" strokeWidth={1.75} />}>
            邀请
          </Button>
        </div>
      )}
      <div>
        <p className="eyebrow mb-1">Members · 成员</p>
        <ul className="divide-y divide-ink-200 border-y border-ink-200">
          {members.map((m) => (
            <li key={m.user.id} className="flex items-center gap-3 py-3">
              <Avatar user={m.user} size={36} />
              <div className="min-w-0 flex-1">
                <UserName user={m.user} />
                <div className="mt-0.5 text-xs tracking-wide text-ink-400">
                  {m.role === 'owner' ? '作者' : m.status === 'pending' ? '已邀请，等待接受' : '共同作者'}
                </div>
              </div>
              {m.role !== 'owner' && (trip.is_owner || m.user.id === me?.id) && (
                <Button size="xs" variant="ghost" onClick={() => remove(m)}>
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

/* ---------------- 页面 ---------------- */
export default function TripEditPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const qc = useQueryClient()
  const key = ['trip', id]
  const { data: trip, isLoading, error, refetch } = useQuery({ queryKey: key, queryFn: () => api.trips.get(id!) })
  const [panel, setPanel] = useState<Panel>((params.get('panel') as Panel) || 'route')
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [pickMode, setPickMode] = useState(false)
  // 地图选点：点击的位置（打开候选面板）
  const [pickPoint, setPickPoint] = useState<LngLat | null>(null)
  const [addDay, setAddDay] = useState(0)
  const [addAs, setAddAs] = useState<'plan' | 'visited' | null>(null)
  const [flyTarget, setFlyTarget] = useState<LngLat | null>(null)
  const [order, setOrder] = useState<Waypoint[]>([])
  const [legMode, setLegMode] = useState<LegMode>('transit')
  // 待滚动到的地点：新加的点要等刷新后列表渲染出这一行才能滚过去
  const scrollTo = useRef<number | null>(null)

  useEffect(() => {
    if (trip) setOrder([...trip.waypoints].sort(bySeq))
  }, [trip])

  // 没有依赖数组：每次渲染后检查，直到这一行出现（order 在刷新后的 effect 里才更新）
  useEffect(() => {
    const id = scrollTo.current
    if (id == null) return
    const el = document.getElementById(`wp-${id}`)
    if (!el) return
    scrollTo.current = null
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  )
  const maxDay = useMemo(() => {
    if (!trip) return 1
    const byDate = trip.start_date && trip.end_date ? dayjs(trip.end_date).diff(dayjs(trip.start_date), 'day') + 1 : 0
    return Math.max(byDate, ...trip.waypoints.map((w) => w.day), 1)
  }, [trip])
  const planned = useMemo(() => plannedPath(order), [order])
  const actual = useMemo(() => actualPath(order), [order])
  // 路段用时只在出发前 / 旅行中有用；已完成的旅程不计算（也不消耗站点的高德额度）
  const legs = useTripLegs(trip?.can_edit && trip.phase !== 'finished' ? trip.id : undefined, order, legMode)

  if (isLoading) return <PageLoader />
  // 保存后的刷新失败（网络不好）时保留编辑中的内容；404 说明旅程已删除或不再可见
  if (!trip || isNotFound(error))
    return <LoadError className="min-h-[60vh]" error={error} notFoundTitle="旅程不存在或无权编辑" onRetry={() => refetch()} />
  if (!trip.can_edit) return <Empty className="min-h-[60vh]" title="你没有编辑权限" />

  // 打卡点、照片的变化也会影响卡片、个人统计和足迹
  const refresh = () => {
    invalidateTripLists(qc)
    return qc.invalidateQueries({ queryKey: key })
  }
  const near = order.length ? ([order[order.length - 1].lng, order[order.length - 1].lat] as LngLat) : null
  // 每个计划点「距上一站」的路段。只用和当前列表相邻关系一致的：排序、删除、改天数后，
  // 新结果算出来之前还显示着旧结果，其中有的路段已经不再连着相邻的两站
  const legByTo = new Map<number, TripLeg>()
  for (const l of legs.data?.legs ?? []) legByTo.set(l.to_id, l)
  const legOf = new Map<number, TripLeg>()
  let prevPlanned: Waypoint | null = null
  for (const w of order) {
    if (!w.planned) continue
    const l = legByTo.get(w.id)
    if (l && prevPlanned && l.from_id === prevPlanned.id && prevPlanned.day === w.day) legOf.set(w.id, l)
    prevPlanned = w
  }
  // 规划中只能加入计划；出发后默认也是加入计划（比如明天要去的地方），需要时可切换为补记打卡
  const addMode = trip.phase === 'planning' ? 'plan' : (addAs ?? (trip.phase === 'finished' ? 'visited' : 'plan'))

  const addWaypoint = async (input: WaypointInput, openEditor = false) => {
    // 总是显式指定是否计划内，避免旅程阶段变化后服务端把新点当成「此刻已到达」
    const flags: WaypointInput = addMode === 'plan' ? { planned: true, status: 'todo' } : { planned: false }
    try {
      const w = await api.waypoints.create(trip.id, { ...flags, ...input, day: input.day ?? addDay })
      await refresh()
      setSelected(w.id)
      setFlyTarget([w.lng, w.lat])
      if (openEditor) setEditing(w.id)
      // 手机上列表在地图下方：把新加的点滚到地图下面，编辑框整个可见
      scrollTo.current = w.id
      toast.success(w.planned ? `已加入计划：${w.name}` : `已打卡：${w.name}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const onPick = (it: GeoSearchItem, from: PickSource) =>
    addWaypoint({
      // 离线搜索（source: local）的结果是城市 / 省份的中心点，没有 amap_id：不提交名称，由服务端自动命名，
      // 否则会被当作用户起的店名，新建一个叫「杭州市」的地点；社区地点用原名，服务端按同名同位置关联到已有地点和评价。
      // 天地图结果没有高德 ID，但是真实的店铺 / 景点名称，照常提交
      name: it.amap_id || from === 'community' || from === 'tianditu' ? it.name : undefined,
      address: it.address,
      lng: it.lng,
      lat: it.lat,
      category: it.category || undefined,
      amap_id: it.amap_id || undefined,
      // 搜索结果自带的行政区：有地址和区县时服务端不必再逆地理（省一次高德调用）；离线结果没有区县，不传空串
      province: it.province || undefined,
      city: it.city || undefined,
      district: it.district || undefined,
    })

  const endPick = () => {
    setPickPoint(null)
    setPickMode(false)
  }
  // 旧逻辑（服务端没有 /geo/pick 或用户选择直接用坐标）：不提交名称，服务端逆地理补全地址并自动命名；
  // 打开编辑框让用户填写真正的店名
  const pickByCoords = (p: LngLat) => {
    endPick()
    addWaypoint({ lng: p[0], lat: p[1] }, true)
  }
  // 地图点击：列出那里的景区 / 店铺 / 社区地点，选好后再加入；面板打开时再点地图会换一个位置
  const onMapClick = (p: LngLat) => {
    if (geoPickUnsupported()) pickByCoords(p)
    else setPickPoint(p)
  }

  const saveWaypoint = async (w: Waypoint, patch: WaypointInput) => {
    setSaving(true)
    try {
      await api.waypoints.update(w.id, patch)
      await refresh()
      setEditing(null)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const moveWaypoint = async (w: Waypoint, p: LngLat) => {
    try {
      await api.waypoints.update(w.id, { lng: p[0], lat: p[1] })
      refresh()
    } catch (e) {
      toast.error(errorMessage(e))
      refresh()
    }
  }

  const deleteWaypoint = async (w: Waypoint) => {
    if (!(await confirmDialog({ title: `删除「${w.name}」？`, desc: '关联的照片会保留。', danger: true, okText: '删除' }))) return
    try {
      await api.waypoints.remove(w.id)
      refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const onDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = order.findIndex((w) => w.id === active.id)
    const to = order.findIndex((w) => w.id === over.id)
    const next = arrayMove(order, from, to)
    setOrder(next)
    try {
      await api.waypoints.order(trip.id, next.map((w) => w.id))
      refresh()
    } catch (err) {
      toast.error(errorMessage(err))
      refresh()
    }
  }

  const count = (n: number) => (n ? <span className="font-num ml-1 text-[13px] text-ink-400">{n}</span> : null)
  const tabs: { value: Panel; label: ReactNode }[] = [
    { value: 'route', label: <>路线{count(order.length)}</> },
    { value: 'info', label: '信息' },
    { value: 'photos', label: <>照片{count(trip.photos.length)}</> },
    { value: 'track', label: '轨迹' },
    { value: 'members', label: '成员' },
  ]
  // 3D 预览：沿计划路线飞一遍（至少两个地点才有路线）
  const canPreview = order.length >= 2

  return (
    <div className="md:grid md:h-full md:grid-cols-[minmax(400px,460px)_1fr]">
      <div className="sticky top-15 z-20 border-b border-ink-200 md:static md:order-2 md:h-full md:border-b-0">
        {/* 手机上展开编辑框时地图变矮，给表单留出空间 */}
        <BaseMap className={cn('md:h-full', editing !== null ? 'h-[22vh]' : 'h-[38vh]')} kindSwitcher locate>
          <RouteLines planned={planned} actual={trip.phase !== 'planning' ? actual : undefined} />
          <EditableMarkers
            waypoints={order}
            selectedId={selected}
            onSelect={(w) => {
              setSelected(w.id)
              setPanel('route')
              document.getElementById(`wp-${w.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }}
            onMove={moveWaypoint}
          />
          <MapClick enabled={pickMode} onClick={onMapClick} />
          <FitOnce points={order.map((w) => [w.lng, w.lat])} fitKey={`${trip.id}-${order.length > 0}`} />
          <FlyTo target={flyTarget} />
          <MapTools
            pickMode={pickMode}
            picking={!!pickPoint}
            onTogglePick={() => {
              if (pickMode) endPick()
              else {
                setPickMode(true)
                setPanel('route')
              }
            }}
          />
          {pickPoint && (
            <MapPicker
              point={pickPoint}
              onClose={() => setPickPoint(null)}
              onFallback={pickByCoords}
              onChoose={(input, openEditor) => {
                endPick()
                addWaypoint(input, openEditor)
              }}
            />
          )}
        </BaseMap>
      </div>

      <div className="flex min-h-0 flex-col md:order-1 md:border-r md:border-ink-200">
        <header className="px-4 pt-3 md:px-5 md:pt-4">
          <div className="flex items-center gap-1.5">
            <Link
              to={`/trips/${trip.id}`}
              className="-ml-1.5 rounded-full p-1.5 text-ink-600 transition-colors hover:bg-ink-900/5 hover:text-ink-900"
              aria-label="返回旅程"
            >
              <ArrowLeft className="size-5" strokeWidth={1.5} />
            </Link>
            <p className="eyebrow min-w-0 flex-1 truncate">
              <span className="hidden sm:inline">Editing · </span>
              {phases[trip.phase].label}
            </p>
            <Link
              to={`/trips/${trip.id}`}
              className={buttonClass({ size: 'sm', variant: 'ghost', className: 'px-2 sm:px-3' })}
              title="预览旅程页"
            >
              <Eye className="size-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">预览</span>
            </Link>
            <Link
              to={`/trips/${trip.id}/replay?plan=1`}
              onClick={(e) => {
                if (canPreview) return
                e.preventDefault()
                toast('先添加至少两个地点，再来 3D 预览路线')
              }}
              aria-disabled={!canPreview}
              className={buttonClass({ size: 'sm', variant: 'outline', className: cn('px-2.5', !canPreview && 'opacity-50') })}
              title="沿计划路线 3D 飞行预览"
            >
              <Box className="size-4" strokeWidth={1.75} />
              3D 预览
            </Link>
            {trip.phase !== 'finished' && (
              <Button size="sm" variant="accent" icon={<Play className="size-3.5" strokeWidth={1.75} />} onClick={() => nav(`/trips/${trip.id}/go`)}>
                出发
              </Button>
            )}
          </div>
          <h1 className="mt-2 line-clamp-2 text-[21px] leading-snug text-ink-900 md:text-[24px]">{trip.title}</h1>
          <TabBar<Panel> value={panel} onChange={setPanel} options={tabs} className="mt-4 gap-5 md:gap-6" />
        </header>

        {/* 手机上整页滚动（列表不是滚动容器，scrollIntoView 才能把行滚到吸顶地图的下方） */}
        <div className="flex-1 px-4 pt-4 pb-8 md:overflow-y-auto md:px-5">
          {panel === 'route' && (
            <div className="space-y-4">
              <PlaceSearch onPick={onPick} city={trip.cities[0]} near={near} />
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                <span className="shrink-0 tracking-wide">添加到</span>
                <div className="w-28 shrink-0">
                  <Select value={addDay} onChange={(e) => setAddDay(Number(e.target.value))} className="h-8 rounded-md text-xs" aria-label="添加到第几天">
                    <option value={0}>不分天</option>
                    {Array.from({ length: maxDay + 1 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        第 {d} 天
                      </option>
                    ))}
                  </Select>
                </div>
                {trip.phase === 'planning' ? (
                  <span className="ml-auto text-right text-ink-400">新加的点会作为计划路线</span>
                ) : (
                  <Segmented<'plan' | 'visited'>
                    size="sm"
                    className="ml-auto"
                    value={addMode}
                    onChange={setAddAs}
                    options={[
                      { value: 'plan', label: '加入计划' },
                      { value: 'visited', label: '记为已打卡' },
                    ]}
                  />
                )}
              </div>
              {trip.phase !== 'finished' && planned.length >= 2 && (
                <LegsSummary data={legs.data} mode={legMode} onMode={setLegMode} loading={legs.isFetching} error={legs.isError} />
              )}
              {order.length === 0 ? (
                <Empty
                  icon={<Route className="size-9" strokeWidth={1.75} />}
                  title="还没有打卡点"
                  desc="搜索地点、在地图上点选，或者到「照片」里从照片自动生成"
                />
              ) : (
                <div>
                  <div className="flex items-baseline justify-between pt-2 pb-2">
                    <p className="eyebrow">Itinerary · 路线</p>
                    <p className="text-[11px] tracking-wide text-ink-400">
                      <span className="font-num">{order.length}</span> 个地点
                    </p>
                  </div>
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                    <SortableContext items={order.map((w) => w.id)} strategy={verticalListSortingStrategy}>
                      <div className="divide-y divide-ink-200 border-y border-ink-200">
                        {order.map((w, i) => (
                          <div
                            id={`wp-${w.id}`}
                            key={w.id}
                            className={cn(
                              'md:scroll-mt-3',
                              editing !== null ? 'scroll-mt-[calc(3.5rem+22vh+0.75rem)]' : 'scroll-mt-[calc(3.5rem+38vh+0.75rem)]',
                            )}
                          >
                            <SortableRow
                              w={w}
                              index={i}
                              phase={trip.phase}
                              selected={selected === w.id}
                              editing={editing === w.id}
                              maxDay={maxDay}
                              saving={saving}
                              onSelect={() => {
                                setSelected(w.id)
                                setFlyTarget([w.lng, w.lat])
                              }}
                              onEdit={(v) => {
                                setEditing(v ? w.id : null)
                                if (v) scrollTo.current = w.id
                              }}
                              onSave={(p) => saveWaypoint(w, p)}
                              onDelete={() => deleteWaypoint(w)}
                              leg={legOf.get(w.id)}
                            />
                          </div>
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                </div>
              )}
              {order.length > 1 && (
                <p className="text-center text-[11px] tracking-wide text-ink-400">拖动左侧把手调整顺序，拖动地图上的标记可微调位置</p>
              )}
            </div>
          )}
          {panel === 'info' && (
            <InfoPanel
              trip={trip}
              onSaved={(t) => {
                qc.setQueryData(key, t)
                invalidateTripLists(qc)
              }}
            />
          )}
          {panel === 'photos' && (
            <PhotosPanel
              trip={trip}
              refresh={() => {
                invalidateTripLists(qc)
                refetch()
              }}
            />
          )}
          {panel === 'track' && <TrackPanel trip={trip} />}
          {panel === 'members' && <MembersPanel trip={trip} />}
        </div>
      </div>
    </div>
  )
}
