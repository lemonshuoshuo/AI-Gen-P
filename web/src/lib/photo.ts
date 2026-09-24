// 照片预处理：读取 EXIF（GPS / 拍摄时间）→ HEIC 转换 → 压缩
import exifr from 'exifr'
import { MAX_EDGE, compressImage, loadImage } from './image'

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

// 预览缩略图的短边：预览网格一格约 62px，3 倍屏约 186 像素
const THUMB_EDGE = 256

function isHeic(f: File) {
  return /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/i.test(f.type)
}

async function readExif(f: File) {
  try {
    // latitude / longitude 是 exifr 由原始 GPS 标签（含 Ref 半球标记）算出来的，pick 里必须列原始标签
    const data = await exifr.parse(f, {
      pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'GPSLatitude', 'GPSLatitudeRef', 'GPSLongitude', 'GPSLongitudeRef'],
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

// heic2any 只有一个全局 worker，每张都要解码成全尺寸位图：一次只转一张，并发只会抬高内存峰值
let heicQueue: Promise<unknown> = Promise.resolve()

function heicToJpeg(f: File): Promise<Blob> {
  const run = heicQueue.then(async () => {
    // 按需加载转换库，避免拖慢首屏
    const { default: heic2any } = await import('heic2any')
    const out = await heic2any({ blob: f, toType: 'image/jpeg', quality: 0.9 })
    return Array.isArray(out) ? out[0] : out
  })
  heicQueue = run.catch(() => {})
  return run
}

export async function preparePhoto(f: File): Promise<PreparedPhoto> {
  const exif = await readExif(f)
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
  let r: Awaited<ReturnType<typeof compressImage>>
  if (isHeic(f)) {
    // Safari / iOS 17+ 能直接解码 HEIC；其他浏览器解码失败时再用 heic2any 转换（库很大、转换慢）
    try {
      r = await compressImage(f, MAX_EDGE, 0.86, THUMB_EDGE)
    } catch {
      r = await compressImage(await heicToJpeg(f), MAX_EDGE, 0.86, THUMB_EDGE)
    }
  } else {
    r = await compressImage(f, MAX_EDGE, 0.86, THUMB_EDGE)
  }
  return {
    file: r.blob,
    filename: f.name.replace(/\.[^.]+$/, '') + '.jpg',
    // 预览用小缩略图：上传的仍是上面压缩好的整张照片
    previewUrl: URL.createObjectURL(r.thumb ?? r.blob),
    ...exif,
    width: r.width,
    height: r.height,
    original: f,
  }
}

/** 并发处理，限制同时解码的数量避免手机内存吃紧 */
export async function preparePhotos(files: File[], onEach?: (done: number) => void, concurrency = 3) {
  const results: (PreparedPhoto | null)[] = Array.from({ length: files.length }, () => null)
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
