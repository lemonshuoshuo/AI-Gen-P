import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Send, UserPlus, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, isNotFound, type SpaceType, type UserBrief } from '@/api'
import { Avatar, Button, Field, Input, Modal } from '@/components/ui'
import { beijingToday } from '@/lib/format'
import { useAuth } from '@/stores/auth'
import { SpaceTypeChooser, refreshSpaces, spaceTypeOf, useSpaces } from '@/components/space'

const USERNAME = /^@?[A-Za-z0-9_]{3,20}$/

/** 每种类型的简介示例 */
const descExamples: Record<SpaceType, string> = {
  couple: '一起走过的每一个地方',
  besties: '每年一次姐妹旅行',
  friends: '大学室友 · 毕业后也要常聚',
  family: '带爸妈看看世界',
  custom: '周末一起去爬山',
}

/**
 * 新建空间：类型（情侣 / 闺蜜 / 朋友 / 家人 / 自定义）、名称、纪念日（情侣）、简介，
 * 以及马上邀请几个人（先查用户名，填错了当场提示）。创建后打开新空间
 */
export function CreateSpaceDialog({
  open,
  onClose,
  initialType,
  invitee,
}: {
  open: boolean
  onClose: () => void
  initialType?: SpaceType
  /** 预先放进「邀请成员」的用户名（如邀请链接的主人） */
  invitee?: string
}) {
  if (!open) return null
  return <CreateSpaceForm onClose={onClose} initialType={initialType} invitee={invitee} />
}

function CreateSpaceForm({ onClose, initialType, invitee }: { onClose: () => void; initialType?: SpaceType; invitee?: string }) {
  const me = useAuth((s) => s.user)!
  const nav = useNavigate()
  const qc = useQueryClient()
  const spaces = useSpaces()
  // 每人只能在一个情侣空间里
  const couple = spaces.data?.find((s) => s.type === 'couple')
  const [type, setType] = useState<SpaceType>(initialType && !(initialType === 'couple' && couple) ? initialType : couple ? 'friends' : 'couple')
  const [label, setLabel] = useState('')
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [anniv, setAnniv] = useState('')
  const [who, setWho] = useState('')
  const [checking, setChecking] = useState(false)
  const [people, setPeople] = useState<UserBrief[]>([])
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  // 预先放进邀请名单的人：查到了才加（查不到时不打扰，自己再输）
  useEffect(() => {
    const u = invitee?.replace(/^@/, '')
    if (!u || !USERNAME.test(u) || u.toLowerCase() === me.username.toLowerCase()) return
    let alive = true
    api.users
      .get(u)
      .then((p) => alive && setPeople((l) => (l.some((x) => x.id === p.id) ? l : [...l, p])))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [invitee, me.username])
  const today = beijingToday()
  const meta = spaceTypeOf(type)
  const max = type === 'couple' ? 1 : 49
  // 不填名称时的默认名（与服务端一致）：内置类型各有默认名，自定义类型用它的类型名称
  const defaultName = type === 'custom' ? label.trim() : meta.defaultName
  const namePlaceholder = defaultName || '如：周末爬山小分队'

  const add = async () => {
    const u = who.trim().replace(/^@/, '')
    if (!u) return
    if (!USERNAME.test(u)) return toast.error('用户名是 3–20 位字母、数字或下划线')
    if (u.toLowerCase() === me.username.toLowerCase()) return toast.error('不用邀请自己')
    if (people.some((p) => p.username.toLowerCase() === u.toLowerCase())) return setWho('')
    if (people.length >= max) return toast.error(type === 'couple' ? '情侣空间只能邀请一个人' : '一次最多邀请 49 人')
    setChecking(true)
    try {
      const p = await api.users.get(u)
      setPeople((l) => [...l, p])
      setWho('')
    } catch (e) {
      toast.error(isNotFound(e) ? `找不到用户 @${u}` : errorMessage(e))
    } finally {
      setChecking(false)
    }
  }

  const submit = async () => {
    if (type === 'custom' && !label.trim()) return toast.error('给自定义的类型起个名字吧，如「驴友团」')
    if (anniv && anniv > today) return toast.error('纪念日不能晚于今天')
    const pending = who.trim().replace(/^@/, '')
    if (pending && !people.some((p) => p.username.toLowerCase() === pending.toLowerCase()))
      return toast.error(`还没添加 @${pending}：点「添加」确认，或清空输入框`)
    setSaving(true)
    try {
      const d = await api.spaces.create({
        type,
        name: name.trim() || undefined,
        type_label: type === 'custom' ? label.trim() : undefined,
        description: desc.trim() || undefined,
        anniversary: type === 'couple' && anniv ? anniv : undefined,
      })
      const failed: string[] = []
      for (const p of people.slice(0, max)) {
        try {
          await api.spaces.invite(d.id, { user_id: p.id, message: message.trim() || undefined })
        } catch (e) {
          failed.push(`${p.nickname || p.username}：${errorMessage(e)}`)
        }
      }
      const sent = Math.min(people.length, max) - failed.length
      toast.success(`已创建「${d.name}」`, { description: sent > 0 ? `已向 ${sent} 人发出邀请，对方接受后就会加入` : undefined })
      if (failed.length) toast.error('有的邀请没有发出', { description: failed.join('\n') })
      refreshSpaces(qc)
      onClose()
      nav(`/spaces/${d.id}`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => !saving && onClose()}
      title="新建空间"
      footer={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button variant="accent" loading={saving} onClick={submit}>
            {people.length ? '创建并邀请' : '创建空间'}
          </Button>
        </>
      }
    >
      <div className="space-y-6 pt-1">
        <div>
          <span className="mb-2 block text-[12.5px] font-medium text-ink-600">和谁的空间</span>
          <SpaceTypeChooser
            value={type}
            onChange={(t) => {
              setType(t)
              if (t === 'couple') setPeople((l) => l.slice(0, 1))
            }}
            disabled={couple ? { couple: `你已在情侣空间「${couple.name}」中` } : undefined}
          />
          <p className="mt-2 text-xs text-ink-500">{meta.hint}</p>
          {couple && <p className="mt-0.5 text-xs text-ink-400">每人只能在一个情侣空间里，你已在「{couple.name}」中</p>}
        </div>

        {type === 'custom' && (
          <Field label="类型名称" hint="显示在空间名旁边，最多 10 个字">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={10} placeholder="如：驴友团、室友、球队" autoFocus />
          </Field>
        )}

        <Field
          label="空间名称"
          hint={name.trim() ? undefined : defaultName ? `不填时叫「${defaultName}」` : type === 'custom' ? '不填时用上面的类型名称' : undefined}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} placeholder={namePlaceholder} />
        </Field>

        {type === 'couple' && (
          <Field label="在一起的纪念日（可选）" hint="用来计算「在一起 N 天」">
            <Input type="date" value={anniv} max={today} onChange={(e) => setAnniv(e.target.value)} className="font-num" />
          </Field>
        )}

        <Field label="一句话介绍（可选）">
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={120} placeholder={descExamples[type]} />
        </Field>

        <div className="border-t border-line pt-5">
          <p className="flex items-baseline justify-between gap-3">
            <span className="text-[12.5px] font-medium text-ink-600">{type === 'couple' ? '邀请 TA（可选）' : '邀请成员（可选，可以多人）'}</span>
            {people.length > 0 && <span className="caption">{people.length} 人</span>}
          </p>
          {people.length < max && (
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void add()
              }}
            >
              <Input value={who} onChange={(e) => setWho(e.target.value)} placeholder="对方的用户名" aria-label="对方的用户名" autoCapitalize="off" autoCorrect="off" />
              <Button type="submit" variant={who.trim() ? 'primary' : 'outline'} disabled={!who.trim() || checking} icon={checking ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" strokeWidth={1.5} />}>
                添加
              </Button>
            </form>
          )}
          {people.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2" aria-label="将要邀请的人">
              {people.map((p) => (
                <li key={p.id} className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface pr-1 pl-1 text-[13px] text-ink-900">
                  <Avatar user={p} size={26} />
                  <span className="max-w-[9rem] truncate">{p.nickname || p.username}</span>
                  <button
                    type="button"
                    onClick={() => setPeople((l) => l.filter((x) => x.id !== p.id))}
                    aria-label={`不邀请 ${p.nickname || p.username}`}
                    className="flex size-7 items-center justify-center rounded-full text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900"
                  >
                    <X className="size-3.5" strokeWidth={1.75} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {people.length > 0 && (
            <Field label="想说的话（可选）" className="mt-4">
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={200}
                placeholder={type === 'couple' ? '以后的旅行，都一起记录吧' : '一起把去过的地方记在同一张地图上吧'}
              />
            </Field>
          )}
          <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-500">
            <Send className="size-3 shrink-0" strokeWidth={1.5} aria-hidden />
            对方会收到通知，接受后才会加入；之后也可以在空间设置里继续邀请
          </p>
        </div>
      </div>
    </Modal>
  )
}
