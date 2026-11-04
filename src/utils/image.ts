// 图片上传压缩：在渲染进程做（字节本来就在手里），后端只管原子落盘。
// 策略：GIF 原样直存（canvas 会丢动画帧）；小 PNG 直存（文字截图重编码会糊）；
// 其余长边压到 1920 后转 WebP q85。SVG 一律拒收（XSS 面）。
const MAX_EDGE = 1920
const PASSTHROUGH_MAX_BYTES = 1024 * 1024
const HARD_MAX_BYTES = 20 * 1024 * 1024
const HARD_MAX_EDGE = 12000

function readAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result || ''))
    r.onerror = () => reject(new Error('图片读取失败'))
    r.readAsDataURL(blob)
  })
}

function dataUrlToB64(url) {
  const i = url.indexOf(',')
  if (i < 0) throw new Error('图片编码失败')
  return url.slice(i + 1)
}

// 返回 { b64（无前缀）, mime, w, h }；失败抛中文 Error（调用方 toast）
export async function compressImageFile(file) {
  if (!file || !file.type?.startsWith('image/')) throw new Error('请选择图片文件')
  if (file.type === 'image/svg+xml') throw new Error('不支持 SVG 图片，请转成 PNG 后上传')
  if (file.size <= 0 || file.size > HARD_MAX_BYTES) throw new Error('图片过大（超过 20MB），请压缩后重试')
  // GIF 直存：保动画
  if (file.type === 'image/gif') {
    return { b64: dataUrlToB64(await readAsDataURL(file)), mime: 'image/gif', w: null, h: null }
  }
  let bmp
  try {
    // imageOrientation 必须 from-image，否则手机竖拍会旋转
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('图片解码失败，可能已损坏')
  }
  try {
    const { width: w, height: h } = bmp
    if (w > HARD_MAX_EDGE || h > HARD_MAX_EDGE) throw new Error('图片尺寸过大，请缩小后重试')
    // 小 PNG 直存
    if (file.type === 'image/png' && file.size <= PASSTHROUGH_MAX_BYTES && w <= MAX_EDGE && h <= MAX_EDGE) {
      return { b64: dataUrlToB64(await readAsDataURL(file)), mime: 'image/png', w, h }
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h))
    const cw = Math.max(1, Math.round(w * scale))
    const ch = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('压缩失败（无画布上下文）')
    ctx.drawImage(bmp, 0, 0, cw, ch)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85))
    if (!blob) throw new Error('压缩失败')
    return { b64: dataUrlToB64(await readAsDataURL(blob)), mime: 'image/webp', w: cw, h: ch }
  } finally {
    try {
      bmp.close()
    } catch {
      /* ignore */
    }
  }
}
