// 照片预处理：读取 EXIF（GPS / 拍摄时间）→ HEIC 转换 → 压缩
import exifr from 'exifr'

export interface PreparedPhoto {
  file: Blob
  filename: string
  previewUrl: string
  /** WGS-84 */
  lng?: number
  lat?: number
  takenAt?: string
  width: number
  height: number
  original: File
}

const MAX_EDGE = 2560

function isHeic(f: File) {
  return /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/i.test(f.type)
}

async function readExif(f: File) {
  try {
    const data = await exifr.parse(f, {
      gps: true,
      pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'latitude', 'longitude'],
    })
    if (!data) return {}
    let takenAt: string | undefined
    const dt: Date | undefined = data.DateTimeOriginal ?? data.CreateDate
    if (dt instanceof Date && !Number.isNaN(dt.getTime())) takenAt = dt.toISOString()
    const lat = typeof data.latitude === 'number' ? data.latitude : undefined
    const lng = typeof data.longitude === 'number' ? data.longitude : undefined
    const valid = lat != null && lng != null && !(lat === 0 && lng === 0)
    return { takenAt, lat: valid ? lat : undefined, lng: valid ? lng : undefined }
  } catch {
    return {}
  }
}

async function heicToJpeg(f: File): Promise<Blob> {
  // 按需加载转换库，避免拖慢首屏
  const { default: heic2any } = await import('heic2any')
  const out = await heic2any({ blob: f, toType: 'image/jpeg', quality: 0.9 })
  return Array.isArray(out) ? out[0] : out
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
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

export async function compressImage(blob: Blob, maxEdge = MAX_EDGE, quality = 0.86) {
  const img = await loadImage(blob)
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth * scale)
  const h = Math.round(img.naturalHeight * scale)
  // 小图且本身是 JPEG 时直接上传原图
  if (scale === 1 && blob.type === 'image/jpeg' && blob.size < 3 * 1024 * 1024) return { blob, width: w, height: h }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, w, h)
  const out = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('图片压缩失败'))), 'image/jpeg', quality),
  )
  return { blob: out, width: w, height: h }
}

export async function preparePhoto(f: File): Promise<PreparedPhoto> {
  const exif = await readExif(f)
  let source: Blob = f
  if (isHeic(f)) source = await heicToJpeg(f)
  if (f.type === 'image/gif') {
    const img = await loadImage(f)
    return {
      file: f,
      filename: f.name,
      previewUrl: URL.createObjectURL(f),
      ...exif,
      width: img.naturalWidth,
      height: img.naturalHeight,
      original: f,
    }
  }
  const { blob, width, height } = await compressImage(source)
  return {
    file: blob,
    filename: f.name.replace(/\.[^.]+$/, '') + '.jpg',
    previewUrl: URL.createObjectURL(blob),
    ...exif,
    width,
    height,
    original: f,
  }
}

/** 并发处理，限制同时解码的数量避免手机内存吃紧 */
export async function preparePhotos(files: File[], onEach?: (done: number) => void, concurrency = 3) {
  const results: (PreparedPhoto | null)[] = new Array(files.length).fill(null)
  let next = 0
  let done = 0
  async function worker() {
    while (next < files.length) {
      const i = next++
      try {
        results[i] = await preparePhoto(files[i])
      } catch (e) {
        console.warn('照片处理失败', files[i].name, e)
      }
      onEach?.(++done)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker))
  return results.filter((x): x is PreparedPhoto => x !== null)
}
