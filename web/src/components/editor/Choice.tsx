import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Check, Loader2, Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * 可选项的统一「已选中」样式：强调色边框 + 实心对勾 + 淡淡的底色，一眼就能看出选的是哪个
 * （只有颜色或下划线的区别在深色底上太难分辨）
 */
export const selectedCls = 'border-brand-500 bg-brand-100 text-ink-900'
export const unselectedCls = 'border-ink-200 text-ink-600 hover:border-ink-400 hover:text-ink-900'

/** 实心对勾：选中标记 */
export function CheckDot({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('flex size-4 shrink-0 items-center justify-center rounded-full bg-brand-500 text-paper', className)}>
      <Check className="size-2.5" strokeWidth={3} />
    </span>
  )
}

export interface ChoiceChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'role'> {
  selected: boolean
  icon?: ReactNode
  size?: 'sm' | 'md'
  loading?: boolean
  /** radio（缺省）或 tab：决定读屏用 aria-checked 还是 aria-selected */
  role?: 'radio' | 'tab' | 'button'
  /** 选中时不把图标换成对勾（如带颜色标记的天数页签） */
  keepIcon?: boolean
}

/** 胶囊选项：未选中是细线，选中是强调色边框 + 对勾 + 底色 */
export const ChoiceChip = forwardRef<HTMLButtonElement, ChoiceChipProps>(function ChoiceChip(
  { selected, icon, size = 'md', loading, role = 'radio', keepIcon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const a11y =
    role === 'radio' ? { role, 'aria-checked': selected } : role === 'tab' ? { role, 'aria-selected': selected } : { 'aria-pressed': selected }
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      {...a11y}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border whitespace-nowrap transition-colors duration-200 select-none disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-[12.5px]' : 'h-9 px-3.5 text-[13px]',
        selected ? cn(selectedCls, 'font-medium') : unselectedCls,
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} />
      ) : selected && !keepIcon ? (
        <CheckDot className="-ml-1" />
      ) : (
        icon
      )}
      {children}
    </button>
  )
})

/** 大号单选卡片：左侧圆形单选标记（选中为实心对勾），整张卡片强调色边框 + 底色 */
export function ChoiceCard({
  selected,
  onClick,
  title,
  desc,
  aside,
  className,
}: {
  selected: boolean
  onClick: () => void
  title: ReactNode
  desc?: ReactNode
  aside?: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        'group relative flex w-full items-start gap-3.5 rounded-lg border px-4 py-4 text-left transition-colors duration-200 md:gap-4 md:px-5 md:py-5',
        selected ? selectedCls : 'border-ink-200 hover:border-ink-400',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200',
          selected ? 'border-brand-500 bg-brand-500 text-paper' : 'border-ink-300 group-hover:border-ink-500',
        )}
      >
        {selected && <Check className="size-3" strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[16px] leading-snug md:text-[17px]', selected ? 'font-medium text-ink-900' : 'text-ink-800')}>{title}</span>
        {desc && <span className="mt-1 block text-[13px] leading-relaxed text-ink-500">{desc}</span>}
      </span>
      {aside}
      {selected && <span className="sr-only">（已选择）</span>}
    </button>
  )
}

/** 数量步进：− 3 天 + */
export function Stepper({
  value,
  min = 0,
  max = 365,
  onChange,
  unit,
  disabled,
  label,
  className,
}: {
  value: number
  min?: number
  max?: number
  onChange: (v: number) => void
  unit?: string
  disabled?: boolean
  /** 读屏用的名称，如「天数」 */
  label: string
  className?: string
}) {
  const btn =
    'flex size-8 items-center justify-center rounded-full text-ink-600 transition-colors hover:bg-ink-900/[0.06] hover:text-ink-900 disabled:opacity-35 disabled:hover:bg-transparent'
  return (
    <div className={cn('inline-flex h-9 items-center rounded-full border border-ink-200 px-0.5', className)} role="group" aria-label={label}>
      <button type="button" className={btn} disabled={disabled || value <= min} onClick={() => onChange(value - 1)} aria-label={`${label}减一`}>
        <Minus className="size-3.5" strokeWidth={1.75} />
      </button>
      <span className="min-w-12 px-1 text-center text-[13px] text-ink-900" aria-live="polite">
        <span className="font-num text-[16px]">{value}</span>
        {unit && <span className="ml-0.5 text-[12px] text-ink-500">{unit}</span>}
      </span>
      <button type="button" className={btn} disabled={disabled || value >= max} onClick={() => onChange(value + 1)} aria-label={`${label}加一`}>
        <Plus className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  )
}
