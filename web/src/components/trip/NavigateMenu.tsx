import { useState } from 'react'
import { ArrowUpRight, Copy, Navigation } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Modal, Segmented } from '@/components/ui'
import { cn } from '@/lib/cn'
import { copyText } from '@/lib/clipboard'
import { defaultNavMode, isIOS, isWeChat, navModes, navProviders, rememberNavMode, type NavMode, type NavTarget } from '@/lib/nav'

export function NavigateMenu({
  target,
  size = 'xs',
  label = '导航',
  variant = 'secondary',
  distanceM,
  className,
}: {
  target: NavTarget
  size?: 'xs' | 'sm' | 'md'
  label?: string
  variant?: 'secondary' | 'outline' | 'primary' | 'ghost'
  /** 当前位置到目的地的距离（米）：用来选默认的出行方式 */
  distanceM?: number | null
  className?: string
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
      <Button
        size={size}
        variant={variant}
        className={cn(variant === 'ghost' && 'text-ink-500 hover:text-ink-900', className)}
        icon={<Navigation className="size-3.5" strokeWidth={1.5} />}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <Modal open={open} onClose={close} title={`导航到「${target.name}」`}>
        {wx ? (
          <p className="mb-2 border-l-2 border-amber-400 pl-3 text-xs leading-relaxed text-amber-800">
            微信内无法直接唤起地图 App：点右上角「···」选择「在浏览器打开」后再导航；也可先用下面的网页地图查看
          </p>
        ) : (
          <p className="eyebrow mb-1">Open in · 用地图 App 打开</p>
        )}
        <Segmented<NavMode>
          size="sm"
          className="my-2"
          value={mode}
          onChange={(m) => {
            setPicked(m)
            rememberNavMode(m)
          }}
          options={navModes}
        />
        <div className="divide-y divide-ink-200 border-t border-ink-200">
          {providers.map((p) => (
            <div key={p.key} className="flex items-center gap-2">
              <a
                href={p.route(target, mode)}
                target="_blank"
                rel="noreferrer"
                onClick={close}
                className="group flex min-h-12 flex-1 items-center gap-3 py-2.5 text-[15px] text-ink-900 transition-colors hover:text-brand-600"
              >
                <Navigation className="size-4 text-ink-400 group-hover:text-brand-500" strokeWidth={1.5} />
                <span className="font-display">{p.name}</span>
              </a>
              <a
                href={p.marker(target)}
                target="_blank"
                rel="noreferrer"
                onClick={close}
                className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-2.5 py-2 text-xs text-ink-500 transition-colors hover:bg-ink-900/5 hover:text-ink-900"
              >
                查看位置
                <ArrowUpRight className="size-3" strokeWidth={1.75} />
              </a>
            </div>
          ))}
          <button
            type="button"
            onClick={copy}
            className="group flex min-h-12 w-full items-center gap-3 py-2.5 text-left text-[15px] text-ink-900 transition-colors hover:text-brand-600"
          >
            <Copy className="size-4 text-ink-400 group-hover:text-brand-500" strokeWidth={1.5} />
            复制地点和地址
          </button>
        </div>
      </Modal>
    </span>
  )
}
