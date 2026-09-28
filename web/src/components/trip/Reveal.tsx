import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { cn } from '@/lib/cn'

/**
 * 进入视野时淡入上移一次（animate-slide-up）。动画结束后不保留 transform：
 * 里面的菜单遮罩（fixed）等仍以视口定位。不支持 IntersectionObserver 或偏好减少动效时直接显示
 */
export function Reveal({
  children,
  className,
  delay = 0,
  as = 'div',
  id,
}: {
  children: ReactNode
  className?: string
  /** 毫秒：同一组元素错开 60–80ms */
  delay?: number
  as?: 'div' | 'section' | 'figure' | 'li' | 'header'
  id?: string
}) {
  const ref = useRef<HTMLElement>(null)
  // 标签只影响语义，类型上按 div 处理
  const Tag = as as 'div'
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setShown(true)
      return
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setShown(true)
          io.disconnect()
        }
      },
      { rootMargin: '0px 0px -6% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <Tag
      ref={ref as RefObject<HTMLDivElement>}
      id={id}
      className={cn(shown ? 'animate-slide-up [animation-fill-mode:backwards]' : 'opacity-0', className)}
      style={shown && delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  )
}
