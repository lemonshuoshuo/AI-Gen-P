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
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} className="pr-9 pl-9" />
      {text && (
        <button
          type="button"
          aria-label="清空"
          onClick={() => setText('')}
          className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-0.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center gap-2">{children}</div>
}

/** Select 自带 w-full，用固定宽度的容器约束 */
export function FilterSlot({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('w-[calc(50%-0.25rem)] sm:w-36', className)}>{children}</div>
}

export function PanelHeader({ title, desc, extra }: { title: string; desc?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold">{title}</h2>
        {desc && <p className="mt-0.5 text-sm text-ink-400">{desc}</p>}
      </div>
      {extra}
    </div>
  )
}

type Tone = 'green' | 'red' | 'amber' | 'sky' | 'gray' | 'dark'
const toneCls: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700',
  red: 'bg-red-50 text-red-700',
  amber: 'bg-amber-50 text-amber-700',
  sky: 'bg-sky-50 text-sky-700',
  gray: 'bg-ink-100 text-ink-500',
  dark: 'bg-ink-900 text-white',
}

export function Pill({ tone = 'gray', icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
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
      className={cn(danger && 'text-red-600 hover:bg-red-50', className)}
    >
      <span className="lg:hidden">{label}</span>
    </Button>
  )
}
