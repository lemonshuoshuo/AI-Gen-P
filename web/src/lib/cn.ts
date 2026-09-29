import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// 调用方 className 覆盖组件默认类；登记 index.css 自定义 utility 与主题令牌，避免被误判为颜色类而被合并掉
// （如 text-h1 / text-display-xl 是字号，不能被后面的 text-ink-900 顶掉）
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ['card', 'float'],
      text: ['hero', 'h1', 'h2', 'card', 'body', 'small', 'label', 'num'],
      radius: ['btn', 'field', 'card', 'option', 'modal', 'image'],
      font: ['display', 'num', 'label', 'prose'],
      leading: ['body'],
    },
    classGroups: {
      'bg-image': [{ bg: ['brand-gradient', 'love-gradient', 'night'] }],
      'font-size': [{ text: ['display-xl', 'display-lg', 'display-md'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
