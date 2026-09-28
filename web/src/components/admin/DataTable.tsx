import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { Empty, Pagination, Spinner } from '@/components/ui'
import { cn } from '@/lib/cn'

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** 桌面端单元格样式（宽度、对齐等） */
  className?: string
  /** 移动端卡片中作为标题区域展示（不带标签） */
  primary?: boolean
  /** 移动端卡片中隐藏 */
  hideOnMobile?: boolean
}

/**
 * 响应式数据表：大屏为表格，小屏为细线分隔的列表。
 * 注意：外层不设置 overflow，避免操作菜单被裁切。
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  actions,
  compactActions,
  loading,
  fetching,
  emptyText = '暂无数据',
  page,
  total,
  pageSize,
  onPage,
}: {
  rows: T[] | undefined
  columns: Column<T>[]
  rowKey: (row: T) => string | number
  actions?: (row: T) => ReactNode
  /** 操作只有一个图标（如「更多」菜单）时，移动端放在卡片右上角 */
  compactActions?: boolean
  loading?: boolean
  /** 翻页 / 筛选时的后台刷新 */
  fetching?: boolean
  emptyText?: string
  page: number
  total: number
  pageSize: number
  onPage: (p: number) => void
}) {
  // 当前页的最后一条被删除 / 隐藏后停在了空页：面板正在退回上一页（usePageGuard），先显示加载中
  if (loading || (!rows?.length && page > 1 && total > 0))
    return (
      <div className="flex justify-center border-y border-ink-200 py-20">
        <Spinner className="size-6" />
      </div>
    )
  if (!rows?.length)
    return (
      <div className="border-y border-ink-200">
        <Empty className="py-20" icon={<Inbox className="size-9" />} title={emptyText} />
      </div>
    )

  const primary = columns.filter((c) => c.primary)
  const rest = columns.filter((c) => !c.primary && !c.hideOnMobile)

  return (
    <div className={cn('transition-opacity duration-300', fetching && 'opacity-60')}>
      {/* 桌面端表格：细线行，列名是极小的大写字距标签，不做斑马纹 */}
      <div className="hidden lg:block">
        <table className="w-full text-[14px]">
          <thead>
            <tr className="border-y border-ink-200 text-left">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn('eyebrow px-4 py-3.5 !font-medium whitespace-nowrap first:pl-0', c.className)}
                >
                  {c.header}
                </th>
              ))}
              {actions && <th className="eyebrow py-3.5 pr-0 pl-4 text-right !font-medium">操作</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} className="border-b border-ink-200 align-middle transition-colors duration-300 hover:bg-ink-100/60">
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-4 py-5 first:pl-0', c.className)}>
                    {c.cell(r)}
                  </td>
                ))}
                {actions && (
                  <td className="py-5 pr-0 pl-4">
                    <div className="flex items-center justify-end gap-0.5">{actions(r)}</div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 移动端：排版 + 细线的列表，而不是一张张卡片 */}
      <ul className="divide-y divide-ink-200 border-y border-ink-200 lg:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className="relative py-6">
            {primary.map((c) => (
              <div key={c.key} className={cn('min-w-0', compactActions && 'pr-11')}>
                {c.cell(r)}
              </div>
            ))}
            {actions && compactActions && <div className="absolute top-5 -right-1.5">{actions(r)}</div>}
            {rest.length > 0 && (
              <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 text-[14px]">
                {rest.map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className="eyebrow">{c.header}</dt>
                    <dd className="mt-1 min-w-0">{c.cell(r)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {actions && !compactActions && (
              <div className="-mr-2 mt-4 flex flex-wrap items-center justify-end gap-1">{actions(r)}</div>
            )}
          </li>
        ))}
      </ul>

      <div className="pt-6">
        <Pagination page={page} total={total} pageSize={pageSize} onChange={onPage} />
      </div>
    </div>
  )
}
