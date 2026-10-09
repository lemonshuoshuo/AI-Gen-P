/**
 * 设计令牌 → 真实颜色。
 * DOM 里直接写 var(--color-…)（切换主题自动跟着变）；WebGL（MapLibre 图层、deck.gl）和 <canvas> 不认识 var()，
 * 用 cssColor() 把令牌解析成 rgba()，并在主题变化时（onThemeChange / useThemeVersion）重新调用。
 * 这个模块很轻（不依赖地图库），lib/meta.ts、公共组件都可以引入。
 */

const colorCache = new Map<string, string>()
let colorProbe: CanvasRenderingContext2D | null = null
const PROBE_SENTINEL = '#010203'

/** 'var(--x)' / 'var(--x, …)' → '--x'；其他原样返回 */
function tokenName(v: string) {
  const m = v.match(/^var\(\s*(--[\w-]+)/)
  return m ? m[1] : v
}

/**
 * 设计令牌（CSS 变量名如 --color-sky-600，或 var(--color-sky-600)）或任意 CSS 颜色 → WebGL / 画布能用的 rgba()。
 * 用 1×1 画布读回像素：主题里写成 oklch()、color-mix() 等新格式的颜色也能用；解析不了时返回 fallback。
 * scope：在哪个元素上读令牌（强制深色的局部，如 useThemeScope('dark') 的容器）；默认 <html>
 */
export function cssColor(v: string, fallback = 'rgba(148, 142, 132, 1)', scope?: Element | null): string {
  if (typeof document === 'undefined') return fallback
  const name = tokenName(v.trim())
  const raw = name.startsWith('--') ? getComputedStyle(scope ?? document.documentElement).getPropertyValue(name).trim() : name
  if (!raw) return fallback
  const hit = colorCache.get(raw)
  if (hit) return hit
  try {
    colorProbe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    const ctx = colorProbe
    if (ctx) {
      ctx.fillStyle = PROBE_SENTINEL
      ctx.fillStyle = raw
      // 无效的颜色不会改变 fillStyle
      if (ctx.fillStyle !== PROBE_SENTINEL || raw.toLowerCase() === PROBE_SENTINEL) {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
        const out = `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
        colorCache.set(raw, out)
        return out
      }
    }
  } catch {
    /* 忽略：用 fallback */
  }
  return fallback
}
