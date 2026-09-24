import { useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Footprints, Heart, Route, Sparkles } from 'lucide-react'
import { api, errorMessage } from '@/api'
import { Logo } from '@/components/layout/AppLayout'
import { Button, Field, Input } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { useAuth } from '@/stores/auth'

const highlights = [
  { icon: Route, title: '计划 vs 实际', desc: '规划路线，按图出行，结束后对比' },
  { icon: Sparkles, title: 'AI 推荐下一站', desc: '到了一个地方，推荐附近值得去的' },
  { icon: Footprints, title: '3D 足迹回放', desc: '点亮去过的城市，回放每一段旅程' },
  { icon: Heart, title: '我们一起走过的地方', desc: '情侣空间，记录两个人的足迹' },
]

export default function LoginPage() {
  const isRegister = useLocation().pathname === '/register'
  const [params] = useSearchParams()
  const next = params.get('next') || '/'
  const nav = useNavigate()
  const loginWith = useAuth((s) => s.loginWith)
  const { data: site } = useSite()
  const [form, setForm] = useState({ account: '', username: '', email: '', password: '', password2: '', nickname: '' })
  const [loading, setLoading] = useState(false)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isRegister) {
      if (!/^[A-Za-z0-9_]{3,20}$/.test(form.username)) return toast.error('用户名需为 3-20 位字母、数字或下划线')
      if (form.password.length < 6) return toast.error('密码至少 6 位')
      if (form.password !== form.password2) return toast.error('两次输入的密码不一致')
    }
    setLoading(true)
    try {
      const r = isRegister
        ? await api.auth.register({
            username: form.username,
            password: form.password,
            email: form.email || undefined,
            nickname: form.nickname || undefined,
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

  return (
    <div className="flex min-h-dvh">
      <aside className="bg-night relative hidden w-[46%] flex-col justify-between overflow-hidden p-10 text-white lg:flex">
        <div
          className="pointer-events-none absolute -top-40 -right-40 size-[520px] rounded-full opacity-40 blur-3xl"
          style={{ background: 'radial-gradient(circle, #ff5a5f, transparent 60%)' }}
        />
        <div
          className="pointer-events-none absolute -bottom-40 -left-20 size-[480px] rounded-full opacity-30 blur-3xl"
          style={{ background: 'radial-gradient(circle, #7c5cff, transparent 60%)' }}
        />
        <Logo light />
        <div className="relative">
          <h1 className="text-4xl leading-tight font-extrabold">
            把每一次出发
            <br />
            都变成<span className="text-brand-300">值得回看</span>的足迹
          </h1>
          <p className="mt-4 max-w-md text-white/60">
            记录旅途的每一个打卡点，分享真实的推荐与避雷，让下一个出发的人少走弯路。
          </p>
          <div className="mt-10 grid max-w-lg grid-cols-2 gap-4">
            {highlights.map((h) => (
              <div key={h.title} className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
                <h.icon className="size-5 text-brand-300" />
                <div className="mt-2 font-semibold">{h.title}</div>
                <div className="mt-0.5 text-sm text-white/50">{h.desc}</div>
              </div>
            ))}
          </div>
        </div>
        <p className="text-xs text-white/30">© TripHub</p>
      </aside>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-10">
        <div className="w-full max-w-sm">
          <Logo className="mb-10 lg:hidden" />
          <h2 className="text-2xl font-bold">{isRegister ? '创建账号' : '欢迎回来'}</h2>
          <p className="mt-1 text-sm text-ink-500">
            {isRegister ? '开始记录你的第一段旅程' : '登录后继续你的旅程'}
          </p>

          {isRegister && site && !site.registration_open ? (
            <div className="mt-8 rounded-2xl bg-amber-50 p-4 text-sm text-amber-800">站点暂时关闭了注册，请稍后再来。</div>
          ) : (
            <form onSubmit={submit} className="mt-8 space-y-4">
              {isRegister ? (
                <>
                  <Field label="用户名" hint="3-20 位字母、数字或下划线，注册后不可修改">
                    <Input value={form.username} onChange={set('username')} autoComplete="username" required autoFocus />
                  </Field>
                  <Field label="昵称（可选）">
                    <Input value={form.nickname} onChange={set('nickname')} maxLength={20} />
                  </Field>
                  <Field label="邮箱（可选）" hint="可用邮箱登录">
                    <Input type="email" value={form.email} onChange={set('email')} autoComplete="email" />
                  </Field>
                  <Field label="密码">
                    <Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" required />
                  </Field>
                  <Field label="确认密码">
                    <Input type="password" value={form.password2} onChange={set('password2')} autoComplete="new-password" required />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="用户名或邮箱">
                    <Input value={form.account} onChange={set('account')} autoComplete="username" required autoFocus />
                  </Field>
                  <Field label="密码">
                    <Input type="password" value={form.password} onChange={set('password')} autoComplete="current-password" required />
                  </Field>
                </>
              )}
              <Button type="submit" block size="lg" loading={loading}>
                {isRegister ? '注册' : '登录'}
              </Button>
            </form>
          )}

          <p className="mt-6 text-center text-sm text-ink-500">
            {isRegister ? '已有账号？' : '还没有账号？'}
            <Link
              to={`${isRegister ? '/login' : '/register'}${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}
              className="font-medium text-brand-600"
            >
              {isRegister ? '去登录' : '立即注册'}
            </Link>
          </p>
          <p className="mt-3 text-center">
            <Link to="/" className="text-sm text-ink-400 hover:text-ink-700">
              先随便逛逛 →
            </Link>
          </p>
        </div>
      </main>
    </div>
  )
}
