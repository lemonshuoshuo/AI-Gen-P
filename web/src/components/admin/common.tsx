import { Fragment, useEffect, useEffectEvent, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Ellipsis, Search, X } from 'lucide-react'
import type { Paged, UserBrief } from '@/api'
import { Button, IconButton, Input, Menu } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fmtBytes } from '@/lib/format'

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
          className="absolute top-1/2 right-0 flex size-10 -translate-y-1/2 items-center justify-center rounded-full text-ink-400 transition-colors hover:text-ink-900"
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
  /** 待办：标签前一粒朱砂小点（标签本身仍是象牙白） */
  tone?: 'brand'
  className?: string
}) {
  return (
    <div className={cn('flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-ink-200 pt-3 pb-1', className)}>
      <p className="flex min-w-0 items-baseline gap-3">
        <span className="eyebrow inline-flex items-center gap-2.5 !text-ink-800">
          {tone === 'brand' && <span className="size-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />}
          {label}
        </span>
        {count != null && count !== '' && <span className="font-num text-[13px] text-ink-400">{count}</span>}
      </p>
      {extra}
    </div>
  )
}

/** 文字筛选：「待处理 / 已处理 / 全部」，当前项象牙白细下划线 */
export function TextTabs<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  /** 读屏的分组名称 */
  label: string
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={cn('-mx-2 flex flex-wrap items-center text-[13.5px]', className)}>
      {options.map((o, i) => (
        <Fragment key={o.value || '_all'}>
          {i > 0 && (
            <span aria-hidden className="text-ink-300">
              /
            </span>
          )}
          <button
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-10 items-center px-2 tracking-wide whitespace-nowrap transition-colors duration-300',
              value === o.value
                ? 'text-ink-900 underline decoration-ink-900 decoration-1 underline-offset-[7px]'
                : 'text-ink-400 hover:text-ink-900',
            )}
          >
            {o.label}
          </button>
        </Fragment>
      ))}
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

/**
 * 状态胶囊：一律细灰线 + 象牙白文字，只有 4px 的小圆点带颜色。
 * brand = 待处理 / 待审核（全站同一种朱砂），ivory = 已处理，hollow = 已封禁 / 已隐藏（空心点），gray = 无点
 */
type Tone = 'brand' | 'ivory' | 'hollow' | 'gray'
const toneDot: Record<Tone, string> = {
  brand: 'size-1 bg-brand-500',
  ivory: 'size-1 bg-ink-900',
  hollow: 'size-1.5 ring-1 ring-inset ring-ink-600',
  gray: '',
}

export function Pill({ tone = 'gray', icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  const dot = toneDot[tone]
  return (
    <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full border border-ink-300 px-2.5 text-[11.5px] leading-none tracking-[0.04em] whitespace-nowrap text-ink-700">
      {icon ?? (dot && <span className={cn('shrink-0 rounded-full', dot)} aria-hidden />)}
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
      className={cn('max-lg:h-10 lg:size-9 lg:px-0 [&_svg]:stroke-[1.5]', danger && 'text-ink-500 hover:bg-transparent hover:text-brand-600', className)}
    >
      <span className="lg:hidden">{label}</span>
    </Button>
  )
}

/** 行尾的「…」菜单：每行只有一个安静的入口，危险操作（朱砂）收在菜单里 */
export function RowMenu({ children }: { children: (close: () => void) => ReactNode }) {
  return (
    <Menu
      trigger={(toggle, open) => (
        <IconButton label="更多操作" onClick={toggle} aria-expanded={open} className="size-10">
          <Ellipsis className="size-4.5" strokeWidth={1.5} />
        </IconButton>
      )}
    >
      {children}
    </Menu>
  )
}

/** 字节数去掉多余的 0：「133.0 KB」→「133 KB」，「1.50 GB」→「1.5 GB」 */
export const tidyBytes = (n: number) =>
  fmtBytes(n)
    .replace(/\.0+(?=\s)/, '')
    .replace(/(\.\d*?)0+(?=\s)/, '$1')

/** 默认头像：近黑底 + 细线圈 + 象牙白首字，不用彩色圆片（传给 Avatar 的 className） */
export const monoAvatar = '!bg-surface-2 ring-1 ring-inset ring-ink-300 !text-ink-800'

/** 作者 / 举报人：象牙白名字（不加等级、管理员小框）+ 可选的灰色 @用户名 */
export function PersonName({
  user,
  handle = true,
  className,
}: {
  user: Pick<UserBrief, 'nickname' | 'username'>
  /** 下一行显示 @username */
  handle?: boolean
  className?: string
}) {
  return (
    <span className={cn('block min-w-0', className)}>
      <Link
        to={`/u/${user.username}`}
        onClick={(e) => e.stopPropagation()}
        className="block truncate text-ink-900 underline decoration-transparent underline-offset-4 transition-colors duration-300 hover:decoration-ink-500"
      >
        {user.nickname || user.username}
      </Link>
      {handle && <span className="caption block truncate">@{user.username}</span>}
    </span>
  )
}
