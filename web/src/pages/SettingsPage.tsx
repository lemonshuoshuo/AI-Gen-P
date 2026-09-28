import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Camera, UserX } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Me } from '@/api'
import { Avatar, Button, Field, Input, LevelBadge, Modal, Textarea } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'
import { fmtBytes } from '@/lib/format'
import { compressImage } from '@/lib/image'
import { isAdmin, useAuth } from '@/stores/auth'

const expRules = [
  ['创建旅程', 5],
  ['旅程首次公开', 20],
  ['添加打卡点', 1],
  ['上传照片', 1],
  ['发表评论', 1],
  ['旅程被点赞', 2],
  ['被收藏', 2],
  ['被评论', 1],
  ['被引用', 5],
  ['被关注', 2],
  ['被设为精选', 50],
] as const

/** 一组设置：小标题 + 宋体标题，组与组之间一道细线（第一组是墨线） */
function Section({
  eyebrow,
  title,
  children,
  className,
}: {
  eyebrow: string
  title: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('border-t border-ink-200 py-8 first:border-ink-900', className)}>
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="mt-1.5 mb-6 text-xl text-ink-900">{title}</h2>
      {children}
    </section>
  )
}

/** 细进度线：一道淡细线上叠一段有色线 */
function ProgressLine({ value, className, barCls = 'bg-ink-900' }: { value: number; className?: string; barCls?: string }) {
  const pct = Math.min(100, Math.max(0, value * 100))
  return (
    <div
      className={cn('relative h-[3px] bg-ink-200', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div className={cn('absolute inset-y-0 left-0 transition-all', barCls)} style={{ width: `${pct}%` }} />
    </div>
  )
}

function ProfileSection({ user }: { user: Me }) {
  const setUser = useAuth((s) => s.setUser)
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [nickname, setNickname] = useState(user.nickname)
  const [bio, setBio] = useState(user.bio)
  const [email, setEmail] = useState(user.email)
  const dirty = nickname.trim() !== user.nickname || bio.trim() !== user.bio || email.trim() !== user.email

  const avatar = useMutation({
    mutationFn: async (file: File) => {
      const { blob } = await compressImage(file, 512)
      return api.me.avatar(blob)
    },
    onSuccess: ({ avatar_url }) => {
      const cur = useAuth.getState().user
      if (cur) setUser({ ...cur, avatar_url })
      qc.invalidateQueries({ queryKey: ['user', user.username] })
      toast.success('头像已更新')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const save = useMutation({
    mutationFn: () => api.me.update({ nickname: nickname.trim(), bio: bio.trim(), email: email.trim() }),
    onSuccess: (me) => {
      setUser(me)
      qc.invalidateQueries({ queryKey: ['user', user.username] })
      toast.success('资料已保存')
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  return (
    <Section eyebrow="Profile" title="个人资料">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={avatar.isPending}
          className="group relative shrink-0 rounded-full"
          aria-label="更换头像"
        >
          <Avatar user={user} size={72} />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-ink-900/40 text-white opacity-0 transition group-hover:opacity-100">
            <Camera className="size-5" strokeWidth={1.5} />
          </span>
        </button>
        <div className="min-w-0">
          <Button
            variant="outline"
            size="sm"
            icon={<Camera className="size-4" strokeWidth={1.75} />}
            loading={avatar.isPending}
            onClick={() => fileRef.current?.click()}
          >
            更换头像
          </Button>
          <p className="mt-1.5 text-xs text-ink-400">支持 JPG / PNG / WebP，会自动压缩</p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) avatar.mutate(f)
          }}
        />
      </div>

      <form
        className="mt-5 space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!nickname.trim()) return toast.error('昵称不能为空')
          save.mutate()
        }}
      >
        <Field label="用户名" hint="用户名不可修改">
          <Input value={user.username} disabled />
        </Field>
        <Field label="昵称">
          <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} placeholder="给自己起个名字" />
        </Field>
        <Field label="个人简介" hint={`${bio.length}/200`}>
          <Textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={200} placeholder="介绍一下自己，喜欢去哪里旅行？" />
        </Field>
        <Field label="邮箱" hint="可用于登录">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="email" />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={!dirty} loading={save.isPending}>
            保存资料
          </Button>
        </div>
      </form>
    </Section>
  )
}

function LevelSection({ user }: { user: Me }) {
  const { data: site } = useSite()
  const levels = site?.levels ?? []
  const cur = levels.find((l) => l.level === user.level)
  const next = levels.find((l) => l.level === user.level + 1)
  // 满级时 next_level_exp 为 null
  const nextExp = user.next_level_exp ?? next?.min_exp ?? null
  const base = cur?.min_exp ?? 0
  const progress = nextExp ? (user.exp - base) / Math.max(1, nextExp - base) : 1

  return (
    <Section eyebrow="Level · 等级" title="等级与经验">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-ink-600">
            <LevelBadge level={user.level} className="h-5 px-1.5 text-xs" />
            <span className="font-display text-[17px] text-ink-900">{user.level_name}</span>
          </div>
          <div className="mt-3 flex items-baseline gap-1.5">
            <span className="font-num text-5xl leading-none tracking-tight text-ink-900">{user.exp}</span>
            {nextExp ? <span className="font-num text-lg text-ink-400">/ {nextExp}</span> : null}
            <span className="ml-1 text-xs text-ink-400">经验</span>
          </div>
        </div>
        <p className="text-xs text-ink-400 sm:text-right">
          {nextExp ? (
            <>
              再获得 <span className="font-num text-sm text-ink-900">{Math.max(0, nextExp - user.exp)}</span> 经验
              <br className="max-sm:hidden" />
              升级到 <span className="font-num italic">Lv.{user.level + 1}</span>
              {next ? `「${next.name}」` : ''}
            </>
          ) : (
            '已达到最高等级'
          )}
        </p>
      </div>
      <ProgressLine value={progress} className="mt-4" barCls="bg-brand-500" />

      {levels.length > 0 && (
        <table className="mt-8 w-full border-t border-ink-900 text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-left text-xs text-ink-400">
              <th className="py-2.5 pr-3 font-normal tracking-wide">等级</th>
              <th className="px-3 py-2.5 font-normal tracking-wide">称号</th>
              <th className="px-3 py-2.5 text-right font-normal tracking-wide">所需经验</th>
              <th className="py-2.5 pl-3 text-right font-normal tracking-wide">存储空间</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((l) => {
              const current = l.level === user.level
              return (
                <tr key={l.level} className={cn('border-b border-ink-200', l.level > user.level ? 'text-ink-400' : 'text-ink-700')}>
                  <td className="py-2.5 pr-3">
                    <LevelBadge level={l.level} />
                  </td>
                  <td className={cn('px-3 py-2.5', current && 'font-display text-ink-900')}>
                    {l.name}
                    {current && <span className="ml-2 font-sans text-xs text-brand-600">当前</span>}
                  </td>
                  <td className="font-num px-3 py-2.5 text-right">{l.min_exp}</td>
                  <td className="font-num py-2.5 pl-3 text-right">{fmtBytes(l.quota_mb * 1024 ** 2)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      <div className="mt-8">
        <p className="eyebrow">How to earn · 如何获得经验</p>
        {/* 像一份价目表：名称 …… 经验值 */}
        <dl className="mt-3 grid gap-x-8 sm:grid-cols-2">
          {expRules.map(([label, n]) => (
            <div key={label} className="flex items-baseline gap-2 border-b border-dotted border-ink-300 py-2 text-sm">
              <dt className="text-ink-600">{label}</dt>
              <dd className="font-num ml-auto text-ink-900">+{n}</dd>
            </div>
          ))}
        </dl>
        {site && (
          <p className="mt-3 text-xs text-ink-400">
            每天最多获得 <span className="font-num">{site.exp_daily_cap}</span> 经验（被设为精选不受此限制）
          </p>
        )}
      </div>
    </Section>
  )
}

function StorageSection({ user }: { user: Me }) {
  const unlimited = user.storage_quota <= 0
  const ratio = unlimited ? 0 : user.storage_used / user.storage_quota
  const barCls = ratio > 0.9 ? 'bg-brand-500' : ratio > 0.75 ? 'bg-amber-500' : 'bg-ink-900'
  const [used, usedUnit] = fmtBytes(user.storage_used).split(' ')
  return (
    <Section eyebrow="Storage · 存储" title="存储空间">
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="font-num text-5xl leading-none tracking-tight text-ink-900">{used}</span>
          <span className="font-num text-sm text-ink-400">{usedUnit}</span>
          <span className="ml-1 text-sm text-ink-400">
            / <span className="font-num">{unlimited ? '不限' : fmtBytes(user.storage_quota)}</span>
          </span>
        </div>
        {!unlimited && (
          <span className="font-num text-2xl leading-none text-ink-500">
            {Math.round(ratio * 100)}
            <span className="text-sm">%</span>
          </span>
        )}
      </div>
      {!unlimited && <ProgressLine value={ratio} className="mt-4" barCls={barCls} />}
      <p className="mt-3 text-xs text-ink-400">
        {unlimited
          ? '管理员账号不受存储空间限制'
          : ratio > 0.9
            ? '存储空间快用完了，提升等级可以获得更多空间'
            : '照片会占用存储空间，等级越高空间越大'}
      </p>
    </Section>
  )
}

function PasswordSection() {
  const [form, setForm] = useState({ old: '', next: '', confirm: '' })
  const m = useMutation({
    mutationFn: () => api.me.password({ old_password: form.old, new_password: form.next }),
    onSuccess: () => {
      toast.success('密码已修改', { description: '其他设备上的登录已失效，需要重新登录' })
      setForm({ old: '', next: '', confirm: '' })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (form.next.length < 8 || form.next.length > 64) return toast.error('新密码需为 8–64 位')
    if (form.next !== form.confirm) return toast.error('两次输入的新密码不一致')
    if (form.next === form.old) return toast.error('新密码不能与当前密码相同')
    m.mutate()
  }
  return (
    <Section eyebrow="Security · 安全" title="修改密码">
      <form className="space-y-4" onSubmit={submit}>
        <Field label="当前密码">
          <Input
            type="password"
            value={form.old}
            onChange={(e) => setForm({ ...form, old: e.target.value })}
            autoComplete="current-password"
          />
        </Field>
        <Field label="新密码" hint="8–64 位">
          <Input
            type="password"
            value={form.next}
            onChange={(e) => setForm({ ...form, next: e.target.value })}
            autoComplete="new-password"
          />
        </Field>
        <Field label="确认新密码">
          <Input
            type="password"
            value={form.confirm}
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            autoComplete="new-password"
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={!form.old || !form.next || !form.confirm} loading={m.isPending}>
            修改密码
          </Button>
        </div>
      </form>
    </Section>
  )
}

function DeleteAccountSection({ user }: { user: Me }) {
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [ack, setAck] = useState(false)
  const m = useMutation({
    mutationFn: () => api.me.remove(password),
    onSuccess: async () => {
      toast.success('账号已注销，感谢使用')
      // 服务端已作废全部登录：清除本地 token 和缓存的数据（其中 /auth/logout 请求会静默失败）
      await useAuth.getState().logout()
      nav('/', { replace: true })
    },
    // 密码不正确、尝试次数过多（429）等：显示服务端的提示
    onError: (e) => toast.error(errorMessage(e)),
  })
  const close = () => {
    if (m.isPending) return
    setOpen(false)
    setPassword('')
    setAck(false)
  }
  return (
    <section className="border-t border-ink-200 py-8">
      <p className="eyebrow !text-brand-600">Danger zone · 注销</p>
      <h2 className="mt-1.5 mb-4 flex items-center gap-2 text-xl text-ink-900">
        <UserX className="size-5 text-brand-600" strokeWidth={1.5} />
        注销账号
      </h2>
      <p className="text-sm leading-relaxed text-ink-500">
        注销后账号无法恢复：只有你能编辑的旅程会被删除（含照片、轨迹和评论）；有其他共同作者的旅程会转交给最早加入的共同作者；你上传的照片和
        GPS 轨迹全部删除，你的评论显示为「已删除」；点赞、收藏、关注、情侣绑定和所有设备上的登录都会解除。
        <Link to="/legal/privacy" className="text-ink-900 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-900">
          详见《隐私政策》
        </Link>
      </p>
      {isAdmin(user) ? (
        <p className="mt-4 border-l-2 border-amber-500 py-0.5 pl-3 text-sm leading-relaxed text-ink-600">
          管理员账号不能注销；如需注销，请先让其他管理员取消你的管理员权限。
        </p>
      ) : (
        <div className="mt-4 flex justify-end">
          <Button variant="danger" onClick={() => setOpen(true)}>
            注销账号
          </Button>
        </div>
      )}
      <Modal
        open={open}
        onClose={close}
        title="确认注销账号"
        footer={
          <>
            <Button variant="ghost" disabled={m.isPending} onClick={close}>
              取消
            </Button>
            <Button variant="danger" disabled={!password || !ack} loading={m.isPending} onClick={() => m.mutate()}>
              确认注销
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="登录密码">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </Field>
          <label className="flex items-start gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-brand-600"
            />
            我已了解注销后数据无法恢复
          </label>
        </div>
      </Modal>
    </section>
  )
}

export default function SettingsPage() {
  const user = useAuth((s) => s.user)!
  // 等级、经验和存储空间以服务端为准：每次打开都刷新
  useEffect(() => {
    void useAuth.getState().refreshMe()
  }, [])
  return (
    <div className="mx-auto max-w-2xl px-4 pt-6 pb-12 md:pt-10">
      <header className="mb-8">
        <p className="eyebrow">Account · 账号</p>
        <h1 className="mt-2 text-[28px] leading-[1.15] text-ink-900 md:text-[34px]">账号设置</h1>
        <p className="mt-2 text-sm text-ink-500">个人资料、等级经验、存储空间与账号安全</p>
      </header>
      <div>
        <ProfileSection user={user} />
        <LevelSection user={user} />
        <StorageSection user={user} />
        <PasswordSection />
      </div>
      <DeleteAccountSection user={user} />
    </div>
  )
}
