import { Check, Loader2, RotateCw, Save } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { SaveState } from './usePlanEditor'

const label: Record<SaveState, string> = {
  saved: '已保存',
  saving: '保存中',
  dirty: '保存',
  error: '重试保存',
}

/**
 * 「保存」：清楚地显示有没有保存好。已保存为细线 + 对勾；有未保存的修改为实心按钮 + 强调色圆点（count：几处）；
 * 保存中转圈；失败为强调色可重试。修改都在本机的草稿里，点这里一次提交
 */
export function SaveButton({
  state,
  onSave,
  busy,
  count = 0,
  className,
}: {
  state: SaveState
  onSave: () => void
  busy?: boolean
  count?: number
  className?: string
}) {
  const Icon = state === 'saving' || busy ? Loader2 : state === 'error' ? RotateCw : state === 'dirty' ? Save : Check
  return (
    <button
      type="button"
      onClick={onSave}
      disabled={busy}
      aria-live="polite"
      title={
        state === 'saved'
          ? '全部修改已保存'
          : state === 'error'
            ? '没有保存成功，点这里重试'
            : state === 'dirty'
              ? `有 ${count} 处修改还没有保存（Ctrl / ⌘ + S）`
              : undefined
      }
      className={cn(
        'inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium tracking-[0.02em] whitespace-nowrap transition-colors duration-300 md:h-9',
        state === 'dirty' && 'border-ink-900 bg-ink-900 text-paper hover:bg-ink-700',
        state === 'saved' && 'border-ink-900/25 text-ink-900 hover:border-ink-900/60',
        state === 'saving' && 'border-ink-900/25 text-ink-600',
        state === 'error' && 'border-brand-500 bg-brand-100 text-ink-900 hover:bg-brand-200',
        className,
      )}
    >
      <Icon
        className={cn('size-3.5', (state === 'saving' || busy) && 'animate-spin', state === 'saved' && !busy && 'text-emerald-600')}
        strokeWidth={state === 'saved' ? 2.25 : 1.75}
      />
      {label[state]}
      {state === 'dirty' && count > 0 && (
        <span className="font-num -mr-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-paper px-1 text-[11px] leading-none font-semibold text-ink-900">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  )
}
