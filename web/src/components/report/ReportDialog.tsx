import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, errorMessage, type Report } from '@/api'
import { Button, Modal, Textarea } from '@/components/ui'
import { cn } from '@/lib/cn'

export type ReportTarget = { type: Report['target_type']; id: number }

const targetLabel: Record<ReportTarget['type'], string> = { trip: '旅程', comment: '评论', user: '用户', place: '地点' }
const reasons = ['广告营销', '骚扰谩骂', '虚假信息', '色情低俗', '侵犯隐私']
const placeReasons = ['名称违规', '虚假地点', '重复地点', '位置错误']

/** 举报旅程、评论、用户或地点；target 为 null 时关闭 */
export function ReportDialog({ target, onClose }: { target: ReportTarget | null; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const m = useMutation({
    mutationFn: (t: ReportTarget) => api.reports.create({ target_type: t.type, target_id: t.id, reason: reason.trim() }),
    onSuccess: () => {
      setReason('')
      toast.success('已提交，管理员会尽快处理')
      onClose()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const presets = target?.type === 'place' ? placeReasons : reasons
  // 点选常见原因：追加到说明里（可以再补充细节）
  const pick = (r: string) => setReason((cur) => (cur.includes(r) ? cur : cur.trim() ? `${cur.trim()}；${r}` : r))
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={target ? `举报${targetLabel[target.type]}` : ''}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!reason.trim()} loading={m.isPending} onClick={() => target && m.mutate(target)}>
            提交
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] leading-relaxed text-ink-500">说明遇到的问题，管理员核实后会处理。举报内容不会告知对方。</p>
      <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="常见原因">
        {presets.map((r) => {
          const on = reason.includes(r)
          return (
            <button
              key={r}
              type="button"
              aria-pressed={on}
              onClick={() => pick(r)}
              className={cn(
                'h-7 rounded-md border px-2.5 text-xs tracking-wide transition-colors',
                on ? 'border-ink-900 bg-ink-900 text-paper' : 'border-ink-200 text-ink-600 hover:border-ink-400 hover:text-ink-900',
              )}
            >
              {r}
            </button>
          )
        })}
      </div>
      <Textarea
        className="mt-3"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        aria-label="举报原因"
        placeholder={target?.type === 'place' ? '地点名称违规、虚假或重复地点等' : '请描述问题（广告、骚扰、虚假信息、违规内容等）'}
      />
      <p className="font-num mt-1.5 text-right text-xs text-ink-400">{reason.length} / 500</p>
    </Modal>
  )
}
