import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { Markdown } from '@/components/Markdown'
import { Empty, LoadError, PageLoader, Spinner } from '@/components/ui'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

type LegalDoc = 'terms' | 'privacy'
const legalTitle: Record<LegalDoc, string> = { terms: '用户协议', privacy: '隐私政策' }
const isLegalDoc = (d: string | undefined): d is LegalDoc => d === 'terms' || d === 'privacy'

/** 用户协议 / 隐私政策（管理员在后台填写，未填写时为服务端内置模板）；站点页脚（含登录 / 注册页）链接到这里 */
export default function LegalPage() {
  const { doc } = useParams()
  const valid = isLegalDoc(doc)
  // 与登录页 LegalModal 共用缓存
  const q = useQuery({
    queryKey: ['legal', doc],
    queryFn: () => api.legal(doc as LegalDoc),
    enabled: valid,
    staleTime: 10 * 60_000,
  })
  useDocumentTitle(valid ? legalTitle[doc] : '页面不存在')

  if (!valid) return <Empty className="min-h-[60vh]" title="页面不存在" />
  if (q.isLoading) return <PageLoader />
  if (q.isError) return <LoadError className="min-h-[60vh]" error={q.error} onRetry={() => q.refetch()} />
  const other: LegalDoc = doc === 'terms' ? 'privacy' : 'terms'
  return (
    <article className="mx-auto max-w-2xl px-4 pt-8 pb-16 md:px-6 md:pt-12">
      <div className="flex items-center justify-between gap-4 pb-2.5">
        <p className="eyebrow">Legal · {legalTitle[doc]}</p>
        <Link to={`/legal/${other}`} className="eyebrow transition-colors hover:!text-ink-900">
          {legalTitle[other]} →
        </Link>
      </div>
      <div className="border-t-2 border-ink-900 pt-8">
        {/* 正文以一级标题开头：去掉第一个元素的上边距（.prose-trip 的样式不在 Tailwind 层里，需要 !） */}
        <div className="prose-trip text-[15px] [&>:first-child]:!mt-0 [&>h1:first-child]:text-[30px] [&>h1:first-child]:leading-tight md:[&>h1:first-child]:text-[36px]">
          <Markdown fallback={<Spinner />}>{q.data?.content ?? ''}</Markdown>
        </div>
      </div>
      <p className="mt-12 border-t border-ink-200 pt-4 text-xs text-ink-400">
        另见
        <Link to={`/legal/${other}`} className="mx-0.5 text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-900">
          《{legalTitle[other]}》
        </Link>
        。
      </p>
    </article>
  )
}
