import { Link } from 'react-router'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'

// 手机上链接行高 40px，方便点按
const linkCls = 'inline-flex h-10 items-center transition-colors duration-300 hover:text-ink-900 md:h-auto'

/**
 * 页脚：超大字标、一行安静的链接（用户协议 / 隐私政策），以及管理员填写的 ICP 备案号和公安联网备案号
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
    <>
      <Link to="/legal/terms" className={linkCls}>
        用户协议
      </Link>
      <Link to="/legal/privacy" className={linkCls}>
        隐私政策
      </Link>
    </>
  )
  const beian = (icp || police) && (
    <>
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
    </>
  )

  if (compact)
    return (
      <footer className={cn('w-full space-y-2 text-center text-[12px] tracking-[0.08em] text-ink-400', className)}>
        <p className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">{legal}</p>
        {beian && <p className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">{beian}</p>}
        <p>
          <span className="font-num">© {year}</span> {name}
        </p>
      </footer>
    )

  return (
    // w-full：在布局的纵向 flex 里 mx-auto 会让页脚收缩成内容宽度
    <footer className={cn('mx-auto w-full max-w-[90rem] px-4 md:px-8', className)}>
      <div className="grid gap-y-8 border-t border-ink-200 pt-4 pb-10 text-[13px] md:grid-cols-12 md:gap-x-8 md:pb-16">
        {/* 说明文字对：亮 + 灰 */}
        <p className="md:col-span-5">
          <span className="block text-ink-900">{name} · 旅迹</span>
          <span className="caption block">记录每一次出发，把走过的地方都点亮。</span>
        </p>
        <nav aria-label="站点信息" className="flex flex-wrap gap-x-6 gap-y-2 text-ink-500 md:col-span-4">
          {legal}
          {beian}
        </nav>
        <p className="font-num text-ink-400 md:col-span-3 md:text-right">
          © {year} {name}
        </p>
      </div>
      {/* 超大字标：几乎占满整行宽度，字母下伸部分被页面底边轻轻裁掉 */}
      <div aria-hidden className="overflow-hidden select-none">
        <p
          className="font-display -mb-[0.08em] text-center leading-[0.95] tracking-[-0.02em] whitespace-nowrap text-ink-900"
          style={{ fontSize: `min(${Math.min(21, 150 / Math.max(name.length, 1))}vw, ${Math.min(19, 133 / Math.max(name.length, 1))}rem)` }}
        >
          {name}
        </p>
      </div>
    </footer>
  )
}
