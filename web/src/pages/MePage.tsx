import { useEffect, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, LogOut, PenLine } from 'lucide-react'
import { api } from '@/api'
import { useSpaces } from '@/components/space'
import { Avatar, buttonClass } from '@/components/ui'
import { cn } from '@/lib/cn'
import { dayjs, fmtCount } from '@/lib/format'
import { useSite } from '@/hooks/useSite'
import { isAdmin, useAuth } from '@/stores/auth'

interface LinkItem {
  to: string
  label: string
  /** 左栏的西文小标签 */
  en: string
  extra?: ReactNode
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 细线标签行：一条 border-t，左侧 eyebrow + 灰色计数，右侧补充 */
function LabelRow({ label, count, extra, className }: { label: ReactNode; count?: ReactNode; extra?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-ink-200 pt-3 pb-1', className)}>
      <p className="flex min-w-0 items-baseline gap-3">
        <span className="eyebrow !text-ink-800">{label}</span>
        {count != null && <span className="font-num text-[13px] text-ink-400">{count}</span>}
      </p>
      {extra}
    </div>
  )
}

/** 待处理数量：一粒朱砂小圆点（全站「待处理」同一种颜色）+ 象牙白 Cormorant 数字，不用色块 */
function Badge({ n, unit, prefix }: { n: number | string; unit: string; prefix?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-ink-700">
      <span className="size-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />
      <span>
        {prefix}
        <span className="font-num text-[15px] text-ink-900">{n}</span> {unit}
      </span>
    </span>
  )
}

/** 默认头像：近黑底 + 细线圈 + 象牙白首字，不用彩色圆片 */
const monoAvatar = '!bg-surface-2 ring-1 ring-inset ring-ink-300 !text-ink-800'

/**
 * 目录（Exemplar 的字体样张式）：左栏西文小标签，中间卡片标题字号（text-card）的名称，右侧灰色补充 + 箭头，行间细线。
 * 悬停只改颜色，不位移。
 */
function Directory({ label, items, start = 0 }: { label: string; items: LinkItem[]; start?: number }) {
  return (
    <section className="animate-slide-up">
      <LabelRow label={label} count={pad2(items.length)} />
      <ul className="mt-4 md:mt-8">
        {items.map((it, i) => (
          <li key={it.to} className="border-b border-ink-200">
            <Link
              to={it.to}
              className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-4 md:grid-cols-12 md:gap-x-8 md:py-5"
            >
              <span className="col-span-2 flex items-baseline gap-3 max-md:mb-1.5 md:col-span-4">
                <span className="font-num text-[13px] text-ink-400 transition-colors duration-300 group-hover:text-ink-900">
                  {pad2(start + i + 1)}
                </span>
                <span className="eyebrow transition-colors duration-300 group-hover:!text-ink-700">{it.en}</span>
              </span>
              <span className="min-w-0 md:col-span-5">
                <span className="font-display block text-[length:var(--text-card)] leading-snug text-ink-900 transition-colors duration-300 group-hover:text-brand-700">
                  {it.label}
                </span>
                {it.extra && <span className="mt-2 block text-[13px] text-ink-500 md:hidden">{it.extra}</span>}
              </span>
              <span className="flex items-center justify-end gap-6 md:col-span-3">
                {it.extra && <span className="hidden min-w-0 truncate text-[13px] text-ink-500 md:inline">{it.extra}</span>}
                <ArrowRight
                  className="size-4 shrink-0 text-ink-400 transition-colors duration-300 group-hover:text-ink-900"
                  strokeWidth={1.5}
                />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function MePage() {
  const user = useAuth((s) => s.user)!
  const logout = useAuth((s) => s.logout)
  const nav = useNavigate()
  const { data: site } = useSite()
  const profile = useQuery({ queryKey: ['user', user.username], queryFn: () => api.users.get(user.username) })
  const { data: unread = 0 } = useQuery({
    queryKey: ['unread'],
    queryFn: api.notifications.unreadCount,
    select: (d) => d.count,
  })
  const invites = useQuery({ queryKey: ['me', 'invites'], queryFn: api.me.invites })
  // 等级经验、情侣绑定以服务端为准：每次打开都刷新
  useEffect(() => {
    void useAuth.getState().refreshMe()
  }, [])

  const cur = site?.levels.find((l) => l.level === user.level)
  const next = site?.levels.find((l) => l.level === user.level + 1)
  const nextExp = user.next_level_exp ?? null
  const base = cur?.min_exp ?? 0
  const progress = nextExp ? Math.min(1, Math.max(0, (user.exp - base) / Math.max(1, nextExp - base))) : 1
  const tripInvites = invites.data?.trip_invites.length ?? 0
  // 待我回应的空间邀请（旧版服务端只有情侣邀请）
  const spaceInvites = invites.data?.space_invites?.length ?? invites.data?.partner_invites.length ?? 0
  const spaces = useSpaces().data
  const defaultSpace = spaces?.find((s) => s.is_default)
  const stats = profile.data?.stats
  const name = user.nickname || user.username

  const main: LinkItem[] = [
    { to: `/u/${user.username}`, label: '我的主页', en: 'Profile' },
    {
      to: '/me/trips',
      label: '我的旅程',
      en: 'Journeys',
      extra: tripInvites > 0 && <Badge n={tripInvites} unit="个邀请" />,
    },
    { to: '/me/favorites', label: '我的收藏', en: 'Saved' },
    { to: '/footprints', label: '我的足迹', en: 'Footprints' },
    {
      // 「我们」：打开默认空间，没有时是空间总览
      to: '/together',
      label: '我们',
      en: 'Together',
      extra:
        spaceInvites > 0 ? (
          <Badge prefix="空间 · " n={spaceInvites} unit="个邀请" />
        ) : spaces?.length ? (
          `${spaces.length} 个空间${defaultSpace ? ` · 默认「${defaultSpace.name}」` : ''}`
        ) : spaces ? (
          '和情侣、闺蜜、家人建一个空间'
        ) : undefined,
    },
  ]
  const more: LinkItem[] = [
    {
      to: '/notifications',
      label: '通知',
      en: 'Notifications',
      extra: unread > 0 && <Badge n={unread > 99 ? '99+' : unread} unit="条未读" />,
    },
    { to: '/settings', label: '账号设置', en: 'Settings' },
    ...(isAdmin(user) ? [{ to: '/admin', label: '管理后台', en: 'Console' }] : []),
  ]

  const figures = [
    ['旅程', 'Journeys', stats?.trips],
    ['粉丝', 'Followers', stats?.followers],
    ['关注', 'Following', stats?.following],
    ['获赞', 'Likes', stats?.likes],
  ] as const

  return (
    <div className="mx-auto max-w-[90rem] px-4 pt-10 pb-24 [font-variant-numeric:lining-nums] md:px-8 md:pt-20 md:pb-32">
      {/* 刊头：细线标签行 + 名字（页面 H1，text-display-lg）；右栏头像与说明文字对 */}
      <header className="animate-slide-up">
        <LabelRow
          label="Traveler · 旅人"
          extra={
            <span className="truncate text-[13px] text-ink-400">
              @{user.username}
              {isAdmin(user) && ' · 管理员'}
            </span>
          }
        />
        <div className="mt-8 grid gap-x-8 gap-y-8 md:mt-12 lg:grid-cols-12 lg:items-end">
          <h1 className="text-display-lg min-w-0 font-normal break-words lg:col-span-8">{name}</h1>
          <div className="flex items-center gap-5 lg:col-span-4 lg:col-start-9 lg:pb-3">
            <Avatar user={user} size={56} className={monoAvatar} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-ink-900">
                <span className="font-num italic">Lv.{user.level}</span> · {user.level_name}
              </p>
              <p className="caption mt-0.5 truncate">
                {user.created_at ? `${dayjs(user.created_at).format('YYYY 年 M 月')}加入` : `@${user.username}`}
                {user.partner && ` · 和 ${user.partner.nickname || user.partner.username} 同行`}
              </p>
            </div>
            <Link to="/settings" aria-label="编辑资料" className={buttonClass({ variant: 'outline', size: 'sm', className: 'max-sm:size-10 max-sm:px-0' })}>
              <PenLine className="size-3.5" strokeWidth={1.5} />
              <span className="max-sm:sr-only">编辑资料</span>
            </Link>
          </div>
        </div>
      </header>

      {/* 数据：主题的大数字（font-num text-num），竖细线分隔；大屏左侧三分之一是标签栏，数字从与设置页、通知页同一条竖线起排 */}
      <section className="animate-slide-up mt-14 [animation-delay:80ms] [animation-fill-mode:backwards] md:mt-20" aria-label="数据">
        <div className="grid border-t border-ink-200 lg:grid-cols-12 lg:gap-x-8 lg:border-b">
          <div className="hidden pt-5 lg:col-span-4 lg:block">
            <p className="eyebrow">Numbers · 数据</p>
            <p className="caption mt-2">公开主页上的数字</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:col-span-8">
            {figures.map(([label, en, v], i) => (
              <Link
                key={label}
                to={`/u/${user.username}`}
                className={cn(
                  'group min-w-0 border-b border-ink-200 pt-5 pb-6 md:pt-6 md:pb-8 lg:border-b-0',
                  i % 2 === 1 && 'border-l pl-5 md:pl-8',
                  i === 2 && 'md:border-l md:pl-8',
                )}
              >
                <p className="eyebrow">
                  {en} · {label}
                </p>
                <p className="font-num text-num mt-4 text-ink-900 transition-colors duration-300 group-hover:text-brand-700 md:mt-6">
                  {v == null ? '–' : fmtCount(v)}
                </p>
              </Link>
            ))}
          </div>
        </div>

        {/* 等级：一道极细的线，当前位置一粒朱砂小点 */}
        <div className="mt-10 grid gap-y-5 md:mt-14 lg:grid-cols-12 lg:items-end lg:gap-x-8">
          <div className="lg:col-span-4">
            <p className="eyebrow">Level · 等级</p>
            <p className="mt-3 flex items-baseline gap-3">
              <span className="font-num text-[length:var(--text-h2)] leading-none text-ink-900">{user.exp}</span>
              <span className="text-[13px] text-ink-500">
                {nextExp ? (
                  <>
                    / <span className="font-num text-[15px]">{nextExp}</span> 经验
                  </>
                ) : (
                  '经验 · 已满级'
                )}
              </span>
            </p>
          </div>
          <div className="lg:col-span-8 lg:pb-2">
            <div
              className="relative h-1 rounded-full bg-ink-200"
              role="progressbar"
              aria-label="升级进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
            >
              <div className="absolute inset-y-0 left-0 rounded-full bg-brand-600" style={{ width: `${progress * 100}%` }} />
              <span
                className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-600 ring-4 ring-paper"
                style={{ left: `${progress * 100}%` }}
                aria-hidden
              />
            </div>
            <div className="mt-4 flex items-baseline justify-between gap-4 text-[13px]">
              <span className="text-ink-900">
                <span className="font-num italic">Lv.{user.level}</span> {user.level_name}
              </span>
              <span className="text-right text-ink-500">
                {nextExp ? (
                  <>
                    再得 <span className="font-num text-[15px] text-ink-900">{Math.max(0, nextExp - user.exp)}</span> 经验 · 升至{' '}
                    <span className="font-num italic">Lv.{user.level + 1}</span>
                    {next ? ` ${next.name}` : ''}
                  </>
                ) : (
                  '已达到最高等级'
                )}
              </span>
            </div>
          </div>
        </div>
      </section>

      <div className="mt-16 space-y-14 md:mt-24 md:space-y-20">
        <Directory label="Journal · 旅行" items={main} />
        <Directory label="Account · 账户" items={more} start={main.length} />
      </div>

      <div className="mt-12 flex justify-end md:mt-16">
        <button
          type="button"
          onClick={async () => {
            // 先离开受保护页面再登出，避免被重定向到登录页
            await nav('/', { replace: true })
            await logout()
          }}
          className="inline-flex h-11 items-center gap-2.5 text-[13px] tracking-[0.04em] text-ink-500 transition-colors duration-300 hover:text-brand-600"
        >
          <LogOut className="size-4" strokeWidth={1.25} />
          退出登录
        </button>
      </div>
    </div>
  )
}
