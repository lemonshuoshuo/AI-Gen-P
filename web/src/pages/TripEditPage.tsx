import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Marker, type MapMouseEvent } from 'maplibre-gl'
import { DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  ArrowLeft,
  Crosshair,
  Eye,
  GripVertical,
  ImageIcon,
  Info,
  Play,
  Route,
  Star,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api,
  errorMessage,
  type GeoSearchItem,
  type Phase,
  type TripDetail,
  type TripInput,
  type Visibility,
  type Waypoint,
  type WaypointInput,
} from '@/api'
import { BaseMap, useMap } from '@/components/map/BaseMap'
import { FitOnce, RouteLines } from '@/components/map/layers'
import { PhotoImporter } from '@/components/editor/PhotoImporter'
import { PlaceSearch } from '@/components/editor/PlaceSearch'
import { WaypointForm } from '@/components/editor/WaypointForm'
import { WaypointNumber } from '@/components/trip/WaypointItem'
import {
  Avatar,
  Button,
  CategoryChip,
  Empty,
  Field,
  Input,
  PageLoader,
  Segmented,
  Select,
  Tag,
  Textarea,
  UserName,
  VerdictBadge,
  confirmDialog,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { dayjs } from '@/lib/format'
import { categoryOf, phases, visibilities, waypointStatus } from '@/lib/meta'
import { actualPath, bySeq, plannedPath } from '@/lib/trip'
import { useAuth } from '@/stores/auth'

type Panel = 'route' | 'info' | 'photos' | 'members'

/* ---------------- 地图上可拖动的打卡点 ---------------- */
function EditableMarkers({
  waypoints,
  selectedId,
  onSelect,
  onMove,
}: {
  waypoints: Waypoint[]
  selectedId: number | null
  onSelect: (w: Waypoint) => void
  onMove: (w: Waypoint, lngLat: [number, number]) => void
}) {
  const map = useMap()
  const cb = useRef({ onSelect, onMove })
  cb.current = { onSelect, onMove }
  useEffect(() => {
    if (!map) return
    const markers = waypoints.map((w, i) => {
      const el = document.createElement('div')
      const c = w.status === 'skipped' ? '#9895a5' : categoryOf(w.category).color
      const todo = w.planned && w.status === 'todo'
      const sel = w.id === selectedId
      el.innerHTML = `<div style="transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;cursor:grab">
        <div style="min-width:${sel ? 34 : 28}px;height:${sel ? 34 : 28}px;padding:0 6px;border-radius:999px;display:flex;align-items:center;justify-content:center;font:700 12px system-ui;color:${todo ? c : '#fff'};background:${todo ? '#fff' : c};border:2.5px ${todo ? 'dashed' : 'solid'} ${todo ? c : '#fff'};box-shadow:0 2px 8px rgba(0,0,0,.25);${sel ? 'outline:3px solid rgba(255,90,95,.45)' : ''}">${i + 1}</div>
        <div style="width:2px;height:8px;background:${c}"></div></div>`
      const m = new Marker({ element: el, anchor: 'bottom', draggable: true }).setLngLat([w.lng, w.lat]).addTo(map)
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        cb.current.onSelect(w)
      })
      m.on('dragend', () => {
        const p = m.getLngLat()
        cb.current.onMove(w, [p.lng, p.lat])
      })
      return m
    })
    return () => markers.forEach((m) => m.remove())
  }, [map, waypoints, selectedId])
  return null
}

function MapClick({ enabled, onClick }: { enabled: boolean; onClick: (p: [number, number]) => void }) {
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

function FlyTo({ target }: { target: [number, number] | null }) {
  const map = useMap()
  useEffect(() => {
    if (map && target) map.flyTo({ center: target, zoom: Math.max(map.getZoom(), 14), duration: 700 })
  }, [map, target])
  return null
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
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id })
  const st = waypointStatus[w.status]
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('rounded-2xl bg-white shadow-card', isDragging && 'relative z-10 shadow-float', selected && 'ring-2 ring-brand-200')}
    >
      <div className="flex items-center gap-2 p-2.5" onClick={onSelect}>
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab touch-none p-1 text-ink-300 hover:text-ink-500 active:cursor-grabbing"
          aria-label="拖动排序"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="size-4" />
        </button>
        <WaypointNumber w={w} label={String(index + 1)} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{w.name || '未命名地点'}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {w.day > 0 && <Tag className="!py-0 text-[11px]">第{w.day}天</Tag>}
            <CategoryChip category={w.category} className="!py-0 text-[11px]" />
            {phase !== 'planning' && w.planned && <span className={cn('rounded-full px-1.5 text-[11px]', st.cls)}>{st.label}</span>}
            {!w.planned && <span className="rounded-full bg-violet-50 px-1.5 text-[11px] text-violet-700">计划外</span>}
            <VerdictBadge verdict={w.verdict} className="!py-0 text-[11px]" />
          </div>
        </div>
        <Button size="xs" variant={editing ? 'secondary' : 'ghost'} onClick={(e) => (e.stopPropagation(), onEdit(!editing))}>
          {editing ? '收起' : '编辑'}
        </Button>
        <button
          type="button"
          className="p-1.5 text-ink-300 hover:text-red-500"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          aria-label="删除"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      {editing && (
        <div className="px-2.5 pb-2.5">
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
      if (trip.is_owner) body.visibility = f.visibility
      const t = await api.trips.update(trip.id, body)
      onSaved(t)
      toast.success('已保存')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="space-y-4">
      <Field label="标题">
        <Input value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={80} />
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
      {trip.is_owner && (
        <Field label="谁可以看" hint={visibilities[f.visibility].desc}>
          <Segmented<Visibility>
            value={f.visibility}
            onChange={(v) => set('visibility', v)}
            options={(['private', 'unlisted', 'public'] as Visibility[]).map((v) => ({ value: v, label: visibilities[v].label }))}
          />
        </Field>
      )}
      <Field label="一句话简介">
        <Textarea value={f.summary} onChange={(e) => set('summary', e.target.value)} maxLength={300} className="min-h-16" />
      </Field>
      <Field label="游记正文" hint="支持 Markdown：## 标题、**加粗**、- 列表">
        <Textarea
          value={f.content}
          onChange={(e) => set('content', e.target.value)}
          className="min-h-48"
          placeholder="写写这段旅程的故事、整体攻略、预算、交通建议…"
        />
      </Field>
      <Field label="标签" hint="空格分隔，如：情侣 美食 周末游">
        <Input value={f.tags} onChange={(e) => set('tags', e.target.value)} />
      </Field>
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
    <div className="space-y-4">
      <PhotoImporter tripId={trip.id} onDone={refresh} defaultAuto={trip.phase !== 'planning'} compact={trip.photos.length > 0} />
      {trip.photos.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {trip.photos.map((p) => (
            <div key={p.id} className="overflow-hidden rounded-xl bg-white shadow-card">
              <div className="relative aspect-square bg-ink-100">
                <img src={p.thumb_url} alt="" loading="lazy" className="size-full object-cover" />
                {trip.cover_url === p.url && (
                  <span className="absolute top-1.5 left-1.5 rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-white">封面</span>
                )}
              </div>
              <div className="space-y-1.5 p-1.5">
                <Select
                  value={p.waypoint_id ?? 0}
                  onChange={(e) => assign(p.id, Number(e.target.value))}
                  className="h-7 rounded-lg px-2 text-xs"
                >
                  <option value={0}>未关联打卡点</option>
                  {sorted.map((w, i) => (
                    <option key={w.id} value={w.id}>
                      {i + 1}. {w.name}
                    </option>
                  ))}
                </Select>
                <div className="flex justify-between">
                  <button type="button" onClick={() => setCover(p.url)} className="flex items-center gap-0.5 text-xs text-ink-500 hover:text-amber-600">
                    <Star className="size-3" />
                    设为封面
                  </button>
                  <button type="button" onClick={() => remove(p.id)} className="text-ink-300 hover:text-red-500" aria-label="删除">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------------- 成员 ---------------- */
function MembersPanel({ trip }: { trip: TripDetail }) {
  const me = useAuth((s) => s.user)
  const qc = useQueryClient()
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
  const remove = async (uid: number) => {
    try {
      await api.trips.removeMember(trip.id, uid)
      refetch()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const partner = me?.partner
  const partnerIn = partner && members.some((m) => m.user.id === partner.id)
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-500">共同作者可以一起编辑路线、打卡、上传照片。和情侣一起的旅程会出现在「我们」的足迹里。</p>
      {trip.is_owner && partner && !partnerIn && (
        <button
          type="button"
          onClick={() => invite(partner.username)}
          className="bg-love-gradient flex w-full items-center gap-3 rounded-2xl p-3 text-left text-white"
        >
          <Avatar user={partner} size={36} ring />
          <span className="flex-1 text-sm font-medium">把 {partner.nickname || partner.username} 加入这段旅程 💕</span>
        </button>
      )}
      {trip.is_owner && (
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="输入对方用户名" />
          <Button disabled={!name.trim()} onClick={() => invite(name.trim())} icon={<UserPlus className="size-4" />}>
            邀请
          </Button>
        </div>
      )}
      <div className="space-y-2">
        {members.map((m) => (
          <div key={m.user.id} className="flex items-center gap-3 rounded-2xl bg-white p-3 shadow-card">
            <Avatar user={m.user} size={36} />
            <div className="min-w-0 flex-1">
              <UserName user={m.user} />
              <div className="text-xs text-ink-400">
                {m.role === 'owner' ? '作者' : m.status === 'pending' ? '已邀请，等待接受' : '共同作者'}
              </div>
            </div>
            {m.role !== 'owner' && (trip.is_owner || m.user.id === me?.id) && (
              <Button size="xs" variant="ghost" onClick={() => remove(m.user.id)}>
                {m.user.id === me?.id ? '退出' : '移除'}
              </Button>
            )}
          </div>
        ))}
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
  const [addDay, setAddDay] = useState(0)
  const [flyTarget, setFlyTarget] = useState<[number, number] | null>(null)
  const [order, setOrder] = useState<Waypoint[]>([])

  useEffect(() => {
    if (trip) setOrder([...trip.waypoints].sort(bySeq))
  }, [trip])

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

  if (isLoading) return <PageLoader />
  if (error || !trip) return <Empty className="min-h-[60vh]" title="旅程不存在或无权编辑" desc={errorMessage(error)} />
  if (!trip.can_edit) return <Empty className="min-h-[60vh]" title="你没有编辑权限" />

  const refresh = () => qc.invalidateQueries({ queryKey: key })
  const near = order.length ? ([order[order.length - 1].lng, order[order.length - 1].lat] as [number, number]) : null

  const addWaypoint = async (input: WaypointInput, openEditor = false) => {
    try {
      const w = await api.waypoints.create(trip.id, { ...input, day: input.day ?? addDay })
      await refresh()
      setSelected(w.id)
      setFlyTarget([w.lng, w.lat])
      if (openEditor) setEditing(w.id)
      toast.success(`已添加：${w.name}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const onPick = (it: GeoSearchItem) =>
    addWaypoint({
      name: it.name,
      address: it.address,
      lng: it.lng,
      lat: it.lat,
      category: it.category || undefined,
      amap_id: it.amap_id || undefined,
    })

  const onMapPick = async (p: [number, number]) => {
    setPickMode(false)
    let name = ''
    let address = ''
    try {
      const r = await api.geo.regeo({ lng: p[0], lat: p[1] })
      name = r.street || r.district || r.city || ''
      address = r.address
    } catch {
      /* 逆地理失败时仍可添加 */
    }
    addWaypoint({ name: name || '地图选点', address, lng: p[0], lat: p[1] }, true)
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

  const moveWaypoint = async (w: Waypoint, p: [number, number]) => {
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

  const tabs: { value: Panel; label: string; icon: typeof Route }[] = [
    { value: 'route', label: '路线', icon: Route },
    { value: 'info', label: '信息', icon: Info },
    { value: 'photos', label: `照片${trip.photos.length ? ` ${trip.photos.length}` : ''}`, icon: ImageIcon },
    { value: 'members', label: '成员', icon: Users },
  ]

  return (
    <div className="md:grid md:h-[calc(100dvh-3.5rem)] md:grid-cols-[440px_1fr]">
      <div className="sticky top-14 z-20 md:static md:order-2 md:h-full">
        <BaseMap
          className="h-[38vh] md:h-full"
          kindSwitcher
          locate
          overlay={
            <div className="absolute top-3 left-3 z-10">
              <Button
                size="sm"
                variant={pickMode ? 'primary' : 'outline'}
                icon={pickMode ? <X className="size-4" /> : <Crosshair className="size-4" />}
                onClick={() => setPickMode((v) => !v)}
              >
                {pickMode ? '取消点选' : '在地图上点选'}
              </Button>
              {pickMode && <p className="glass mt-2 rounded-xl px-3 py-1.5 text-xs text-ink-700 shadow-card">点击地图任意位置添加打卡点</p>}
            </div>
          }
        >
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
          <MapClick enabled={pickMode} onClick={onMapPick} />
          <FitOnce points={order.map((w) => [w.lng, w.lat])} fitKey={`${trip.id}-${order.length > 0}`} />
          <FlyTo target={flyTarget} />
        </BaseMap>
      </div>

      <div className="flex min-h-0 flex-col bg-ink-50 md:order-1 md:border-r md:border-ink-200">
        <div className="border-b border-ink-200 bg-white px-4 pt-3">
          <div className="flex items-center gap-2">
            <Link to={`/trips/${trip.id}`} className="rounded-full p-1.5 hover:bg-ink-100" aria-label="返回">
              <ArrowLeft className="size-5" />
            </Link>
            <h1 className="min-w-0 flex-1 truncate font-bold">{trip.title}</h1>
            <Link to={`/trips/${trip.id}`}>
              <Button size="sm" variant="ghost" icon={<Eye className="size-4" />}>
                预览
              </Button>
            </Link>
            {trip.phase !== 'finished' && (
              <Button size="sm" icon={<Play className="size-4" />} onClick={() => nav(`/trips/${trip.id}/go`)}>
                出发
              </Button>
            )}
          </div>
          <div className="mt-2 flex">
            {tabs.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setPanel(t.value)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2.5 text-sm font-medium',
                  panel === t.value ? 'border-brand-500 text-brand-600' : 'border-transparent text-ink-400',
                )}
              >
                <t.icon className="size-4" />
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {panel === 'route' && (
            <div className="space-y-3">
              <PlaceSearch onPick={onPick} city={trip.cities[0]} near={near} />
              <div className="flex items-center gap-2 text-xs text-ink-500">
                <span className="shrink-0">添加到</span>
                <div className="w-28 shrink-0">
                <Select value={addDay} onChange={(e) => setAddDay(Number(e.target.value))} className="h-8 rounded-lg text-xs">
                  <option value={0}>不分天</option>
                  {Array.from({ length: maxDay + 1 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      第 {d} 天
                    </option>
                  ))}
                </Select>
                </div>
                <span className="ml-auto text-right">{trip.phase === 'planning' ? '新加的点会作为计划路线' : '新加的点记为计划外打卡'}</span>
              </div>
              {order.length === 0 ? (
                <Empty
                  icon={<Route className="size-10" />}
                  title="还没有打卡点"
                  desc="搜索地点、在地图上点选，或者到「照片」里从照片自动生成"
                />
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                  <SortableContext items={order.map((w) => w.id)} strategy={verticalListSortingStrategy}>
                    <div className="space-y-2">
                      {order.map((w, i) => (
                        <div id={`wp-${w.id}`} key={w.id}>
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
                            onEdit={(v) => setEditing(v ? w.id : null)}
                            onSave={(p) => saveWaypoint(w, p)}
                            onDelete={() => deleteWaypoint(w)}
                          />
                        </div>
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
              {order.length > 1 && <p className="text-center text-xs text-ink-400">拖动左侧把手调整顺序，拖动地图上的标记可微调位置</p>}
            </div>
          )}
          {panel === 'info' && <InfoPanel trip={trip} onSaved={(t) => qc.setQueryData(key, t)} />}
          {panel === 'photos' && (
            <PhotosPanel
              trip={trip}
              refresh={() => {
                refetch()
              }}
            />
          )}
          {panel === 'members' && <MembersPanel trip={trip} />}
        </div>
      </div>
    </div>
  )
}

