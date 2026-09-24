import { useState } from 'react'
import { Link } from 'react-router'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, CircleCheck, CircleX, Flag, Inbox } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type Report } from '@/api'
import { Avatar, Button, Card, Empty, Field, Modal, Pagination, Segmented, Spinner, Switch, Textarea, UserName } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fmtTime, fromNow } from '@/lib/format'
import { ADMIN_PAGE_SIZE, PanelHeader, Pill, useFilters } from './common'

type Status = Report['status']
type Target = Report['target_type']

const statusMeta: Record<Status, { label: string; tone: 'amber' | 'green' | 'gray' }> = {
  pending: { label: '待处理', tone: 'amber' },
  resolved: { label: '已处理', tone: 'green' },
  rejected: { label: '已驳回', tone: 'gray' },
}

const targetMeta: Record<Target, { label: string; action?: string }> = {
  trip: { label: '旅程', action: '同时隐藏该旅程' },
  comment: { label: '评论', action: '同时删除该评论' },
  user: { label: '用户', action: '同时封禁该用户' },
  place: { label: '打卡地' },
}

/** 被举报用户的链接：优先取预览里的 @username，其次预览本身就是用户名 */
function userLinkOf(preview: string) {
  const m = preview.match(/@([A-Za-z0-9_]{3,20})/)
  if (m) return `/u/${m[1]}`
  const s = preview.trim()
  return /^[A-Za-z0-9_]{3,20}$/.test(s) ? `/u/${s}` : null
}

function targetLink(r: Report) {
  switch (r.target_type) {
    case 'trip':
      return `/trips/${r.target_id}`
    case 'place':
      return `/places/${r.target_id}`
    case 'user':
      return userLinkOf(r.target_preview)
    default:
      return null
  }
}

/** 对被举报对象执行处置动作 */
function moderate(r: Report) {
  switch (r.target_type) {
    case 'trip':
      return api.admin.updateTrip(r.target_id, { status: 'hidden' })
    case 'comment':
      return api.admin.deleteComment(r.target_id)
    case 'user':
      return api.admin.updateUser(r.target_id, { status: 'banned' })
    default:
      return Promise.resolve()
  }
}

function HandleDialog({ report, status, onClose }: { report: Report; status: 'resolved' | 'rejected'; onClose: () => void }) {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const action = status === 'resolved' ? targetMeta[report.target_type].action : undefined
  const [alsoAct, setAlsoAct] = useState(false)
  const m = useMutation({
    mutationFn: async () => {
      if (action && alsoAct) await moderate(report)
      return api.admin.updateReport(report.id, { status, note: note.trim() || undefined })
    },
    onSuccess: () => {
      toast.success(status === 'resolved' ? '举报已处理' : '举报已驳回')
      qc.invalidateQueries({ queryKey: ['admin'] })
      onClose()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <Modal
      open
      onClose={onClose}
      title={status === 'resolved' ? '处理举报' : '驳回举报'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant={status === 'resolved' ? 'primary' : 'dark'} loading={m.isPending} onClick={() => m.mutate()}>
            {status === 'resolved' ? '确认处理' : '确认驳回'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl bg-ink-50 p-3 text-sm">
          <div className="text-xs text-ink-400">
            被举报{targetMeta[report.target_type].label} · 理由
          </div>
          <p className="mt-1 text-ink-900">{report.reason}</p>
        </div>
        {action && <Switch checked={alsoAct} onChange={setAlsoAct} label={action} />}
        <Field label="处理备注（可选）" hint="仅管理员可见">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder={status === 'resolved' ? '例如：内容违规，已隐藏' : '例如：内容正常，不予处理'}
          />
        </Field>
      </div>
    </Modal>
  )
}

function ReportCard({ r, onHandle }: { r: Report; onHandle: (s: 'resolved' | 'rejected') => void }) {
  const link = targetLink(r)
  const meta = statusMeta[r.status]
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Pill tone="sky">{targetMeta[r.target_type]?.label ?? r.target_type}</Pill>
        <Avatar user={r.reporter} size={22} />
        <UserName user={r.reporter} className="max-w-40 text-sm" />
        <span className="text-xs text-ink-400">{fromNow(r.created_at)} 举报</span>
        <span className="ml-auto">
          <Pill tone={meta.tone}>{meta.label}</Pill>
        </span>
      </div>

      <p className="mt-3 text-sm break-words text-ink-900">
        <Flag className="mr-1 inline size-3.5 -translate-y-px text-red-500" />
        {r.reason}
      </p>

      <div className="mt-3 flex items-start gap-3 rounded-xl bg-ink-50 p-3 text-sm">
        <p className="line-clamp-3 min-w-0 flex-1 break-words text-ink-500">
          {r.target_preview || <span className="text-ink-400">（内容已不存在）</span>}
        </p>
        {link && (
          <Link to={link} className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-brand-600 hover:underline">
            查看
            <ArrowUpRight className="size-3.5" />
          </Link>
        )}
      </div>

      {r.status !== 'pending' && (r.note || r.handled_at) && (
        <p className="mt-3 text-xs text-ink-400">
          {r.handled_at && `${fmtTime(r.handled_at)} ${meta.label}`}
          {r.note && <span className="text-ink-500">{r.handled_at ? ' · ' : ''}备注：{r.note}</span>}
        </p>
      )}

      {r.status === 'pending' && (
        <div className="mt-3 flex justify-end gap-2 border-t border-ink-100 pt-3">
          <Button size="sm" variant="outline" icon={<CircleX className="size-4" />} onClick={() => onHandle('rejected')}>
            驳回
          </Button>
          <Button size="sm" icon={<CircleCheck className="size-4" />} onClick={() => onHandle('resolved')}>
            处理
          </Button>
        </div>
      )}
    </Card>
  )
}

export function ReportsPanel() {
  const { f, set, setPage } = useFilters<{ status: Status | '' }>({ status: 'pending' })
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin', 'reports', f],
    queryFn: () => api.admin.reports({ ...f, page_size: ADMIN_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  })
  const [handling, setHandling] = useState<{ report: Report; status: 'resolved' | 'rejected' } | null>(null)

  return (
    <div>
      <PanelHeader
        title="举报处理"
        desc={data ? `共 ${data.total} 条` : undefined}
        extra={
          <Segmented<Status | ''>
            size="sm"
            value={f.status}
            onChange={(status) => set({ status })}
            options={[
              { value: 'pending', label: '待处理' },
              { value: 'resolved', label: '已处理' },
              { value: 'rejected', label: '已驳回' },
              { value: '', label: '全部' },
            ]}
          />
        }
      />
      {isLoading ? (
        <Card className="flex justify-center py-16">
          <Spinner className="size-6" />
        </Card>
      ) : !data?.items.length ? (
        <Card>
          <Empty
            icon={<Inbox className="size-10" />}
            title={f.status === 'pending' ? '没有待处理的举报' : '暂无举报记录'}
            desc={f.status === 'pending' ? '社区一切正常 🎉' : undefined}
          />
        </Card>
      ) : (
        <div className={cn('transition-opacity', isFetching && 'opacity-60')}>
          <div className="space-y-3">
            {data.items.map((r) => (
              <ReportCard key={r.id} r={r} onHandle={(status) => setHandling({ report: r, status })} />
            ))}
          </div>
          <Pagination page={f.page} total={data.total} pageSize={ADMIN_PAGE_SIZE} onChange={setPage} />
        </div>
      )}
      {handling && <HandleDialog report={handling.report} status={handling.status} onClose={() => setHandling(null)} />}
    </div>
  )
}
