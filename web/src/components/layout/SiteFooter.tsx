import { Link } from 'react-router'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'

const linkCls = 'transition hover:text-ink-700'

/**
 * 页脚：版权、用户协议 / 隐私政策，以及管理员填写的 ICP 备案号和公安联网备案号
 * （工信部要求在网站首页底部显示备案号并链接到备案管理系统）。compact 用于登录页等没有边框和留白的场合
 */
export function SiteFooter({ className, compact }: { className?: string; compact?: boolean }) {
  const { data: site } = useSite()
  const icp = site?.icp_beian?.trim() ?? ''
  const police = site?.police_beian?.trim() ?? ''
  // 公安备案号形如「京公网安备11010502030143号」：链接到全国互联网安全管理服务平台的备案查询
  const policeCode = police.match(/\d{6,}/)?.[0]
  const policeUrl = policeCode ? `https://beian.mps.gov.cn/#/query/webSearch?code=${policeCode}` : 'https://beian.mps.gov.cn/'
  return (
    <footer
      className={cn(
        // w-full：在布局的纵向 flex 里 mx-auto 会让页脚收缩成内容宽度
        'mx-auto w-full max-w-6xl text-center text-xs leading-relaxed text-ink-400',
        !compact && 'border-t border-ink-100 px-4 py-6',
        className,
      )}
    >
      <p className="flex flex-wrap items-center justify-center gap-x-2">
        <span>
          © {new Date().getFullYear()} {site?.name || 'TripHub'}
        </span>
        <span aria-hidden="true">·</span>
        <Link to="/legal/terms" className={linkCls}>
          用户协议
        </Link>
        <span aria-hidden="true">·</span>
        <Link to="/legal/privacy" className={linkCls}>
          隐私政策
        </Link>
      </p>
      {(icp || police) && (
        <p className="mt-1 flex flex-wrap items-center justify-center gap-x-4">
          {icp && (
            <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className={linkCls}>
              {icp}
            </a>
          )}
          {police && (
            <a href={policeUrl} target="_blank" rel="noopener noreferrer" className={linkCls}>
              {police}
            </a>
          )}
        </p>
      )}
    </footer>
  )
}
