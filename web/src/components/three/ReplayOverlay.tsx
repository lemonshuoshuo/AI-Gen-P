// 3D 回放地图上的 HTML 标记：同行者的头像（沿路线移动）、每一站的标记、路段中点的出行方式图标。
// 标记放在 deck.gl 画布之上的一层（MapLibre 的 Marker 在 deck.gl 画布之下，会被轨迹盖住），
// 位置在地图每一帧渲染时（'render' 事件）统一更新，与底图、deck.gl 轨迹同一帧移动，不会抖动或滞后
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Map as MLMap } from 'maplibre-gl'
import { Bed } from 'lucide-react'
import type { LegMode, UserBrief } from '@/api/types'
import { useMap } from '@/components/map/BaseMap'
import { LEG_MODE_ICONS, LEG_MODE_LABELS } from '@/components/map/layers'
import { dayTone } from '@/components/trip/plan'
import { Avatar } from '@/components/ui'
import { cn } from '@/lib/cn'
import type { PlacedStop } from './replay'

type LngLat = [number, number]

/* ---------------- 强调色：夜色里是金色，「我们」的足迹是玫瑰色（类名要原样写出来，Tailwind 才会生成） ---------------- */
export interface Accent {
  /** CSS 变量名（deck.gl 图层按当前主题解析） */
  v: string
  bg: string
  text: string
  /** 强调色实心底上的文字 */
  on: string
  ring: string
  border: string
}
export const ACCENTS: Record<'gold' | 'love', Accent> = {
  gold: { v: '--color-gold', bg: 'bg-gold', text: 'text-gold', on: 'text-on-gold', ring: 'ring-gold', border: 'border-gold' },
  love: { v: '--color-pink-600', bg: 'bg-pink-600', text: 'text-pink-600', on: 'text-paper', ring: 'ring-pink-600', border: 'border-pink-600' },
}

/* ---------------- 覆盖层：与地图同步定位 ---------------- */
interface Slot {
  el: HTMLElement
  at: () => LngLat | null
  /** 近大远小（倾斜时画面越靠上越远，越小） */
  depth: boolean
  /** 只有当 [起点, 终点] 在屏幕上长于 minSpan 像素时显示（路段太短时不放图标） */
  span?: () => [LngLat, LngLat] | null
  minSpan: number
}

interface OverlayApi {
  register: (id: string, slot: Slot) => () => void
  repaint: () => void
}
const OverlayCtx = createContext<OverlayApi | null>(null)

const MARGIN = 80 // 屏幕外这么多像素以内仍然摆放（进出画面时不闪）

function place(map: MLMap, slots: Map<string, Slot>) {
  const c = map.getContainer()
  const w = c.clientWidth
  const h = c.clientHeight
  // 倾斜时远处的点会挤到地平线附近：只显示可见范围（到地平线为止）以内的点
  const b = map.getBounds()
  const inView = (p: LngLat) => p[0] >= b.getWest() && p[0] <= b.getEast() && p[1] >= b.getSouth() && p[1] <= b.getNorth()
  for (const s of slots.values()) {
    const at = s.at()
    let show = !!at && inView(at)
    let x = 0
    let y = 0
    if (at && show) {
      const p = map.project(at)
      x = p.x
      y = p.y
      show = x > -MARGIN && x < w + MARGIN && y > -MARGIN && y < h + MARGIN
      const span = s.span?.()
      if (show && span) {
        const a = map.project(span[0])
        const z = map.project(span[1])
        show = Math.hypot(a.x - z.x, a.y - z.y) >= s.minSpan
      }
    }
    if (show) {
      const k = s.depth ? 0.72 + 0.28 * Math.min(1, Math.max(0, y / (h || 1))) : 1
      s.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${k.toFixed(3)})`
    }
    s.el.style.visibility = show ? 'visible' : 'hidden'
  }
}

/** 地图之上、deck.gl 画布之上的一层 HTML（不接收鼠标事件） */
export function MapOverlay({ children }: { children: ReactNode }) {
  const map = useMap()
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const slots = useRef(new Map<string, Slot>())
  useEffect(() => {
    if (!map) return
    const el = document.createElement('div')
    // deck.gl 的画布在控件容器（z-index 2）里：这一层要在它之上
    Object.assign(el.style, { position: 'absolute', inset: '0', zIndex: '3', pointerEvents: 'none', overflow: 'hidden' })
    map.getContainer().appendChild(el)
    const update = () => place(map, slots.current)
    map.on('render', update)
    map.on('resize', update)
    setRoot(el)
    return () => {
      map.off('render', update)
      map.off('resize', update)
      el.remove()
      setRoot(null)
    }
  }, [map])
  const register = useCallback(
    (id: string, slot: Slot) => {
      slots.current.set(id, slot)
      map?.triggerRepaint()
      return () => {
        if (slots.current.get(id) === slot) slots.current.delete(id)
      }
    },
    [map],
  )
  const repaint = useCallback(() => map?.triggerRepaint(), [map])
  const api = useMemo(() => ({ register, repaint }), [register, repaint])
  if (!root) return null
  return createPortal(<OverlayCtx.Provider value={api}>{children}</OverlayCtx.Provider>, root)
}

/**
 * 放在地图坐标上的一个 HTML 元素。anchor：bottom 为底边中点对准坐标（标记、头像），center 为中心对准（图标）。
 * at 每次渲染都可以变（头像每帧移动），位置在下一次地图渲染时更新
 */
export function Anchor({
  id,
  at,
  anchor = 'bottom',
  depth = false,
  z = 1,
  span,
  minSpan = 0,
  children,
}: {
  id: string
  at: LngLat | null
  anchor?: 'bottom' | 'center'
  depth?: boolean
  z?: number
  span?: [LngLat, LngLat] | null
  minSpan?: number
  children: ReactNode
}) {
  const api = useContext(OverlayCtx)
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef({ at, span })
  latest.current = { at, span }
  useLayoutEffect(() => {
    if (!api || !ref.current) return
    return api.register(id, {
      el: ref.current,
      at: () => latest.current.at,
      span: () => latest.current.span ?? null,
      depth,
      minSpan,
    })
  }, [api, id, depth, minSpan])
  // 位置变了：请地图再画一帧（镜头不动时标记也会移动）
  const ax = at?.[0]
  const ay = at?.[1]
  useLayoutEffect(() => {
    api?.repaint()
  }, [api, ax, ay])
  return (
    <div ref={ref} className="absolute top-0 left-0 origin-top-left will-change-transform" style={{ zIndex: z, visibility: 'hidden' }}>
      <div className={anchor === 'bottom' ? '-translate-x-1/2 -translate-y-full' : '-translate-x-1/2 -translate-y-1/2'}>{children}</div>
    </div>
  )
}

/* ---------------- 同行者：头像叠在一起（情侣两个，最多 4 个 + 「+N」） ---------------- */
export type Traveller = Pick<UserBrief, 'id' | 'nickname' | 'username' | 'avatar_url'>

const MAX_FACES = 4

export function AvatarStack({ users, size, className, ringClass }: { users: Traveller[]; size: number; className?: string; ringClass?: string }) {
  const faces = users.slice(0, MAX_FACES)
  const more = users.length - faces.length
  const overlap = Math.round(size * 0.32)
  return (
    <span className={cn('flex items-center', className)}>
      {faces.map((u, i) => (
        // 后面的头像压在前面的下面：作者（第一个）在最上
        <span key={u.id} className="relative flex shrink-0 rounded-full" style={{ marginLeft: i ? -overlap : 0, zIndex: faces.length - i }}>
          <Avatar user={u} size={size} className={cn('ring-2', ringClass ?? 'ring-paper')} />
        </span>
      ))}
      {more > 0 && (
        // 压在最后一个头像下面（和头像的叠法一致）：多出来的宽度正好被盖住，「+N」在露出来的部分居中；小尺寸时字也不小于 10px
        <span
          className={cn('font-num relative flex shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink-900 ring-2', ringClass ?? 'ring-paper')}
          style={{ width: size + overlap, height: size, marginLeft: -overlap, paddingLeft: overlap, fontSize: Math.max(10, size * 0.36) }}
        >
          +{more}
        </span>
      )}
    </span>
  )
}

/**
 * 移动中的同行者：头像气泡 + 细针 + 地面上的光点；在路上时气泡右下角是这一段的出行方式。
 * aside：停在某一站时让到标记的右边（不挡住这一站的标记），针和光点隐去
 */
export const TravellerMarker = memo(function TravellerMarker({
  users,
  mode,
  accent,
  size,
  aside,
}: {
  users: Traveller[]
  mode: LegMode | null
  accent: Accent
  size: number
  aside?: boolean
}) {
  const Icon = mode ? LEG_MODE_ICONS[mode] : null
  const names = users.map((u) => u.nickname || u.username).join('、')
  return (
    <div
      className={cn(
        'flex flex-col items-center transition-[translate] duration-500 ease-out',
        // 右移半个自身宽度 + 半个标记宽度，下移到与标记齐平
        aside && 'translate-x-[calc(50%_+_20px)] translate-y-[18px]',
      )}
      aria-label={names}
      title={names}
    >
      <div className={cn('relative rounded-full bg-night/75 p-[3px] shadow-float ring-1 backdrop-blur-sm', accent.ring)}>
        {users.length ? (
          <AvatarStack users={users} size={size} ringClass="ring-night" />
        ) : (
          <span className={cn('block rounded-full', accent.bg)} style={{ width: size, height: size }} />
        )}
        {Icon && mode && (
          <span
            key={mode}
            title={LEG_MODE_LABELS[mode]}
            className={cn(
              'animate-fade-in absolute -right-2 -bottom-1.5 flex size-[22px] items-center justify-center rounded-full ring-2 ring-night',
              accent.bg,
              accent.on,
            )}
          >
            <Icon className="size-3" strokeWidth={2} />
          </span>
        )}
      </div>
      <span className={cn('flex flex-col items-center transition-opacity duration-300', aside && 'opacity-0')}>
        <span className={cn('h-2.5 w-[1.5px] opacity-80', accent.bg)} />
        <span className="relative flex size-2.5 items-center justify-center">
          <span className={cn('animate-pulse-ring absolute inset-0 rounded-full opacity-60', accent.bg)} />
          <span className={cn('relative size-2.5 rounded-full ring-2 ring-night/70', accent.bg)} />
        </span>
      </span>
    </div>
  )
})

/* ---------------- 每一站：游玩点是序号印章，住宿是床；当前一站是强调色，还没到的是虚线空心 ---------------- */
export type PinState = 'upcoming' | 'reached' | 'current'

export const StopPin = memo(function StopPin({ stop, state, accent }: { stop: PlacedStop; state: PinState; accent: Accent }) {
  const lodging = stop.kind === 'lodging'
  const tone = stop.day != null && stop.day > 0 ? dayTone(stop.day).v : undefined
  const current = state === 'current'
  return (
    <div
      className={cn('flex flex-col items-center transition-opacity duration-500', state === 'upcoming' && 'opacity-75')}
      title={lodging ? `住宿 · ${stop.name}` : stop.name}
    >
      <div
        className={cn(
          'font-num relative flex items-center justify-center leading-none font-medium transition-all duration-300',
          lodging ? 'rounded-md' : 'rounded-full',
          current
            ? cn(lodging ? 'size-8' : 'h-8 min-w-8 px-1.5', 'text-[15px]', accent.bg, accent.on)
            : state === 'reached'
              ? cn(lodging ? 'size-[26px]' : 'h-[26px] min-w-[26px] px-1', 'bg-ink-900 text-[13px] text-paper')
              : cn(lodging ? 'size-6' : 'h-6 min-w-6 px-1', 'border border-dashed border-ink-600 bg-night/80 text-[12px] text-ink-800'),
        )}
        style={{
          boxShadow:
            state === 'reached' && tone
              ? `0 0 0 2px var(--color-night), 0 0 0 3.5px var(${tone}), 0 6px 14px -6px rgb(0 0 0 / 0.7)`
              : '0 6px 14px -6px rgb(0 0 0 / 0.7)',
        }}
      >
        {current && <span className={cn('animate-pulse-ring absolute inset-0 -z-10 rounded-[inherit] opacity-50', accent.bg)} />}
        {lodging ? <Bed className={current ? 'size-4' : 'size-3.5'} strokeWidth={1.75} /> : stop.label}
      </div>
      <span className={cn('h-[7px] w-[1.5px]', current ? accent.bg : state === 'reached' ? 'bg-ink-900/70' : 'bg-ink-600/60')} />
    </div>
  )
})

/* ---------------- 路段中点的出行方式 ---------------- */
export const ModeBadge = memo(function ModeBadge({ mode, done, accent }: { mode: LegMode; done: boolean; accent: Accent }) {
  const Icon = LEG_MODE_ICONS[mode]
  return (
    <span
      title={LEG_MODE_LABELS[mode]}
      className={cn(
        'flex size-[26px] items-center justify-center rounded-full border-[1.5px] bg-night/90 shadow-float backdrop-blur-sm transition-colors duration-500',
        done ? cn(accent.border, accent.text) : 'border-ink-600 text-ink-900',
      )}
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
    </span>
  )
})
