import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, Bed, Crosshair, GripVertical, Heart, Loader2, MoreHorizontal, PenLine, Plus, Sparkles, Trash2 } from 'lucide-react'
import type { GeoSearchItem, Phase, TripDetail, TripLeg, Waypoint, WaypointInput } from '@/api'
import { PlaceStatsBadge, WaypointNumber } from '@/components/trip/WaypointItem'
import { dayTone, isLodging, legBetween, legIndex, type DayPlan, type PlanGroups } from '@/components/trip/plan'
import { Button, CategoryChip, Modal, Select, VerdictBadge, confirmDialog } from '@/components/ui'
import { cn } from '@/lib/cn'
import { dayjs, fmtMinutes } from '@/lib/format'
import { formatDistance } from '@/lib/geo'
import { waypointStatus } from '@/lib/meta'
import { ChoiceChip, Stepper } from './Choice'
import { LodgingRow, LodgingSlot } from './LodgingSlot'
import { PlaceSearch, type PickSource } from './PlaceSearch'
import { hasHistory, isNew } from './planDraft'
import { LegLine, TravelModePicker, type DayTotal } from './RouteLegs'
import { WaypointForm } from './WaypointForm'
import { usePlanEditorCtx } from './usePlanEditor'

type LngLat = [number, number]

/** 编辑页的页签：全部 / 第 N 天 / 想去（未安排） */
export type PlanTab = 'all' | 'pool' | number
/** 在地图上点选时，选中的地点加到哪里 */
export type PickTarget = { kind: 'stop'; day: number } | { kind: 'lodging'; night: number }

const pad2 = (n: number) => String(n).padStart(2, '0')

export const poolName = (t: Pick<TripDetail, 'phase'>) => (t.phase === 'planning' ? '想去的地方' : '未分天')

function dayDate(t: TripDetail, day: number) {
  return t.start_date && day > 0 ? dayjs(t.start_date).add(day - 1, 'day') : null
}

/** 搜索结果 → 新地点：离线的城市结果（没有 amap_id）不提交名称，由服务端按地址自动命名 */
export function stopInputOf(it: GeoSearchItem, from: PickSource): WaypointInput {
  return {
    name: it.amap_id || from === 'community' || from === 'tianditu' ? it.name : undefined,
    address: it.address,
    lng: it.lng,
    lat: it.lat,
    category: it.category || undefined,
    amap_id: it.amap_id || undefined,
    province: it.province || undefined,
    city: it.city || undefined,
    district: it.district || undefined,
  }
}

const iconBtn =
  'flex size-8 shrink-0 items-center justify-center rounded-full text-ink-500 transition-colors hover:bg-ink-900/[0.06] hover:text-ink-900 disabled:pointer-events-none disabled:opacity-30'

/* ---------------- 页签：全部 / 第 N 天 / 想去（可以把地点拖到页签上换一天） ---------------- */

function TabChip({
  id,
  selected,
  onClick,
  dot,
  count,
  droppable,
  children,
}: {
  id: string
  selected: boolean
  onClick: () => void
  dot?: ReactNode
  count?: number
  droppable?: boolean
  children: ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable })
  return (
    <ChoiceChip
      ref={setNodeRef}
      role="tab"
      size="sm"
      selected={selected}
      onClick={onClick}
      icon={dot}
      className={cn('h-9 px-3.5', droppable && 'border-dashed', isOver && 'border-solid border-brand-500 bg-brand-100 text-ink-900')}
    >
      {children}
      {count != null && count > 0 && <span className={cn('font-num text-[13px] leading-none', selected ? 'text-ink-700' : 'text-ink-400')}>{count}</span>}
    </ChoiceChip>
  )
}

function DayTabs({ trip, groups, tab, onTab, dragging }: { trip: TripDetail; groups: PlanGroups; tab: PlanTab; onTab: (t: PlanTab) => void; dragging: boolean }) {
  const editor = usePlanEditorCtx()
  const changeDays = async (n: number) => {
    if (n < groups.dayCount) {
      const cut = groups.days.slice(n)
      const stops = cut.reduce((k, d) => k + d.stops.length, 0)
      const nights = [...groups.lodging.keys()].filter((k) => k > n).length
      if (stops || nights) {
        const range = cut.length > 1 ? `第 ${n + 1}–${groups.dayCount} 天` : `第 ${n + 1} 天`
        const ok = await confirmDialog({
          title: `改成 ${n} 天？`,
          desc: `${range}的${stops ? ` ${stops} 个地点会移到「${poolName(trip)}」` : ''}${stops && nights ? '，' : ''}${nights ? '多出来的几晚住宿会移除（照片、评论保留）或放回「想去」' : ''}。`,
          okText: `改成 ${n} 天`,
        })
        if (!ok) return
      }
      if (typeof tab === 'number' && tab > n) onTab(n > 0 ? n : 'all')
    }
    void editor.setDays(n)
  }
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="eyebrow !text-ink-900">Days · 按天安排</p>
        <div className="flex items-center gap-2 text-[12px] text-ink-500">
          {trip.start_date && trip.end_date && (
            <span className="font-num hidden text-[13px] sm:inline">
              {dayjs(trip.start_date).format('M.D')} – {dayjs(trip.end_date).format('M.D')}
            </span>
          )}
          <span>共</span>
          <Stepper value={groups.dayCount} min={trip.start_date ? 1 : 0} max={60} onChange={changeDays} unit="天" label="天数" />
        </div>
      </div>
      <div role="tablist" aria-label="按天查看" className="scrollbar-none -mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pt-0.5 pb-1.5 md:-mx-8 md:px-8">
        <TabChip id="tab-all" selected={tab === 'all'} onClick={() => onTab('all')}>
          全部
        </TabChip>
        {groups.days.map((d) => {
          const date = dayDate(trip, d.day)
          return (
            <TabChip
              key={d.day}
              id={`tab-${d.day}`}
              droppable={dragging}
              selected={tab === d.day}
              onClick={() => onTab(d.day)}
              dot={<span className={cn('size-2 rounded-full', dayTone(d.day).bg)} aria-hidden />}
              count={d.stops.length}
            >
              第{d.day}天
              {date && <span className={cn('font-num text-[12.5px]', tab === d.day ? 'text-ink-700' : 'text-ink-400')}>{date.format('M/D')}</span>}
            </TabChip>
          )
        })}
        <TabChip
          id="tab-pool"
          droppable={dragging}
          selected={tab === 'pool'}
          onClick={() => onTab('pool')}
          dot={<Heart className="size-3.5" strokeWidth={1.5} />}
          count={groups.pool.length}
        >
          {poolName(trip)}
        </TabChip>
      </div>
      {groups.dayCount === 0 && (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-500">还没有分天：点上面的「+」设置玩几天，就能按天安排和设置每晚的住宿。</p>
      )}
    </div>
  )
}

/* ---------------- 一行游玩点 ---------------- */

function StopRow({
  w,
  label,
  tone,
  selected,
  editing,
  onSelect,
  onEdit,
  onMore,
  onDelete,
  onUp,
  onDown,
  pool,
  maxDay,
  poolLabel,
  phase,
  changed,
}: {
  w: Waypoint
  label: string
  tone: string
  selected: boolean
  editing: boolean
  /** 有未保存的修改（新加的点、改过的点） */
  changed?: boolean
  onSelect: () => void
  onEdit: (v: boolean) => void
  onMore: () => void
  onDelete: () => void
  onUp?: () => void
  onDown?: () => void
  /** 「想去」里的点：主要操作是「安排到…」 */
  pool?: boolean
  maxDay: number
  poolLabel: string
  phase: Phase
}) {
  const editor = usePlanEditorCtx()
  const busy = editor.isBusy(w.id)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id, disabled: busy })
  const st = waypointStatus[w.status]
  const statusTone = w.status === 'visited' ? 'text-emerald-700' : w.status === 'skipped' ? 'text-ink-400' : 'text-sky-600'
  return (
    <div
      ref={setNodeRef}
      id={`wp-${w.id}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'relative scroll-mt-[calc(3.75rem+38vh+0.75rem)] transition-colors duration-300 md:scroll-mt-3',
        selected || editing ? 'bg-surface' : 'hover:bg-surface/60',
        isDragging && 'z-10 bg-surface-2 shadow-float',
        busy && 'opacity-55',
      )}
    >
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-0.5 bg-brand-500 transition-opacity', selected ? 'opacity-100' : 'opacity-0')} />
      <div className="flex items-center gap-2 py-2.5 pr-1.5 pl-1 md:pr-3 md:pl-3">
        <button
          type="button"
          {...attributes}
          {...listeners}
          disabled={busy}
          className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-full text-ink-400 transition-colors hover:text-ink-900 active:cursor-grabbing disabled:cursor-default"
          aria-label={`拖动「${w.name || '地点'}」调整顺序或拖到其他天`}
        >
          <GripVertical className="size-4" strokeWidth={1.25} />
        </button>
        {pool ? (
          <span className="font-num flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-ink-500 px-1 text-[12.5px] text-ink-700">
            {label}
          </span>
        ) : (
          <WaypointNumber
            w={w}
            label={label}
            className="shadow-[0_0_0_2px_var(--color-paper),0_0_0_3.5px_var(--tone)]"
            style={{ '--tone': `var(${tone})` } as CSSProperties}
          />
        )}
        <button type="button" onClick={onSelect} aria-pressed={selected} className="min-w-0 flex-1 pl-1 text-left">
          <span
            className={cn(
              'font-display block truncate text-[16.5px] leading-snug text-ink-900',
              w.status === 'skipped' && 'text-ink-400 line-through decoration-ink-300 decoration-1',
            )}
          >
            {w.name || '未命名地点'}
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] tracking-wide">
            {changed && (
              <span className="inline-flex items-center gap-1 text-brand-600" title="还没有保存">
                <span aria-hidden className="size-1.5 rounded-full bg-brand-500" />
                {isNew(w) ? '新加 · 未保存' : '已修改 · 未保存'}
              </span>
            )}
            <CategoryChip category={w.category} className="text-[11px]" />
            {w.planned && w.status !== 'todo' && <span className={statusTone}>{st.label}</span>}
            {!w.planned && <span className="text-violet-600">计划外</span>}
            <VerdictBadge verdict={w.verdict} className="!py-0 text-[11px]" />
            <PlaceStatsBadge stats={w.place_stats} className="!py-0 text-[11px]" />
          </span>
        </button>
        <div className="flex shrink-0 items-center">
          {busy ? (
            <Loader2 className="mx-2 size-4 animate-spin text-ink-400" strokeWidth={1.5} aria-label="保存中" />
          ) : pool ? (
            <button
              type="button"
              onClick={onMore}
              className="inline-flex h-8 items-center gap-1 rounded-full border border-ink-200 px-3 text-[12px] text-ink-800 transition-colors hover:border-ink-500 hover:text-ink-900"
            >
              安排到…
            </button>
          ) : (
            <>
              <button type="button" className={iconBtn} disabled={!onUp} onClick={onUp} aria-label="上移" title="上移">
                <ArrowUp className="size-4" strokeWidth={1.5} />
              </button>
              <button type="button" className={iconBtn} disabled={!onDown} onClick={onDown} aria-label="下移" title="下移">
                <ArrowDown className="size-4" strokeWidth={1.5} />
              </button>
            </>
          )}
          <button
            type="button"
            className={cn(iconBtn, 'hidden md:flex', editing && 'bg-ink-900/[0.08] text-ink-900')}
            disabled={busy}
            onClick={() => onEdit(!editing)}
            aria-expanded={editing}
            aria-label="编辑"
            title="编辑"
          >
            <PenLine className="size-3.5" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className={cn(iconBtn, 'hidden hover:text-brand-600 md:flex')}
            disabled={busy}
            onClick={onDelete}
            aria-label={`删除「${w.name || '未命名地点'}」`}
            title="删除"
          >
            <Trash2 className="size-3.5" strokeWidth={1.5} />
          </button>
          <button type="button" className={iconBtn} disabled={busy} onClick={onMore} aria-label="更多操作：移到其他天、编辑、删除" title="移到其他天、编辑、删除">
            <MoreHorizontal className="size-4" strokeWidth={1.5} />
          </button>
        </div>
      </div>
      {editing && (
        <div className="animate-fade-in mx-4 border-t border-ink-200 pt-5 pb-6 md:mx-8">
          <WaypointForm
            w={w}
            phase={phase}
            maxDay={maxDay}
            poolLabel={poolLabel}
            saving={busy}
            onCancel={() => onEdit(false)}
            onSave={(p) => void editor.update(w, p).then((r) => r && onEdit(false))}
          />
        </div>
      )}
    </div>
  )
}

/** 路段：一条竖线 + 出行方式、用时和路程 */
function Connector({ leg, loading, label }: { leg?: TripLeg; loading?: boolean; label?: ReactNode }) {
  return (
    <div className="flex h-7 min-w-0 items-center gap-2 pr-4 pl-[4.5rem] md:pl-[5rem]">
      {label && <span className="max-w-[45%] shrink-0 truncate text-[11px] text-ink-500">{label}</span>}
      <LegLine leg={leg} loading={loading} />
    </div>
  )
}

/** 正在添加、还没保存好的地点 */
function AddingRow({ name, lodging }: { name: string; lodging?: boolean }) {
  return (
    <div className="flex items-center gap-3 py-3 pr-4 pl-[2.75rem] text-[13px] text-ink-500 md:pl-[3.25rem]">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-ink-400">
        <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
      </span>
      正在添加{lodging ? '住宿' : ''}「{name}」…
    </div>
  )
}

/* ---------------- 主体 ---------------- */

export interface RoutePlannerProps {
  trip: TripDetail
  groups: PlanGroups
  labels: Map<number, string>
  /** 草稿每天路线的各段（已保存的用服务端的路段，新连起来的按直线估算） */
  legs: TripLeg[]
  /** 每天的路程合计 */
  totals: Map<number, DayTotal>
  legsLoading: boolean
  tab: PlanTab
  onTab: (t: PlanTab) => void
  selected: number | null
  onSelect: (w: Waypoint) => void
  editing: number | null
  onEdit: (id: number | null) => void
  /** 开始在地图上为某个位置（某天 / 某晚住宿）选点；再点一次同一个取消 */
  onPick: (target: PickTarget) => void
  pickTarget: PickTarget | null
  /** 新地点加好后：选中、在地图上飞过去 */
  onAdded: (w: Waypoint) => void
  /** 打开「一键排好路线」：pool 只排想去的，all 重新排全部 */
  onArrange: (scope?: 'pool' | 'all') => void
  city?: string
  near?: LngLat | null
}

export function RoutePlanner(props: RoutePlannerProps) {
  const { trip, groups, labels, legs, totals, legsLoading, tab, onTab, selected, onSelect, editing, onEdit, onPick, pickTarget, onAdded, onArrange, city, near } =
    props
  const editor = usePlanEditorCtx()
  const [dragging, setDragging] = useState(false)
  const [sheet, setSheet] = useState<Waypoint | null>(null)
  // 旅行中 / 已完成的旅程：新加的点默认加入计划，也可以补记为已打卡
  const [addAs, setAddAs] = useState<'plan' | 'visited'>(trip.phase === 'finished' ? 'visited' : 'plan')
  const [addDay, setAddDay] = useState(0)
  const idx = useMemo(() => legIndex(legs), [legs])
  const byId = useMemo(() => new Map(trip.waypoints.map((w) => [w.id, w])), [trip.waypoints])
  const changedIds = useMemo(() => new Set(editor.changes.flatMap((c) => (c.id != null ? [c.id] : []))), [editor.changes])
  const pName = poolName(trip)
  const maxDay = Math.max(1, groups.dayCount)
  const target = typeof tab === 'number' ? tab : tab === 'pool' ? 0 : Math.min(addDay, groups.dayCount)
  const flags: WaypointInput =
    trip.phase === 'planning' || addAs === 'plan' ? { planned: true, status: 'todo' } : { planned: false }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  // 指针在页签上：放到那一天；否则按最近的一行排序（可以跨天）
  const collision: CollisionDetection = (args) => {
    const tabs = pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter((c) => String(c.id).startsWith('tab-')) })
    if (tabs.length) return tabs
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => !String(c.id).startsWith('tab-')) })
  }
  const listOf = (day: number) => (day === 0 ? groups.pool : (groups.days.find((d) => d.day === day)?.stops ?? []))

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(false)
    const { active, over } = e
    if (!over) return
    const w = byId.get(Number(active.id))
    if (!w) return
    const oid = String(over.id)
    if (oid.startsWith('tab-')) {
      const day = oid === 'tab-pool' ? 0 : Number(oid.slice(4))
      if (Number.isFinite(day) && day !== w.day) void editor.moveToDay(w, day)
      return
    }
    const o = byId.get(Number(over.id))
    if (!o || o.id === w.id || isLodging(o)) return
    if (o.day === w.day) {
      const ids = listOf(w.day).map((x) => x.id)
      void editor.reorder(w.day, arrayMove(ids, ids.indexOf(w.id), ids.indexOf(o.id)))
    } else void editor.moveToDay(w, o.day, Math.max(0, listOf(o.day).findIndex((x) => x.id === o.id)))
  }

  /** 上移 / 下移：到了一天的开头 / 结尾时移到前一天最后 / 后一天最前 */
  const shift = (w: Waypoint, dir: -1 | 1) => {
    const ids = listOf(w.day).map((x) => x.id)
    const i = ids.indexOf(w.id)
    const j = i + dir
    if (j >= 0 && j < ids.length) return () => void editor.reorder(w.day, arrayMove(ids, i, j))
    if (w.day === 0) return undefined
    if (dir < 0 && w.day > 1) return () => void editor.moveToDay(w, w.day - 1)
    if (dir > 0 && w.day < groups.dayCount) return () => void editor.moveToDay(w, w.day + 1, 0)
    return undefined
  }

  const del = async (w: Waypoint) => {
    if (editor.isBusy(w.id)) return
    const photos = trip.photos.filter((p) => p.waypoint_id === w.id).length
    if (editing === w.id) onEdit(null)
    // 打卡记录（计划外的打卡、已到达、有照片）：立即删除，先确认
    if (!isNew(w) && hasHistory(trip, w)) {
      const ok = await confirmDialog({
        title: `删除打卡记录「${w.name || '未命名地点'}」？`,
        desc: `这是已经去过的地点，会立即删除（不用再点保存）。${photos ? `关联的 ${photos} 张照片会保留。` : '备注和评价会一起删除。'}`,
        danger: true,
        okText: '删除',
      })
      if (ok) void editor.remove(w)
      return
    }
    const rich = !!w.note.trim() || !!w.verdict || w.rating > 0
    if (!rich) return void editor.remove(w, { undo: true })
    const ok = await confirmDialog({
      title: `删除「${w.name || '未命名地点'}」？`,
      desc: '备注和评价会一起删除（保存后生效）。',
      danger: true,
      okText: '删除',
    })
    if (ok) void editor.remove(w)
  }

  const add = (it: GeoSearchItem, from: PickSource) =>
    void editor.addStop(stopInputOf(it, from), target, flags).then((w) => w && onAdded(w))

  const row = (w: Waypoint, i: number, day: number) => (
    <StopRow
      key={w.id}
      w={w}
      label={labels.get(w.id) ?? String(i + 1)}
      tone={dayTone(day).v}
      pool={day === 0 && groups.dayCount > 0}
      selected={selected === w.id}
      editing={editing === w.id}
      onSelect={() => onSelect(w)}
      onEdit={(v) => onEdit(v ? w.id : null)}
      onMore={() => setSheet(w)}
      onDelete={() => void del(w)}
      onUp={shift(w, -1)}
      onDown={shift(w, 1)}
      maxDay={maxDay}
      poolLabel={pName}
      phase={trip.phase}
      changed={changedIds.has(w.id)}
    />
  )

  /** 一天的路线：出发的住宿 → 游玩点（中间是路段）→ 当晚住宿 */
  const dayBlock = (d: DayPlan, full: boolean) => {
    const tone = dayTone(d.day)
    const t = totals.get(d.day)
    const date = dayDate(trip, d.day)
    // 路段：出发住宿 → 第一个计划点，每个计划点 → 下一个计划点（或当晚住宿）
    const planned = d.stops.filter((w) => w.planned)
    const chain = [d.start, ...planned, d.end].filter((w): w is Waypoint => !!w)
    const legAfter = new Map<number | 'start', TripLeg | undefined>()
    for (let i = 0; i + 1 < chain.length; i++) {
      const key = i === 0 && d.start ? 'start' : chain[i].id
      legAfter.set(key, legBetween(idx, chain[i], chain[i + 1]))
    }
    const hasLeg = (k: number | 'start') => legAfter.has(k)
    const adding = editor.adding.filter((a) => !a.lodging && a.day === d.day)
    const last = d.day === groups.dayCount
    return (
      <section key={d.day} aria-label={`第 ${d.day} 天`} className={cn(!full && 'pt-2')}>
        <header className="flex items-baseline gap-2.5 border-t border-ink-200 pt-3 pb-2">
          <span className={cn('size-2 shrink-0 translate-y-[-1px] rounded-full', tone.bg)} aria-hidden />
          {full ? (
            <span className="eyebrow !text-ink-900">Day {pad2(d.day)}</span>
          ) : (
            <button type="button" onClick={() => onTab(d.day)} className="eyebrow !text-ink-900 underline-offset-4 hover:underline">
              Day {pad2(d.day)}
            </button>
          )}
          {date && <span className="text-[12.5px] text-ink-700">{date.format('M月D日 ddd')}</span>}
          <span className="caption ml-auto shrink-0 !text-[11.5px]">
            <span className="font-num text-[13px] text-ink-900">{d.stops.length}</span> 站
            {t && t.duration_s > 0 && (
              <>
                <span className="mx-1 text-ink-300">·</span>路上{t.estimated ? '约' : ''}{' '}
                <span className="font-num text-[13px] text-ink-900">{fmtMinutes(t.duration_s)}</span>
                <span className="mx-1 text-ink-300">·</span>
                <span className="font-num text-[13px]">{formatDistance(t.distance_m)}</span>
              </>
            )}
          </span>
        </header>
        <div className="relative -mx-4 md:-mx-8">
          {/* 时间线：竖线串起住宿和各站 */}
          <span aria-hidden className="absolute top-4 bottom-4 left-[57.5px] w-px opacity-60 md:left-[65.5px]" style={{ background: `var(${tone.v})` }} />
          {d.day === 1 ? (
            <LodgingSlot
              night={0}
              groups={groups}
              caption="出发前一晚"
              emptyTitle="出发前一晚住哪儿？"
              collapsed="出发前一晚住哪儿（可选）"
              selectedId={selected}
              onSelect={onSelect}
              onPickOnMap={(n) => onPick({ kind: 'lodging', night: n })}
              picking={pickTarget?.kind === 'lodging' && pickTarget.night === 0}
              city={city}
              near={near}
            />
          ) : (
            full &&
            (d.start ? (
              <LodgingRow
                w={d.start}
                night={d.day - 1}
                caption="从前一晚的住处出发"
                selected={selected === d.start.id}
                onSelect={() => onSelect(d.start!)}
              />
            ) : (
              // 前一晚没有住宿：从第一站出发；也可以在这里补上前一晚住哪儿
              <LodgingSlot
                night={d.day - 1}
                groups={groups}
                caption={`第 ${d.day - 1} 晚`}
                emptyTitle="前一晚住哪儿？这天从那里出发"
                collapsed="从第一站出发 · 前一晚住哪儿？"
                selectedId={selected}
                onSelect={onSelect}
                onPickOnMap={(n) => onPick({ kind: 'lodging', night: n })}
                picking={pickTarget?.kind === 'lodging' && pickTarget.night === d.day - 1}
                city={city}
                near={near}
              />
            ))
          )}
          {!dragging && hasLeg('start') && (
            <Connector
              leg={legAfter.get('start')}
              loading={legsLoading}
              label={!full && d.day > 1 && d.start ? `从「${d.start.name}」出发` : undefined}
            />
          )}
          <SortableContext items={d.stops.map((w) => w.id)} strategy={verticalListSortingStrategy}>
            {d.stops.map((w, i) => (
              <Fragment key={w.id}>
                {row(w, i, d.day)}
                {!dragging && hasLeg(w.id) && (d.end || i < d.stops.length - 1) && <Connector leg={legAfter.get(w.id)} loading={legsLoading} />}
              </Fragment>
            ))}
          </SortableContext>
          {adding.map((a) => (
            <AddingRow key={a.key} name={a.name} />
          ))}
          {!d.stops.length && !adding.length && (
            <p className="py-4 pr-4 pl-[4.5rem] text-[13px] leading-relaxed text-ink-500 md:pl-[5rem]">
              这一天还没有安排地点。{full ? `在上面搜索添加${groups.pool.length ? `，或从下面「${pName}」里挑` : ''}。` : ''}
            </p>
          )}
          <LodgingSlot
            night={d.day}
            groups={groups}
            caption={`第 ${d.day} 晚`}
            emptyTitle="今晚住哪儿？"
            collapsed={last ? '最后一晚也要住宿？' : !full ? '今晚住哪儿？' : undefined}
            selectedId={selected}
            onSelect={onSelect}
            onPickOnMap={(n) => onPick({ kind: 'lodging', night: n })}
            picking={pickTarget?.kind === 'lodging' && pickTarget.night === d.day}
            city={city}
            near={near}
          />
          {groups.extraLodging
            .filter((w) => w.day === d.day)
            .map((w) => (
              <LodgingRow
                key={w.id}
                w={w}
                night={d.day}
                caption="同一晚的另一处住宿"
                selected={selected === w.id}
                onSelect={() => onSelect(w)}
                actions={
                  <button type="button" className={cn(iconBtn, 'hover:text-brand-600')} onClick={() => void editor.remove(w, { undo: true })} aria-label="删除">
                    <Trash2 className="size-3.5" strokeWidth={1.5} />
                  </button>
                }
              />
            ))}
        </div>
      </section>
    )
  }

  const arrangeCta = (compact?: boolean) =>
    groups.pool.some((w) => w.planned) && (
      <div className={cn('rounded-lg border border-brand-300 bg-brand-50', compact ? 'px-4 py-3' : 'p-4')}>
        <div className="flex items-center gap-3">
          <Sparkles className="size-5 shrink-0 text-brand-500" strokeWidth={1.5} />
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-medium text-ink-900">一键排好路线</p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-600">
              把 {groups.pool.filter((w) => w.planned).length} 个想去的地方分到{groups.dayCount ? ` ${groups.dayCount} 天` : '每一天'}，按住处排出最顺的顺序。先看预览再决定。
            </p>
          </div>
          <Button size="sm" onClick={() => onArrange('pool')} className="shrink-0">
            预览方案
          </Button>
        </div>
      </div>
    )

  const poolBlock = (full: boolean) => {
    const adding = editor.adding.filter((a) => !a.lodging && a.day === 0)
    if (!full && !groups.pool.length && !adding.length) return null
    return (
      <section aria-label={pName}>
        <header className="flex items-baseline gap-2.5 border-t border-ink-200 pt-3 pb-2">
          <Heart className="size-3.5 shrink-0 translate-y-[1px] text-ink-500" strokeWidth={1.5} />
          {full ? (
            <span className="eyebrow !text-ink-900">Wishlist · {pName}</span>
          ) : (
            <button type="button" onClick={() => onTab('pool')} className="eyebrow !text-ink-900 underline-offset-4 hover:underline">
              Wishlist · {pName}
            </button>
          )}
          <span className="caption ml-auto !text-[11.5px]">
            <span className="font-num text-[13px] text-ink-900">{groups.pool.length}</span> 个{groups.dayCount > 0 ? '，还没安排到某天' : ''}
          </span>
        </header>
        <div className="-mx-4 md:-mx-8">
          <SortableContext items={groups.pool.map((w) => w.id)} strategy={verticalListSortingStrategy}>
            {groups.pool.map((w, i) => row(w, i, 0))}
          </SortableContext>
          {adding.map((a) => (
            <AddingRow key={a.key} name={a.name} />
          ))}
        </div>
        {full && !groups.pool.length && !adding.length && (
          <p className="py-5 text-[13px] leading-relaxed text-ink-500">
            先把想去的景点、美食、街区都加进来（上面搜索，或在地图上点选），不用管顺序；再「一键排好路线」分到每一天。
          </p>
        )}
      </section>
    )
  }

  /** 某一天里：从「想去」挑几个加进来 */
  const poolPicks = (day: number) =>
    groups.pool.length > 0 && (
      <section className="rounded-lg border border-ink-200 px-4 py-3">
        <p className="flex items-baseline gap-2 text-[12.5px] text-ink-500">
          <Heart className="size-3.5 translate-y-[2px]" strokeWidth={1.5} />从「{pName}」里挑，加到第 {day} 天
        </p>
        <ul className="mt-2 divide-y divide-ink-200">
          {groups.pool.slice(0, 8).map((w) => (
            <li key={w.id} className="flex items-center gap-3 py-2">
              <span className="font-display min-w-0 flex-1 truncate text-[15px] text-ink-800">{w.name}</span>
              <CategoryChip category={w.category} className="hidden text-[11px] sm:inline-flex" />
              <button
                type="button"
                disabled={editor.isBusy(w.id)}
                onClick={() => void editor.moveToDay(w, day)}
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-ink-200 px-3 text-[12px] text-ink-800 transition-colors hover:border-brand-500 hover:text-ink-900 disabled:opacity-40"
              >
                <Plus className="size-3.5" strokeWidth={1.5} />
                加到这天
              </button>
            </li>
          ))}
        </ul>
      </section>
    )

  const picking = pickTarget?.kind === 'stop' && pickTarget.day === target
  const addBar = (
    <div className="space-y-2.5">
      <PlaceSearch
        onPick={add}
        city={city}
        near={near}
        placeholder={target === 0 ? '搜索想去的地方：景点、美食、街区…' : `搜索地点，加到第 ${target} 天`}
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[12px] text-ink-500">
        {tab === 'all' && groups.dayCount > 0 ? (
          <>
            <span>加到</span>
            <Select
              value={target}
              onChange={(e) => setAddDay(Number(e.target.value))}
              className="h-8 w-auto rounded-full pr-8 pl-3 text-[12px]"
              aria-label="加到哪一天"
            >
              <option value={0}>{pName}</option>
              {groups.days.map((d) => (
                <option key={d.day} value={d.day}>
                  第 {d.day} 天
                </option>
              ))}
            </Select>
          </>
        ) : (
          <span>
            加到<span className="ml-1 text-ink-900">{target === 0 ? `「${pName}」` : `第 ${target} 天`}</span>
          </span>
        )}
        <button
          type="button"
          onClick={() => onPick({ kind: 'stop', day: target })}
          aria-pressed={picking}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors',
            picking ? 'border-brand-500 bg-brand-100 text-ink-900' : 'border-ink-200 text-ink-700 hover:border-ink-500 hover:text-ink-900',
          )}
        >
          <Crosshair className="size-3.5" strokeWidth={1.5} />
          {picking ? '正在地图上点选…' : '在地图上点选'}
        </button>
        {trip.phase !== 'planning' && (
          <div role="radiogroup" aria-label="新加的点" className="ml-auto flex gap-1.5">
            <ChoiceChip size="sm" selected={addAs === 'plan'} onClick={() => setAddAs('plan')}>
              加入计划
            </ChoiceChip>
            <ChoiceChip size="sm" selected={addAs === 'visited'} onClick={() => setAddAs('visited')}>
              记为已打卡
            </ChoiceChip>
          </div>
        )}
      </div>
    </div>
  )

  const dayCur = typeof tab === 'number' ? groups.days.find((d) => d.day === tab) : undefined

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={() => setDragging(true)}
      onDragCancel={() => setDragging(false)}
      onDragEnd={onDragEnd}
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="eyebrow !text-ink-900">Getting around · 出行方式</p>
          <TravelModePicker value={trip.travel_mode || 'auto'} onChange={(m) => void editor.setTravelMode(m)} loading={legsLoading && !legs} />
        </div>
        <div className="md:sticky md:-top-6 md:z-20 md:-mx-8 md:bg-paper md:px-8 md:pt-4 md:pb-1">
          <DayTabs trip={trip} groups={groups} tab={tab} onTab={onTab} dragging={dragging} />
        </div>
        {addBar}
        {tab === 'all' && (
          <div className="space-y-6">
            {groups.dayCount > 0 && arrangeCta(true)}
            {groups.dayCount > 0 && !groups.pool.some((w) => w.planned) && groups.days.reduce((n, d) => n + d.stops.length, 0) >= 3 && (
              <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-500">
                <Sparkles className="size-3.5 text-brand-500" strokeWidth={1.5} />
                顺序不满意？
                <button
                  type="button"
                  onClick={() => onArrange('all')}
                  className="text-ink-900 underline decoration-ink-300 underline-offset-4 transition-colors hover:decoration-ink-900"
                >
                  一键重新排全部路线
                </button>
                <span className="text-ink-400">（先看预览）</span>
              </p>
            )}
            {groups.dayCount === 0 ? poolBlock(true) : groups.days.map((d) => dayBlock(d, false))}
            {groups.dayCount > 0 && poolBlock(false)}
          </div>
        )}
        {dayCur && (
          <div className="space-y-6">
            {dayBlock(dayCur, true)}
            {poolPicks(dayCur.day)}
          </div>
        )}
        {tab === 'pool' && (
          <div className="space-y-5">
            {arrangeCta()}
            {poolBlock(true)}
          </div>
        )}
        {trip.waypoints.length > 1 && (
          <p className="text-center text-[11px] leading-relaxed tracking-wide text-ink-500">
            拖动左侧把手调整顺序，拖到上面的「第 N 天」页签可以换一天；拖动地图上的标记可以微调位置
          </p>
        )}
      </div>
      <MoveSheet trip={trip} groups={groups} w={sheet} onClose={() => setSheet(null)} onEdit={(w) => onEdit(w.id)} onDelete={(w) => void del(w)} />
    </DndContext>
  )
}

/* ---------------- 「更多」：移到哪一天、设为住宿、编辑、删除 ---------------- */

function MoveSheet({
  trip,
  groups,
  w,
  onClose,
  onEdit,
  onDelete,
}: {
  trip: TripDetail
  groups: PlanGroups
  w: Waypoint | null
  onClose: () => void
  onEdit: (w: Waypoint) => void
  onDelete: (w: Waypoint) => void
}) {
  const editor = usePlanEditorCtx()
  const pName = poolName(trip)
  const open = !!w
  const hotel = w?.category === 'hotel'
  return (
    <Modal open={open} onClose={onClose} title={w?.name || '地点'}>
      {w && (
        <div className="space-y-6 pb-2">
          <div>
            <p className="mb-2.5 text-xs tracking-[0.06em] text-ink-500">移到哪一天</p>
            <div role="radiogroup" aria-label="移到哪一天" className="flex flex-wrap gap-1.5">
              {groups.days.map((d) => {
                const date = dayDate(trip, d.day)
                return (
                  <ChoiceChip
                    key={d.day}
                    selected={w.day === d.day}
                    icon={<span className={cn('size-2 rounded-full', dayTone(d.day).bg)} aria-hidden />}
                    onClick={() => {
                      if (w.day !== d.day) void editor.moveToDay(w, d.day)
                      onClose()
                    }}
                  >
                    第 {d.day} 天{date && <span className="font-num text-[12.5px] text-ink-500">{date.format('M/D')}</span>}
                  </ChoiceChip>
                )
              })}
              <ChoiceChip
                selected={w.day === 0}
                icon={<Heart className="size-3.5" strokeWidth={1.5} />}
                onClick={() => {
                  if (w.day !== 0) void editor.moveToDay(w, 0)
                  onClose()
                }}
              >
                {pName}
              </ChoiceChip>
            </div>
            {groups.dayCount === 0 && <p className="mt-2 text-xs text-ink-500">还没有分天：先在「按天安排」里设置玩几天。</p>}
          </div>
          {hotel && groups.dayCount > 0 && (
            <div>
              <p className="mb-2.5 flex items-center gap-1.5 text-xs tracking-[0.06em] text-ink-500">
                <Bed className="size-3.5" strokeWidth={1.5} />
                设为哪一晚的住宿
              </p>
              <div className="flex flex-wrap gap-1.5">
                {Array.from({ length: groups.dayCount + 1 }, (_, n) => n).map((n) => (
                  <ChoiceChip
                    key={n}
                    size="sm"
                    selected={false}
                    role="button"
                    onClick={() => {
                      void editor.makeLodging(w, n)
                      onClose()
                    }}
                  >
                    {n === 0 ? '出发前一晚' : `第 ${n} 晚`}
                    {groups.lodging.get(n) && <span className="text-ink-400">（替换）</span>}
                  </ChoiceChip>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2 border-t border-ink-200 pt-5">
            <Button
              variant="outline"
              icon={<PenLine className="size-4" strokeWidth={1.5} />}
              onClick={() => {
                onEdit(w)
                onClose()
              }}
            >
              编辑详情
            </Button>
            <Button
              variant="ghost"
              className="text-brand-600 hover:text-brand-700"
              icon={<Trash2 className="size-4" strokeWidth={1.5} />}
              onClick={() => {
                onClose()
                onDelete(w)
              }}
            >
              删除
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
