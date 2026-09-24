/**
 * 复制文本：优先用 Clipboard API；不可用时（HTTP 页面、部分 App 内置浏览器）退回到临时文本框 + execCommand。
 * 要在点击事件里直接调用（不要先 await 别的请求），否则浏览器会拒绝复制。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 被拒绝时改用下面的方式 */
  }
  // 弹窗是 portal 到 body 的普通元素（不是原生 dialog），临时文本框放在 body 里可以正常选中
  const ta = document.createElement('textarea')
  ta.value = text
  ta.readOnly = true
  ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0'
  document.body.appendChild(ta)
  try {
    ta.select()
    ta.setSelectionRange(0, text.length) // iOS 需要显式设置选区
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    ta.remove()
  }
}
