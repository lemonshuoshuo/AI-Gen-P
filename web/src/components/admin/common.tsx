import { useEffect, useEffectEvent, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import type { Paged } from '@/api'
import { Button, Input } from '@/components/ui'
import { cn } from '@/lib/cn'

export const ADMIN_PAGE_SIZE = 20

/** 筛选条件 + 页码；任何筛选变化都会回到第 1 页 */
export function useFilters<F extends Record<string, string>>(init: F) {
  const [state, setState] = useState<F & { page: number }>({ ...init, page: 1 })
  return {
    f: state,
    set: (patch: Partial<F>) => setState((s) => ({ ...s, ...patch, page: 1 })),
    setPage: (page: number) => setState((s) => (s.page === page ? s : { ...s, page })),
  }
}

/** 服务端对超出范围的页返回空 items（total 仍 > 0）：删除 / 隐藏 / 处理掉当前页最后一条后会停在空页 */
export const isStalePage = (d?: Paged<unknown>) => !!d && d.page > 1 && d.items.length === 0 && d.total > 0

/** 停在空页时自动退回最后一个有效页；用服务端回显的 page / page_size，保留的旧数据不会重复触发 */
export function usePageGuard(data: Paged<unknown> | undefined, setPage: (p: number) => void) {
  const back = useEffectEvent(setPage)
  useEffect(() => {
    if (data && isStalePage(data)) back(Math.max(1, Math.min(data.page - 1, Math.ceil(data.total / data.page_size))))
  }, [data])
}

/** 带防抖的搜索框：停止输入 350ms 后才触发 onChange。只有一道下细线，没有底色 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  const [text, setText] = useState(value)
  const commit = useEffectEvent((v: string) => {
    if (v !== value) onChange(v)
  })
  useEffect(() => {
    const t = setTimeout(() => commit(text.trim()), 350)
    return () => clearTimeout(t)
  }, [text])
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-0 size-4 -translate-y-1/2 text-ink-400" strokeWidth={1.5} />
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-11 rounded-none border-0 border-b border-ink-300 bg-transparent pr-9 pl-7 text-[15px] hover:border-ink-500 focus:border-ink-900"
      />
      {text && (
        <button
          type="button"
          aria-label="清空"
          onClick={() => setText('')}
          className="absolute top-1/2 right-0 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-ink-400 transition-colors hover:text-ink-900"
        >
          <X className="size-4" strokeWidth={1.5} />
        </button>
      )}
    </div>
  )
}

/** 筛选行：搜索框与下拉框都是「一道下细线」的样式 */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="mb-10 flex flex-wrap items-end gap-x-6 gap-y-3 md:mb-12 [&_select]:h-11 [&_select]:rounded-none [&_select]:border-0 [&_select]:border-b [&_select]:border-ink-300 [&_select]:bg-transparent [&_select]:bg-[position:right_0.25rem_center] [&_select]:pl-0 [&_select]:text-[14px]">
      {children}
    </div>
  )
}

/** Select 自带 w-full，用固定宽度的容器约束 */
export function FilterSlot({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('w-[calc(50%-0.75rem)] sm:w-40', className)}>{children}</div>
}

/** 细线标签行（Exemplar 式区块头）：一条 border-t，左侧 eyebrow + 灰色计数，右侧操作 */
export function LabelRow({
  label,
  count,
  extra,
  tone,
  className,
}: {
  label: ReactNode
  count?: ReactNode
  extra?: ReactNode
  /** 待办、危险操作：标签用朱砂色 */
  tone?: 'brand'
  className?: string
}) {
  return (
    <div className={cn('flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-ink-200 pt-3 pb-1', className)}>
      <p className="flex min-w-0 items-baseline gap-3">
        <span className={cn('eyebrow', tone === 'brand' ? '!text-brand-600' : '!text-ink-800')}>{label}</span>
        {count != null && count !== '' && <span className="font-num text-[13px] text-ink-400">{count}</span>}
      </p>
      {extra}
    </div>
  )
}

/** 大号细字数字：Cormorant Light */
export const Num = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cn('font-num font-light text-ink-900', className)}>{children}</span>
)

/** 各管理页的页头：细线标签行，下面大号宋体标题 + 一句灰色说明；右侧放操作 */
export function PanelHeader({
  eyebrow,
  title,
  desc,
  extra,
}: {
  eyebrow?: string
  title: string
  desc?: ReactNode
  extra?: ReactNode
}) {
  return (
    <header className="animate-slide-up mb-12 md:mb-16">
      {eyebrow && <LabelRow label={eyebrow} />}
      <div className="mt-8 flex flex-wrap items-end justify-between gap-x-10 gap-y-6 md:mt-12">
        <div className="min-w-0">
          <h1 className="text-display-lg font-normal max-sm:text-[2.75rem]">{title}</h1>
          {desc && <p className="mt-4 max-w-xl text-[14px] leading-[1.8] text-ink-500">{desc}</p>}
        </div>
        {extra && <div className="md:pb-1">{extra}</div>}
      </div>
    </header>
  )
}

type Tone = 'green' | 'red' | 'amber' | 'sky' | 'gray' | 'dark'
// 细线胶囊：矿物色小圆点 + 文字 + 同色淡细线，不铺底色
const toneCls: Record<Tone, [string, string]> = {
  green: ['border-emerald-500/35 text-emerald-700', 'bg-emerald-500'],
  red: ['border-red-500/40 text-red-700', 'bg-red-500'],
  amber: ['border-amber-500/40 text-amber-700', 'bg-amber-500'],
  sky: ['border-sky-500/35 text-sky-700', 'bg-sky-500'],
  gray: ['border-ink-300 text-ink-600', ''],
  dark: ['border-ink-500 text-ink-900', ''],
}

export function Pill({ tone = 'gray', icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  const [cls, dot] = toneCls[tone]
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] leading-none tracking-[0.04em] whitespace-nowrap',
        cls,
      )}
    >
      {icon ?? (dot && <span className={cn('size-1 shrink-0 rounded-full', dot)} aria-hidden />)}
      {children}
    </span>
  )
}

/** 行操作按钮：表格中只显示图标（悬停提示），卡片中显示文字 */
export function ActionButton({
  icon,
  label,
  onClick,
  danger,
  disabled,
  className,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  className?: string
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      title={label}
      aria-label={label}
      icon={icon}
      disabled={disabled}
      onClick={onClick}
      className={cn('max-lg:h-10 lg:size-9 lg:px-0 [&_svg]:stroke-[1.5]', danger && 'text-brand-600 hover:bg-brand-50 hover:text-brand-700', className)}
    >
      <span className="lg:hidden">{label}</span>
    </Button>
  )
}
