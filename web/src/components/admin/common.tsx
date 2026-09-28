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

/** 带防抖的搜索框：停止输入 350ms 后才触发 onChange */
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
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" strokeWidth={1.75} />
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="pr-9 pl-9" />
      {text && (
        <button
          type="button"
          aria-label="清空"
          onClick={() => setText('')}
          className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-0.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
        >
          <X className="size-4" strokeWidth={1.75} />
        </button>
      )}
    </div>
  )
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="mb-5 flex flex-wrap items-center gap-2">{children}</div>
}

/** Select 自带 w-full，用固定宽度的容器约束 */
export function FilterSlot({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('w-[calc(50%-0.25rem)] sm:w-36', className)}>{children}</div>
}

/** 各管理页的页头：西文 + 中文小标题、宋体大标题、一句灰色说明；右侧放操作 */
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
    <header className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="mt-2 text-[28px] leading-[1.15] text-ink-900 md:text-[34px]">{title}</h1>
        {desc && <p className="mt-2 text-sm leading-relaxed text-ink-500">{desc}</p>}
      </div>
      {extra}
    </header>
  )
}

type Tone = 'green' | 'red' | 'amber' | 'sky' | 'gray' | 'dark'
// 细线小方标签：矿物色文字 + 同色淡细线，不铺底色
const toneCls: Record<Tone, string> = {
  green: 'border-emerald-500/35 text-emerald-700',
  red: 'border-red-500/35 text-red-700',
  amber: 'border-amber-500/45 text-amber-700',
  sky: 'border-sky-500/35 text-sky-700',
  gray: 'border-ink-200 text-ink-500',
  dark: 'border-ink-900 bg-ink-900 text-paper',
}

export function Pill({ tone = 'gray', icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-xs leading-[1.125rem] tracking-wide whitespace-nowrap',
        toneCls[tone],
      )}
    >
      {icon}
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
      size="xs"
      variant="ghost"
      title={label}
      aria-label={label}
      icon={icon}
      disabled={disabled}
      onClick={onClick}
      className={cn('[&_svg]:stroke-[1.75]', danger && 'text-brand-600 hover:bg-brand-50', className)}
    >
      <span className="lg:hidden">{label}</span>
    </Button>
  )
}
