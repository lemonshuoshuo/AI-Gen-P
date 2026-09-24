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
import type { Category, Phase, Verdict, Visibility, WaypointStatus } from '@/api/types'

export const categories: Record<Category, { label: string; color: string; icon: LucideIcon }> = {
  scenic: { label: '景点', color: '#10b981', icon: Landmark },
  food: { label: '美食', color: '#f97316', icon: UtensilsCrossed },
  hotel: { label: '住宿', color: '#6366f1', icon: Bed },
  shopping: { label: '购物', color: '#ec4899', icon: ShoppingBag },
  transport: { label: '交通', color: '#0ea5e9', icon: TrainFront },
  entertainment: { label: '娱乐', color: '#a855f7', icon: Clapperboard },
  other: { label: '其他', color: '#64748b', icon: MapPin },
}
export const categoryList = Object.keys(categories) as Category[]
export const categoryOf = (c: string | undefined) => categories[(c as Category) || 'other'] ?? categories.other

export const verdicts: Record<Exclude<Verdict, ''>, { label: string; emoji: string; cls: string; color: string }> = {
  recommend: { label: '推荐', emoji: '👍', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', color: '#10b981' },
  neutral: { label: '一般', emoji: '😐', cls: 'bg-amber-50 text-amber-700 ring-amber-200', color: '#f59e0b' },
  avoid: { label: '踩雷', emoji: '⚠️', cls: 'bg-red-50 text-red-700 ring-red-200', color: '#ef4444' },
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

export const waypointStatus: Record<WaypointStatus, { label: string; cls: string }> = {
  todo: { label: '待前往', cls: 'bg-sky-50 text-sky-700' },
  visited: { label: '已打卡', cls: 'bg-emerald-50 text-emerald-700' },
  skipped: { label: '已跳过', cls: 'bg-ink-100 text-ink-500' },
}

export const PhotoIcon = Camera

export const levelColors = ['#94a3b8', '#22c55e', '#0ea5e9', '#8b5cf6', '#f59e0b', '#ef4444']
export const levelColor = (lv: number) => levelColors[Math.min(Math.max(lv, 1), 6) - 1]
