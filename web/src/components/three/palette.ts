// 3D 场景（足迹地图、足迹地球、点亮的省份与光柱）的颜色：全部来自主题令牌，不写死颜色。
// - 夜景（全国 / 省级视图、地球）：任何模式下都是深色，用当前主题「深色模式」的令牌；
// - 城市级（底图跟随当前模式）：路线、路线描边、分类色用当前模式的令牌。
// WebGL 不认识 CSS 变量：在一个带 data-theme / data-mode 的隐藏元素上读计算样式，再用 cssColor() 换成 rgba()；
// 换主题或深浅色时 useLitPalette 重新读取（依赖 useTheme 的 theme / mode），地图图层随之重设颜色。
import { useMemo } from 'react'
import type { Category } from '@/api/types'
import { cssColor } from '@/components/map/layers'
import { useTheme, type Mode, type ThemeId } from '@/theme'

/** 足迹的色调：sunset 是自己的足迹（主题的路线色），love 是「我们」的共同足迹（胭脂色） */
export type LitTheme = 'sunset' | 'love'

type RGBA = [number, number, number, number]

const parse = (c: string): RGBA => {
  const m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] == null ? 1 : Number(m[4])] : [148, 142, 132, 1]
}
const fmt = ([r, g, b]: RGBA, a: number) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`

/** 两种颜色（rgba()）按 k 混合：0 = a，1 = b */
export function mixColor(a: string, b: string, k: number, alpha = 1) {
  const x = parse(a)
  const y = parse(b)
  return fmt([x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k, 1], alpha)
}
/** 同一种颜色换一个不透明度 */
export const withAlpha = (c: string, a: number) => fmt(parse(c), a)

/** 当前主题某个模式下的颜色令牌：CSS 变量名 → rgba()（WebGL 用） */
export function tokenColors<K extends string>(theme: ThemeId, mode: Mode, names: readonly K[]): Record<K, string> {
  const out = {} as Record<K, string>
  if (typeof document === 'undefined') {
    for (const n of names) out[n] = fmt([148, 142, 132, 1], 1)
    return out
  }
  const el = document.createElement('div')
  el.hidden = true
  el.dataset.theme = theme
  el.dataset.mode = mode
  document.body.appendChild(el)
  const cs = getComputedStyle(el)
  for (const n of names) out[n] = cssColor(cs.getPropertyValue(n).trim())
  el.remove()
  return out
}

/** 分类的颜色令牌（与公共组件 CategoryChip 一致）：DOM 里写 var(…)，WebGL 用 tokenColors 解析 */
export const CATEGORY_TOKENS: Record<Category, string> = {
  scenic: '--color-emerald-600',
  food: '--color-orange-600',
  hotel: '--color-indigo-500',
  shopping: '--color-pink-600',
  transport: '--color-sky-600',
  entertainment: '--color-violet-600',
  other: '--color-ink-400',
}
export const categoryToken = (c: string | undefined) => CATEGORY_TOKENS[(c && c in CATEGORY_TOKENS ? c : 'other') as Category]

export interface LitPalette {
  /* ---- 夜景（深色）：全国 / 省级视图、地球 ---- */
  /** 去过的省份 / 城市：打卡少 → 多（石刻色，多的带一点足迹色） */
  low: string
  high: string
  /** 去过的省界、城市光晕：象牙白带一点足迹色 */
  line: string
  /** 没去过的地方的细线 */
  idle: string
  /** 光柱、夜色里的足迹点：主题的路线色（「我们」是胭脂色） */
  column: string
  /** 光柱顶端的细帽（象牙白） */
  cap: string
  /** 夜色里的路线 */
  routeNight: string
  /** 夜色底色（点的描边） */
  night: string
  /** 立体省份的光源 */
  light: string
  /* ---- 城市级：底图是当前模式 ---- */
  /** 旅程路线 */
  routeDay: string
  /** 路线描边、点的描边：当前模式的纸色 */
  casing: string
  /** 没去过的城市边界 */
  idleDay: string
  /** 足迹点的分类色 */
  categories: Record<Category, string>
}

const NIGHT_TOKENS = [
  '--color-ink-200',
  '--color-ink-300',
  '--color-ink-400',
  '--color-ink-500',
  '--color-ink-900',
  '--color-sky-600',
  '--color-night',
  '--route-actual',
  '--color-pink-600',
  '--color-pink-700',
] as const
const DAY_TOKENS = ['--color-paper', '--color-ink-400', '--route-actual', '--color-pink-600', ...Object.values(CATEGORY_TOKENS)] as const

/** 按主题令牌算出足迹地图的配色（theme / mode：当前生效的主题与模式） */
export function litPalette(tone: LitTheme, theme: ThemeId, mode: Mode): LitPalette {
  const n = tokenColors(theme, 'dark', NIGHT_TOKENS)
  const d = tokenColors(theme, mode, DAY_TOKENS)
  const love = tone === 'love'
  // 地面（点亮的省份、省界）两种色调都一样，只带一点主题的路线色；「我们」的胭脂色只用在光柱、路线上，不做大色块
  const ground = n['--route-actual']
  const column = love ? n['--color-pink-600'] : ground
  const categories = Object.fromEntries(Object.entries(CATEGORY_TOKENS).map(([k, v]) => [k, d[v as (typeof DAY_TOKENS)[number]]])) as Record<Category, string>
  return {
    // 最亮也只到中灰（约 55% 明度），打卡多的省份不会亮成一块白
    low: mixColor(n['--color-ink-200'], n['--color-ink-300'], 0.5),
    high: mixColor(n['--color-ink-400'], ground, 0.22),
    line: mixColor(n['--color-ink-900'], ground, 0.25),
    idle: mixColor(n['--color-ink-500'], n['--color-sky-600'], 0.5),
    column,
    cap: n['--color-ink-900'],
    routeNight: love ? n['--color-pink-700'] : column,
    night: n['--color-night'],
    light: n['--color-ink-900'],
    routeDay: love ? d['--color-pink-600'] : d['--route-actual'],
    casing: d['--color-paper'],
    idleDay: d['--color-ink-400'],
    categories,
  }
}

/** 足迹地图的配色，换主题 / 深浅色时重新读取 */
export function useLitPalette(tone: LitTheme = 'sunset'): LitPalette {
  const { theme, mode } = useTheme()
  return useMemo(() => litPalette(tone, theme, mode), [tone, theme, mode])
}

/**
 * DOM 标记用的 CSS 变量（随所在的主题作用域解析，换主题时自动更新）：
 * accent：选中的照片相框；column：夜色里城市名旁的打卡数
 */
export const litVars = (tone: LitTheme) =>
  tone === 'love'
    ? { accent: 'var(--color-pink-600)', column: 'var(--color-pink-600)' }
    : { accent: 'var(--color-brand-600)', column: 'var(--route-actual)' }
