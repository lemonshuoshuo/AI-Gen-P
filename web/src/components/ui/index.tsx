import { forwardRef, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { Loader2, Star, X } from 'lucide-react'
import { create } from 'zustand'
import type { Category, UserBrief, Verdict } from '@/api/types'
import { cn } from '@/lib/cn'
import { categoryOf, levelColor, verdicts } from '@/lib/meta'

/* ---------------- Button ---------------- */
type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'love' | 'dark'
type Size = 'xs' | 'sm' | 'md' | 'lg'

const variantCls: Record<Variant, string> = {
  primary: 'bg-brand-gradient text-white shadow-sm shadow-brand-500/30 hover:brightness-105 active:brightness-95',
  secondary: 'bg-ink-100 text-ink-900 hover:bg-ink-200',
  outline: 'border border-ink-200 bg-white text-ink-900 hover:bg-ink-50',
  ghost: 'text-ink-700 hover:bg-ink-100',
  danger: 'bg-red-500 text-white hover:bg-red-600',
  love: 'bg-love-gradient text-white shadow-sm shadow-pink-500/30 hover:brightness-105',
  dark: 'bg-ink-900 text-white hover:bg-ink-700',
}
const sizeCls: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-xs gap-1 rounded-lg',
  sm: 'h-8 px-3 text-sm gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-base gap-2 rounded-2xl',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
  block?: boolean
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
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition select-none disabled:opacity-50',
        variantCls[variant],
        sizeCls[size],
        block && 'w-full',
        className,
      )}
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
        'inline-flex size-9 shrink-0 items-center justify-center rounded-full text-ink-700 transition hover:bg-ink-100 disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/* ---------------- Form ---------------- */
const fieldBase =
  'w-full rounded-xl border border-ink-200 bg-white px-3.5 text-sm text-ink-900 placeholder:text-ink-400 outline-none transition focus:border-brand-400 focus:ring-4 focus:ring-brand-100 disabled:bg-ink-50'

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
    <select className={cn(fieldBase, 'h-10 appearance-none bg-[length:16px] pr-8', className)} {...rest}>
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
      {label && <span className="mb-1.5 block text-sm font-medium text-ink-700">{label}</span>}
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-400">{hint}</span>}
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
          'relative inline-block h-6 w-10 rounded-full transition',
          checked ? 'bg-brand-500' : 'bg-ink-200',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition',
            checked && 'translate-x-4',
          )}
        />
      </span>
      {label}
    </button>
  )
}

/* ---------------- Segmented tabs ---------------- */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  className?: string
  size?: 'sm' | 'md'
}) {
  return (
    <div className={cn('inline-flex rounded-xl bg-ink-100 p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-lg font-medium whitespace-nowrap transition',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
            value === o.value ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

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
    <div className={cn('scrollbar-none flex gap-5 overflow-x-auto border-b border-ink-200', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'relative shrink-0 pb-2.5 text-sm font-medium transition',
            value === o.value ? 'text-ink-900' : 'text-ink-400 hover:text-ink-700',
          )}
        >
          {o.label}
          {value === o.value && (
            <span className="bg-brand-gradient absolute right-1/4 bottom-0 left-1/4 h-0.5 rounded-full" />
          )}
        </button>
      ))}
    </div>
  )
}

/* ---------------- Avatar & user ---------------- */
const avatarColors = ['#ff5a5f', '#ff9a44', '#10b981', '#0ea5e9', '#8b5cf6', '#ec4899', '#f59e0b']

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
  const ringCls = ring && 'ring-2 ring-white'
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
  const color = avatarColors[(user?.id ?? 0) % avatarColors.length]
  return (
    <span
      style={{ ...style, background: color }}
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', ringCls, className)}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

export function LevelBadge({ level, className }: { level: number; className?: string }) {
  return (
    <span
      className={cn('inline-flex h-4 items-center rounded px-1 text-[10px] leading-none font-bold text-white', className)}
      style={{ background: levelColor(level) }}
    >
      Lv{level}
    </span>
  )
}

export function UserName({ user, className, link = true }: { user: UserBrief; className?: string; link?: boolean }) {
  const inner = (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span className="truncate font-medium">{user.nickname || user.username}</span>
      <LevelBadge level={user.level} />
      {user.role === 'admin' && (
        <span className="inline-flex h-4 items-center rounded bg-ink-900 px-1 text-[10px] leading-none font-bold text-white">
          管理员
        </span>
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
export function VerdictBadge({ verdict, className }: { verdict: Verdict; className?: string }) {
  if (!verdict) return null
  const v = verdicts[verdict]
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1', v.cls, className)}>
      <span>{v.emoji}</span>
      {v.label}
    </span>
  )
}

export function CategoryChip({ category, className }: { category: Category | string; className?: string }) {
  const c = categoryOf(category)
  const Icon = c.icon
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', className)}
      style={{ background: c.color + '18', color: c.color }}
    >
      <Icon className="size-3" />
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
            className={cn(filled ? 'fill-amber-400 text-amber-400' : half ? 'fill-amber-200 text-amber-400' : 'text-ink-300')}
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
    <span className={cn('inline-flex items-center rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-700', className)}>
      {children}
    </span>
  )
}

/* ---------------- States ---------------- */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-brand-500', className)} />
}

export function PageLoader({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-sm text-ink-400">
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
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon && <div className="mb-3 text-ink-300">{icon}</div>}
      <p className="font-medium text-ink-700">{title}</p>
      {desc && <p className="mt-1 max-w-sm text-sm text-ink-400">{desc}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-2xl bg-white shadow-card', className)}>{children}</div>
}

/* ---------------- Modal / Sheet ---------------- */
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
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4">
      <div className="animate-fade-in absolute inset-0 bg-ink-900/40 backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'animate-slide-up relative flex max-h-[90dvh] w-full flex-col rounded-t-3xl bg-white shadow-float sm:rounded-3xl',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
          className,
        )}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
            <h3 className="text-base font-semibold">{title}</h3>
            <IconButton label="关闭" onClick={onClose} className="-mr-2">
              <X className="size-5" />
            </IconButton>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-5 pb-5">{children}</div>
        {footer && <div className="pb-safe flex justify-end gap-2 border-t border-ink-100 px-5 py-3">{footer}</div>}
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
  trigger: (toggle: () => void) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative inline-block">
      {trigger(() => setOpen((v) => !v))}
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={cn(
              'animate-fade-in absolute z-50 mt-2 min-w-44 overflow-hidden rounded-2xl bg-white py-1.5 shadow-float ring-1 ring-ink-100',
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
    'flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition hover:bg-ink-50',
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
      <div className="flex items-baseline gap-0.5">
        <span className="text-xl font-bold tabular-nums">{value}</span>
        {unit && <span className="text-xs text-ink-400">{unit}</span>}
      </div>
      <div className="text-xs text-ink-400">{label}</div>
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
