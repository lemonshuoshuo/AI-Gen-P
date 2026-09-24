import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage } from '@/api'
import { Button, Card, Empty, Field, Input, PageLoader, Switch, Textarea } from '@/components/ui'
import { PanelHeader } from './common'

type SiteSettings = Awaited<ReturnType<typeof api.admin.settings>>

function SettingsForm({ initial }: { initial: SiteSettings }) {
  const qc = useQueryClient()
  const [form, setForm] = useState(initial)
  const dirty =
    form.site_name !== initial.site_name ||
    form.announcement !== initial.announcement ||
    form.registration_open !== initial.registration_open

  const save = useMutation({
    mutationFn: () =>
      api.admin.saveSettings({ ...form, site_name: form.site_name.trim(), announcement: form.announcement.trim() }),
    onSuccess: () => {
      toast.success('设置已保存')
      qc.invalidateQueries({ queryKey: ['admin', 'settings'] })
      // 顶部公告等前台配置
      qc.invalidateQueries({ queryKey: ['site'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!form.site_name.trim()) return toast.error('站点名称不能为空')
        save.mutate()
      }}
    >
      <Card className="space-y-5 p-4 sm:p-5">
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
            maxLength={300}
            placeholder="例如：国庆期间服务器维护，届时可能短暂无法访问"
          />
        </Field>
        <div className="flex items-center justify-between gap-4 rounded-xl bg-ink-50 p-3">
          <div>
            <div className="text-sm font-medium text-ink-700">开放注册</div>
            <div className="text-xs text-ink-400">关闭后新用户将无法注册，已有用户不受影响</div>
          </div>
          <Switch checked={form.registration_open} onChange={(v) => setForm({ ...form, registration_open: v })} />
        </div>
        {form.announcement.trim() && (
          <div>
            <div className="mb-1.5 text-xs text-ink-400">公告预览</div>
            <div className="rounded-xl bg-brand-50 px-3 py-2 text-sm text-brand-800">📢 {form.announcement.trim()}</div>
          </div>
        )}
      </Card>
      <div className="mt-4 flex justify-end gap-2">
        {dirty && (
          <Button variant="ghost" onClick={() => setForm(initial)}>
            撤销修改
          </Button>
        )}
        <Button type="submit" disabled={!dirty} loading={save.isPending} icon={<Save className="size-4" />}>
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
      <PanelHeader title="站点设置" desc="修改后对所有用户立即生效" />
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
