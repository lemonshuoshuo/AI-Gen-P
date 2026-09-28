import { Link } from 'react-router'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'

const linkCls = 'transition-colors hover:text-ink-900'

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
  const name = site?.name || 'TripHub'
  const year = new Date().getFullYear()

  const legal = (
    <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
      <Link to="/legal/terms" className={linkCls}>
        用户协议
      </Link>
      <span aria-hidden className="text-ink-300">
        /
      </span>
      <Link to="/legal/privacy" className={linkCls}>
        隐私政策
      </Link>
    </p>
  )
  const beian = (icp || police) && (
    <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 md:justify-start">
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
  )

  if (compact)
    return (
      <footer className={cn('w-full space-y-1.5 text-center text-[11.5px] tracking-[0.12em] text-ink-400', className)}>
        <p>
          <span className="font-num">©</span> <span className="font-num">{year}</span> {name}
        </p>
        {legal}
        {beian}
      </footer>
    )

  return (
    // w-full：在布局的纵向 flex 里 mx-auto 会让页脚收缩成内容宽度
    <footer className={cn('mx-auto w-full max-w-6xl px-4 md:px-6', className)}>
      <div className="flex flex-col items-center gap-3 border-t border-ink-200 py-7 text-[11.5px] tracking-[0.12em] text-ink-400 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col items-center gap-1.5 md:items-start">
          <p className="flex items-baseline gap-2">
            <span className="font-num text-[14px] tracking-normal text-ink-700 italic">{name}</span>
            <span className="eyebrow !tracking-[0.3em]">旅迹 · 手账</span>
          </p>
          {beian}
        </div>
        <div className="flex flex-col items-center gap-1 md:items-end">
          {legal}
          <p>
            <span className="font-num">© {year}</span> {name} · 记录每一次出发
          </p>
        </div>
      </div>
    </footer>
  )
}
