import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, errorMessage, type Report } from '@/api'
import { Button, Modal, Textarea } from '@/components/ui'

export type ReportTarget = { type: Report['target_type']; id: number }

const targetLabel: Record<ReportTarget['type'], string> = { trip: '旅程', comment: '评论', user: '用户', place: '地点' }

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
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={target ? `举报${targetLabel[target.type]}` : ''}
      footer={
        <Button disabled={!reason.trim()} loading={m.isPending} onClick={() => target && m.mutate(target)}>
          提交
        </Button>
      }
    >
      <Textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        placeholder={target?.type === 'place' ? '地点名称违规、虚假或重复地点等' : '请描述问题（广告、骚扰、虚假信息、违规内容等）'}
      />
    </Modal>
  )
}
