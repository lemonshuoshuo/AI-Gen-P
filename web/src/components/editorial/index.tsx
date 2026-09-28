// 「旅行手账」版式积木：页头、区块标题、文字筛选、注记、邮戳、矿物色封面色板
// 只给发现 / 社区相关页面用（W1），样式全部取自 index.css 的令牌
import { Fragment, useId, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

/* ---------------- 页头：eyebrow + 宋体 H1 + 一句副标题，右侧放操作 ---------------- */
export function PageHead({
  eyebrow,
  title,
  dek,
  actions,
  className,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  dek?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-x-8 gap-y-5', className)}>
      <div className="min-w-0 max-w-2xl">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="mt-2.5 text-[28px] leading-[1.2] md:text-[38px]">{title}</h1>
        {dek && <p className="mt-2.5 text-[14.5px] leading-relaxed text-ink-500">{dek}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** 报头式双线：上粗下细 */
export function DoubleRule({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('space-y-[3px]', className)}>
      <div className="h-[2px] bg-ink-900" />
      <div className="h-px bg-ink-900" />
    </div>
  )
}

/* ---------------- 区块标题：eyebrow + H2，底部细线；右侧放「更多」或筛选 ---------------- */
export function SectionHead({
  eyebrow,
  title,
  extra,
  className,
  id,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  extra?: ReactNode
  className?: string
  id?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-ink-200 pb-3', className)}>
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2 id={id} className="mt-1 text-[20px] leading-snug md:text-[22px]">
          {title}
        </h2>
      </div>
      {extra}
    </div>
  )
}

/* ---------------- 文字筛选：「全部 / 游记 / 路线攻略」，当前项墨色下划线 ---------------- */
export function FilterLinks<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  /** 组名：显示为 eyebrow，同时作为读屏的分组名称 */
  label?: string
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap items-center gap-y-1 text-[13.5px]', className)}>
      {label && (
        <span aria-hidden className="eyebrow mr-2.5">
          {label}
        </span>
      )}
      {options.map((o, i) => {
        const active = o.value === value
        return (
          <Fragment key={o.value || '_all'}>
            {i > 0 && (
              <span aria-hidden className="px-0.5 text-ink-300">
                /
              </span>
            )}
            <button
              type="button"
              aria-pressed={active}
              onClick={() => onChange(o.value)}
              className={cn(
                'rounded-sm px-1.5 py-1 whitespace-nowrap tracking-wide transition-colors',
                active
                  ? 'text-ink-900 underline decoration-ink-900 decoration-[1.5px] underline-offset-[7px]'
                  : 'text-ink-400 hover:text-ink-900',
              )}
            >
              {o.label}
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}

/* ---------------- 注记：左侧一条色线的说明文字（代替彩色底的提示框） ---------------- */
const noteTone = {
  ink: 'border-ink-900 text-ink-600',
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
    <div className={cn('border-l-2 bg-white/55 py-2.5 pr-3 pl-3.5 text-[13.5px] leading-relaxed', noteTone[tone], className)}>
      {label && (
        <span className={cn('eyebrow mr-2', tone === 'caution' ? '!text-brand-600' : tone === 'amber' && '!text-amber-700')}>
          {label}
        </span>
      )}
      {children}
    </div>
  )
}

/* ---------------- 邮戳：双圈 + 环形小字 + 中间大号 Cormorant 数字 ---------------- */
export function Postmark({
  value,
  unit,
  ring,
  className,
  waves,
}: {
  value: string
  unit: string
  /** 沿外圈排的一行小字，自动撑满一圈 */
  ring: string
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
          <path
            key={y}
            d={`M -60 ${y} q 7.5 -5 15 0 t 15 0 t 15 0 t 15 0`}
            strokeWidth={1.1}
            strokeLinecap="round"
            opacity={0.8}
          />
        ))}
      <circle cx={50} cy={50} r={47} strokeWidth={1.5} />
      <circle cx={50} cy={50} r={31} strokeWidth={0.8} />
      <text
        fill="currentColor"
        stroke="none"
        fontFamily="var(--font-num)"
        fontSize={7}
        fontWeight={500}
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
        fontWeight={500}
        style={{ fontVariantNumeric: 'lining-nums' }}
      >
        {value}
      </text>
      <line x1={38} x2={62} y1={61.5} y2={61.5} strokeWidth={0.6} />
      <text
        x={50}
        y={70}
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="var(--font-num)"
        fontSize={6}
        letterSpacing={1.4}
      >
        {unit}
      </text>
    </svg>
  )
}

/* ---------------- 矿物色：没有封面照片时的纯色块（按 id 取色） ---------------- */
// 取值与 index.css 中的矿物色令牌一致（玉青 / 黛青 / 赭石 / 藕荷 / 胭脂 / 石青 / 宣纸）
export const minerals = [
  { name: '玉青', bg: '#2a5447', fg: '#f4f1ea', stamp: '#f4f1ea' },
  { name: '黛青', bg: '#325662', fg: '#f4f1ea', stamp: '#f4f1ea' },
  { name: '赭石', bg: '#7d561e', fg: '#f4f1ea', stamp: '#f4f1ea' },
  { name: '藕荷', bg: '#594b74', fg: '#f4f1ea', stamp: '#f4f1ea' },
  { name: '胭脂', bg: '#6b3242', fg: '#f4f1ea', stamp: '#f4f1ea' },
  { name: '石青', bg: '#3d4e7a', fg: '#f4f1ea', stamp: '#f4f1ea' },
  { name: '墨', bg: '#1d1c19', fg: '#f2eee6', stamp: '#cf6041' },
] as const
export type Mineral = (typeof minerals)[number]
export const mineralOf = (id: number) => minerals[Math.abs(id) % minerals.length]

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

/** 列表底部「加载更多」：细线分隔 + 文字按钮 */
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
    <div className={cn('flex items-center gap-4 pt-10', className)}>
      <span className="h-px flex-1 bg-ink-200" />
      <button
        type="button"
        onClick={onClick}
        disabled={loading}
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-ink-900/15 px-5 text-[13px] tracking-wider text-ink-700 transition-colors hover:border-ink-900/40 hover:bg-surface disabled:opacity-50"
      >
        {loading ? '加载中…' : children}
      </button>
      <span className="h-px flex-1 bg-ink-200" />
    </div>
  )
}
