import { useId, useRef, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, CircleCheck, Copy, KeyRound, ShieldCheck, ShieldOff, Sparkles, UserCheck } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, type AdminUser } from '@/api'
import { Avatar, Button, Field, Input, MenuItem, Modal, Select, confirmDialog } from '@/components/ui'
import { useSite } from '@/hooks/useSite'
import { copyText } from '@/lib/clipboard'
import { fromNow } from '@/lib/format'
import { useAuth } from '@/stores/auth'
import {
  ADMIN_PAGE_SIZE,
  FilterBar,
  FilterSlot,
  monoAvatar,
  PanelHeader,
  PersonName,
  Pill,
  RowMenu,
  SearchInput,
  tidyBytes,
  useFilters,
  usePageGuard,
} from './common'
import { DataTable, type Column } from './DataTable'

type UserPatch = { role?: 'user' | 'admin'; status?: 'active' | 'banned'; exp?: number }

const displayName = (u: AdminUser) => u.nickname || u.username

function ExpDialog({ user, onClose, onSave, saving }: { user: AdminUser; onClose: () => void; onSave: (exp: number) => void; saving: boolean }) {
  const { data: site } = useSite()
  const [value, setValue] = useState(String(user.exp))
  const exp = Number(value)
  const valid = value.trim() !== '' && Number.isInteger(exp) && exp >= 0
  const level = site?.levels.filter((l) => exp >= l.min_exp).at(-1)
  return (
    <Modal
      open
      onClose={onClose}
      title={`调整经验值 · ${displayName(user)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button disabled={!valid || exp === user.exp} loading={saving} onClick={() => onSave(exp)}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-500">
          当前 <span className="font-num text-ink-700 italic">Lv.{user.level}</span> {user.level_name} · <span className="font-num">{user.exp}</span> 经验
        </p>
        <Field
          label="新的经验值"
          hint={valid && level ? `保存后等级为 Lv${level.level}「${level.name}」` : '请输入不小于 0 的整数'}
        >
          <Input type="number" min={0} step={1} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </Field>
        {site && (
          <div className="flex flex-wrap gap-1.5">
            {site.levels.map((l) => (
              <button
                key={l.level}
                type="button"
                onClick={() => setValue(String(l.min_exp))}
                className="inline-flex h-10 items-center rounded-full border border-ink-200 px-3 text-xs sm:h-8 text-ink-600 transition-colors duration-300 hover:border-ink-900/40 hover:text-ink-900"
              >
                <span className="font-num italic">Lv.{l.level}</span> · <span className="font-num">{l.min_exp}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

/** 重置密码：留空由服务端生成 12 位随机密码；成功后显示新密码（只显示这一次） */
function ResetPasswordDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const formId = useId()
  const [pw, setPw] = useState('')
  const [result, setResult] = useState<string | null>(null)
  // 与服务端一致按字符数计（不是 UTF-16 长度）
  const len = [...pw].length
  const valid = !pw || (len >= 8 && len <= 64)
  // 请求进行中不能关闭，也不能重复提交：密码已在服务端修改，关掉就看不到新密码了。
  // 用 ref 而不是 isPending：isPending 要到下一次渲染才变，提交后立刻按 Esc / 回车仍会漏过去
  const busy = useRef(false)
  const m = useMutation({
    mutationFn: (password: string) => api.admin.resetPassword(user.id, password || undefined),
    onSuccess: (r) => setResult(r.password),
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => {
      busy.current = false
    },
  })
  const close = () => {
    if (!busy.current) onClose()
  }
  const copy = async (text: string) => {
    if (await copyText(text)) toast.success('已复制')
    else toast.error('复制失败，请手动选中密码复制')
  }
  return (
    <Modal
      open
      onClose={close}
      title={`重置密码 · ${displayName(user)}`}
      footer={
        result ? (
          <Button onClick={onClose}>完成</Button>
        ) : (
          <>
            <Button variant="ghost" disabled={m.isPending} onClick={close}>
              取消
            </Button>
            <Button type="submit" form={formId} variant="danger" disabled={!valid} loading={m.isPending}>
              重置密码
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700">
            <CircleCheck className="size-4 shrink-0" strokeWidth={1.75} />
            密码已重置，该用户所有设备上的登录已失效
          </p>
          <div>
            <div className="eyebrow mb-2">New password · 新密码</div>
            <div className="flex items-center gap-2 rounded-md border border-ink-200 bg-paper py-2 pr-2 pl-3.5">
              <code className="min-w-0 flex-1 font-mono text-base break-all text-ink-900 select-all">{result}</code>
              <Button size="sm" variant="outline" icon={<Copy className="size-4" strokeWidth={1.75} />} onClick={() => copy(result)}>
                复制
              </Button>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-ink-500">
            请通过可靠渠道告诉该用户，并提醒其登录后在「账号设置」中修改密码。
          </p>
        </div>
      ) : (
        <form
          id={formId}
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!valid || busy.current) return
            busy.current = true
            m.mutate(pw)
          }}
        >
          <p className="text-sm leading-relaxed text-ink-500">
            重置后该用户所有设备上的登录会立即失效。新密码可以留空自动生成（12 位随机密码），也可以自己设置（8–64 位）。
          </p>
          <Field label="新密码（可选）" hint={!valid && <span className="text-red-600">密码长度需为 8–64 位</span>}>
            <Input
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="留空则自动生成"
              className="font-mono"
            />
          </Field>
        </form>
      )}
    </Modal>
  )
}

export function UsersPanel() {
  const me = useAuth((s) => s.user)
  const qc = useQueryClient()
  const { f, set, setPage } = useFilters({ q: '', role: '', status: '' })
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['admin', 'users', f],
    queryFn: () => api.admin.users({ ...f, page_size: ADMIN_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  })
  usePageGuard(data, setPage)
  const [expUser, setExpUser] = useState<AdminUser | null>(null)
  const [pwUser, setPwUser] = useState<AdminUser | null>(null)

  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: UserPatch; ok: string }) => api.admin.updateUser(id, body),
    onSuccess: (_, v) => {
      toast.success(v.ok)
      setExpUser(null)
      qc.invalidateQueries({ queryKey: ['admin', 'users'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const toggleBan = async (u: AdminUser) => {
    const ban = u.status !== 'banned'
    if (
      ban &&
      !(await confirmDialog({
        title: `封禁 ${displayName(u)}？`,
        desc: '封禁后该用户将无法登录，也不能再发布或互动。可以随时解封。',
        danger: true,
        okText: '封禁',
      }))
    )
      return
    update.mutate({ id: u.id, body: { status: ban ? 'banned' : 'active' }, ok: ban ? '已封禁' : '已解封' })
  }

  const toggleAdmin = async (u: AdminUser) => {
    const promote = u.role !== 'admin'
    const ok = await confirmDialog({
      title: promote ? `将 ${displayName(u)} 设为管理员？` : `取消 ${displayName(u)} 的管理员权限？`,
      desc: promote ? '管理员可以管理所有用户、内容和站点设置，请谨慎操作。' : '取消后该用户将无法再访问管理后台。',
      danger: true,
      okText: promote ? '设为管理员' : '取消管理员',
    })
    if (!ok) return
    update.mutate({ id: u.id, body: { role: promote ? 'admin' : 'user' }, ok: promote ? '已设为管理员' : '已取消管理员' })
  }

  const columns: Column<AdminUser>[] = [
    {
      key: 'user',
      header: '用户',
      mobile: 'primary',
      cell: (u) => (
        <div className="flex min-w-0 items-center gap-3.5">
          <Avatar user={u} size={36} className={monoAvatar} />
          <div className="min-w-0">
            <PersonName user={u} handle={false} className="text-[15px]" />
            <div className="caption truncate">
              @{u.username}
              {u.role === 'admin' && ' · 管理员'}
              {u.email && ` · ${u.email}`}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'level',
      header: '等级',
      className: 'whitespace-nowrap',
      cell: (u) => (
        <span className="text-ink-700">
          <span className="font-num text-[13px] text-ink-500 italic">Lv.{u.level}</span> {u.level_name}
          <span className="caption ml-2">
            <span className="font-num text-[15px]">{u.exp}</span> 经验
          </span>
        </span>
      ),
      meta: (u) => (
        <>
          <span className="font-num text-[14px] italic">Lv.{u.level}</span> {u.level_name}
        </>
      ),
    },
    {
      key: 'trips',
      header: '旅程',
      cell: (u) => <span className="font-num text-[1.375rem] leading-none font-light text-ink-900">{u.trip_count}</span>,
      meta: (u) => (
        <>
          <span className="font-num text-[14px] text-ink-700">{u.trip_count}</span> 段旅程
        </>
      ),
    },
    {
      key: 'storage',
      header: '存储',
      className: 'whitespace-nowrap',
      mobile: 'hide',
      cell: (u) => (
        <span className="font-num text-[15px] text-ink-700">
          {tidyBytes(u.storage_used)}
          <span className="text-[13px] text-ink-500"> / {u.storage_quota > 0 ? tidyBytes(u.storage_quota) : '不限'}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      cell: (u) =>
        u.status === 'banned' ? (
          <Pill tone="hollow">已封禁</Pill>
        ) : u.status === 'deleted' ? (
          <Pill>已注销</Pill>
        ) : (
          <span className="text-[13px] text-ink-500">正常</span>
        ),
      // 小屏只在不正常时提示
      meta: (u) => (u.status === 'banned' ? <Pill tone="hollow">已封禁</Pill> : u.status === 'deleted' ? <Pill>已注销</Pill> : null),
    },
    {
      key: 'login',
      header: '最近登录',
      className: 'whitespace-nowrap',
      cell: (u) => (
        <span className="text-[13px] text-ink-500" title={`注册于 ${u.created_at}`}>
          {u.last_login_at ? fromNow(u.last_login_at) : '从未'}
        </span>
      ),
      meta: (u) => (u.last_login_at ? `${fromNow(u.last_login_at)}登录` : '从未登录'),
    },
  ]

  const actions = (u: AdminUser) => {
    // 已注销的账号服务端拒绝任何修改（「该账号已注销」）：不显示操作
    if (u.status === 'deleted') return null
    const self = u.id === me?.id
    return (
      <RowMenu>
        {(close) => (
          <>
            {!self && (
              <MenuItem
                icon={u.status === 'banned' ? <UserCheck className="size-4" /> : <Ban className="size-4" />}
                danger={u.status !== 'banned'}
                onClick={() => (close(), toggleBan(u))}
              >
                {u.status === 'banned' ? '解封' : '封禁'}
              </MenuItem>
            )}
            {!self && (
              <MenuItem
                icon={u.role === 'admin' ? <ShieldOff className="size-4" /> : <ShieldCheck className="size-4" />}
                onClick={() => (close(), toggleAdmin(u))}
              >
                {u.role === 'admin' ? '取消管理员' : '设为管理员'}
              </MenuItem>
            )}
            {!self && (
              <MenuItem icon={<KeyRound className="size-4" />} onClick={() => (close(), setPwUser(u))}>
                重置密码
              </MenuItem>
            )}
            <MenuItem icon={<Sparkles className="size-4" />} onClick={() => (close(), setExpUser(u))}>
              调整经验值
            </MenuItem>
          </>
        )}
      </RowMenu>
    )
  }

  return (
    <div>
      <PanelHeader
        eyebrow="Members · 用户"
        title="用户管理"
        desc={
          data ? (
            <>
              共 <span className="font-num text-[17px] text-ink-900">{data.total}</span> 位用户
            </>
          ) : undefined
        }
      />
      <FilterBar>
        <SearchInput
          value={f.q}
          onChange={(q) => set({ q })}
          placeholder="搜索用户名、昵称或邮箱"
          className="w-full sm:w-64"
        />
        <FilterSlot>
          <Select value={f.role} onChange={(e) => set({ role: e.target.value })} aria-label="角色">
            <option value="">全部角色</option>
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </Select>
        </FilterSlot>
        <FilterSlot>
          <Select value={f.status} onChange={(e) => set({ status: e.target.value })} aria-label="状态">
            <option value="">全部状态</option>
            <option value="active">正常</option>
            <option value="banned">已封禁</option>
            <option value="deleted">已注销</option>
          </Select>
        </FilterSlot>
      </FilterBar>
      <DataTable
        rows={data?.items}
        columns={columns}
        rowKey={(u) => u.id}
        actions={actions}
        compactActions
        metaClassName="pl-[3.125rem]"
        loading={isLoading}
        fetching={isFetching}
        emptyText="没有符合条件的用户"
        page={f.page}
        total={data?.total ?? 0}
        pageSize={ADMIN_PAGE_SIZE}
        onPage={setPage}
      />
      {expUser && (
        <ExpDialog
          user={expUser}
          saving={update.isPending}
          onClose={() => setExpUser(null)}
          onSave={(exp) => update.mutate({ id: expUser.id, body: { exp }, ok: '经验值已更新' })}
        />
      )}
      {pwUser && <ResetPasswordDialog user={pwUser} onClose={() => setPwUser(null)} />}
    </div>
  )
}
