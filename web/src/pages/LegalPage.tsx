import { Link, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api'
import { LabelRow } from '@/components/editorial'
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
    <article className="mx-auto max-w-[90rem] px-4 pt-12 pb-24 md:px-8 md:pt-20 md:pb-32">
      <LabelRow
        label={`Legal · ${legalTitle[doc]}`}
        extra={
          <Link to={`/legal/${other}`} className="inline-flex h-10 items-center text-[13px] text-ink-500 transition-colors hover:text-ink-900 md:h-8">
            {legalTitle[other]} →
          </Link>
        }
      />
      <div className="mt-12 grid gap-x-8 gap-y-10 md:mt-20 lg:grid-cols-12">
        {/* 左栏：说明文字对 + 另一份文件（宽屏吸顶） */}
        <aside className="lg:sticky lg:top-24 lg:col-span-4 lg:self-start">
          <p className="text-[13px] text-ink-900">{legalTitle[doc]}</p>
          <p className="caption">使用本站前请仔细阅读</p>
          <p className="caption mt-6">
            另见
            <Link to={`/legal/${other}`} className="mx-0.5 text-ink-900 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-900">
              《{legalTitle[other]}》
            </Link>
          </p>
        </aside>
        {/* 正文以一级标题开头：一级标题放大成展示字号，去掉上边距（.prose-trip 的样式不在 Tailwind 层里，需要 !） */}
        <div className="animate-slide-up prose-trip max-w-2xl text-[15px] lg:col-span-8 [&>:first-child]:!mt-0 [&>h1:first-child]:!mb-12 [&>h1:first-child]:!text-[clamp(2.25rem,5.4vw,4.25rem)] [&>h1:first-child]:!leading-[1.05] [&>h1:first-child]:!font-normal [&_h2]:!mt-12 [&_h2]:!font-normal">
          <Markdown fallback={<Spinner />}>{q.data?.content ?? ''}</Markdown>
        </div>
      </div>
    </article>
  )
}
