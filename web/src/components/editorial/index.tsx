// 「夜航」版式积木：细线区块头、页头、文字筛选、注记、细线邮戳、滚动淡入
// 只给发现 / 社区相关页面用，样式全部取自 index.css 的令牌
import { useEffect, useId, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/cn'

/* ---------------- 细线标签行：一条 border-t，下面左侧 eyebrow + 灰色计数，右侧操作 ---------------- */
export function LabelRow({
  label,
  count,
  extra,
  className,
  id,
}: {
  label: ReactNode
  /** 灰色计数 / 说明，紧跟在标签后面 */
  count?: ReactNode
  extra?: ReactNode
  className?: string
  id?: string
}) {
  return (
    <div className={cn('flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-ink-200 pt-3 pb-1', className)}>
      {/* div 而不是 p：标签里可能放导航（面包屑） */}
      <div id={id} className="flex min-w-0 items-baseline gap-3">
        <span className="eyebrow !text-ink-800">{label}</span>
        {count != null && count !== '' && <span className="font-num text-[14px] leading-none text-ink-400">{count}</span>}
      </div>
      {extra}
    </div>
  )
}

/* ---------------- 页头：细线标签行 + 大号宋体 H1，右侧一句导语和操作 ---------------- */
export function PageHead({
  eyebrow,
  title,
  dek,
  actions,
  meta,
  className,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  dek?: ReactNode
  actions?: ReactNode
  /** 标签行右侧的灰色小字（如总数） */
  meta?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('animate-slide-up', className)}>
      {eyebrow && <LabelRow label={eyebrow} extra={meta && <span className="font-num text-[13px] text-ink-400">{meta}</span>} />}
      <div className="mt-10 grid gap-x-8 gap-y-6 md:mt-16 lg:grid-cols-12 lg:items-end">
        <h1 className="text-display-lg font-normal [font-variant-numeric:lining-nums] max-sm:text-[3.25rem] lg:col-span-7">{title}</h1>
        {(dek || actions) && (
          <div className="flex flex-col items-start gap-6 lg:col-span-4 lg:col-start-9 lg:pb-3">
            {dek && <p className="max-w-sm text-[14.5px] leading-[1.8] text-pretty text-ink-500">{dek}</p>}
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
        )}
      </div>
    </header>
  )
}

/* ---------------- 区块头（Exemplar 式）：细线 + 标签行，再往下是大号标题 ---------------- */
export function SectionHead({
  eyebrow,
  count,
  title,
  extra,
  className,
  titleClassName,
  id,
}: {
  eyebrow?: ReactNode
  count?: ReactNode
  title?: ReactNode
  extra?: ReactNode
  className?: string
  titleClassName?: string
  id?: string
}) {
  return (
    <div className={className}>
      <LabelRow label={eyebrow} count={count} extra={extra} />
      {title && (
        <h2 id={id} className={cn("text-display-md mt-8 [font-feature-settings:'halt'] [font-variant-numeric:lining-nums] md:mt-12", titleClassName)}>
          {title}
        </h2>
      )}
    </div>
  )
}

/* ---------------- 文字筛选：「全部 / 游记 / 路线攻略」，当前项象牙白下划线 ---------------- */
export function FilterLinks<T extends string>({
  value,
  onChange,
  options,
  label,
  separator = true,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  /** 组名：显示为 eyebrow，同时作为读屏的分组名称 */
  label?: string
  /** 选项之间的斜线；false 时只用间距分隔（选项多、会折行时） */
  separator?: boolean
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap items-center text-[13.5px]', !separator && 'gap-x-3', className)}>
      {label && (
        <span aria-hidden className="eyebrow mr-2">
          {label}
        </span>
      )}
      {options.map((o, i) => {
        const active = o.value === value
        return (
          // 斜线和它后面的选项是一个整体：折行时斜线只会出现在行首，不会孤零零挂在行尾
          <span key={o.value || '_all'} className="inline-flex items-center">
            {separator && i > 0 && (
              <span aria-hidden className="text-ink-300">
                /
              </span>
            )}
            <button
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.value)}
              className={cn(
                'inline-flex h-10 items-center rounded-sm px-2 whitespace-nowrap tracking-wide transition-colors duration-300 md:h-8',
                active
                  ? 'text-ink-900 underline decoration-ink-900 decoration-1 underline-offset-[7px]'
                  : 'text-ink-400 hover:text-ink-900',
              )}
            >
              {o.label}
            </button>
          </span>
        )
      })}
    </div>
  )
}

/* ---------------- 空状态：细线下左对齐的一行宋体 + 灰字说明 + 文字链接（不用图标和胶囊按钮） ---------------- */
export function EmptyNote({
  title,
  desc,
  action,
  className,
}: {
  title: ReactNode
  desc?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('animate-fade-in max-w-2xl', className)}>
      <p className="text-display-md text-ink-900 [font-feature-settings:'halt'] [font-variant-numeric:lining-nums]">{title}</p>
      {desc && <p className="caption mt-3 max-w-md text-[14px] leading-relaxed text-pretty">{desc}</p>}
      {action && <div className="mt-5 flex flex-wrap items-center gap-x-8">{action}</div>}
    </div>
  )
}

/** 文字 + →：安静的链接式操作（手机上 40px 高） */
export function TextLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link
      to={to}
      className={cn(
        'group inline-flex min-h-10 items-center gap-2 text-[13.5px] text-ink-900 underline decoration-ink-300 underline-offset-[6px] transition-colors duration-300 hover:decoration-ink-900',
        className,
      )}
    >
      {children}
      <span aria-hidden className="no-underline transition-transform duration-300 group-hover:translate-x-0.5">
        →
      </span>
    </Link>
  )
}

/* ---------------- 注记：左侧一条细线的说明文字（代替彩色底的提示框） ---------------- */
const noteTone = {
  ink: 'border-ink-400 text-ink-600',
  caution: 'border-brand-500 text-ink-700',
  amber: 'border-amber-500 text-ink-700',
}
export function Note({
  tone = 'ink',
  label,
  children,
  className,
}: {
  tone?: keyof typeof noteTone
  label?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('border-l py-1 pl-4 text-[13.5px] leading-relaxed', noteTone[tone], className)}>
      {label && (
        <span className={cn('eyebrow mr-2', tone === 'caution' ? '!text-brand-600' : tone === 'amber' && '!text-amber-600')}>
          {label}
        </span>
      )}
      {children}
    </div>
  )
}

/* ---------------- 细线邮戳：双圈 + 环形小字 + 中间 Cormorant 数字 ---------------- */
export function Postmark({
  value,
  unit,
  ring,
  ringClassName,
  className,
  waves,
}: {
  value: string
  unit: string
  /** 沿外圈排的一行小字，自动撑满一圈 */
  ring: string
  /** 环形小字的类名：窄小的邮戳上可以按容器宽度隐藏 */
  ringClassName?: string
  className?: string
  /** 邮戳左侧的波浪注销线 */
  waves?: boolean
}) {
  const id = `pm${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const r = 36.5
  const circ = 2 * Math.PI * r
  return (
    <svg
      viewBox={waves ? '-62 0 162 100' : '0 0 100 100'}
      className={className}
      aria-hidden
      fill="none"
      stroke="currentColor"
    >
      <defs>
        <path id={id} d={`M ${50 - r} 50 a ${r} ${r} 0 1 1 ${2 * r} 0 a ${r} ${r} 0 1 1 ${-2 * r} 0`} />
      </defs>
      {waves &&
        [34, 44, 54, 64].map((y) => (
          <path key={y} d={`M -60 ${y} q 7.5 -5 15 0 t 15 0 t 15 0 t 15 0`} strokeWidth={0.6} strokeLinecap="round" />
        ))}
      <circle cx={50} cy={50} r={47} strokeWidth={0.7} />
      <circle cx={50} cy={50} r={31} strokeWidth={0.5} />
      <text
        className={ringClassName}
        fill="currentColor"
        stroke="none"
        fontFamily="var(--font-sans)"
        fontSize={5.6}
        fontWeight={500}
        letterSpacing={0.6}
        style={{ textTransform: 'uppercase' }}
      >
        <textPath href={`#${id}`} textLength={circ - 5} lengthAdjust="spacing">
          {ring}
        </textPath>
      </text>
      <text
        x={50}
        y={55}
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="var(--font-num)"
        fontSize={value.length > 3 ? 17 : 23}
        fontWeight={300}
        style={{ fontVariantNumeric: 'lining-nums' }}
      >
        {value}
      </text>
      <line x1={40} x2={60} y1={61.5} y2={61.5} strokeWidth={0.4} />
      <text x={50} y={70} textAnchor="middle" fill="currentColor" stroke="none" fontFamily="var(--font-sans)" fontSize={5} letterSpacing={1.4}>
        {unit}
      </text>
    </svg>
  )
}

/* ---------------- 滚动淡入：进入视口时缓慢上移显现（只一次；减少动效时直接显示） ---------------- */
export function Reveal({
  as: Tag = 'div',
  delay = 0,
  className,
  children,
  ...rest
}: {
  as?: ElementType
  /** 毫秒，同一组元素错开 60–80ms */
  delay?: number
  className?: string
  children?: ReactNode
  id?: string
  'aria-labelledby'?: string
  'aria-label'?: string
}) {
  const ref = useRef<HTMLElement>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setShown(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true)
          io.disconnect()
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const style: CSSProperties | undefined = delay ? { transitionDelay: `${delay}ms` } : undefined
  return (
    <Tag
      ref={ref}
      style={style}
      data-shown={shown || undefined}
      className={cn(
        'translate-y-6 opacity-0 transition-[opacity,translate] duration-[900ms] ease-out-expo data-[shown]:translate-y-0 data-[shown]:opacity-100 motion-reduce:translate-y-0 motion-reduce:opacity-100 motion-reduce:transition-none',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  )
}

const ETHNIC = '(?:藏|彝|白|傣|苗|侗|土家|布依|壮|哈尼|景颇|傈僳|朝鲜|回|蒙古|哈萨克|柯尔克孜|羌|黎|瑶|畲|纳西|怒|独龙)族?'
const PREFECTURE = new RegExp(`^(.+?)(?:${ETHNIC})+自治[州县]$`)

/** 城市名的短写（封面大字、列表小字）：杭州市 → 杭州，大理白族自治州 → 大理，稻城县 → 稻城 */
export function cityShort(name: string) {
  const m = name.match(PREFECTURE)
  if (m && m[1].length >= 2) return m[1]
  const s = name.replace(/(特别行政区|地区|市|县|盟)$/, '')
  return s.length >= 2 ? s : name
}

/** 两位序号：1 → 01 */
export const pad2 = (n: number) => String(n).padStart(2, '0')

/** 列表底部「加载更多」：细线之间一个细线胶囊 */
export function MoreButton({
  onClick,
  loading,
  children = '加载更多',
  className,
}: {
  onClick: () => void
  loading?: boolean
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-5 pt-16', className)}>
      <span className="h-px flex-1 bg-ink-200" />
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="inline-flex h-10 items-center gap-2 rounded-full border border-ink-900/20 px-6 text-[13px] tracking-[0.08em] text-ink-800 transition-colors duration-300 hover:border-ink-900/60 hover:text-ink-900 disabled:opacity-50"
      >
        {loading ? '加载中…' : children}
      </button>
      <span className="h-px flex-1 bg-ink-200" />
    </div>
  )
}
