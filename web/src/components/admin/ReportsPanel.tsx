import { useState } from 'react'
import { Link } from 'react-router'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, CircleCheck, CircleX } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, isNotFound, type Report } from '@/api'
import { Avatar, Button, Field, Modal, Pagination, Spinner, Switch, Textarea } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fmtTime, fromNow } from '@/lib/format'
import { ADMIN_PAGE_SIZE, isStalePage, monoAvatar, PanelHeader, PersonName, Pill, TextTabs, useFilters, usePageGuard } from './common'

type Status = Report['status']
type Target = Report['target_type']

// 待处理与侧栏角标、内容审核同一种朱砂小点；已处理象牙白点；已驳回无点
const statusMeta: Record<Status, { label: string; tone: 'brand' | 'ivory' | 'gray' }> = {
  pending: { label: '待处理', tone: 'brand' },
  resolved: { label: '已处理', tone: 'ivory' },
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
      if (action && alsoAct) {
        try {
          await moderate(report)
        } catch (e) {
          // 对象已不存在（作者自删、随旅程删除，或已在另一条举报里处理）：视为处置已完成，照常结案
          if (!isNotFound(e)) throw e
        }
      }
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
        <div className="border-l border-ink-300 py-1 pl-4">
          <p className="eyebrow">被举报{targetMeta[report.target_type].label} · 理由</p>
          <p className="font-display mt-2 text-[18px] leading-snug text-ink-900">{report.reason}</p>
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

/** 西文小标签 */
const targetEn: Record<Target, string> = { trip: 'Journey', comment: 'Comment', user: 'Member', place: 'Place' }

/**
 * 一条举报：左栏是类型、状态和举报人（说明文字对），右栏是宋体的举报理由、
 * 细线引文的被举报内容与操作；行间细线
 */
function ReportItem({ r, onHandle }: { r: Report; onHandle: (s: 'resolved' | 'rejected') => void }) {
  const link = targetLink(r)
  const meta = statusMeta[r.status]
  return (
    <article className="grid gap-x-8 gap-y-5 py-8 md:py-10 xl:grid-cols-12">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 xl:col-span-3 xl:block">
        <div>
          <p className="eyebrow">
            {targetEn[r.target_type] ?? 'Report'} · {targetMeta[r.target_type]?.label ?? r.target_type}
          </p>
          <div className="mt-3 flex items-center gap-3">
            <Avatar user={r.reporter} size={32} className={monoAvatar} />
            <div className="min-w-0">
              <PersonName user={r.reporter} handle={false} className="max-w-40 text-[14px]" />
              <p className="caption">{fromNow(r.created_at)} 举报</p>
            </div>
          </div>
        </div>
        <div className="xl:mt-5">
          <Pill tone={meta.tone}>{meta.label}</Pill>
        </div>
      </div>

      <div className="min-w-0 xl:col-span-9">
        <p className="font-display text-[length:var(--text-card)] leading-[1.45] break-words text-ink-900">{r.reason}</p>

        {/* 被举报内容：左侧细线引文 */}
        <div className="mt-5 flex items-start gap-4 border-l border-ink-300 py-1 pl-4">
          <p className="line-clamp-3 min-w-0 flex-1 text-[14px] leading-[1.8] break-words text-ink-500">
            {r.target_preview || <span className="text-ink-400">（内容已不存在）</span>}
          </p>
          {link && (
            <Link
              to={link}
              className="inline-flex h-8 shrink-0 items-center gap-1 text-[13px] text-ink-700 underline decoration-ink-300 underline-offset-4 transition-colors duration-300 hover:text-ink-900 hover:decoration-ink-900"
            >
              查看
              <ArrowUpRight className="size-3.5" strokeWidth={1.25} />
            </Link>
          )}
        </div>

        {r.status !== 'pending' && (r.note || r.handled_at) && (
          <p className="caption mt-4">
            {r.handled_at && (
              <>
                <span className="font-num text-[15px] text-ink-700">{fmtTime(r.handled_at)}</span> {meta.label}
              </>
            )}
            {r.note && <span>{r.handled_at ? ' · ' : ''}备注：{r.note}</span>}
          </p>
        )}

        {/* 一列待处理的举报里不出现一串实心按钮：处理是细线胶囊，驳回是纯文字 */}
        {r.status === 'pending' && (
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" icon={<CircleX className="size-4" strokeWidth={1.5} />} onClick={() => onHandle('rejected')}>
              驳回
            </Button>
            <Button variant="outline" icon={<CircleCheck className="size-4" strokeWidth={1.5} />} onClick={() => onHandle('resolved')}>
              处理
            </Button>
          </div>
        )}
      </div>
    </article>
  )
}

export function ReportsPanel() {
  const { f, set, setPage } = useFilters<{ status: Status | '' }>({ status: 'pending' })
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin', 'reports', f],
    queryFn: () => api.admin.reports({ ...f, page_size: ADMIN_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  })
  usePageGuard(data, setPage)
  const [handling, setHandling] = useState<{ report: Report; status: 'resolved' | 'rejected' } | null>(null)

  return (
    <div>
      <PanelHeader
        eyebrow="Reports · 举报"
        title="举报处理"
        desc={
          data ? (
            <>
              共 <span className="font-num text-[17px] text-ink-900">{data.total}</span> 条
            </>
          ) : undefined
        }
        extra={
          <TextTabs<Status | ''>
            label="状态"
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
      {/* 处理掉当前页最后一条后先显示加载中，退回上一页后再显示结果（而不是「没有待处理的举报」） */}
      {isLoading || isStalePage(data) ? (
        <div className="flex justify-center border-y border-ink-200 py-20">
          <Spinner className="size-6" />
        </div>
      ) : !data?.items.length ? (
        // 空状态：左对齐的一句宋体 + 灰色说明，不用图标
        <div className="animate-fade-in border-y border-ink-200 py-14 md:py-20">
          <p className="text-display-md font-normal text-ink-900">{f.status === 'pending' ? '社区一切正常。' : '暂无举报记录。'}</p>
          <p className="caption mt-4">
            {f.status === 'pending' ? '没有待处理的举报；有新举报时，导航里会出现一粒小圆点。' : '这里会列出处理过的举报与备注。'}
          </p>
        </div>
      ) : (
        <div className={cn('transition-opacity duration-300', isFetching && 'opacity-60')}>
          <div className="divide-y divide-ink-200 border-y border-ink-200">
            {data.items.map((r) => (
              <ReportItem key={r.id} r={r} onHandle={(status) => setHandling({ report: r, status })} />
            ))}
          </div>
          <div className="pt-6">
            <Pagination page={f.page} total={data.total} pageSize={ADMIN_PAGE_SIZE} onChange={setPage} />
          </div>
        </div>
      )}
      {handling && <HandleDialog report={handling.report} status={handling.status} onClose={() => setHandling(null)} />}
    </div>
  )
}
