import {
  Bed,
  Camera,
  Clapperboard,
  Landmark,
  MapPin,
  ShoppingBag,
  TrainFront,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react'
import type { Category, Phase, TripStatus, Verdict, Visibility, WaypointStatus } from '@/api/types'
import { cssColor } from './color'

/**
 * 分类、评价、等级的颜色都是设计令牌，随主题与深浅色变化：
 * - token：CSS 变量名（如 --color-emerald-600）；
 * - css：var(token)，DOM 样式里用它（切换主题自动跟着变，不用重新渲染）；
 * - color：按当前主题解析好的 rgba()，只给画布 / WebGL 图层用（每次读取都按当前主题解析，主题变化后重新读取）。
 */
export interface Tone {
  token: string
  css: string
  readonly color: string
}

function tone<T extends object>(token: string, rest: T): T & Tone {
  return Object.defineProperty({ ...rest, token, css: `var(${token})` }, 'color', {
    get: () => cssColor(token),
    enumerable: true,
  }) as T & Tone
}

// 与公共组件 CategoryChip 的图标颜色一致：可读的 600 档矿物色
export const categories: Record<Category, { label: string; icon: LucideIcon } & Tone> = {
  scenic: tone('--color-emerald-600', { label: '景点', icon: Landmark }),
  food: tone('--color-orange-600', { label: '美食', icon: UtensilsCrossed }),
  hotel: tone('--color-indigo-500', { label: '住宿', icon: Bed }),
  shopping: tone('--color-pink-600', { label: '购物', icon: ShoppingBag }),
  transport: tone('--color-sky-600', { label: '交通', icon: TrainFront }),
  entertainment: tone('--color-violet-600', { label: '娱乐', icon: Clapperboard }),
  other: tone('--color-ink-400', { label: '其他', icon: MapPin }),
}
export const categoryList = Object.keys(categories) as Category[]
export const categoryOf = (c: string | undefined) => categories[(c as Category) || 'other'] ?? categories.other

/**
 * 评价：推荐 = 玉青、一般 = 赭黄、踩雷 = 红；mark 是排版用的小符号（不用 emoji）。
 * cls：浅底徽章（100 档底 + 700 档字）；text：纸面上的文字色（600 档，≥ 5:1）；
 * solid：选中的实心 chip（600 档底 + 纸色字，深浅色下都 ≥ 5:1）
 */
export const verdicts: Record<Exclude<Verdict, ''>, { label: string; emoji: string; mark: string; cls: string; text: string; solid: string } & Tone> = {
  recommend: tone('--color-emerald-600', {
    label: '推荐',
    emoji: '',
    mark: '◎',
    cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    text: 'text-emerald-600',
    solid: 'border-emerald-600 bg-emerald-600 text-paper',
  }),
  neutral: tone('--color-amber-600', {
    label: '一般',
    emoji: '',
    mark: '○',
    cls: 'bg-amber-50 text-amber-700 ring-amber-200',
    text: 'text-amber-600',
    solid: 'border-amber-600 bg-amber-600 text-paper',
  }),
  avoid: tone('--color-red-600', {
    label: '踩雷',
    emoji: '',
    mark: '✕',
    cls: 'bg-red-50 text-red-700 ring-red-200',
    text: 'text-red-600',
    solid: 'border-red-600 bg-red-600 text-paper',
  }),
}

export const phases: Record<Phase, { label: string; cls: string }> = {
  planning: { label: '规划中', cls: 'bg-sky-50 text-sky-700' },
  ongoing: { label: '旅行中', cls: 'bg-emerald-50 text-emerald-700' },
  finished: { label: '已完成', cls: 'bg-ink-100 text-ink-700' },
}

export const visibilities: Record<Visibility, { label: string; desc: string }> = {
  private: { label: '私密', desc: '仅自己和共同作者可见' },
  unlisted: { label: '链接可见', desc: '拿到分享链接的人可以看，不出现在广场' },
  public: { label: '公开', desc: '所有人可见，会出现在发现广场' },
}

/** 旅程审核状态：pending（公开待审核）和 hidden（被管理员隐藏）只有成员和管理员能看到 */
export const tripStatuses: Record<TripStatus, { label: string; cls: string }> = {
  normal: { label: '正常', cls: 'bg-emerald-50 text-emerald-700' },
  pending: { label: '审核中', cls: 'bg-amber-50 text-amber-700' },
  hidden: { label: '已隐藏', cls: 'bg-red-50 text-red-600' },
}

export const waypointStatus: Record<WaypointStatus, { label: string; cls: string }> = {
  todo: { label: '待前往', cls: 'bg-sky-50 text-sky-700' },
  visited: { label: '已打卡', cls: 'bg-emerald-50 text-emerald-700' },
  skipped: { label: '已跳过', cls: 'bg-ink-100 text-ink-500' },
}

export const PhotoIcon = Camera

/** 等级颜色（Lv.1 → Lv.6）：与公共组件 LevelBadge 一致的 600 档矿物色；DOM 里用 var(levelTokens[i]) */
export const levelTokens = ['--color-ink-500', '--color-emerald-600', '--color-sky-600', '--color-violet-600', '--color-amber-600', '--color-brand-600'] as const
const levelIndex = (lv: number) => Math.min(Math.max(lv, 1), levelTokens.length) - 1
/** 按当前主题解析好的等级颜色（rgba，画布用），每次读取都按当前主题解析 */
export const levelColors: readonly string[] = Object.defineProperties(
  [] as string[],
  Object.fromEntries(levelTokens.map((t, i) => [i, { get: () => cssColor(t), enumerable: true }])),
)
export const levelColor = (lv: number) => cssColor(levelTokens[levelIndex(lv)])
