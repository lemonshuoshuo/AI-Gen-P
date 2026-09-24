// 图片解码与压缩（不含 EXIF 解析：头像、旅行模式拍照只需要这些，不必下载 exifr）

export const MAX_EDGE = 2560

export async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return img
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

/** 画到 w×h 的画布上并编码成 JPEG；用完立即清空画布（iOS Safari 要等回收才释放画布内存，批量处理会超出上限） */
async function drawJpeg(img: HTMLImageElement, w: number, h: number, quality: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  try {
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('图片压缩失败')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, w, h)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片压缩失败'))), 'image/jpeg', quality),
    )
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

/**
 * 压缩成长边不超过 maxEdge 的 JPEG。
 * thumbEdge > 0 时另外生成短边约 thumbEdge 像素的缩略图：预览网格用它，不必在手机上解码几十张全尺寸大图
 */
export async function compressImage(blob: Blob, maxEdge = MAX_EDGE, quality = 0.86, thumbEdge = 0) {
  const img = await loadImage(blob)
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  let thumb: Blob | undefined
  if (thumbEdge > 0) {
    const ts = Math.min(1, thumbEdge / Math.min(nw, nh))
    thumb = await drawJpeg(img, Math.max(1, Math.round(nw * ts)), Math.max(1, Math.round(nh * ts)), 0.7)
  }
  const scale = Math.min(1, maxEdge / Math.max(nw, nh))
  const w = Math.round(nw * scale)
  const h = Math.round(nh * scale)
  // 小图且本身是 JPEG 时直接上传原图
  if (scale === 1 && blob.type === 'image/jpeg' && blob.size < 3 * 1024 * 1024) return { blob, width: w, height: h, thumb }
  return { blob: await drawJpeg(img, w, h, quality), width: w, height: h, thumb }
}
