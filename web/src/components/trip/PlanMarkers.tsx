import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Marker } from 'maplibre-gl'
import { Bed } from 'lucide-react'
import type { Waypoint } from '@/api/types'
import { useMap } from '@/components/map/BaseMap'
import { cn } from '@/lib/cn'
import { categoryOf } from '@/lib/meta'
import { dayTone, isLodging, type PlanGroups } from './plan'

type LngLat = [number, number]

export interface PlanMarkerItem {
  w: Waypoint
  /** 游玩点的序号（每天各自从 1 编号）；住宿不编号 */
  label?: string
  /** 外圈颜色：CSS 变量名（每天一种颜色） */
  tone?: string
  /** 不是当前查看的那一天：变淡 */
  dim?: boolean
  /** 「想去」里还没安排到某天的地点：虚线空心 */
  pool?: boolean
}

/**
 * 地图上的打卡点：游玩点是印章式序号（外圈是那一天的颜色），住宿是床的图标（不编号），「想去」是虚线空心圆。
 * 标记内容用 React 渲染（portal），颜色都来自设计令牌，切换主题自动跟着变
 */
export function PlanMarkers({
  items,
  selectedId,
  onSelect,
  draggable,
  onMove,
}: {
  items: PlanMarkerItem[]
  selectedId?: number | null
  onSelect?: (w: Waypoint) => void
  /** 可拖动标记微调位置 */
  draggable?: boolean
  onMove?: (w: Waypoint, p: LngLat) => void
}) {
  const map = useMap()
  const reg = useRef(new Map<number, { m: Marker; el: HTMLDivElement }>())
  const latest = useRef({ items, onSelect, onMove })
  latest.current = { items, onSelect, onMove }
  const [els, setEls] = useState<Map<number, HTMLDivElement>>(() => new Map())

  useEffect(() => {
    if (!map) return
    const cur = reg.current
    const ids = new Set(items.map((x) => x.w.id))
    let changed = false
    for (const [id, x] of cur)
      if (!ids.has(id)) {
        x.m.remove()
        cur.delete(id)
        changed = true
      }
    const find = (id: number) => latest.current.items.find((i) => i.w.id === id)
    for (const it of items) {
      const have = cur.get(it.w.id)
      if (have) {
        const p = have.m.getLngLat()
        if (p.lng !== it.w.lng || p.lat !== it.w.lat) have.m.setLngLat([it.w.lng, it.w.lat])
        have.m.setDraggable(!!draggable)
        have.el.style.cursor = draggable ? 'grab' : 'pointer'
        continue
      }
      const id = it.w.id
      const el = document.createElement('div')
      el.style.cursor = draggable ? 'grab' : 'pointer'
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        const x = find(id)
        if (x) latest.current.onSelect?.(x.w)
      })
      // anchor: 'bottom'：针尖正好在坐标上，拖动结束时 getLngLat() 就是看到的针尖位置
      const m = new Marker({ element: el, anchor: 'bottom', draggable: !!draggable }).setLngLat([it.w.lng, it.w.lat]).addTo(map)
      m.on('dragend', () => {
        const x = find(id)
        const p = m.getLngLat()
        if (x) latest.current.onMove?.(x.w, [p.lng, p.lat])
      })
      cur.set(id, { m, el })
      changed = true
    }
    if (changed) setEls(new Map([...cur].map(([id, x]) => [id, x.el])))
  }, [map, items, draggable])

  useEffect(() => {
    const cur = reg.current
    return () => {
      cur.forEach((x) => x.m.remove())
      cur.clear()
    }
  }, [map])

  // 叠放顺序：选中的在最上，变淡的在下
  useEffect(() => {
    for (const it of items) {
      const el = els.get(it.w.id)
      if (el) el.style.zIndex = it.w.id === selectedId ? '4' : it.dim ? '1' : isLodging(it.w) ? '2' : '3'
    }
  }, [els, items, selectedId])

  return (
    <>
      {items.map((it) => {
        const el = els.get(it.w.id)
        if (!el) return null
        const sel = it.w.id === selectedId
        const face = isLodging(it.w) ? (
          <LodgingFace w={it.w} tone={it.tone} selected={sel} dim={it.dim} />
        ) : it.pool ? (
          <PoolFace label={it.label} selected={sel} dim={it.dim} />
        ) : (
          <StopFace w={it.w} label={it.label ?? ''} tone={it.tone} selected={sel} dim={it.dim} />
        )
        return createPortal(face, el, String(it.w.id))
      })}
    </>
  )
}

function Tail({ muted }: { muted?: boolean }) {
  return <div className={cn('h-[7px] w-[1.5px] opacity-70', muted ? 'bg-ink-300' : 'bg-ink-900')} />
}

/** 游玩点：已到达为象牙白实心，计划中为虚线空心，跳过为淡灰；右下角是分类色，外圈是那一天的颜色 */
function StopFace({ w, label, tone, selected, dim }: { w: Waypoint; label: string; tone?: string; selected: boolean; dim?: boolean }) {
  const skipped = w.status === 'skipped'
  const todo = w.planned && w.status === 'todo'
  return (
    <div className={cn('relative flex flex-col items-center transition-opacity duration-300', dim && 'opacity-35')} title={w.name}>
      <div
        className={cn(
          'font-num relative flex items-center justify-center rounded-full border-[1.5px] px-1.5 leading-none font-medium transition-all duration-200',
          selected ? 'h-8 min-w-8 text-[15px]' : 'h-[26px] min-w-[26px] text-[13px]',
          skipped
            ? 'border-ink-300 bg-ink-200 text-ink-400'
            : todo
              ? cn('border-dashed bg-paper', selected ? 'border-brand-500 text-brand-600' : 'border-ink-900 text-ink-900')
              : cn('border-paper text-paper', selected ? 'bg-brand-500' : 'bg-ink-900'),
        )}
        style={{
          boxShadow:
            tone && !skipped && !selected
              ? `0 0 0 2px var(--color-paper), 0 0 0 3.5px var(${tone}), 0 4px 12px -4px rgb(0 0 0 / 0.6)`
              : '0 4px 12px -4px rgb(0 0 0 / 0.6)',
        }}
      >
        {label}
        {!skipped && (
          <span
            aria-hidden
            className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-[1.5px] ring-paper"
            style={{ background: categoryOf(w.category).color }}
          />
        )}
      </div>
      {w.verdict === 'avoid' && (
        <span className="absolute -top-1.5 -right-1.5 flex size-3.5 items-center justify-center rounded-full bg-brand-500 text-[9px] leading-none text-paper ring-[1.5px] ring-paper">
          ✕
        </span>
      )}
      <Tail muted={skipped} />
    </div>
  )
}

/** 住宿：圆角方章里一张床，边框是那一晚所属那天的颜色 */
function LodgingFace({ w, tone, selected, dim }: { w: Waypoint; tone?: string; selected: boolean; dim?: boolean }) {
  const visited = w.status === 'visited'
  return (
    <div className={cn('relative flex flex-col items-center transition-opacity duration-300', dim && 'opacity-35')} title={`住宿 · ${w.name}`}>
      <div
        className={cn(
          'flex items-center justify-center rounded-md border-[1.5px] transition-all duration-200',
          selected ? 'size-8 border-brand-500 bg-brand-50 text-brand-600' : cn('size-7', visited ? 'bg-ink-900 text-paper' : 'bg-surface-2 text-ink-900'),
        )}
        style={{
          borderColor: selected ? undefined : tone ? `var(${tone})` : undefined,
          boxShadow: '0 4px 12px -4px rgb(0 0 0 / 0.6)',
        }}
      >
        <Bed className="size-4" strokeWidth={1.5} />
      </div>
      <Tail />
    </div>
  )
}

/** 「想去」：虚线空心圆（查看「想去」时带序号） */
function PoolFace({ label, selected, dim }: { label?: string; selected: boolean; dim?: boolean }) {
  return (
    <div className={cn('relative flex flex-col items-center transition-opacity duration-300', dim && 'opacity-40')}>
      <div
        className={cn(
          'font-num flex items-center justify-center rounded-full border-[1.5px] border-dashed bg-paper leading-none',
          label ? 'h-6 min-w-6 px-1 text-[12px]' : 'size-4',
          selected ? 'border-brand-500 text-brand-600' : 'border-ink-600 text-ink-700',
        )}
      >
        {label}
      </div>
      <div className="h-[5px] w-px bg-ink-600 opacity-70" />
    </div>
  )
}

/**
 * 按天规划的标记：focus 为某一天时只突出那天的游玩点和出发 / 结束的住宿，为 'pool' 时突出「想去」；
 * 没有分天的旅程（全在 day=0）按顺序编号，和以前一样
 */
export function planMarkerItems(
  g: PlanGroups,
  labels: Map<number, string>,
  opts: { focus?: number | 'pool' | null; hidePool?: boolean; labelOf?: (w: Waypoint) => string | undefined } = {},
): PlanMarkerItem[] {
  const { focus = null } = opts
  const out: PlanMarkerItem[] = []
  const lab = (w: Waypoint) => opts.labelOf?.(w) ?? labels.get(w.id)
  for (const d of g.days)
    for (const w of d.stops)
      out.push({ w, label: lab(w), tone: dayTone(d.day).v, dim: focus === 'pool' || (typeof focus === 'number' && focus !== d.day) })
  for (const [night, w] of g.lodging) {
    const near = typeof focus === 'number' && (focus === night || focus === night + 1)
    out.push({ w, tone: dayTone(Math.max(1, night)).v, dim: focus === 'pool' || (typeof focus === 'number' && !near) })
  }
  for (const w of g.extraLodging) out.push({ w, tone: dayTone(Math.max(1, w.day)).v, dim: focus != null })
  if (g.dayCount === 0) {
    // 没有分天：「想去」就是整条路线
    for (const w of g.pool) out.push({ w, label: lab(w) })
  } else if (!opts.hidePool) {
    // 还没有安排到任何一天时也给「想去」编号（和列表一致）
    const numbered = focus === 'pool' || g.days.every((d) => !d.stops.length)
    for (const w of g.pool) out.push({ w, pool: true, label: numbered ? lab(w) : undefined, dim: typeof focus === 'number' })
  }
  return out
}
