import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Camera, HardDrive, KeyRound, Sparkles, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Me } from '@/api'
import { Avatar, Button, Card, Field, Input, LevelBadge, Textarea } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { cn } from '@/lib/cn'
import { fmtBytes } from '@/lib/format'
import { compressImage } from '@/lib/image'
import { useAuth } from '@/stores/auth'

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

function Section({ icon, title, children, className }: { icon: ReactNode; title: string; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('p-4 sm:p-5', className)}>
      <h2 className="mb-4 flex items-center gap-2 font-bold">
        <span className="text-brand-500">{icon}</span>
        {title}
      </h2>
      {children}
    </Card>
  )
}

function ProgressBar({ value, className, barCls = 'bg-brand-gradient' }: { value: number; className?: string; barCls?: string }) {
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-ink-100', className)}>
      <div className={cn('h-full rounded-full transition-all', barCls)} style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
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
    <Section icon={<UserRound className="size-4.5" />} title="个人资料">
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
            <Camera className="size-5" />
          </span>
        </button>
        <div className="min-w-0">
          <Button
            variant="outline"
            size="sm"
            icon={<Camera className="size-4" />}
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
    <Section icon={<Sparkles className="size-4.5" />} title="等级与经验">
      <div className="flex items-center gap-2">
        <LevelBadge level={user.level} className="h-5 px-1.5 text-xs" />
        <span className="font-semibold">{user.level_name}</span>
        <span className="ml-auto text-sm text-ink-500 tabular-nums">
          {user.exp}
          {nextExp ? ` / ${nextExp}` : ''} 经验
        </span>
      </div>
      <ProgressBar value={progress} className="mt-2.5" />
      <p className="mt-2 text-xs text-ink-400">
        {nextExp
          ? `再获得 ${Math.max(0, nextExp - user.exp)} 经验升级到 Lv${user.level + 1}${next ? `「${next.name}」` : ''}`
          : '已达到最高等级，你就是传奇 ✨'}
      </p>

      {levels.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-xl ring-1 ring-ink-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-ink-50 text-left text-xs text-ink-400">
                <th className="px-3 py-2 font-medium">等级</th>
                <th className="px-3 py-2 font-medium">称号</th>
                <th className="px-3 py-2 text-right font-medium">所需经验</th>
                <th className="px-3 py-2 text-right font-medium">存储空间</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((l) => {
                const current = l.level === user.level
                return (
                  <tr
                    key={l.level}
                    className={cn(
                      'border-t border-ink-100',
                      current ? 'bg-brand-50 font-medium' : l.level > user.level && 'text-ink-400',
                    )}
                  >
                    <td className="px-3 py-2">
                      <LevelBadge level={l.level} />
                    </td>
                    <td className="px-3 py-2">
                      {l.name}
                      {current && <span className="ml-1.5 text-xs text-brand-600">当前</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{l.min_exp}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtBytes(l.quota_mb * 1024 ** 2)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4">
        <div className="mb-2 text-xs font-medium text-ink-500">如何获得经验</div>
        <div className="flex flex-wrap gap-1.5">
          {expRules.map(([label, n]) => (
            <span key={label} className="rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-700">
              {label} <b className="text-brand-600">+{n}</b>
            </span>
          ))}
        </div>
      </div>
    </Section>
  )
}

function StorageSection({ user }: { user: Me }) {
  const unlimited = user.storage_quota <= 0
  const ratio = unlimited ? 0 : user.storage_used / user.storage_quota
  const barCls = ratio > 0.9 ? 'bg-red-500' : ratio > 0.75 ? 'bg-amber-500' : 'bg-brand-gradient'
  return (
    <Section icon={<HardDrive className="size-4.5" />} title="存储空间">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span>
          已使用 <b className="tabular-nums">{fmtBytes(user.storage_used)}</b>
          <span className="text-ink-400"> / {unlimited ? '不限' : fmtBytes(user.storage_quota)}</span>
        </span>
        {!unlimited && <span className="text-ink-500 tabular-nums">{Math.round(ratio * 100)}%</span>}
      </div>
      {!unlimited && <ProgressBar value={ratio} className="mt-2.5" barCls={barCls} />}
      <p className="mt-2 text-xs text-ink-400">
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
    if (form.next.length < 6 || form.next.length > 64) return toast.error('新密码需为 6–64 位')
    if (form.next !== form.confirm) return toast.error('两次输入的新密码不一致')
    if (form.next === form.old) return toast.error('新密码不能与当前密码相同')
    m.mutate()
  }
  return (
    <Section icon={<KeyRound className="size-4.5" />} title="修改密码">
      <form className="space-y-4" onSubmit={submit}>
        <Field label="当前密码">
          <Input
            type="password"
            value={form.old}
            onChange={(e) => setForm({ ...form, old: e.target.value })}
            autoComplete="current-password"
          />
        </Field>
        <Field label="新密码" hint="6–64 位">
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

export default function SettingsPage() {
  const user = useAuth((s) => s.user)!
  // 等级、经验和存储空间以服务端为准：每次打开都刷新
  useEffect(() => {
    void useAuth.getState().refreshMe()
  }, [])
  return (
    <div className="mx-auto max-w-2xl space-y-5 px-4 py-6">
      <h1 className="text-2xl font-extrabold">账号设置</h1>
      <ProfileSection user={user} />
      <LevelSection user={user} />
      <StorageSection user={user} />
      <PasswordSection />
    </div>
  )
}
