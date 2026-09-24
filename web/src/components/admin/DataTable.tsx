import type { ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { Card, Empty, Pagination, Spinner } from '@/components/ui'
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
 * 响应式数据表：大屏为表格，小屏为卡片列表。
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
      <Card className="flex justify-center py-16">
        <Spinner className="size-6" />
      </Card>
    )
  if (!rows?.length)
    return (
      <Card>
        <Empty icon={<Inbox className="size-10" />} title={emptyText} />
      </Card>
    )

  const primary = columns.filter((c) => c.primary)
  const rest = columns.filter((c) => !c.primary && !c.hideOnMobile)

  return (
    <div className={cn('transition-opacity', fetching && 'opacity-60')}>
      {/* 桌面端表格 */}
      <div className="hidden rounded-2xl bg-white shadow-card lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-100 text-left text-xs text-ink-400">
              {columns.map((c) => (
                <th key={c.key} className={cn('px-3 py-3 font-medium whitespace-nowrap first:pl-4', c.className)}>
                  {c.header}
                </th>
              ))}
              {actions && <th className="py-3 pr-4 pl-3 text-right font-medium">操作</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} className="border-b border-ink-100 align-middle last:border-none hover:bg-ink-50/60">
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-3 py-3 first:pl-4', c.className)}>
                    {c.cell(r)}
                  </td>
                ))}
                {actions && (
                  <td className="py-3 pr-4 pl-3">
                    <div className="flex items-center justify-end gap-0.5">{actions(r)}</div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 移动端卡片 */}
      <div className="space-y-3 lg:hidden">
        {rows.map((r) => (
          <Card key={rowKey(r)} className="relative p-4">
            {primary.map((c) => (
              <div key={c.key} className={cn('min-w-0', compactActions && 'pr-9')}>
                {c.cell(r)}
              </div>
            ))}
            {actions && compactActions && <div className="absolute top-3 right-3">{actions(r)}</div>}
            {rest.length > 0 && (
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                {rest.map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className="text-xs text-ink-400">{c.header}</dt>
                    <dd className="mt-0.5 min-w-0">{c.cell(r)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {actions && !compactActions && (
              <div className="mt-3 flex flex-wrap items-center justify-end gap-1 border-t border-ink-100 pt-3">{actions(r)}</div>
            )}
          </Card>
        ))}
      </div>

      <Pagination page={page} total={total} pageSize={pageSize} onChange={onPage} />
    </div>
  )
}
