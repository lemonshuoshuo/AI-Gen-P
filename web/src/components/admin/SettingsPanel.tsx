import { useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, FileText, Save } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/api'
import { Button, buttonClass, Empty, Field, Input, PageLoader, Switch, Textarea } from '@/components/ui'
import { cn } from '@/lib/cn'
import { LabelRow, PanelHeader } from './common'

type SiteSettings = Awaited<ReturnType<typeof api.admin.settings>>
type LegalDoc = 'terms' | 'privacy'

const legalFields: { doc: LegalDoc; key: 'terms_md' | 'privacy_md'; label: string }[] = [
  { doc: 'terms', key: 'terms_md', label: '用户协议' },
  { doc: 'privacy', key: 'privacy_md', label: '隐私政策' },
]

/** 屏蔽词个数：与服务端一样按换行和中英文逗号分隔 */
const countWords = (s: string) =>
  s
    .split(/[\n,，]+/)
    .map((w) => w.trim())
    .filter(Boolean).length

/** 一组设置（Exemplar 式区块）：细线标签行，下面左栏宋体标题 + 说明，右栏表单 */
function Section({
  eyebrow,
  index,
  title,
  desc,
  children,
}: {
  eyebrow: string
  index: number
  title: string
  desc?: ReactNode
  children: ReactNode
}) {
  return (
    <section>
      <LabelRow label={eyebrow} count={String(index).padStart(2, '0')} />
      <div className="mt-8 grid gap-x-10 gap-y-8 md:mt-10 xl:grid-cols-12">
        <div className="xl:col-span-4">
          <h2 className="font-display text-[1.75rem] leading-tight font-normal md:text-[2.125rem]">{title}</h2>
          {desc && <p className="mt-3 max-w-xs text-[13px] leading-[1.8] text-pretty text-ink-500">{desc}</p>}
        </div>
        <div className="min-w-0 space-y-7 xl:col-span-8">{children}</div>
      </div>
    </section>
  )
}

/** 开关行：左侧亮色标题 + 灰色说明，右侧开关；上下细线，不装进有底色的盒子 */
function SwitchRow({
  title,
  desc,
  checked,
  onChange,
}: {
  title: string
  desc: ReactNode
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-y border-ink-200 py-5">
      <div className="min-w-0">
        <div className="text-[14px] text-ink-900">{title}</div>
        <div className="caption mt-1 max-w-xl leading-relaxed">{desc}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={<span className="sr-only">{title}</span>} />
    </div>
  )
}

function LegalField({
  doc,
  label,
  value,
  onChange,
  canLoad,
  loading,
  onLoad,
}: {
  doc: LegalDoc
  label: string
  value: string
  onChange: (v: string) => void
  canLoad: boolean
  loading: boolean
  onLoad: () => void
}) {
  const id = useId()
  return (
    <div>
      {/* 标题行不用 Field：<label> 会把点击转给它里面的第一个按钮 */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium tracking-[0.06em] text-ink-500">
          {label}
        </label>
        <div className="flex items-center gap-1">
          {canLoad && (
            <Button size="xs" variant="ghost" className="max-sm:h-10" loading={loading} icon={<FileText className="size-3.5" strokeWidth={1.75} />} onClick={onLoad}>
              载入内置模板
            </Button>
          )}
          <Link
            to={`/legal/${doc}`}
            target="_blank"
            rel="noopener"
            title="在新标签页查看已保存的版本"
            className={buttonClass({ variant: 'ghost', size: 'xs', className: 'max-sm:h-10' })}
          >
            <ExternalLink className="size-3.5" strokeWidth={1.75} />
            预览
          </Link>
        </div>
      </div>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={20000}
        placeholder="留空则使用内置模板"
        className="min-h-60 font-mono text-xs"
      />
    </div>
  )
}

function SettingsForm({ initial }: { initial: SiteSettings }) {
  const qc = useQueryClient()
  const [form, setForm] = useState(initial)
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)

  const save = useMutation({
    mutationFn: (f: SiteSettings) =>
      api.admin.saveSettings({
        ...f,
        site_name: f.site_name.trim(),
        announcement: f.announcement.trim(),
        icp_beian: f.icp_beian.trim(),
        police_beian: f.police_beian.trim(),
      }),
    onSuccess: (saved, sent) => {
      toast.success('设置已保存')
      // 服务端会去掉首尾空白：保存期间没有再改动时换成保存后的值，否则会一直显示有未保存的修改
      setForm((cur) => (cur === sent ? saved : cur))
      qc.setQueryData(['admin', 'settings'], saved)
      qc.invalidateQueries({ queryKey: ['admin', 'settings'] })
      // 顶部公告、页脚备案号等前台配置，以及用户协议 / 隐私政策页
      qc.invalidateQueries({ queryKey: ['site'] })
      qc.invalidateQueries({ queryKey: ['legal'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  // 已保存的内容为空时，服务端返回内置模板（其中的 {{site}} 已换成站点名称）
  const template = useMutation({
    mutationFn: (doc: LegalDoc) => api.legal(doc),
    onSuccess: ({ content }, doc) => {
      const key = legalFields.find((l) => l.doc === doc)!.key
      // 等待期间已经输入了内容：不覆盖
      setForm((f) => (f[key].trim() ? f : { ...f, [key]: content }))
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!form.site_name.trim()) return toast.error('站点名称不能为空')
        save.mutate(form)
      }}
    >
      <div className="space-y-20 md:space-y-28">
        <Section eyebrow="General · 基本" index={1} title="基本信息" desc="站点名称、顶部公告与注册开关">
          <Field label="站点名称">
            <Input
              value={form.site_name}
              onChange={(e) => setForm({ ...form, site_name: e.target.value })}
              maxLength={30}
              placeholder="TripHub"
            />
          </Field>
          <Field label="站点公告" hint="显示在所有页面顶部，留空则不显示">
            <Textarea
              value={form.announcement}
              onChange={(e) => setForm({ ...form, announcement: e.target.value })}
              maxLength={500}
              placeholder="例如：国庆期间服务器维护，届时可能短暂无法访问"
            />
          </Field>
          <SwitchRow
            title="开放注册"
            desc="关闭后新用户将无法注册，已有用户不受影响"
            checked={form.registration_open}
            onChange={(v) => setForm({ ...form, registration_open: v })}
          />
          {form.announcement.trim() && (
            <div>
              <div className="mb-2 text-xs font-medium tracking-[0.06em] text-ink-500">公告预览</div>
              <div className="flex items-baseline gap-4 border-y border-ink-200 py-3 text-[13.5px] text-ink-700">
                <span className="eyebrow shrink-0 !text-brand-600">Notice</span>
                <span className="min-w-0 break-words">{form.announcement.trim()}</span>
              </div>
            </div>
          )}
        </Section>

        <Section eyebrow="Filing · 备案" index={2} title="备案信息" desc="显示在所有页面的页脚">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="ICP 备案号" hint="显示在网站页脚，链接到工信部备案系统">
              <Input
                value={form.icp_beian}
                onChange={(e) => setForm({ ...form, icp_beian: e.target.value })}
                maxLength={50}
                placeholder="如：京ICP备12345678号-1"
              />
            </Field>
            <Field label="公安联网备案号" hint="显示在页脚，链接到全国互联网安全管理服务平台">
              <Input
                value={form.police_beian}
                onChange={(e) => setForm({ ...form, police_beian: e.target.value })}
                maxLength={60}
                placeholder="如：京公网安备11010502000001号"
              />
            </Field>
          </div>
        </Section>

        <Section eyebrow="Safety · 安全" index={3} title="内容安全" desc="公开旅程审核与屏蔽词">
          <SwitchRow
            title="公开旅程需审核"
            desc="开启后，普通用户新公开的旅程要在「内容管理 → 待审核」中通过后才会出现在广场、搜索和地点统计中；已公开的旅程不受影响，关闭后队列中的旅程不会自动通过"
            checked={form.review_public_trips}
            onChange={(v) => setForm({ ...form, review_public_trips: v })}
          />
          <Field
            label={
              <span className="flex items-baseline justify-between gap-2">
                屏蔽词
                <span className="text-xs font-normal text-ink-400">
                  已设置 <span className="font-num">{countWords(form.sensitive_words)}</span> 个
                </span>
              </span>
            }
            hint="每行一个，也可用逗号分隔。用户提交的标题、正文、评论、打卡点、昵称等包含屏蔽词时会被拒绝（忽略大小写、全半角、空格和符号）；管理员不受限制；已发布的内容不会被追溯处理"
          >
            <Textarea
              value={form.sensitive_words}
              onChange={(e) => setForm({ ...form, sensitive_words: e.target.value })}
              maxLength={100000}
              className="min-h-32 font-mono text-xs"
            />
          </Field>
        </Section>

        <Section
          eyebrow="Legal · 条款"
          index={4}
          title="用户协议与隐私政策"
          desc={
            <>
              Markdown 格式，可用 <code className="rounded-sm bg-ink-100 px-1 font-mono text-ink-700">{'{{site}}'}</code>{' '}
              代表站点名称；留空时使用内置模板（请把模板中的【运营者名称】【联系邮箱】改成实际信息）
            </>
          }
        >
          {legalFields.map(({ doc, key, label }) => (
            <LegalField
              key={doc}
              doc={doc}
              label={label}
              value={form[key]}
              onChange={(v) => setForm({ ...form, [key]: v })}
              // 已保存了自定义内容时服务端返回的是它而不是模板：只在两者都为空时提供
              canLoad={!form[key].trim() && !initial[key].trim()}
              loading={template.isPending && template.variables === doc}
              onLoad={() => template.mutate(doc)}
            />
          ))}
        </Section>
      </div>

      {/* 有未保存的修改时吸底，长表单中随时可以保存；手机上留出底部导航的位置 */}
      <div
        className={cn(
          'mt-12 flex items-center justify-end gap-2 border-t border-ink-200 pt-6',
          dirty &&
            'glass sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 border-b px-4 pb-4 md:bottom-0 md:mx-0 md:px-0 md:pb-6',
        )}
      >
        {dirty && (
          <span className="mr-auto flex items-center gap-2 text-[13px] text-ink-500">
            <span className="size-1.5 rounded-full bg-brand-500" aria-hidden />
            有未保存的修改
          </span>
        )}
        {dirty && (
          <Button variant="ghost" onClick={() => setForm(initial)}>
            撤销修改
          </Button>
        )}
        {/* 没有修改时是细线胶囊，不是一块发灰的实心按钮 */}
        <Button
          type="submit"
          variant={dirty ? 'primary' : 'outline'}
          className={dirty ? undefined : 'disabled:border-ink-300 disabled:text-ink-400 disabled:opacity-100'}
          disabled={!dirty}
          loading={save.isPending}
          icon={<Save className="size-4" strokeWidth={1.5} />}
        >
          保存设置
        </Button>
      </div>
    </form>
  )
}

export function SettingsPanel() {
  const { data, isLoading, error } = useQuery({ queryKey: ['admin', 'settings'], queryFn: api.admin.settings })
  return (
    <div>
      <PanelHeader eyebrow="Site · 站点" title="站点设置" desc="修改后对所有用户立即生效" />
      {isLoading ? (
        <PageLoader />
      ) : data ? (
        <SettingsForm initial={data} />
      ) : (
        <Empty title="加载失败" desc={errorMessage(error)} />
      )}
    </div>
  )
}
