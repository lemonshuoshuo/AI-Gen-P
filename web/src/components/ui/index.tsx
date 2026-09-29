import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { Check, Loader2, Star, X } from 'lucide-react'
import { create } from 'zustand'
import { errorMessage, isNotFound } from '@/api/client'
import type { Category, UserBrief, Verdict } from '@/api/types'
import { cn } from '@/lib/cn'
import { categoryOf, verdicts } from '@/lib/meta'
// 主题运行时随公共组件在启动时加载（main.tsx 引入了 ConfirmHost）：套用偏好、加载当前主题的字体、跟随系统深浅色
import '@/theme/runtime'

/*
 * 公共组件：颜色、圆角、描边都读主题令牌（styles/themes.css + styles/components.css），
 * 同一个组件在五个主题、两种模式下各有样子，调用方式不变。
 */

/* ---------------- Button ---------------- */
type Variant = 'primary' | 'accent' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'love' | 'dark'
type Size = 'xs' | 'sm' | 'md' | 'lg'

// primary：主题的实心主按钮（手帐砖红、山野万寿菊黄、晴海海蓝、暮色腮红、夜航象牙白）；
// accent：每页最重要的一个动作；outline 细线；ghost 纯文字；danger 踩雷红；love 仅情侣空间
const variantCls: Record<Variant, string> = {
  primary: 'th-btn-primary',
  accent: 'th-btn-accent',
  secondary: 'th-btn-secondary',
  outline: 'th-btn-outline',
  ghost: 'th-btn-ghost',
  danger: 'th-btn-danger',
  love: 'th-btn-love',
  dark: 'th-btn-dark',
}
// 圆角由主题决定（胶囊 / 圆角矩形），见 .th-btn
const sizeCls: Record<Size, string> = {
  xs: 'h-7 px-3 text-xs gap-1',
  sm: 'h-8 px-3.5 text-[13px] gap-1.5',
  md: 'h-10 px-5 text-[13.5px] gap-2',
  lg: 'h-12 px-7 text-[14.5px] gap-2',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
  block?: boolean
}

/**
 * 按钮样式，也给 Link / a 用：跳转用「长得像按钮的链接」，不要把 Button 套在 Link 里
 * （按钮嵌在链接里是无效 HTML，键盘要按两次 Tab 才能经过）
 */
export function buttonClass({
  variant = 'primary',
  size = 'md',
  block,
  className,
}: { variant?: Variant; size?: Size; block?: boolean; className?: string } = {}) {
  return cn(
    'th-btn inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors duration-300 select-none disabled:opacity-60',
    variantCls[variant],
    sizeCls[size],
    block && 'w-full',
    className,
  )
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={buttonClass({ variant, size, block, className })}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  )
})

export function IconButton({
  className,
  label,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-9 shrink-0 items-center justify-center rounded-full text-ink-700 transition hover:bg-ink-900/[0.07] hover:text-ink-900 disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ---------------- Form ---------------- */
// 形状、底色、描边、聚焦光圈由主题决定（.th-field）
const fieldBase = 'th-field w-full px-3.5 text-sm placeholder:text-ink-400 outline-none disabled:opacity-60'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(fieldBase, 'h-10', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cn(fieldBase, 'min-h-24 py-2.5 leading-relaxed', className)} {...rest} />
  },
)

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(fieldBase, 'select-chevron h-10 appearance-none pr-8', className)} {...rest}>
      {children}
    </select>
  )
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label?: ReactNode
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <label className={cn('block', className)}>
      {label && <span className="mb-2 block text-[12.5px] font-medium text-ink-600">{label}</span>}
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
    </label>
  )
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: ReactNode
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-sm text-ink-700"
    >
      <span
        className={cn(
          'relative inline-block h-6 w-10 shrink-0 rounded-full border transition',
          checked ? 'border-brand-fill bg-brand-fill' : 'border-ink-300 bg-transparent',
        )}
      >
        <span
          className={cn(
            'absolute top-[3px] left-[3px] size-4 rounded-full transition',
            checked ? 'translate-x-4 bg-on-brand' : 'bg-ink-400',
          )}
        />
      </span>
      {label}
    </button>
  )
}

/** 单选组的方向键：←→↑↓ 在选项间移动并选中（WAI-ARIA radio group） */
function radioArrowKeys(e: KeyboardEvent<HTMLElement>) {
  if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)')]
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (i < 0 || !items.length) return
  e.preventDefault()
  const n = items.length
  const next =
    e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + n) % n
  items[next].focus()
  items[next].click()
}

/* ---------------- Segmented tabs ---------------- */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  className?: string
  size?: 'sm' | 'md'
  /** 读屏用的组名 */
  label?: string
}) {
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={radioArrowKeys} className={cn('th-seg', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'th-seg-item font-medium tracking-[0.02em] duration-300',
            size === 'sm' ? 'px-3 py-1 text-xs' : 'px-4 py-1.5 text-[13px]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 页内 Tab：下划线（手帐、晴海、夜航）或胶囊（山野、暮色），由主题决定 */
export function TabBar<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  className?: string
}) {
  return (
    <div role="tablist" className={cn('th-tabs', className)}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)} className="th-tab">
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ---------------- 选中态（所有主题统一的规则） ----------------
 * 选中 = 强调色描边 + 浅色底纹 + 实心勾选徽章 + 强调色标题；未选中的标题保持 ink-900，不变灰。
 * OptionCard：大选项（新建旅程的「方式」、主题选择…）；ChoiceChip：筛选 / 标签；
 * selectedClass()：给自己排版的元素套上同一套选中样式（card / row / chip / tab / filter）。
 */
export type SelectableKind = 'card' | 'row' | 'chip' | 'tab' | 'filter'

const selectableBase: Record<SelectableKind, string> = {
  card: 'th-sel-card',
  row: 'th-sel-row',
  chip: 'th-chip',
  tab: 'th-tab',
  filter: 'th-filter',
}

/**
 * 统一的选中样式类。card：描边 + 底纹 + 阴影（内部可用 th-option-title / th-option-num / CheckBadge）；
 * row：底纹 + 左侧亮条或圆点（标题加 th-sel-title）；chip：实心胶囊；tab：Tab 样式；
 * filter：「全部 / 游记 / 路线」这类文字筛选（下划线主题是 2px 强调色下划线，山野 / 暮色是实心胶囊，需要 px-3 左右的内边距）。
 * 同时请在元素上写 aria-checked / aria-selected / aria-pressed（样式也认这些属性）。
 */
export function selectedClass(selected: boolean, kind: SelectableKind = 'card', className?: string) {
  return cn(selectableBase[kind], selected && 'is-selected', className)
}

/** 勾选徽章：放在已选中的容器里自动变成实心勾；单独使用时传 checked */
export function CheckBadge({ checked, className }: { checked?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn('th-check', checked && 'is-selected', className)}>
      <Check strokeWidth={2.75} />
    </span>
  )
}

export interface OptionCardProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'role'> {
  selected: boolean
  title: ReactNode
  description?: ReactNode
  /** 序号：数字补零成「01」 */
  index?: number | string
  /** 标题上方的小标签（如 Plan · 规划） */
  eyebrow?: ReactNode
  /** 序号旁的小图标 */
  icon?: ReactNode
  /** radio：单选（默认，放在 OptionGroup 里）；checkbox：多选 */
  role?: 'radio' | 'checkbox'
}

/**
 * 大选项卡片（单选 / 多选）。选中：强调色描边 + 浅色底纹 + 右上角实心勾 + 强调色序号与标题；
 * 各主题的形状（手帐虚线纸片、山野圆角实心卡、夜航细线条目…）由令牌决定。
 */
export const OptionCard = forwardRef<HTMLButtonElement, OptionCardProps>(function OptionCard(
  { selected, title, description, index, eyebrow, icon, role = 'radio', className, children, type = 'button', ...rest },
  ref,
) {
  const num = typeof index === 'number' ? String(index).padStart(2, '0') : index
  return (
    <button ref={ref} type={type} role={role} aria-checked={selected} className={cn('th-option', className)} {...rest}>
      {(num != null || icon) && (
        <span className="flex items-center gap-2">
          {num != null && <span className="th-option-num">{num}</span>}
          {icon}
        </span>
      )}
      {eyebrow && <span className="eyebrow mt-3 block">{eyebrow}</span>}
      <span className={cn('th-option-title', num != null || icon ? 'mt-2.5' : eyebrow ? 'mt-1' : undefined)}>{title}</span>
      {description && <span className="th-option-desc mt-1.5">{description}</span>}
      {children}
      <CheckBadge />
    </button>
  )
})

/** 单选组容器（role=radiogroup + 方向键）；布局用 className，如 grid gap-3 sm:grid-cols-3 */
export function OptionGroup({
  label,
  className,
  children,
  ...rest
}: { label: string; className?: string; children: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'role'>) {
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={radioArrowKeys} className={className} {...rest}>
      {children}
    </div>
  )
}

export interface ChoiceChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role'> {
  selected: boolean
  /** 未选中时显示的图标（选中时换成勾，除非 keepIcon） */
  icon?: ReactNode
  /**
   * checkbox：可多选（默认，aria-checked）；radio：单选（放在 OptionGroup 里）；
   * tab：页签（aria-selected）；button：开关按钮（aria-pressed）
   */
  role?: 'checkbox' | 'radio' | 'tab' | 'button'
  size?: 'sm' | 'md'
  loading?: boolean
  /** 选中时不把图标换成勾（如带颜色标记的天数页签） */
  keepIcon?: boolean
}

/** 筛选 / 标签 chip：选中是实心强调色 + 勾，未选中是细线胶囊（形状、颜色随主题） */
export const ChoiceChip = forwardRef<HTMLButtonElement, ChoiceChipProps>(function ChoiceChip(
  { selected, icon, role = 'checkbox', size = 'md', loading, keepIcon, className, children, type = 'button', ...rest },
  ref,
) {
  const a11y =
    role === 'tab'
      ? ({ role, 'aria-selected': selected } as const)
      : role === 'button'
        ? ({ 'aria-pressed': selected } as const)
        : ({ role, 'aria-checked': selected } as const)
  return (
    <button ref={ref} type={type} {...a11y} className={cn('th-chip', size === 'sm' && 'h-7 px-2.5 text-[12.5px]', className)} {...rest}>
      {loading ? <Loader2 className="animate-spin" strokeWidth={1.75} aria-hidden /> : selected && !keepIcon ? <Check strokeWidth={2.75} aria-hidden /> : icon}
      {children}
    </button>
  )
})

/* ---------------- Avatar & user ---------------- */
// 没有头像时的底色：矿物色的浅底 + 深字（深色模式下自动变成深底 + 浅字）
const avatarTones = ['brand', 'emerald', 'sky', 'violet', 'pink', 'amber', 'ink'] as const

export function Avatar({
  user,
  size = 36,
  className,
  ring,
}: {
  user: Pick<UserBrief, 'nickname' | 'username' | 'avatar_url' | 'id'> | null | undefined
  size?: number
  className?: string
  ring?: boolean
}) {
  const name = user?.nickname || user?.username || '?'
  const style = { width: size, height: size, fontSize: size * 0.42 }
  const ringCls = ring && 'ring-2 ring-paper'
  if (user?.avatar_url)
    return (
      <img
        src={user.avatar_url}
        alt={name}
        style={style}
        className={cn('shrink-0 rounded-full bg-ink-100 object-cover', ringCls, className)}
        loading="lazy"
      />
    )
  const tone = avatarTones[(user?.id ?? 0) % avatarTones.length]
  return (
    <span
      style={{ ...style, background: `var(--color-${tone}-200)`, color: `var(--color-${tone}-800)` }}
      className={cn('font-display inline-flex shrink-0 items-center justify-center rounded-full', ringCls, className)}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

// 等级颜色：可读的 600 档矿物色（随主题、模式变化）
const levelTones = ['--color-ink-500', '--color-emerald-600', '--color-sky-600', '--color-violet-600', '--color-amber-600', '--color-brand-600']

export function LevelBadge({ level, className }: { level: number; className?: string }) {
  return (
    <span
      className={cn('font-num inline-flex items-baseline text-[12px] leading-none italic', className)}
      style={{ color: `var(${levelTones[Math.min(Math.max(level, 1), levelTones.length) - 1]})` }}
    >
      Lv.{level}
    </span>
  )
}

export function UserName({ user, className, link = true }: { user: UserBrief; className?: string; link?: boolean }) {
  const inner = (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span className="truncate font-medium">{user.nickname || user.username}</span>
      <LevelBadge level={user.level} />
      {user.role === 'admin' && (
        <span className="text-[10px] leading-none tracking-[0.12em] text-ink-500">管理员</span>
      )}
    </span>
  )
  return link ? (
    <Link to={`/u/${user.username}`} className="min-w-0 hover:text-brand-600" onClick={(e) => e.stopPropagation()}>
      {inner}
    </Link>
  ) : (
    inner
  )
}

/* ---------------- Badges ---------------- */
// 评价：推荐 = 玉青、一般 = 赭黄、踩雷 = 红；底纹用 100 档、文字用 700 档（对比度 ≥ 5）
const verdictCls: Record<Exclude<Verdict, ''>, string> = {
  recommend: 'bg-emerald-100 text-emerald-700',
  neutral: 'bg-amber-100 text-amber-700',
  avoid: 'bg-red-100 text-red-700',
}

export function VerdictBadge({ verdict, className }: { verdict: Verdict; className?: string }) {
  if (!verdict) return null
  const v = verdicts[verdict]
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', verdictCls[verdict], className)}>
      <span className="text-[10px] leading-none">{v.mark}</span>
      {v.label}
    </span>
  )
}

// 分类小图标的颜色：随主题的矿物色
const categoryTones: Record<Category, string> = {
  scenic: 'var(--color-emerald-600)',
  food: 'var(--color-orange-600)',
  hotel: 'var(--color-indigo-500)',
  shopping: 'var(--color-pink-600)',
  transport: 'var(--color-sky-600)',
  entertainment: 'var(--color-violet-600)',
  other: 'var(--color-ink-400)',
}

export function CategoryChip({ category, className }: { category: Category | string; className?: string }) {
  const c = categoryOf(category)
  const Icon = c.icon
  const tone = categoryTones[(category in categoryTones ? category : 'other') as Category]
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs tracking-wide text-ink-500', className)}>
      <Icon className="size-3" style={{ color: tone }} strokeWidth={1.75} />
      {c.label}
    </span>
  )
}

export function Stars({
  value,
  onChange,
  size = 14,
}: {
  value: number
  onChange?: (v: number) => void
  size?: number
}) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => {
        const filled = value >= i - 0.25
        const half = !filled && value >= i - 0.75
        const star = (
          <Star
            style={{ width: size, height: size }}
            className={cn(filled ? 'fill-amber-500 text-amber-500' : half ? 'fill-amber-200 text-amber-500' : 'text-ink-300')}
            strokeWidth={1.5}
          />
        )
        return onChange ? (
          <button key={i} type="button" onClick={() => onChange(value === i ? 0 : i)} aria-label={`${i} 星`} className="p-0.5">
            {star}
          </button>
        ) : (
          <span key={i}>{star}</span>
        )
      })}
    </span>
  )
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-full border border-line px-2 py-0.5 text-xs tracking-wide text-ink-600', className)}>
      {children}
    </span>
  )
}

/* ---------------- States ---------------- */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-ink-400', className)} strokeWidth={1.5} />
}

export function PageLoader({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-sm text-ink-500">
      <Spinner className="size-7" />
      {label}
    </div>
  )
}

export function Empty({
  icon,
  title,
  desc,
  action,
  className,
}: {
  icon?: ReactNode
  title: ReactNode
  desc?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}>
      {icon && <div className="mb-5 text-ink-300 [&_svg]:stroke-[1.25]">{icon}</div>}
      <p className="font-display text-[length:var(--text-h2)] leading-tight text-ink-900">{title}</p>
      {desc && <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-500">{desc}</p>}
      {action && <div className="mt-7">{action}</div>}
    </div>
  )
}

/** 加载失败：只有 404 才说「不存在」；网络错误、5xx 显示「加载失败」并可重试 */
export function LoadError({
  error,
  onRetry,
  title,
  notFoundTitle,
  desc,
  back,
  className,
}: {
  error: unknown
  onRetry?: () => void
  title?: ReactNode
  notFoundTitle?: ReactNode
  /** 默认显示错误信息 */
  desc?: ReactNode
  /** 返回入口（全屏页面没有顶栏和底部导航） */
  back?: ReactNode
  className?: string
}) {
  const nf = isNotFound(error)
  const retry = !!onRetry && !nf
  return (
    <Empty
      className={className}
      title={nf ? (notFoundTitle ?? '内容不存在') : (title ?? '加载失败')}
      desc={desc ?? errorMessage(error)}
      action={
        (retry || back) && (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {retry && <Button onClick={onRetry}>重试</Button>}
            {back}
          </div>
        )
      }
    />
  )
}

/** 卡片：手帐是虚线纸片、山野 / 晴海是带柔和阴影的实心卡、暮色细线实心卡、夜航只有细线 */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('th-card', className)}>{children}</div>
}

/* ---------------- Modal / Sheet ---------------- */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  className,
  wide,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
  wide?: boolean
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])
  // 打开时把焦点移进弹窗（已自动聚焦的输入框除外），关闭后还给打开它的按钮。
  // 只依赖 open：onClose 通常是内联函数，放进上面的 effect 会在父组件每次渲染时抢走焦点
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
    return () => {
      if (prev && prev.isConnected) prev.focus({ preventScroll: true })
    }
  }, [open])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4">
      <div className="animate-fade-in absolute inset-0 bg-[var(--scrim)] backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? titleId : undefined}
        tabIndex={-1}
        // Tab 键在弹窗内循环，不跑到背后的页面上。只处理焦点在本弹窗里的按键：
        // React 事件会沿组件树穿过 portal 冒泡，嵌套弹窗的按键也会传到外层弹窗
        onKeyDown={(e) => {
          const p = panelRef.current
          if (e.key !== 'Tab' || !p || !p.contains(e.target as Node)) return
          const els = [...p.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
          if (!els.length) {
            e.preventDefault()
            return
          }
          const first = els[0]
          const last = els[els.length - 1]
          if (e.shiftKey && (document.activeElement === first || document.activeElement === p)) {
            e.preventDefault()
            last.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }}
        className={cn(
          'animate-slide-up relative flex max-h-[90dvh] w-full flex-col rounded-t-modal bg-surface shadow-float outline-none sm:rounded-modal',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
          className,
        )}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-3">
            <h3 id={titleId} className="text-[1.375rem] leading-tight">
              {title}
            </h3>
            <IconButton label="关闭" onClick={onClose} className="-mr-2">
              <X className="size-5" />
            </IconButton>
          </div>
        )}
        {/* 没有底栏的底部面板要避开 iPhone 底部横条 */}
        <div className={cn('flex-1 overflow-y-auto px-6', footer ? 'pb-6' : 'pb-[max(1.5rem,env(safe-area-inset-bottom))]')}>
          {children}
        </div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/* ---------------- Confirm dialog (promise 风格) ---------------- */
interface ConfirmState {
  req: { title: string; desc?: string; okText?: string; danger?: boolean; resolve: (v: boolean) => void } | null
}
const useConfirmStore = create<ConfirmState>(() => ({ req: null }))

export function confirmDialog(opts: { title: string; desc?: string; okText?: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) => useConfirmStore.setState({ req: { ...opts, resolve } }))
}

export function ConfirmHost() {
  const req = useConfirmStore((s) => s.req)
  const close = (v: boolean) => {
    req?.resolve(v)
    useConfirmStore.setState({ req: null })
  }
  return (
    <Modal
      open={!!req}
      onClose={() => close(false)}
      title={req?.title ?? ''}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            取消
          </Button>
          <Button variant={req?.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
            {req?.okText ?? '确定'}
          </Button>
        </>
      }
    >
      {req?.desc && <p className="text-sm leading-relaxed text-ink-500">{req.desc}</p>}
    </Modal>
  )
}

/* ---------------- Popover menu ---------------- */
export function Menu({
  trigger,
  children,
  align = 'right',
  className,
}: {
  /** open 用于触发按钮的 aria-expanded */
  trigger: (toggle: () => void, open: boolean) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Esc 关闭菜单：在捕获阶段处理并阻止传播，弹窗里的菜单按 Esc 只关菜单、不连弹窗一起关
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
  // 在菜单外按下就关闭。下面的全屏遮罩在有 backdrop-filter / transform 的祖先里（如毛玻璃顶栏）
  // 只能盖住那个祖先，点页面其他地方收不到，所以另在 document 上监听（捕获阶段）
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])
  // 面板按 align 贴着触发按钮，但不超出视口：靠近屏幕边缘时（手机顶栏右侧的按钮）水平挪回来，四周至少留 8px
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!open || !el) return
    const place = () => {
      el.style.translate = ''
      const r = el.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const gap = 8
      let dx = 0
      if (r.right > vw - gap) dx = vw - gap - r.right
      if (r.left + dx < gap) dx = gap - r.left
      el.style.translate = dx ? `${Math.round(dx)}px 0` : ''
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])
  return (
    <div ref={rootRef} className="relative inline-block">
      {trigger(() => setOpen((v) => !v), open)}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            ref={panelRef}
            className={cn(
              'animate-fade-in absolute z-50 mt-2 min-w-48 overflow-hidden rounded-xl border border-line bg-[var(--menu-bg)] py-1.5 shadow-float',
              align === 'right' ? 'right-0' : 'left-0',
              className,
            )}
          >
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  )
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  href,
}: {
  icon?: ReactNode
  children: ReactNode
  onClick?: () => void
  danger?: boolean
  href?: string
}) {
  const cls = cn(
    'flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[13.5px] transition-colors hover:bg-ink-100 hover:text-ink-900 [&_svg]:[stroke-width:var(--icon-stroke)]',
    danger ? 'text-red-600' : 'text-ink-700',
  )
  if (href)
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls} onClick={onClick}>
        {icon}
        {children}
      </a>
    )
  return (
    <button type="button" className={cls} onClick={onClick}>
      {icon}
      {children}
    </button>
  )
}

/* ---------------- Stat ---------------- */
export function Stat({ label, value, unit, className }: { label: string; value: ReactNode; unit?: string; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex items-baseline gap-1">
        <span className="font-num text-[2.1rem] leading-none">{value}</span>
        {unit && <span className="text-xs text-ink-500">{unit}</span>}
      </div>
      <div className="mt-2 text-xs tracking-[0.06em] text-ink-500">{label}</div>
    </div>
  )
}

export function Pagination({
  page,
  total,
  pageSize,
  onChange,
}: {
  page: number
  total: number
  pageSize: number
  onChange: (p: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return null
  return (
    <div className="flex items-center justify-center gap-3 py-4 text-sm">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        上一页
      </Button>
      <span className="text-ink-500 tabular-nums">
        {page} / {pages}
      </span>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        下一页
      </Button>
    </div>
  )
}
