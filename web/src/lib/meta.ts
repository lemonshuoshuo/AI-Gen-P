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

export const categories: Record<Category, { label: string; color: string; icon: LucideIcon }> = {
  scenic: { label: '景点', color: '#6fa58e', icon: Landmark },
  food: { label: '美食', color: '#d98a55', icon: UtensilsCrossed },
  hotel: { label: '住宿', color: '#8093c4', icon: Bed },
  shopping: { label: '购物', color: '#c47d90', icon: ShoppingBag },
  transport: { label: '交通', color: '#6f9aa6', icon: TrainFront },
  entertainment: { label: '娱乐', color: '#9a8cc0', icon: Clapperboard },
  other: { label: '其他', color: '#948e84', icon: MapPin },
}
export const categoryList = Object.keys(categories) as Category[]
export const categoryOf = (c: string | undefined) => categories[(c as Category) || 'other'] ?? categories.other

/** 评价：玉青 / 赭黄 / 朱砂；mark 是排版用的小符号（不用 emoji） */
export const verdicts: Record<Exclude<Verdict, ''>, { label: string; emoji: string; mark: string; cls: string; color: string }> = {
  recommend: { label: '推荐', emoji: '', mark: '◎', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', color: '#7aac97' },
  neutral: { label: '一般', emoji: '', mark: '○', cls: 'bg-amber-50 text-amber-700 ring-amber-200', color: '#cfa35e' },
  avoid: { label: '踩雷', emoji: '', mark: '✕', cls: 'bg-red-50 text-red-700 ring-red-200', color: '#de7c5d' },
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

export const levelColors = ['#948e84', '#7aac97', '#7aa1ab', '#988bb3', '#cfa35e', '#de7c5d']
export const levelColor = (lv: number) => levelColors[Math.min(Math.max(lv, 1), 6) - 1]
