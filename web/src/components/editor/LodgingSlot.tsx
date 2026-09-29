import { useState, type ReactNode } from 'react'
import { Bed, Copy, Crosshair, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react'
import type { GeoSearchItem, Waypoint } from '@/api'
import { dayTone, type PlanGroups } from '@/components/trip/plan'
import { cn } from '@/lib/cn'
import { PlaceSearch, type PickSource } from './PlaceSearch'
import { Stepper } from './Choice'
import { usePlanEditorCtx } from './usePlanEditor'

type LngLat = [number, number]

/** 搜索结果 → 住宿的字段（与加游玩点相同的规则：离线的城市结果不提交名称） */
export function lodgingInputOf(it: GeoSearchItem, from: PickSource) {
  return {
    name: it.amap_id || from === 'community' || from === 'tianditu' ? it.name : undefined,
    address: it.address,
    lng: it.lng,
    lat: it.lat,
    amap_id: it.amap_id || undefined,
    category: 'hotel' as const,
    province: it.province || undefined,
    city: it.city || undefined,
    district: it.district || undefined,
  }
}

/** 床的方章：边框是那一晚所属那天的颜色；dashed 为空位 */
export function BedMark({ night, dashed, className }: { night: number; dashed?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md border-[1.5px] bg-surface-2 text-ink-900',
        dashed && 'border-dashed bg-transparent text-ink-500',
        className,
      )}
      style={dashed ? undefined : { borderColor: `var(${dayTone(Math.max(1, night)).v})` }}
    >
      <Bed className="size-4" strokeWidth={1.5} />
    </span>
  )
}

/** 一行住宿：床的方章（不编号）+ 小字说明 + 酒店名 */
export function LodgingRow({
  w,
  night,
  caption,
  selected,
  onSelect,
  actions,
  busy,
  className,
}: {
  w: Waypoint
  night: number
  caption: ReactNode
  selected?: boolean
  onSelect?: () => void
  actions?: ReactNode
  busy?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'relative flex items-center gap-3 py-3 pr-2 pl-[2.75rem] transition-colors duration-300 md:pr-4 md:pl-[3.25rem]',
        selected ? 'bg-surface' : 'hover:bg-surface/60',
        busy && 'opacity-60',
        className,
      )}
    >
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-0.5 bg-brand-500 transition-opacity', selected ? 'opacity-100' : 'opacity-0')} />
      <BedMark night={night} />
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left" aria-pressed={selected}>
        <span className="eyebrow block !text-[10px] !leading-4">{caption}</span>
        <span className="font-display block truncate text-[16px] leading-snug text-ink-900">{w.name || '住宿'}</span>
        {(w.district || w.address) && <span className="block truncate text-[11.5px] text-ink-500">{[w.district, w.address].filter(Boolean).join(' · ')}</span>}
      </button>
      {actions}
    </div>
  )
}

const quiet =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-ink-200 px-3 text-[12px] text-ink-700 transition-colors hover:border-ink-500 hover:text-ink-900 disabled:opacity-50'
const iconBtn =
  'flex size-8 shrink-0 items-center justify-center rounded-full text-ink-500 transition-colors hover:bg-ink-900/[0.06] hover:text-ink-900 disabled:opacity-40'

/**
 * 某一晚的住宿（第 night 天晚上；0 为出发前一晚）：已设置时显示酒店（更换 / 清除），
 * 没有时是一个空位：搜索酒店、「同前一晚」、在地图上选、从「想去」里的酒店选
 */
export function LodgingSlot({
  night,
  groups,
  caption,
  emptyTitle,
  collapsed,
  selectedId,
  onSelect,
  onPickOnMap,
  picking,
  city,
  near,
}: {
  night: number
  groups: PlanGroups
  caption: string
  /** 空位的标题，如「今晚住哪儿？」 */
  emptyTitle: string
  /** 可选的住宿（最后一天、出发前一晚）：没有时只显示一行「+ …」 */
  collapsed?: string
  selectedId: number | null
  onSelect: (w: Waypoint) => void
  onPickOnMap: (night: number) => void
  /** 正在地图上为这一晚选点 */
  picking?: boolean
  city?: string
  near?: LngLat | null
}) {
  const editor = usePlanEditorCtx()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [nights, setNights] = useState(1)
  const lodging = groups.lodging.get(night) ?? null
  const prev = night > 0 ? (groups.lodging.get(night - 1) ?? null) : null
  const pending = editor.adding.some((a) => a.lodging && a.day === night)
  const hotels = groups.pool.filter((w) => w.category === 'hotel')
  const maxNights = Math.max(1, groups.dayCount - night + (night === 0 ? 0 : 1))

  const pick = (it: GeoSearchItem, from: PickSource) => {
    setOpen(false)
    void editor.setLodging(night, lodgingInputOf(it, from), nights)
    setNights(1)
  }

  const search = open && (
    <div className="animate-fade-in space-y-2.5 pt-1 pb-3">
      <PlaceSearch onPick={pick} city={city} near={near} placeholder="搜索酒店、民宿、客栈…" autoFocus />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-ink-500">
        {maxNights > 1 && (
          <>
            <span>连住</span>
            <Stepper value={nights} min={1} max={Math.min(30, maxNights)} onChange={setNights} unit="晚" label="连住几晚" />
          </>
        )}
        <button type="button" onClick={() => setOpen(false)} className="ml-auto h-8 px-2 text-ink-500 hover:text-ink-900">
          取消
        </button>
      </div>
    </div>
  )

  if (lodging)
    return (
      <div>
        <LodgingRow
          w={lodging}
          night={night}
          caption={editor.changes.some((c) => c.id === lodging.id) ? `${caption} · 未保存` : caption}
          selected={selectedId === lodging.id}
          onSelect={() => onSelect(lodging)}
          busy={editor.isBusy(lodging.id)}
          actions={
            <div className="flex shrink-0 items-center gap-0.5">
              <button type="button" className={iconBtn} disabled={editor.isBusy(lodging.id)} onClick={() => setOpen((v) => !v)} title="更换住宿" aria-label="更换住宿">
                <RefreshCw className="size-3.5" strokeWidth={1.5} />
              </button>
              <button
                type="button"
                className={cn(iconBtn, 'hover:text-brand-600')}
                disabled={editor.isBusy(lodging.id)}
                onClick={() => void editor.remove(lodging, { undo: true })}
                title="清除住宿"
                aria-label={`清除住宿「${lodging.name}」`}
              >
                <X className="size-4" strokeWidth={1.5} />
              </button>
            </div>
          }
        />
        {open && <div className="pr-4 pl-[2.75rem] md:pl-[3.25rem]">{search}</div>}
      </div>
    )

  if (pending)
    return (
      <div className="flex items-center gap-3 py-3 pr-4 pl-[2.75rem] text-[13px] text-ink-500 md:pl-[3.25rem]">
        <BedMark night={night} dashed />
        <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
        正在设置住宿…
      </div>
    )

  if (collapsed && !expanded && !open && !picking)
    return (
      <div className="py-1.5 pl-[2.75rem] md:pl-[3.25rem]">
        <button type="button" onClick={() => setExpanded(true)} className="inline-flex h-9 items-center gap-1.5 text-[12.5px] text-ink-500 transition-colors hover:text-ink-900">
          <Plus className="size-3.5" strokeWidth={1.5} />
          {collapsed}
        </button>
      </div>
    )

  return (
    <div className={cn('py-3 pr-2 pl-[2.75rem] md:pr-4 md:pl-[3.25rem]', picking && 'bg-brand-50')}>
      <div className="flex items-center gap-3">
        <BedMark night={night} dashed />
        <p className="min-w-0 flex-1 text-[13.5px] text-ink-700">
          <span className="eyebrow mr-2 !text-[10px]">{caption}</span>
          {picking ? <span className="text-brand-600">在地图上点一下住的地方</span> : emptyTitle}
        </p>
        {collapsed && (
          <button type="button" className={iconBtn} onClick={() => setExpanded(false)} aria-label="收起">
            <X className="size-4" strokeWidth={1.5} />
          </button>
        )}
      </div>
      {!open && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button type="button" className={quiet} onClick={() => setOpen(true)}>
            <Search className="size-3.5" strokeWidth={1.5} />
            搜索酒店
          </button>
          {prev && (
            <button type="button" className={quiet} onClick={() => void editor.copyLodging(night, prev)} title={`和前一晚一样住「${prev.name}」`}>
              <Copy className="size-3.5" strokeWidth={1.5} />
              同前一晚<span className="max-w-[9em] truncate text-ink-500">· {prev.name}</span>
            </button>
          )}
          <button type="button" className={cn(quiet, picking && 'border-brand-500 text-ink-900')} onClick={() => onPickOnMap(night)} aria-pressed={picking}>
            <Crosshair className="size-3.5" strokeWidth={1.5} />
            {picking ? '正在地图上选…' : '地图上选'}
          </button>
          {hotels.slice(0, 3).map((h) => (
            <button key={h.id} type="button" className={quiet} onClick={() => void editor.makeLodging(h, night)} title="把「想去」里的这家设为住宿">
              <Bed className="size-3.5" strokeWidth={1.5} />
              <span className="max-w-[9em] truncate">{h.name}</span>
            </button>
          ))}
        </div>
      )}
      {search}
    </div>
  )
}
