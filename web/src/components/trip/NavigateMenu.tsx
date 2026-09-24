import { Navigation } from 'lucide-react'
import { Button, Menu, MenuItem } from '@/components/ui'
import { isIOS, navProviders, type NavTarget } from '@/lib/nav'

export function NavigateMenu({
  target,
  size = 'xs',
  label = '导航',
  variant = 'secondary',
}: {
  target: NavTarget
  size?: 'xs' | 'sm' | 'md'
  label?: string
  variant?: 'secondary' | 'outline' | 'primary' | 'ghost'
}) {
  const ios = isIOS()
  return (
    <Menu
      align="left"
      trigger={(toggle) => (
        <Button
          size={size}
          variant={variant}
          icon={<Navigation className="size-3.5" />}
          onClick={(e) => {
            e.stopPropagation()
            toggle()
          }}
        >
          {label}
        </Button>
      )}
    >
      {(close) => (
        <>
          <div className="px-4 pt-1 pb-2 text-xs text-ink-400">用地图 App 打开（手机会自动唤起）</div>
          {navProviders
            .filter((p) => !p.iosOnly || ios)
            .map((p) => (
              <div key={p.key} className="flex items-center">
                <MenuItem href={p.route(target)} onClick={close}>
                  {p.name} · 导航
                </MenuItem>
                <a
                  href={p.marker(target)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={close}
                  className="shrink-0 px-3 text-xs text-ink-400 hover:text-brand-600"
                >
                  查看
                </a>
              </div>
            ))}
        </>
      )}
    </Menu>
  )
}
