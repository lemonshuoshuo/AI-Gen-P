import { useEffect } from 'react'
import { useSite } from './useSite'

/**
 * 页面标题：浏览器标签页、历史记录，以及微信内置浏览器转发时的卡片标题（带上管理员设置的站点名称）。
 * 在页面组件里调用（且在提前 return 之前）；不要放在布局组件里，子组件的 effect 先执行，布局会把页面标题覆盖掉
 */
export function useDocumentTitle(title?: string | null) {
  const { data: site } = useSite()
  const name = site?.name || 'TripHub'
  useEffect(() => {
    document.title = title ? `${title} · ${name}` : `${name} · 旅行足迹`
    return () => {
      document.title = `${name} · 旅行足迹`
    }
  }, [title, name])
}
