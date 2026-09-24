import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// 调用方 className 覆盖组件默认类；登记 index.css 自定义 utility，避免被误判为颜色类而被合并掉
const twMerge = extendTailwindMerge({
  extend: {
    theme: { shadow: ['card', 'float'] },
    classGroups: { 'bg-image': [{ bg: ['brand-gradient', 'love-gradient', 'night'] }] },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
