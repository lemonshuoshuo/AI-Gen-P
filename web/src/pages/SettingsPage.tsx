import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Camera } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Me } from '@/api'
import { Avatar, Button, Field, Input, Modal, Textarea } from '@/components/ui'
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

const sectionIds = [
  ['profile', '资料'],
  ['level', '等级'],
  ['storage', '存储'],
  ['security', '密码'],
  ['delete', '注销'],
] as const

/** 字节数去掉多余的 0：「133.0 KB」→「133 KB」，「1.00 GB」→「1 GB」 */
const tidyBytes = (n: number) =>
  fmtBytes(n)
    .replace(/\.0+(?=\s)/, '')
    .replace(/(\.\d*?)0+(?=\s)/, '$1')

/** 默认头像：近黑底 + 细线圈 + 象牙白首字，不用彩色圆片 */
const monoAvatar = '!bg-surface-2 ring-1 ring-inset ring-ink-300 !text-ink-800'

/** 细线标签行：一条 border-t，左侧 eyebrow + 灰色序号，右侧补充 */
function LabelRow({ label, count, extra }: { label: ReactNode; count?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-ink-200 pt-3 pb-1">
      <p className="flex min-w-0 items-baseline gap-3">
        <span className="eyebrow !text-ink-800">{label}</span>
        {count != null && <span className="font-num text-[13px] text-ink-400">{count}</span>}
      </p>
      {extra}
    </div>
  )
}

/**
 * 一组设置（Exemplar 式区块）：细线标签行，下面左栏宋体标题 + 说明，右栏是一行行的设置。
 */
function Section({
  id,
  eyebrow,
  index,
  title,
  desc,
  children,
}: {
  id: string
  eyebrow: string
  index: number
  title: string
  desc?: ReactNode
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="animate-slide-up scroll-mt-24 [animation-fill-mode:backwards]" style={{ animationDelay: `${index * 70}ms` }}>
      <LabelRow label={eyebrow} count={String(index + 1).padStart(2, '0')} />
      {/* 与「我的」「通知」同一套 12 栏：内容从第 5 栏起排 */}
      <div className="mt-8 grid gap-x-8 gap-y-8 md:mt-12 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <h2 id={`${id}-title`} className="text-display-md font-normal">
            {title}
          </h2>
          {desc && <p className="mt-4 max-w-xs text-[13.5px] leading-[1.8] text-pretty text-ink-500">{desc}</p>}
        </div>
        <div className="min-w-0 lg:col-span-8">{children}</div>
      </div>
    </section>
  )
}

/** 一行设置：左侧亮色标签 + 灰色说明，右侧控件；行间细线（由外层 divide-y 负责） */
function Row({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
  className?: string
}) {
  const Label = htmlFor ? 'label' : 'p'
  return (
    <div className={cn('grid gap-x-8 gap-y-3 py-6 sm:grid-cols-[11rem_minmax(0,1fr)] md:grid-cols-[13rem_minmax(0,1fr)]', className)}>
      <div className="flex items-baseline justify-between gap-4 sm:block sm:pt-2.5">
        <Label htmlFor={htmlFor} className="block text-[13px] text-ink-900">
          {label}
        </Label>
        {hint && <p className="caption sm:mt-0.5">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** 未修改时的提交按钮：一道看得清的细线胶囊 + 灰字（而不是整体降到 40% 的实心块） */
const idleBtn = 'disabled:border-ink-300 disabled:text-ink-400 disabled:opacity-100'

/** 表单尾部：右对齐的操作 */
function Actions({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 pt-6">{children}</div>
}

/** 极细的进度线：一道淡细线上叠一段象牙白，当前位置一粒小点 */
function ProgressLine({ value, className, label, dotCls = 'bg-brand-500' }: { value: number; className?: string; label: string; dotCls?: string }) {
  const pct = Math.min(100, Math.max(0, value * 100))
  return (
    <div
      className={cn('relative h-px bg-ink-300', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div className="absolute inset-y-0 left-0 bg-ink-900 transition-all duration-700" style={{ width: `${pct}%` }} />
      <span
        className={cn('absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 ring-paper', dotCls)}
        style={{ left: `${pct}%` }}
        aria-hidden
      />
    </div>
  )
}

function ProfileSection({ user }: { user: Me }) {
  const setUser = useAuth((s) => s.setUser)
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const uid = useId()
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
    <Section id="profile" index={0} eyebrow="Profile · 资料" title="个人资料" desc="头像、昵称与简介会显示在你的主页和公开旅程上。">
      <div className="divide-y divide-ink-200 border-y border-ink-200">
        <Row label="头像" hint="JPG / PNG / WebP，会自动压缩">
          <div className="flex items-center gap-5">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={avatar.isPending}
              className="group relative shrink-0 overflow-hidden rounded-full"
              aria-label="更换头像"
            >
              <Avatar user={user} size={64} className={cn(monoAvatar, 'transition-transform duration-700 ease-out group-hover:scale-[1.03]')} />
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                <Camera className="size-5" strokeWidth={1.25} />
              </span>
            </button>
            <Button variant="outline" size="sm" loading={avatar.isPending} onClick={() => fileRef.current?.click()} className="max-sm:h-10">
              更换头像
            </Button>
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
        </Row>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!nickname.trim()) return toast.error('昵称不能为空')
          save.mutate()
        }}
      >
        <div className="divide-y divide-ink-200 border-b border-ink-200">
          <Row label="用户名" hint="不可修改" htmlFor={`${uid}-u`}>
            <Input id={`${uid}-u`} value={user.username} disabled className="max-w-md border-transparent bg-transparent px-0 font-num text-lg hover:border-transparent disabled:opacity-100" />
          </Row>
          <Row label="昵称" hint="最多 20 字" htmlFor={`${uid}-n`}>
            <Input
              id={`${uid}-n`}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={20}
              placeholder="给自己起个名字"
              className="max-w-md"
            />
          </Row>
          <Row
            label="个人简介"
            hint={
              <>
                <span className="font-num">{bio.length}</span> / <span className="font-num">200</span>
              </>
            }
            htmlFor={`${uid}-b`}
          >
            <Textarea
              id={`${uid}-b`}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={200}
              placeholder="介绍一下自己，喜欢去哪里旅行？"
              className="max-w-md"
            />
          </Row>
          <Row label="邮箱" hint="可用于登录" htmlFor={`${uid}-e`}>
            <Input
              id={`${uid}-e`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              autoComplete="email"
              className="max-w-md"
            />
          </Row>
        </div>
        <Actions>
          {/* 没有修改时是细线胶囊，有修改才变成象牙白实心 */}
          <Button type="submit" variant={dirty ? 'primary' : 'outline'} className={dirty ? undefined : idleBtn} disabled={!dirty} loading={save.isPending}>
            保存资料
          </Button>
        </Actions>
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
    <Section
      id="level"
      index={1}
      eyebrow="Level · 等级"
      title="等级与经验"
      desc="记录旅程、分享照片、获得点赞都会积累经验；等级越高，存储空间越大。"
    >
      {/* 大号细字数字 + 说明文字对 */}
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="flex items-baseline gap-3">
          <span className="font-num text-[5rem] leading-[0.85] font-light text-ink-900 md:text-[7.5rem]">{user.exp}</span>
          <span className="text-[13px] text-ink-500">
            {nextExp ? (
              <>
                / <span className="font-num text-xl">{nextExp}</span> 经验
              </>
            ) : (
              '经验'
            )}
          </span>
        </div>
        <div className="pb-1 sm:text-right">
          <p className="text-[13px] text-ink-900">
            <span className="font-num italic">Lv.{user.level}</span> · {user.level_name}
          </p>
          <p className="caption mt-0.5">
            {nextExp ? (
              <>
                再获得 <span className="font-num text-[15px] text-ink-700">{Math.max(0, nextExp - user.exp)}</span> 经验升级到{' '}
                <span className="font-num italic">Lv.{user.level + 1}</span>
                {next ? `「${next.name}」` : ''}
              </>
            ) : (
              '已达到最高等级'
            )}
          </p>
        </div>
      </div>
      <ProgressLine value={progress} label="升级进度" className="mt-8" />

      {levels.length > 0 && (
        <div className="mt-16 md:mt-20">
          <p className="eyebrow">Levels · 等级一览</p>
          <table className="mt-4 w-full text-[14px]">
            <thead>
              <tr className="border-y border-ink-200 text-left">
                <th className="eyebrow py-3 pr-3 !font-medium">等级</th>
                <th className="eyebrow px-3 py-3 !font-medium">称号</th>
                <th className="eyebrow px-3 py-3 text-right !font-medium">所需经验</th>
                <th className="eyebrow py-3 pl-3 text-right !font-medium">存储空间</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((l) => {
                const current = l.level === user.level
                return (
                  <tr key={l.level} className={cn('border-b border-ink-200', l.level > user.level ? 'text-ink-500' : 'text-ink-700')}>
                    <td className="py-4 pr-3">
                      <span className={cn('font-num text-[15px] italic', current && 'text-ink-900')}>Lv.{l.level}</span>
                    </td>
                    <td className="px-3 py-4">
                      <span className={cn('font-display text-[17px]', current && 'text-ink-900')}>{l.name}</span>
                      {current && (
                        <span className="ml-3 inline-flex items-center gap-1.5 align-middle text-[12px] text-ink-700">
                          <span className="size-1.5 rounded-full bg-brand-500" aria-hidden />
                          当前
                        </span>
                      )}
                    </td>
                    <td className="font-num px-3 py-4 text-right text-[16px]">{l.min_exp}</td>
                    <td className="font-num py-4 pl-3 text-right text-[16px] whitespace-nowrap">{tidyBytes(l.quota_mb * 1024 ** 2)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-16 md:mt-20">
        <p className="eyebrow">How to earn · 如何获得经验</p>
        {/* 像一份价目表：名称 …… 经验值 */}
        <dl className="mt-4 grid gap-x-12 border-t border-ink-200 sm:grid-cols-2">
          {expRules.map(([label, n]) => (
            <div key={label} className="flex items-baseline gap-2 border-b border-ink-200 py-3.5">
              <dt className="text-[14px] text-ink-600">{label}</dt>
              <dd className="font-num ml-auto text-xl leading-none font-light text-ink-900">+{n}</dd>
            </div>
          ))}
        </dl>
        {site && (
          <p className="caption mt-4">
            每天最多获得 <span className="font-num text-[15px] text-ink-700">{site.exp_daily_cap}</span> 经验（被设为精选不受此限制）
          </p>
        )}
      </div>
    </Section>
  )
}

function StorageSection({ user }: { user: Me }) {
  const unlimited = user.storage_quota <= 0
  const ratio = unlimited ? 0 : user.storage_used / user.storage_quota
  // 快满时小点变成赭黄 / 朱砂
  const dotCls = ratio > 0.9 ? 'bg-brand-500' : ratio > 0.75 ? 'bg-amber-500' : 'bg-ink-900'
  const [used, usedUnit] = tidyBytes(user.storage_used).split(' ')
  return (
    <Section id="storage" index={2} eyebrow="Storage · 存储" title="存储空间" desc="照片和 GPS 轨迹会占用存储空间。">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="flex items-baseline gap-2">
          <span className="font-num text-[5rem] leading-[0.85] font-light text-ink-900 md:text-[7.5rem]">{used}</span>
          <span className="font-num text-xl text-ink-500">{usedUnit}</span>
        </div>
        <div className="pb-1 sm:text-right">
          <p className="text-[13px] text-ink-900">
            {unlimited ? (
              '不限容量'
            ) : (
              <>
                共 <span className="font-num text-[15px]">{tidyBytes(user.storage_quota)}</span> · 已用{' '}
                <span className="font-num text-[15px]">{Math.round(ratio * 100)}%</span>
              </>
            )}
          </p>
          <p className="caption mt-0.5">
            {unlimited
              ? '管理员账号不受存储空间限制'
              : ratio > 0.9
                ? '存储空间快用完了，提升等级可以获得更多空间'
                : '等级越高，空间越大'}
          </p>
        </div>
      </div>
      {!unlimited && <ProgressLine value={ratio} label="存储空间使用比例" dotCls={dotCls} className="mt-8" />}
      {unlimited && <div className="mt-8 h-px bg-ink-200" />}
    </Section>
  )
}

function PasswordSection() {
  const uid = useId()
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
  const ready = !!form.old && !!form.next && !!form.confirm
  return (
    <Section id="security" index={3} eyebrow="Security · 安全" title="修改密码" desc="修改后，其他设备上的登录会失效，需要重新登录。">
      <form onSubmit={submit}>
        <div className="divide-y divide-ink-200 border-y border-ink-200">
          <Row label="当前密码" htmlFor={`${uid}-o`}>
            <Input
              id={`${uid}-o`}
              type="password"
              value={form.old}
              onChange={(e) => setForm({ ...form, old: e.target.value })}
              autoComplete="current-password"
              className="max-w-md"
            />
          </Row>
          <Row label="新密码" hint="8–64 位" htmlFor={`${uid}-n`}>
            <Input
              id={`${uid}-n`}
              type="password"
              value={form.next}
              onChange={(e) => setForm({ ...form, next: e.target.value })}
              autoComplete="new-password"
              className="max-w-md"
            />
          </Row>
          <Row label="确认新密码" htmlFor={`${uid}-c`}>
            <Input
              id={`${uid}-c`}
              type="password"
              value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
              autoComplete="new-password"
              className="max-w-md"
            />
          </Row>
        </div>
        <Actions>
          <Button type="submit" variant={ready ? 'primary' : 'outline'} className={ready ? undefined : idleBtn} disabled={!ready} loading={m.isPending}>
            修改密码
          </Button>
        </Actions>
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
    <Section id="delete" index={4} eyebrow="Danger zone · 注销" title="注销账号" desc="注销后账号无法恢复，请谨慎操作。">
      <div className="border-y border-ink-200 py-6">
        <p className="max-w-2xl text-[14px] leading-[1.9] text-ink-600">
          只有你能编辑的旅程会被删除（含照片、轨迹和评论）；有其他共同作者的旅程会转交给最早加入的共同作者；你上传的照片和 GPS
          轨迹全部删除，你的评论显示为「已删除」；点赞、收藏、关注、情侣绑定和所有设备上的登录都会解除。
          <Link to="/legal/privacy" className="ml-1 text-ink-900 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-900">
            详见《隐私政策》
          </Link>
        </p>
        {isAdmin(user) ? (
          <p className="mt-6 border-l border-ink-500 py-1 pl-4 text-[13.5px] leading-relaxed text-ink-700">
            管理员账号不能注销；如需注销，请先让其他管理员取消你的管理员权限。
          </p>
        ) : (
          <div className="mt-6 flex justify-end">
            <Button variant="danger" onClick={() => setOpen(true)}>
              注销账号
            </Button>
          </div>
        )}
      </div>
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
    <div className="mx-auto max-w-[90rem] px-4 pt-10 pb-24 [font-variant-numeric:lining-nums] md:px-8 md:pt-20 md:pb-32">
      {/* 页头：细线标签行 + 大号宋体标题；右栏导语与本页目录 */}
      <header className="animate-slide-up">
        <LabelRow label="Account · 账号" extra={<span className="text-[13px] text-ink-400">@{user.username}</span>} />
        <div className="mt-10 grid gap-x-8 gap-y-8 md:mt-16 lg:grid-cols-12 lg:items-end">
          <h1 className="text-display-lg font-normal max-sm:text-[3.25rem] lg:col-span-7">账号设置</h1>
          <div className="lg:col-span-4 lg:col-start-9 lg:pb-3">
            <p className="max-w-sm text-[14.5px] leading-[1.8] text-ink-500">个人资料、等级经验、存储空间与账号安全。</p>
            <nav aria-label="本页目录" className="mt-6 hidden flex-wrap gap-x-6 gap-y-1 lg:flex">
              {sectionIds.map(([id, label], i) => (
                <a
                  key={id}
                  href={`#${id}`}
                  className="inline-flex h-8 items-baseline gap-1.5 text-[13px] text-ink-500 transition-colors duration-300 hover:text-ink-900"
                >
                  <span className="font-num text-ink-400">{String(i + 1).padStart(2, '0')}</span>
                  {label}
                </a>
              ))}
            </nav>
          </div>
        </div>
      </header>
      <div className="mt-20 space-y-24 md:mt-32 md:space-y-36">
        <ProfileSection user={user} />
        <LevelSection user={user} />
        <StorageSection user={user} />
        <PasswordSection />
        <DeleteAccountSection user={user} />
      </div>
    </div>
  )
}
