import { lazy, Suspense, type ReactNode } from 'react'
import type { Components } from 'react-markdown'

// Markdown 渲染库较大：用到时才加载（游记、用户协议等），不阻塞页面其它部分
const ReactMarkdown = lazy(() => import('react-markdown'))

// 站外链接：http(s)://，以及省略协议（//example.com）等实际指向其他网站的写法
function isExternal(href: string) {
  if (/^https?:\/\//i.test(href)) return true
  try {
    const u = new URL(href, window.location.href)
    return /^https?:$/.test(u.protocol) && u.origin !== window.location.origin
  } catch {
    return false
  }
}

const components: Components = {
  // 只显示本站上传的图片（/uploads/…，见 docs/API.md「内容安全」）：外链图片会绕过上传审核，还能用来追踪读者
  img: ({ src, alt }) => (typeof src === 'string' && src.startsWith('/uploads/') ? <img src={src} alt={alt ?? ''} loading="lazy" /> : null),
  // 用户内容里的站外链接：新标签页打开，不传递搜索权重（nofollow ugc），不带 opener 和 Referer。
  // javascript: 等危险链接已被 react-markdown 默认的 urlTransform 去掉
  a: ({ href, title, children }) =>
    typeof href === 'string' && isExternal(href) ? (
      <a href={href} title={title} target="_blank" rel="nofollow ugc noopener noreferrer">
        {children}
      </a>
    ) : (
      <a href={href} title={title}>
        {children}
      </a>
    ),
}

export function Markdown({ children, fallback = null }: { children: string; fallback?: ReactNode }) {
  return (
    <Suspense fallback={fallback}>
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </Suspense>
  )
}
