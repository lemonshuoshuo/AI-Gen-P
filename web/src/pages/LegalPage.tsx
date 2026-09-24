import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { Markdown } from '@/components/Markdown'
import { Card, Empty, LoadError, PageLoader, Spinner } from '@/components/ui'
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
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <Card className="p-5 sm:p-8">
        {/* 正文以一级标题开头：去掉第一个元素的上边距（.prose-trip 的样式不在 Tailwind 层里，需要 !） */}
        <div className="prose-trip text-sm text-ink-700 [&>:first-child]:!mt-0">
          <Markdown fallback={<Spinner />}>{q.data?.content ?? ''}</Markdown>
        </div>
      </Card>
    </div>
  )
}
