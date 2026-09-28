import { useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, errorMessage } from '@/api'
import { Note } from '@/components/editorial'
import { Logo } from '@/components/layout/AppLayout'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { Markdown } from '@/components/Markdown'
import { Button, Field, Input, LoadError, Modal, Spinner } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'
import { useAuth } from '@/stores/auth'

type LegalDoc = 'terms' | 'privacy'
const legalTitle: Record<LegalDoc, string> = { terms: '用户协议', privacy: '隐私政策' }

/** 注册前查看用户协议 / 隐私政策（管理员在后台填写，未填写时为服务端内置模板） */
function LegalModal({ doc, onClose }: { doc: LegalDoc | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['legal', doc], queryFn: () => api.legal(doc!), enabled: !!doc, staleTime: 10 * 60_000 })
  const spinner = (
    <div className="flex justify-center py-10">
      <Spinner />
    </div>
  )
  return (
    <Modal open={!!doc} onClose={onClose} title={doc ? legalTitle[doc] : ''} wide>
      {q.isLoading ? (
        spinner
      ) : q.isError ? (
        <LoadError className="py-8" error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="prose-trip text-sm text-ink-700">
          <Markdown fallback={spinner}>{q.data?.content ?? ''}</Markdown>
        </div>
      )}
    </Modal>
  )
}

const highlights = [
  { title: '计划与实际', desc: '先规划路线，按图出行，归来逐站对照' },
  { title: '下一站推荐', desc: '走到哪里，就推荐附近值得去的地方' },
  { title: '3D 足迹回放', desc: '点亮去过的城市，重温每一段路' },
  { title: '我们', desc: '两个人的旅行，记在同一本手账里' },
]

/** 题记：宽屏在左侧扉页里是全页焦点；手机上缩小放在表单上方 */
function Epigraph({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <figure className={className}>
      <blockquote>
        <p
          className={cn(
            "font-normal [font-feature-settings:'halt']",
            compact ? 'font-display text-[2.25rem] leading-[1.18] text-ink-900' : 'text-display-lg',
          )}
        >
          世界是一本书，
          <br />
          不旅行的人
          <br />
          只读了其中一页。
        </p>
      </blockquote>
      <figcaption className={cn('flex items-center gap-4', compact ? 'mt-5' : 'mt-8')}>
        <span className="h-px w-10 bg-ink-400" />
        <span>
          <span className="block text-[13px] text-ink-900">圣奥古斯丁</span>
          <span className="caption block">Augustine of Hippo</span>
        </span>
      </figcaption>
    </figure>
  )
}

/** 左侧扉页（宽屏）：一屏高，题记在正中，底部四条编号目录（近黑底 + 细线，不用色块） */
function Frontispiece({ siteName }: { siteName: string }) {
  return (
    <aside className="relative hidden h-svh w-[52%] max-w-[860px] shrink-0 flex-col border-r border-ink-200 px-12 py-10 lg:flex xl:px-16">
      <div className="flex items-center justify-between">
        <Logo />
        <span className="eyebrow">Travel Journal · 旅行手账</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-center py-10">
        <Epigraph className="animate-slide-up" />
      </div>

      <ol className="grid grid-cols-2 border-t border-ink-200 [font-variant-numeric:lining-nums]">
        {highlights.map((h, i) => (
          <li
            key={h.title}
            className={cn('flex gap-4 py-5', i % 2 === 0 ? 'border-r border-ink-200 pr-5' : 'pl-6', i < 2 && 'border-b border-ink-200')}
          >
            <span className="font-num text-[1.75rem] leading-none font-light text-ink-400">{String(i + 1).padStart(2, '0')}</span>
            <span className="min-w-0">
              <span className="font-display block text-[1.15rem] leading-tight text-ink-900">{h.title}</span>
              <span className="caption mt-1 block">{h.desc}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="caption mt-5">
        <span className="font-num">© {new Date().getFullYear()}</span> {siteName}
      </p>
    </aside>
  )
}

export default function LoginPage() {
  const isRegister = useLocation().pathname === '/register'
  const [params] = useSearchParams()
  const next = params.get('next') || '/'
  const nav = useNavigate()
  const loginWith = useAuth((s) => s.loginWith)
  const { data: site } = useSite()
  const [form, setForm] = useState({ account: '', username: '', email: '', password: '', password2: '', nickname: '' })
  const [loading, setLoading] = useState(false)
  const [agree, setAgree] = useState(false)
  const [legal, setLegal] = useState<LegalDoc | null>(null)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isRegister) {
      if (!/^[A-Za-z0-9_]{3,20}$/.test(form.username)) return toast.error('用户名需为 3-20 位字母、数字或下划线')
      if (form.password.length < 8 || form.password.length > 64) return toast.error('密码需为 8–64 位')
      if (form.password !== form.password2) return toast.error('两次输入的密码不一致')
      if (!agree) return toast.error('请先阅读并同意用户协议和隐私政策')
    }
    setLoading(true)
    try {
      const r = isRegister
        ? await api.auth.register({
            username: form.username,
            password: form.password,
            email: form.email || undefined,
            nickname: form.nickname || undefined,
            agree_terms: true,
          })
        : await api.auth.login({ account: form.account, password: form.password })
      loginWith(r)
      toast.success(isRegister ? '注册成功，欢迎来到 TripHub！' : `欢迎回来，${r.user.nickname || r.user.username}`)
      nav(next, { replace: true })
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  const legalLink = 'text-ink-900 underline decoration-ink-300 underline-offset-4 transition-colors hover:decoration-ink-900'

  return (
    // 宽屏一屏高、不滚动：左侧扉页固定，右侧表单在自己的栏里居中（窗口很矮时右栏自己滚动）
    <div className="flex min-h-svh lg:h-svh">
      <Frontispiece siteName={site?.name || 'TripHub'} />

      <main className="flex flex-1 flex-col px-4 pt-6 pb-8 sm:px-10 lg:overflow-y-auto lg:pt-8 lg:pb-6">
        <Logo className="lg:hidden" />
        <Epigraph compact className="animate-slide-up mt-14 mb-4 sm:mx-auto sm:w-full sm:max-w-[26rem] lg:hidden" />
        <div className="animate-slide-up m-auto w-full max-w-[26rem] py-12 lg:py-6">
          <p className="eyebrow border-t border-ink-200 pt-3 !text-ink-800">{isRegister ? 'Join · 注册' : 'Sign in · 登录'}</p>
          <h1 className={cn('text-display-md font-normal', isRegister ? 'mt-7' : 'mt-10')}>{isRegister ? '开一本新的旅行手账' : '欢迎回来'}</h1>
          <p className="caption mt-3 text-[14px]">{isRegister ? '注册后就能记录你的第一段旅程' : '登录后，接着写你的旅程'}</p>

          {isRegister && site && !site.registration_open ? (
            <Note tone="amber" label="Notice" className="mt-8">
              站点暂时关闭了注册，请稍后再来。
            </Note>
          ) : (
            <form onSubmit={submit} className={cn(isRegister ? 'mt-7 space-y-4' : 'mt-10 space-y-5')}>
              {isRegister ? (
                <>
                  <Field label="用户名" hint="3-20 位字母、数字或下划线，注册后不可修改">
                    <Input value={form.username} onChange={set('username')} autoComplete="username" required autoFocus className="h-11" />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="昵称（可选）">
                      <Input value={form.nickname} onChange={set('nickname')} maxLength={20} className="h-11" />
                    </Field>
                    <Field label="邮箱（可选）">
                      <Input type="email" value={form.email} onChange={set('email')} autoComplete="email" className="h-11" />
                    </Field>
                  </div>
                  <Field label="密码" hint="8–64 位，不要用过于简单的密码">
                    <Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" required className="h-11" />
                  </Field>
                  <Field label="确认密码">
                    <Input type="password" value={form.password2} onChange={set('password2')} autoComplete="new-password" required className="h-11" />
                  </Field>
                  <div className="flex items-start gap-3 pt-1 text-[13px] leading-relaxed text-ink-600">
                    <input
                      id="agree-terms"
                      type="checkbox"
                      checked={agree}
                      onChange={(e) => setAgree(e.target.checked)}
                      className="mt-[3px] size-4 shrink-0 accent-ink-900"
                    />
                    <span>
                      <label htmlFor="agree-terms">我已阅读并同意</label>
                      <button type="button" onClick={() => setLegal('terms')} className={cn(legalLink, 'mx-0.5')}>
                        《用户协议》
                      </button>
                      和
                      <button type="button" onClick={() => setLegal('privacy')} className={cn(legalLink, 'mx-0.5')}>
                        《隐私政策》
                      </button>
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <Field label="用户名或邮箱">
                    <Input value={form.account} onChange={set('account')} autoComplete="username" required autoFocus className="h-11" />
                  </Field>
                  <Field label="密码">
                    <Input type="password" value={form.password} onChange={set('password')} autoComplete="current-password" required className="h-11" />
                  </Field>
                </>
              )}
              <div className="pt-3">
                <Button type="submit" block size="lg" loading={loading}>
                  {isRegister ? '注册' : '登录'}
                </Button>
              </div>
            </form>
          )}

          <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-ink-200 pt-4 text-[13px]', isRegister ? 'mt-8' : 'mt-12')}>
            <span className="text-ink-500">
              {isRegister ? '已有账号？' : '还没有账号？'}
              <Link
                to={`${isRegister ? '/login' : '/register'}${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}
                className={cn(legalLink, 'ml-1 font-medium')}
              >
                {isRegister ? '去登录' : '立即注册'}
              </Link>
            </span>
            <Link to="/" className="inline-flex h-10 items-center text-ink-400 transition-colors hover:text-ink-900">
              先随便逛逛 →
            </Link>
          </div>
        </div>
        {/* 登录 / 注册页没有站点布局：在这里显示备案号和用户协议、隐私政策 */}
        <SiteFooter compact className="mt-6 lg:mt-2" />
      </main>
      <LegalModal doc={legal} onClose={() => setLegal(null)} />
    </div>
  )
}
