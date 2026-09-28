import { useInsertionEffect } from 'react'
import { cn } from '@/lib/cn'

const STYLE_ID = 'th-indeterminate'
const CSS = `
@keyframes th-indet {
  0% { transform: translateX(-100%) scaleX(0.4); }
  55% { transform: translateX(60%) scaleX(0.9); }
  100% { transform: translateX(210%) scaleX(0.4); }
}
.th-indet-bar { animation: th-indet 1.7s cubic-bezier(0.65, 0, 0.35, 1) infinite; transform-origin: left center; }
@media (prefers-reduced-motion: reduce) {
  .th-indet-bar { animation: none; transform: none; width: 100% !important; opacity: 0.35; }
}`

/** 不确定进度的细线：一段朱砂在细线上来回滑动（不用转圈图标）。全局只注入一次样式 */
export function IndeterminateLine({ className, label }: { className?: string; label?: string }) {
  useInsertionEffect(() => {
    if (document.getElementById(STYLE_ID)) return
    const s = document.createElement('style')
    s.id = STYLE_ID
    s.textContent = CSS
    document.head.appendChild(s)
  }, [])
  return (
    <div
      role="progressbar"
      aria-label={label ?? '加载中'}
      aria-busy="true"
      className={cn('relative h-[2px] w-full overflow-hidden bg-ink-200/70', className)}
    >
      <div className="th-indet-bar absolute inset-y-0 left-0 w-1/2 bg-brand-500" />
    </div>
  )
}
