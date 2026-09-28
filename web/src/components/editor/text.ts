/** 服务端给的说明（如高德调用失败的原因）补上句号：后面还要接一句提示 */
export function sentence(s?: string | null): string | null {
  const t = s?.trim()
  if (!t) return null
  return /[。．.！!；;？?）)」]$/.test(t) ? t : `${t}。`
}
