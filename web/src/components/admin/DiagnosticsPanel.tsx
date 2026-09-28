import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Copy, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api, errorMessage, isNotFound, type AdminDiagnostics, type DiagDetail, type DiagProxy } from '@/api'
import { Button, LoadError, Spinner, Tag } from '@/components/ui'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/cn'
import { dayjs } from '@/lib/format'
import { PanelHeader } from './common'

type State = 'ok' | 'off' | 'bad'

const stateOf = (s: { configured: boolean; ok: boolean }): State => (!s.configured ? 'off' : s.ok ? 'ok' : 'bad')

/** 状态印记：玉青实心圆＝正常，墨色空心圆＝未配置，朱砂菱形＝异常 */
const stateMeta: Record<State, { label: string; cls: string; mark: ReactNode }> = {
  ok: {
    label: '正常',
    cls: 'border-emerald-500/40 text-emerald-700',
    mark: <span className="size-2 rounded-full bg-emerald-500" />,
  },
  off: {
    label: '未配置',
    cls: 'border-ink-300 text-ink-500',
    mark: <span className="size-2 rounded-full border border-ink-400" />,
  },
  bad: {
    label: '异常',
    cls: 'border-brand-500/45 text-brand-700',
    mark: <span className="size-[7px] rotate-45 bg-brand-500" />,
  },
}

function StateStamp({ state }: { state: State }) {
  const m = stateMeta[state]
  return (
    <span className={cn('inline-flex items-center gap-2 rounded-sm border px-2.5 py-1', m.cls)}>
      <span className="flex size-2 items-center justify-center" aria-hidden>
        {m.mark}
      </span>
      <span className="font-display text-[15px] leading-none">{m.label}</span>
    </span>
  )
}

/** 可复制的 .env / 命令片段：上方一行细线标题（文件名 + 复制），下方等宽正文；wrap 时长行折行（原始错误） */
function Snippet({ label, children, wrap }: { label: string; children: string; wrap?: boolean }) {
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-ink-200 bg-paper">
      <div className="flex items-center justify-between border-b border-ink-200 py-1 pr-1 pl-3.5">
        <span className="font-mono text-[11px] text-ink-400">{label}</span>
        <button
          type="button"
          onClick={async () => {
            if (await copyText(children)) toast.success('已复制')
            else toast.error('复制失败，请手动选中复制')
          }}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-500 transition-colors hover:bg-ink-900/5 hover:text-ink-900"
        >
          <Copy className="size-3.5" strokeWidth={1.75} />
          复制
        </button>
      </div>
      <pre
        className={cn(
          'overflow-x-auto px-3.5 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink-800',
          wrap && 'whitespace-pre-wrap [overflow-wrap:anywhere]',
        )}
      >
        {children}
      </pre>
    </div>
  )
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded-sm bg-ink-100 px-1 py-px font-mono text-[12.5px] text-ink-800">{children}</code>
)

/** 编号步骤：Fraunces 序号 + 细线 */
function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="mt-3 space-y-3">
      {items.map((it, i) => (
        <li key={i} className="flex gap-3 text-sm leading-relaxed text-ink-700">
          <span className="font-num w-5 shrink-0 pt-px text-right text-[15px] leading-6 text-ink-400">{i + 1}.</span>
          <div className="min-w-0 flex-1">{it}</div>
        </li>
      ))}
    </ol>
  )
}

/** 小节标题：细线下的 eyebrow */
const Label = ({ children, className }: { children: ReactNode; className?: string }) => (
  <p className={cn('eyebrow', className)}>{children}</p>
)

/** 突出的一条诊断结论（按错误码 / 错误信息匹配到的原因） */
function Diagnosis({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="border-l-2 border-ink-900 py-0.5 pl-4">
      <p className="font-display text-[15px] text-ink-900">{title}</p>
      <div className="mt-1 text-sm leading-relaxed text-ink-600">{children}</div>
    </div>
  )
}

/** 一个服务的检测结果：左栏编号、名称、状态；右栏服务器原文、详情与修复建议 */
function ServicePanel({
  no,
  en,
  title,
  sub,
  optional,
  state,
  purpose,
  message,
  children,
}: {
  no: string
  en: string
  title: string
  sub: ReactNode
  optional?: boolean
  state: State
  purpose: ReactNode
  message: string
  children?: ReactNode
}) {
  return (
    <section className="grid gap-6 border-t border-ink-200 py-8 first:border-ink-900 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10">
      {/* 手机上状态印记放在标题右侧，桌面在左栏标题下方 */}
      <div className="flex items-start justify-between gap-4 lg:block">
        <div className="min-w-0">
          <p className="eyebrow">
            <span className="font-num">{no}</span> · {en}
          </p>
          <h2 className="mt-2 flex items-center gap-2 text-[22px] leading-tight text-ink-900">
            {title}
            {optional && <Tag className="font-sans text-[11px]">可选</Tag>}
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-400">{sub}</p>
        </div>
        <div className="shrink-0 pt-5 lg:mt-4 lg:pt-0">
          <StateStamp state={state} />
        </div>
      </div>

      <div className="min-w-0 space-y-6">
        <p className="text-sm leading-relaxed text-ink-500">{purpose}</p>
        <div>
          <Label>Server · 服务器返回</Label>
          <p className="mt-2 border-l-2 border-ink-200 py-0.5 pl-4 text-[15px] leading-relaxed break-words text-ink-900">
            {message || '（无返回信息）'}
          </p>
        </div>
        {children}
      </div>
    </section>
  )
}

/* ---------------- 技术细节与网络排查 ---------------- */

type Checked = DiagDetail & { configured: boolean; ok: boolean }

/** 没连上服务（而不是服务返回了错误）的失败环节 */
const networkLayers = new Set(['dns', 'proxy', 'connect', 'tls', 'timeout', 'network'])

const isNetworkFailure = (d: Checked) => d.configured && !d.ok && !!d.layer && networkLayers.has(d.layer)

const layerLabel: Record<string, string> = {
  dns: 'DNS 解析',
  proxy: '代理',
  connect: 'TCP 连接',
  tls: 'TLS 握手',
  timeout: '等待响应',
  network: '网络连接',
  http: 'HTTP 状态',
  api: '接口返回',
  response: '返回内容',
  slow: '响应过慢',
}

function proxyEnv(p?: DiagProxy) {
  if (!p) return ''
  return [
    p.https_proxy && `HTTPS_PROXY=${p.https_proxy}`,
    p.http_proxy && `HTTP_PROXY=${p.http_proxy}`,
    p.no_proxy && `NO_PROXY=${p.no_proxy}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** 服务器进程实际使用的配置（Key 指纹、代理）与失败时的环节、解析地址和原始错误 */
function TechDetail({ d }: { d: Checked }) {
  if (!d.host && !d.key_hint && !d.layer) return null // 旧版服务端
  const failed = !d.ok
  const hint = d.key_hint
  const env = proxyEnv(d.proxy)
  const rows: [string, ReactNode][] = []
  if (failed && d.layer)
    rows.push([
      '失败环节',
      <>
        {layerLabel[d.layer] ?? d.layer}
        {!!d.status && <span className="font-num ml-2 text-ink-500">HTTP {d.status}</span>}
      </>,
    ])
  if (d.host)
    rows.push([
      '服务地址',
      <span className="font-mono text-[12.5px]">
        {d.host}
        {failed && !!d.addrs?.length && <span className="text-ink-500"> → {d.addrs.join(', ')}</span>}
      </span>,
    ])
  rows.push([
    '代理',
    <>
      {d.proxy?.used ? (
        <>
          经 <span className="font-mono text-[12.5px]">{d.proxy.used}</span> 转发
          {failed && !!d.proxy_addrs?.length && (
            <span className="font-mono text-[12.5px] text-ink-500"> → {d.proxy_addrs.join(', ')}</span>
          )}
        </>
      ) : d.proxy ? (
        '直连（设置了代理变量，但这个地址不经过代理）'
      ) : (
        '未设置代理（直连）'
      )}
      {env && <span className="mt-0.5 block font-mono text-[12px] whitespace-pre-line text-ink-500">{env}</span>}
    </>,
  ])
  if (hint)
    rows.push([
      'Key',
      hint.length ? (
        <>
          <span className="font-mono text-[12.5px]">{hint.text}</span>
          {hint.warning && <span className="mt-0.5 block text-brand-600">{hint.warning}</span>}
        </>
      ) : (
        <span className="text-ink-400">未设置</span>
      ),
    ])
  return (
    <div>
      <Label>Detail · 技术细节</Label>
      <dl className="mt-2 divide-y divide-ink-200 border-y border-ink-200 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-4 py-2.5">
            <dt className="w-16 shrink-0 text-xs leading-5 tracking-wide text-ink-400">{k}</dt>
            <dd className="min-w-0 flex-1 leading-5 [overflow-wrap:anywhere] text-ink-800">{v}</dd>
          </div>
        ))}
      </dl>
      {failed && d.detail && (
        <Snippet label="原始错误 · Key 已隐藏" wrap>
          {d.detail}
        </Snippet>
      )}
    </div>
  )
}

/** 各失败环节的含义 */
const layerCause: Record<string, { title: string; fix: ReactNode }> = {
  dns: {
    title: '域名解析失败',
    fix: (
      <>
        容器里解析不了服务的域名。宿主机只配置了本机 DNS（如 <Code>127.0.0.1</Code> 上的 dnsmasq）、Docker
        找不到可用的上游 DNS 时，会给容器改用 8.8.8.8，国内服务器常常不通；使用 systemd-resolved（<Code>127.0.0.53</Code>）时
        Docker 读取的是 <Code>/run/systemd/resolve/resolv.conf</Code> 中的上游 DNS。
      </>
    ),
  },
  proxy: {
    title: '代理不可用',
    fix: (
      <>
        容器带着 <Code>HTTPS_PROXY</Code>，多半是 Docker 从 <Code>~/.docker/config.json</Code> 的 <Code>proxies</Code>{' '}
        注入的。容器里的 <Code>127.0.0.1</Code> 指容器自己，连不到宿主机上的代理。
      </>
    ),
  },
  connect: {
    title: 'TCP 连接失败',
    fix: <>出站连接被拒绝或超时：检查云服务器安全组、防火墙，以及 Docker 的 NAT（iptables）规则是否被清掉。</>,
  },
  tls: {
    title: 'TLS 握手失败',
    fix: (
      <>
        TCP 已连通但握手没有完成。握手超时多为 MTU 不匹配（云服务器、VPN 网卡的 MTU 小于 1500）；证书错误请检查服务器时间，或是否有
        HTTPS 劫持。
      </>
    ),
  },
  timeout: {
    title: '连上了，但没有响应',
    fix: <>请求已经发出，服务在限定时间内没有返回任何数据：多为代理或防火墙拦截了响应，也可能是服务繁忙。</>,
  },
  network: {
    title: '连接中断',
    fix: <>连接建立后被中断，常见于代理、防火墙或不稳定的网络。</>,
  },
}

/** 网络层失败：与 Key 无关，给出容器网络的排查步骤而不是申请 Key 的步骤 */
function NetworkHelp({ d }: { d: Checked }) {
  const cause = d.layer ? layerCause[d.layer] : undefined
  return (
    <div className="space-y-6">
      {cause && <Diagnosis title={cause.title}>{cause.fix}</Diagnosis>}
      <div>
        <Label>Network · 容器网络排查</Label>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">
          服务器没能连上这个服务，与 Key 是否正确无关，不需要重新申请 Key。在服务器的部署目录中依次检查：
        </p>
        <Steps
          items={[
            <>
              在容器里运行自检，逐项查看代理、DNS、TCP、TLS 与一次真实接口调用：
              <Snippet label="终端 · 部署目录">docker compose exec app /triphub -diagnose</Snippet>
            </>,
            <>
              查看 <Code>~/.docker/config.json</Code>（用 sudo 运行 Docker 时是 <Code>/root/.docker/config.json</Code>）是否有{' '}
              <Code>proxies</Code>：删掉它，或把代理地址改成容器能访问的地址，然后重新创建容器：
              <Snippet label="终端 · 部署目录">docker compose up -d --force-recreate app</Snippet>
            </>,
            <>
              修改 <Code>.env</Code> 后要执行 <Code>docker compose up -d</Code>；<Code>docker compose restart</Code> 不会重新读取{' '}
              <Code>.env</Code>，容器仍在用旧的配置。
            </>,
            <>
              DNS：在 <Code>/etc/docker/daemon.json</Code> 中设置国内 DNS 后重启 Docker（<Code>systemctl restart docker</Code>）：
              <Snippet label="/etc/docker/daemon.json">{'{ "dns": ["223.5.5.5", "119.29.29.29"] }'}</Snippet>
            </>,
            <>
              防火墙：<Code>firewall-cmd --reload</Code> 或修改 iptables 后要重启 Docker，否则容器的出站规则会丢失；并确认安全组放行了出站
              443 端口。
            </>,
            <>
              MTU：TLS 握手超时而宿主机上 <Code>curl</Code> 正常时，把网卡的 MTU（<Code>ip link</Code> 查看，如 1450）设给 Docker
              网络：在 <Code>docker-compose.yml</Code> 的 <Code>networks.default.driver_opts</Code> 中加入{' '}
              <Code>com.docker.network.driver.mtu: "1450"</Code>，然后 <Code>docker compose down && docker compose up -d</Code>。
            </>,
          ]}
        />
      </div>
    </div>
  )
}

/** 收到了回应，但不是服务商的数据（代理、防火墙、WAF、网络认证页面）：与 Key 无关 */
function BlockedHelp({ d }: { d: Checked }) {
  return (
    <Diagnosis title="请求被拦截">
      服务器收到了回应，但不是服务商的数据{d.status ? `（HTTP ${d.status}）` : ''}，内容见上方「原始错误」：多为代理、防火墙、WAF
      或网络认证页面拦截了请求，与 Key 无关，不需要重新申请 Key。检查 <Code>~/.docker/config.json</Code> 的{' '}
      <Code>proxies</Code> 与服务器的出站策略，或在部署目录运行 <Code>docker compose exec app /triphub -diagnose</Code> 查看详情。
    </Diagnosis>
  )
}

/** 与 Key 无关、稍后会自行恢复的失败：只需稍后重新检测 */
function RetryLater({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Diagnosis title={title}>
      {children}稍后点「重新检测」即可，不需要修改 <Code>.env</Code>。
    </Diagnosis>
  )
}

/* ---------------- 高德 ---------------- */

const amapCodes: { codes: string[]; title: string; fix: ReactNode }[] = [
  {
    codes: ['10009'],
    title: '平台不匹配',
    fix: (
      <>
        这个 Key 不是「Web服务」平台的（常见于误填了「Web端（JS API）」Key）。请在高德控制台新建一个服务平台为「Web服务」的
        Key，替换 <Code>AMAP_KEY</Code>。
      </>
    ),
  },
  {
    codes: ['10005'],
    title: 'IP 白名单',
    fix: <>服务器的公网 IP 不在该 Key 的白名单中。在高德控制台编辑这个 Key，把服务器 IP 加入白名单，或清空白名单。</>,
  },
  {
    codes: ['10003', '10044'],
    title: '调用额度已用完',
    fix: (
      <>
        当日调用量已到上限（10003 为 Key 维度，10044 为账号维度），次日零点自动恢复；也可以在控制台申请提升配额，或配置天地图作为备用。
      </>
    ),
  },
  {
    codes: ['10001'],
    title: 'Key 无效',
    fix: (
      <>
        检查 <Code>AMAP_KEY</Code> 是否完整复制，前后没有多余的空格或引号；Key 被删除后也会出现这个错误。
      </>
    ),
  },
  {
    codes: ['10002', '10012'],
    title: '没有接口权限',
    fix: <>确认 Key 的服务平台为「Web服务」；新建的 Key 默认已开通搜索、逆地理编码与路径规划。</>,
  },
  {
    codes: ['10004', '10010', '10014', '10019', '10020', '10021'],
    title: '调用过于频繁',
    fix: <>短时间内请求太多，稍后会自动恢复，一般无需处理。</>,
  },
]

/** Key 本身配置有误的错误码：只有这些（和原因不明的失败）才给出申请 / 填写 Key 的步骤 */
const amapKeyCodes = new Set(['10001', '10002', '10006', '10007', '10008', '10009', '10012', '10013'])

function AmapPanel({ d }: { d: AdminDiagnostics['amap'] }) {
  const state = stateOf(d)
  const network = isNetworkFailure(d)
  const code = d.infocode && d.infocode !== '10000' ? d.infocode : undefined
  const matched = code ? amapCodes.find((c) => c.codes.includes(code)) : undefined
  // 高德自己的回应总是 HTTP 200 的 JSON：其它状态或内容来自中间的代理、网关，或高德暂时异常
  const reply = state === 'bad' && !network && (d.blocked || d.layer === 'http' || d.layer === 'response')
  const keySteps = state === 'off' || (state === 'bad' && !network && !reply && (!code || amapKeyCodes.has(code)))
  const steps = [
    <>
      登录高德开放平台（<Code>console.amap.com</Code>）→ 应用管理 → 创建应用并添加 Key，服务平台选择「Web服务」。
    </>,
    <>
      把 Key 填入部署目录 <Code>.env</Code> 的 <Code>AMAP_KEY</Code>：
      <Snippet label=".env">{'AMAP_KEY=你的 Web服务 Key'}</Snippet>
    </>,
    <>
      在部署目录执行下面的命令使配置生效，然后回到这里点「重新检测」。
      <Snippet label="终端 · 部署目录">docker compose up -d</Snippet>
    </>,
  ]
  return (
    <ServicePanel
      no="01"
      en="AMap"
      title="高德地图"
      sub={
        <>
          Web服务 Key
          <br />
          <span className="font-mono">AMAP_KEY</span>
        </>
      }
      state={state}
      purpose="地点搜索、地址解析（逆地理编码）、附近推荐与路线距离都依赖它。未配置时搜索只能退回离线的省市数据，路段距离按直线估算。"
      message={d.message}
    >
      {code && (
        <p className="text-xs text-ink-400">
          错误码 infocode <span className="font-num text-base text-ink-900">{code}</span>
        </p>
      )}
      {state !== 'off' && <TechDetail d={d} />}
      {network && <NetworkHelp d={d} />}
      {reply &&
        (d.blocked ? (
          <BlockedHelp d={d} />
        ) : (
          <RetryLater title="高德暂时异常">
            高德返回了 HTTP {d.status}，与 Key 无关；经代理访问时也可能是代理出错。
          </RetryLater>
        ))}
      {state !== 'ok' && !network && !reply && (
        <div className="space-y-6">
          {matched && <Diagnosis title={`${code} · ${matched.title}`}>{matched.fix}</Diagnosis>}
          {keySteps && (
            <div>
              <Label>{state === 'off' ? 'Setup · 配置方法' : 'Fix · 修复步骤'}</Label>
              <Steps items={steps} />
            </div>
          )}
          {state === 'bad' && (
            <div>
              <Label>Infocode · 常见错误码</Label>
              <dl className="mt-2 divide-y divide-ink-200 border-y border-ink-200 text-sm">
                {amapCodes.slice(0, 4).map((c) => {
                  const hit = !!code && c.codes.includes(code)
                  return (
                    <div key={c.codes[0]} className="flex gap-4 py-2.5">
                      <dt className={cn('font-num w-28 shrink-0', hit ? 'text-brand-600' : 'text-ink-500')}>
                        {c.codes.join(' / ')}
                      </dt>
                      <dd className={cn('min-w-0', hit ? 'text-ink-900' : 'text-ink-600')}>{c.title}</dd>
                    </div>
                  )
                })}
              </dl>
            </div>
          )}
        </div>
      )}
    </ServicePanel>
  )
}

/* ---------------- AI ---------------- */

const thinkingLabel = (t: string) => {
  const v = (t || 'off').toLowerCase()
  return v === 'off' ? '关闭' : v === 'on' ? '开启' : `开启 · ${v}`
}

/** 按服务端给出的错误类别（kind）判断原因；旧版服务端没有 kind 时按错误信息猜 */
function aiCause(d: AdminDiagnostics['ai']): { title: string; fix: ReactNode } | undefined {
  const deepseek = /deepseek/i.test(d.base_url)
  switch (d.kind) {
    case 'auth':
      return {
        title: 'API Key 无效或没有权限',
        fix: (
          <>
            检查 <Code>AI_API_KEY</Code> 是否完整、是否已被删除；可以把上方「技术细节」中 Key 的长度和首尾字符与服务商控制台里的 Key
            对照，确认容器用的是新 Key。
          </>
        ),
      }
    case 'balance':
      return {
        title: '账户余额不足',
        fix: deepseek ? (
          <>
            请在 DeepSeek 开放平台（<Code>platform.deepseek.com</Code>）充值。余额属于账户，新建一个 Key 解决不了这个问题；充值后点「重新检测」即可，不需要修改
            <Code>.env</Code>。
          </>
        ) : (
          <>到模型服务商的控制台充值或提升额度后点「重新检测」，不需要修改 <Code>.env</Code>。</>
        ),
      }
    case 'model':
      return {
        title: '模型名不正确',
        fix: (
          <>
            检查 <Code>AI_MODEL</Code>；使用 DeepSeek 时为 <Code>deepseek-flash</Code>。
          </>
        ),
      }
    case 'rate_limit':
      return { title: '请求过于频繁', fix: <>服务商限制了请求频率或并发数，与 Key 是否正确无关，稍后重新检测即可。</> }
    case 'server':
      return { title: '服务商暂时不可用', fix: <>模型服务返回了 5xx 错误，与本站配置无关，稍后重新检测。</> }
    case 'timeout':
      // 没有收到任何数据的超时是网络问题（layer 为 timeout，显示容器网络排查）；这里是已经开始返回、但没有及时完成
      return {
        title: '模型响应过慢',
        fix: (
          <>
            模型已经开始返回，但没有在限定时间内完成，与网络和 Key 无关：多为服务商繁忙或开启了深度思考。可以在 <Code>.env</Code> 中设置{' '}
            <Code>AI_THINKING=off</Code> 或换用更快的模型（改后执行 <Code>docker compose up -d</Code>），或稍后重新检测。
          </>
        ),
      }
    case 'empty':
      return {
        title: '没有返回结果',
        fix: (
          <>
            模型只返回了思考过程或空内容。开启深度思考时可在 <Code>.env</Code> 中设 <Code>AI_THINKING=off</Code>，执行{' '}
            <Code>docker compose up -d</Code> 后重新检测。
          </>
        ),
      }
    case 'bad_response':
      return {
        title: '接口地址不是 OpenAI 兼容接口',
        fix: (
          <>
            检查 <Code>AI_BASE_URL</Code>，使用 DeepSeek 时为 <Code>https://api.deepseek.com</Code>。
          </>
        ),
      }
  }
  if (d.kind) return undefined
  const msg = d.message
  if (/401|403|unauthori|invalid.{0,12}key|authentication|api key/i.test(msg))
    return { title: 'API Key 无效', fix: <>检查 <Code>AI_API_KEY</Code> 是否正确、是否已过期或被删除。</> }
  if (/402|insufficient|balance|余额|欠费|quota/i.test(msg))
    return { title: '账户余额或额度不足', fix: <>到模型服务商的控制台充值或提升额度后重新检测。</> }
  if (/404|not.?found|model.{0,20}(exist|found|support)|不存在/i.test(msg))
    return {
      title: '接口地址或模型名不正确',
      fix: (
        <>
          检查 <Code>AI_BASE_URL</Code> 与 <Code>AI_MODEL</Code>；使用 DeepSeek 时分别为 <Code>https://api.deepseek.com</Code> 与{' '}
          <Code>deepseek-flash</Code>。
        </>
      ),
    }
  if (/timeout|timed out|deadline|超时|connection|dial|no such host|refused|网络|无法连接/i.test(msg))
    return {
      title: '连接失败或超时',
      fix: <>服务器访问不到模型接口：检查服务器的网络、防火墙或代理设置；开启了深度思考时响应也会明显变慢。</>,
    }
  return undefined
}

/** 参数表：手机上是「标签 … 数值」的细线列表，宽屏为四栏 */
function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 py-2.5 sm:block sm:px-4 sm:py-3 sm:first:pl-0">
      <dt className="shrink-0 text-xs tracking-wide text-ink-400">{label}</dt>
      <dd className="min-w-0 text-right text-sm [overflow-wrap:anywhere] text-ink-900 sm:mt-1.5 sm:text-left">{children}</dd>
    </div>
  )
}

/** 与 Key / 接口地址 / 模型名的配置有关（或原因不明）的错误类别：只有这些才给出填写配置的步骤 */
const aiConfigKinds = new Set(['auth', 'model', 'bad_response', 'request', 'provider'])

function AiPanel({ d }: { d: AdminDiagnostics['ai'] }) {
  const state = stateOf(d)
  const network = isNetworkFailure(d)
  const blocked = state === 'bad' && !network && !!d.blocked
  const cause = state === 'bad' && !network && !blocked ? aiCause(d) : undefined
  const configSteps =
    state === 'off' || (state === 'bad' && !network && !blocked && (!d.kind || aiConfigKinds.has(d.kind)))
  const thinkingOn = !!d.thinking && d.thinking.toLowerCase() !== 'off'
  const slow = state === 'ok' && d.latency_ms > 15000
  return (
    <ServicePanel
      no="02"
      en="AI Model"
      title="AI 模型"
      sub={
        <>
          OpenAI 兼容接口
          <br />
          <span className="font-mono">AI_BASE_URL · AI_MODEL</span>
        </>
      }
      state={state}
      purpose="用于「AI 规划行程」：根据目的地、天数与偏好生成多日行程。未配置时该功能不可用，其余功能不受影响。"
      message={d.message}
    >
      {(d.model || d.base_url) && (
        <dl className="divide-y divide-ink-200 border-y border-ink-200 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_minmax(0,0.8fr)_minmax(0,0.8fr)] sm:divide-x sm:divide-y-0">
          <Meta label="模型">
            <span className="font-mono text-[13px]">{d.model || '—'}</span>
          </Meta>
          <Meta label="接口地址">
            <span className="font-mono text-[13px]">{d.base_url || '—'}</span>
          </Meta>
          <Meta label="深度思考">
            {thinkingLabel(d.thinking)}
          </Meta>
          <Meta label="响应耗时">
            {d.latency_ms > 0 ? (
              d.latency_ms >= 1000 ? (
                <>
                  <span className="font-num text-2xl leading-none">{(d.latency_ms / 1000).toFixed(1)}</span>
                  <span className="font-num ml-1 text-xs text-ink-400">s</span>
                </>
              ) : (
                <>
                  <span className="font-num text-2xl leading-none">{d.latency_ms}</span>
                  <span className="font-num ml-1 text-xs text-ink-400">ms</span>
                </>
              )
            ) : (
              <span className="text-ink-400">—</span>
            )}
          </Meta>
        </dl>
      )}

      {state !== 'off' && <TechDetail d={d} />}
      {network && <NetworkHelp d={d} />}
      {blocked && <BlockedHelp d={d} />}
      {cause && <Diagnosis title={cause.title}>{cause.fix}</Diagnosis>}
      {slow && (
        <Diagnosis title="响应较慢">
          检测用时超过 15 秒。{thinkingOn ? '当前开启了深度思考，' : ''}可以在 <Code>.env</Code> 中设置 <Code>AI_THINKING=off</Code>{' '}
          关闭深度思考，生成会快很多。
        </Diagnosis>
      )}

      {configSteps ? (
        <div>
          <Label>{state === 'off' ? 'Setup · 配置方法' : 'Fix · 修复步骤'}</Label>
          <Steps
            items={[
              <>在模型服务商的控制台获取 API Key（例如 DeepSeek 开放平台 <Code>platform.deepseek.com</Code>）。</>,
              <>
                在部署目录的 <Code>.env</Code> 中填写接口地址、模型和 Key。以 DeepSeek 为例：
                <Snippet label=".env">{'AI_BASE_URL=https://api.deepseek.com\nAI_MODEL=deepseek-flash\nAI_API_KEY=sk-你的Key\nAI_THINKING=off'}</Snippet>
              </>,
              <>
                执行 <Code>docker compose up -d</Code> 使配置生效，然后回到这里点「重新检测」。
              </>,
            ]}
          />
        </div>
      ) : null}

      <p className="text-xs leading-relaxed text-ink-400">
        深度思考默认关闭（<Code>AI_THINKING=off</Code>）。设为 <Code>on</Code>（或 <Code>low</Code> / <Code>high</Code> /{' '}
        <Code>max</Code>）后行程更周全，但生成会明显变慢。
      </p>
    </ServicePanel>
  )
}

/* ---------------- 天地图 ---------------- */

function TiandituPanel({ d }: { d: AdminDiagnostics['tianditu'] }) {
  const state = stateOf(d)
  const network = isNetworkFailure(d)
  const blocked = state === 'bad' && !network && !!d.blocked
  // 天地图用 401 / 403 或错误码回应 Key 的问题；5xx 等其它状态与 Key 无关
  const keyIssue =
    state === 'bad' && !network && !blocked && (!d.layer || d.layer === 'api' || d.status === 401 || d.status === 403)
  const serverDown = state === 'bad' && !network && !blocked && !keyIssue && !!d.status && d.status >= 500
  return (
    <ServicePanel
      no="03"
      en="Tianditu"
      title="天地图"
      optional
      sub={
        <>
          服务端 Key
          <br />
          <span className="font-mono">TIANDITU_KEY</span>
        </>
      }
      state={state}
      purpose="免费的备用服务：高德未配置、出错或额度用完时，用于地点搜索与地址解析。不配置也能正常使用。"
      message={d.message}
    >
      {state !== 'off' && <TechDetail d={d} />}
      {network && <NetworkHelp d={d} />}
      {blocked && <BlockedHelp d={d} />}
      {serverDown && <RetryLater title="天地图暂时异常">天地图返回了 HTTP {d.status}，与 Key 无关。</RetryLater>}
      {keyIssue && (
        <Diagnosis title="确认 Key 的类型">
          服务器上只能使用「服务端」类型的 Key；「浏览器端」Key 会被天地图拒绝。也请确认 Key 已启用、复制完整。
        </Diagnosis>
      )}
      {(state === 'off' || keyIssue) && (
        <div>
          <Label>{state === 'off' ? 'Setup · 配置方法（可选）' : 'Fix · 修复步骤'}</Label>
          <Steps
            items={[
              <>
                在天地图开放平台（<Code>console.tianditu.gov.cn</Code>）注册账号，进入控制台创建应用，应用类型选择「服务端」，得到 Key。
              </>,
              <>
                把 Key 填入 <Code>.env</Code>：
                <Snippet label=".env">{'TIANDITU_KEY=你的服务端 Key'}</Snippet>
              </>,
              <>
                执行 <Code>docker compose up -d</Code>，然后回到这里点「重新检测」。
              </>,
            ]}
          />
        </div>
      )}
    </ServicePanel>
  )
}

/* ---------------- 面板 ---------------- */

export function DiagnosticsPanel() {
  // 检测会真实调用高德、AI 与天地图的接口（AI 还会消耗少量 token）：只在打开本页时检测一次，之后手动「重新检测」，
  // 不轮询、不在窗口聚焦时重试。查询键不放在 ['admin'] 下，其它页面让 ['admin'] 失效时不会顺带重新检测
  const q = useQuery({
    queryKey: ['admin-diagnostics'],
    queryFn: api.admin.diagnostics,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
  const outdated = isNotFound(q.error)
  const d = q.data

  const counts = d
    ? [d.amap, d.ai, d.tianditu].reduce(
        (acc, s) => ({ ...acc, [stateOf(s)]: acc[stateOf(s)] + 1 }),
        { ok: 0, off: 0, bad: 0 } as Record<State, number>,
      )
    : null

  return (
    <div>
      <PanelHeader
        eyebrow="Diagnostics · 诊断"
        title="系统诊断"
        desc="实时检测地图、AI 与地址服务的配置是否可用，并给出修复建议。"
        extra={
          !outdated && (
            <Button
              variant="primary"
              icon={<RefreshCw className={cn('size-4', q.isFetching && 'animate-spin')} strokeWidth={1.75} />}
              disabled={q.isFetching}
              onClick={() => q.refetch()}
            >
              {q.isFetching ? '检测中…' : '重新检测'}
            </Button>
          )
        }
      />

      {q.isPending && q.isFetching ? (
        <div className="flex flex-col items-center gap-3 border-y border-ink-200 py-16 text-sm text-ink-500">
          <Spinner className="size-6" />
          正在检测高德、AI 与天地图…
          <span className="text-xs text-ink-400">AI 模型的检测可能需要十几秒</span>
        </div>
      ) : outdated ? (
        <div className="border-y border-ink-200 py-14 text-center">
          <p className="eyebrow">Unavailable · 暂不可用</p>
          <p className="font-display mt-3 text-xl text-ink-900">服务器版本较旧，升级后可用</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-500">
            当前服务端还没有系统诊断接口。把服务端升级到最新版本并重新部署后，就可以在这里检测高德、AI 与天地图的配置。
          </p>
        </div>
      ) : !d ? (
        <div className="border-y border-ink-200">
          <LoadError title="检测失败" error={q.error} onRetry={() => q.refetch()} />
        </div>
      ) : (
        <div className={cn('transition-opacity', q.isFetching && 'opacity-50')}>
          {counts && (
            <p className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-ink-500">
              <span>
                正常 <span className="font-num text-base text-emerald-700">{counts.ok}</span>
              </span>
              <span>
                异常 <span className={cn('font-num text-base', counts.bad ? 'text-brand-600' : 'text-ink-900')}>{counts.bad}</span>
              </span>
              <span>
                未配置 <span className="font-num text-base text-ink-900">{counts.off}</span>
              </span>
              <span className="ml-auto text-ink-400">
                检测于 <span className="font-num">{dayjs(q.dataUpdatedAt).format('HH:mm:ss')}</span>
              </span>
            </p>
          )}
          {q.isError && (
            <p className="mb-4 border-l-2 border-brand-500 py-0.5 pl-3 text-sm text-ink-600">
              重新检测失败：{errorMessage(q.error)}。下面是上一次的检测结果。
            </p>
          )}
          <div className="border-b border-ink-200" aria-live="polite">
            <AmapPanel d={d.amap} />
            <AiPanel d={d.ai} />
            <TiandituPanel d={d.tianditu} />
          </div>
        </div>
      )}
    </div>
  )
}
