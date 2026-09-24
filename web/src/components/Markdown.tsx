import { lazy, Suspense, type ReactNode } from 'react'
import type { Components } from 'react-markdown'

// Markdown 渲染库较大：用到时才加载（游记、用户协议等），不阻塞页面其它部分
const ReactMarkdown = lazy(() => import('react-markdown'))

// 只显示本站上传的图片（/uploads/…，见 docs/API.md「内容安全」）：外链图片会绕过上传审核，还能用来追踪读者
const components: Components = {
  img: ({ src, alt }) => (typeof src === 'string' && src.startsWith('/uploads/') ? <img src={src} alt={alt ?? ''} loading="lazy" /> : null),
}

export function Markdown({ children, fallback = null }: { children: string; fallback?: ReactNode }) {
  return (
    <Suspense fallback={fallback}>
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </Suspense>
  )
}
