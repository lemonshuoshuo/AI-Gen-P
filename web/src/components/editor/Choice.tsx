import { forwardRef, type ReactNode } from 'react'
import { Minus, Plus } from 'lucide-react'
import { ChoiceChip as ThemeChoiceChip, OptionCard, type ChoiceChipProps as ThemeChoiceChipProps } from '@/components/ui'
import { cn } from '@/lib/cn'

/*
 * 编辑器里的选项直接用公共组件的选中语言（docs/DESIGN.md「选中态」）：选中 = 强调色描边 / 实心 + 勾选徽章 + 强调色标题，
 * 形状和颜色随主题（手帐虚线纸片 + 歪着的方形邮戳勾、山野金色勾、夜航细线条目…），不再单独维护一套 brand-500 样式。
 * 自己排版的元素用 selectedClass() + CheckBadge；多个大选项放进 OptionGroup（方向键切换）。
 */
export { CheckBadge, OptionCard, OptionGroup, selectedClass } from '@/components/ui'

export interface ChoiceChipProps extends Omit<ThemeChoiceChipProps, 'role'> {
  /** radio（缺省，放在 role=radiogroup 里）/ tab（页签，aria-selected）/ button（开关，aria-pressed）/ checkbox（多选） */
  role?: 'radio' | 'tab' | 'button' | 'checkbox'
}

/**
 * 胶囊选项：公共组件的 ChoiceChip（未选中是细线胶囊，选中是实心强调色 + 勾），编辑器里默认单选（role="radio"）。
 * 保持编辑器原来的触控高度：sm 32px、md 36px。选中的实心底上，chip 里自带颜色的小字（天数、日期）改用底色上的字色，不会看不清
 */
export const ChoiceChip = forwardRef<HTMLButtonElement, ChoiceChipProps>(function ChoiceChip(
  { role = 'radio', size = 'md', selected, className, ...rest },
  ref,
) {
  return (
    <ThemeChoiceChip
      ref={ref}
      role={role}
      size={size}
      selected={selected}
      className={cn('leading-tight select-none', size === 'sm' ? 'h-8 px-3' : 'h-9 px-3.5', selected && '[&_span]:text-inherit', className)}
      {...rest}
    />
  )
})

/**
 * 大号单选卡片：公共组件 OptionCard（主题的描边、底纹、右上角勾选徽章、强调色标题）。
 * desc → 说明文字；aside → 放在说明下面。多张卡片请放进 OptionGroup（或 role="radiogroup" 的容器）
 */
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
    <OptionCard selected={selected} onClick={onClick} title={title} description={desc} className={className}>
      {aside}
    </OptionCard>
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
    // 与输入框同一套底色和描边（山野是无描边的实心底）
    <div className={cn('inline-flex h-9 items-center rounded-full border border-[color:var(--field-border)] bg-[var(--field-bg)] px-0.5', className)} role="group" aria-label={label}>
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
