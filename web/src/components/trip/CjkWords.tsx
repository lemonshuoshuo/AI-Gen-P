import { Fragment, useMemo } from 'react'

// 按词切分（浏览器不支持时整段不切）；只在模块加载时创建一次
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('zh', { granularity: 'word' }) : null

// 前置标点跟着后面的词走，其余标点跟着前面的词走
const OPENING = /^[（(《「『“‘[【〈〔｛{]+$/
const HAN1 = /^\p{Script=Han}$/u

/**
 * 把标题切成不可再断开的词组：「温岭海边周末（计划）」→ 温岭 | 海边 | 周末 | （计划）。
 * 词典里没有的地名会被切成单字（温 / 岭），连续的单字合回一个词；空白处照常可以换行。
 */
export function splitWords(text: string): string[] {
  if (!segmenter) return [text]
  const out: string[] = []
  // 等着接到下一个词前面的内容（前置标点、行首标点以及它后面的空格）
  let pending = ''
  // 上一段是不是空白：空白之后的标点（如「台州 · 山海」里的 ·）挂到下一个词上
  let afterSpace = true
  // 上一个词是不是由单个汉字组成（连续的单字合成一个词）
  let single = false
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (/^\s+$/.test(segment)) {
      if (pending) pending += segment
      else out.push(' ')
      afterSpace = true
      single = false
      continue
    }
    if (!isWordLike && (OPENING.test(segment) || afterSpace || !out.length)) {
      pending += segment
      afterSpace = false
      continue
    }
    if (!isWordLike && out.length && out[out.length - 1] !== ' ') {
      out[out.length - 1] += segment
      afterSpace = false
      single = false
      continue
    }
    const one = HAN1.test(segment)
    if (one && single && !pending) out[out.length - 1] += segment
    else {
      out.push(pending + segment)
      pending = ''
    }
    single = one
    afterSpace = false
  }
  if (pending) {
    if (out.length && out[out.length - 1] !== ' ') out[out.length - 1] += pending.trimEnd()
    else out.push(pending.trimEnd())
  }
  return out
}

/**
 * 展示字号的中文标题：每个词包成 inline-block，配合 text-balance 只在词与词之间换行，
 * 不会把「周末」拆成「周 / 末」。超出一行宽度的长词仍可在词内断开，避免横向溢出。
 */
export function CjkWords({ text }: { text: string }) {
  const parts = useMemo(() => splitWords(text), [text])
  return (
    <>
      {parts.map((p, i) =>
        p === ' ' ? (
          <Fragment key={i}> </Fragment>
        ) : (
          <span key={i} className="inline-block max-w-full [overflow-wrap:anywhere]">
            {p}
          </span>
        ),
      )}
    </>
  )
}
