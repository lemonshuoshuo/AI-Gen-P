import { Fragment, type ReactNode } from 'react'
import { Pagination, Spinner } from '@/components/ui'
import { cn } from '@/lib/cn'

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** 桌面端单元格样式（宽度、对齐等） */
  className?: string
  /**
   * 小屏列表中的位置：primary = 标题区域；meta（默认）= 标题下一行灰色说明，各列用「 · 」连接；hide = 不显示
   */
  mobile?: 'primary' | 'meta' | 'hide'
  /** 小屏说明行里的简短写法（默认用 cell）；返回空值时该项不显示 */
  meta?: (row: T) => ReactNode
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
  metaClassName,
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
  /** 小屏说明行的缩进（与标题区域里头像右侧的文字对齐） */
  metaClassName?: string
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
  // 空状态：左对齐的一句宋体，不用图标
  if (!rows?.length)
    return (
      <div className="border-y border-ink-200 py-14 md:py-20">
        <p className="text-display-md font-normal text-ink-700">{emptyText}</p>
      </div>
    )

  const primary = columns.filter((c) => c.mobile === 'primary')
  const meta = columns.filter((c) => (c.mobile ?? 'meta') === 'meta')

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

      {/* 移动端：标题区域 + 一行灰色说明（「Lv.1 新手旅人 · 1 段旅程 · 5 小时前」），细线分隔 */}
      <ul className="divide-y divide-ink-200 border-y border-ink-200 lg:hidden">
        {rows.map((r) => {
          const metas = meta.map((c) => ({ key: c.key, node: (c.meta ?? c.cell)(r) })).filter((m) => m.node != null && m.node !== false && m.node !== '')
          return (
            <li key={rowKey(r)} className="relative py-5">
              {primary.map((c) => (
                <div key={c.key} className={cn('min-w-0', compactActions && 'pr-11')}>
                  {c.cell(r)}
                </div>
              ))}
              {actions && compactActions && <div className="absolute top-4 -right-2">{actions(r)}</div>}
              {metas.length > 0 && (
                <p className={cn('caption mt-2 flex flex-wrap items-center gap-x-2 gap-y-1', metaClassName)}>
                  {metas.map((m, i) => (
                    <Fragment key={m.key}>
                      {i > 0 && (
                        <span aria-hidden className="text-ink-300">
                          ·
                        </span>
                      )}
                      <span className="min-w-0">{m.node}</span>
                    </Fragment>
                  ))}
                </p>
              )}
              {actions && !compactActions && (
                <div className="-mr-2 mt-3 flex flex-wrap items-center justify-end gap-1">{actions(r)}</div>
              )}
            </li>
          )
        })}
      </ul>

      <div className="pt-6">
        <Pagination page={page} total={total} pageSize={pageSize} onChange={onPage} />
      </div>
    </div>
  )
}
