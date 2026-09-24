import { useState } from 'react'
import { Copy, Navigation } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Modal, Segmented } from '@/components/ui'
import { copyText } from '@/lib/clipboard'
import { defaultNavMode, isIOS, isWeChat, navModes, navProviders, rememberNavMode, type NavMode, type NavTarget } from '@/lib/nav'

export function NavigateMenu({
  target,
  size = 'xs',
  label = '导航',
  variant = 'secondary',
  distanceM,
}: {
  target: NavTarget
  size?: 'xs' | 'sm' | 'md'
  label?: string
  variant?: 'secondary' | 'outline' | 'primary' | 'ghost'
  /** 当前位置到目的地的距离（米）：用来选默认的出行方式 */
  distanceM?: number | null
}) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<NavMode | null>(null)
  const mode = picked ?? defaultNavMode(distanceM)
  const close = () => setOpen(false)
  const providers = navProviders.filter((p) => !p.iosOnly || isIOS())
  const wx = isWeChat()
  // 复制名称和地址：唤不起 App 时（如在微信里）可以粘贴到地图 App 里搜索
  const copy = async () => {
    if (await copyText([target.name, target.address].filter(Boolean).join(' '))) toast.success('已复制，可粘贴到地图 App 搜索')
    else toast.error('复制失败')
    close()
  }
  // 用弹窗（手机上是底部面板）而不是下拉菜单：旅行模式里按钮在可滚动面板的右侧，下拉菜单会被裁掉
  // 弹窗通过 portal 渲染，但 React 事件仍会沿组件树冒泡，这里拦住，避免触发外层卡片的点击
  return (
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <Button size={size} variant={variant} icon={<Navigation className="size-3.5" />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Modal open={open} onClose={close} title={`导航到「${target.name}」`}>
        {wx ? (
          <p className="mb-1 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            微信内无法直接唤起地图 App：点右上角「···」选择「在浏览器打开」后再导航；也可先用下面的网页地图查看
          </p>
        ) : (
          <p className="mb-1 text-xs text-ink-400">用地图 App 打开（手机会自动唤起）</p>
        )}
        <Segmented<NavMode>
          size="sm"
          className="my-1.5"
          value={mode}
          onChange={(m) => {
            setPicked(m)
            rememberNavMode(m)
          }}
          options={navModes}
        />
        <div className="divide-y divide-ink-100">
          {providers.map((p) => (
            <div key={p.key} className="flex items-center gap-2">
              <a
                href={p.route(target, mode)}
                target="_blank"
                rel="noreferrer"
                onClick={close}
                className="flex min-h-12 flex-1 items-center gap-2.5 py-2.5 text-sm font-medium text-ink-800 hover:text-brand-600"
              >
                <Navigation className="size-4 text-brand-500" />
                {p.name}
              </a>
              <a
                href={p.marker(target)}
                target="_blank"
                rel="noreferrer"
                onClick={close}
                className="shrink-0 rounded-lg px-3 py-2 text-xs text-ink-500 hover:bg-ink-50 hover:text-brand-600"
              >
                查看位置
              </a>
            </div>
          ))}
          <button
            type="button"
            onClick={copy}
            className="flex min-h-12 w-full items-center gap-2.5 py-2.5 text-left text-sm font-medium text-ink-800 hover:text-brand-600"
          >
            <Copy className="size-4 text-brand-500" />
            复制地点和地址
          </button>
        </div>
      </Modal>
    </span>
  )
}
