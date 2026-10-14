import { loadImageElement } from '@render/imageLoader'

export interface PageBlit {
  /** 源图名（= ImageRef.name） */
  name: string
  x: number
  y: number
  width: number
  height: number
}

export interface PageEncodePlan {
  width: number
  height: number
  blits: PageBlit[]
}

/**
 * 用 OffscreenCanvas 把若干图片拼成图集页并编码为 PNG。
 * 放在渲染进程做：无需引入原生图像依赖，且浏览器 / Electron 行为一致。
 *
 * `plans` 与调用方的页清单**逐项对齐**：`null` 表示这一页不需要编码
 * （本来就是图集，直接把源文件复制过去当页用），对应位置返回空字节。
 */
export async function encodeAtlasPages(
  plans: readonly (PageEncodePlan | null)[],
  loadImage: (name: string) => Promise<ImageBitmap | null>
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for (const plan of plans) {
    if (!plan) {
      out.push(new Uint8Array())
      continue
    }
    const canvas = createCanvas(plan.width, plan.height)
    if (!canvas) {
      out.push(new Uint8Array())
      continue
    }
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null
    if (!ctx) {
      out.push(new Uint8Array())
      continue
    }
    for (const blit of plan.blits) {
      const bitmap = await loadImage(blit.name)
      if (!bitmap) continue
      ctx.drawImage(bitmap as CanvasImageSource, blit.x, blit.y, blit.width, blit.height)
      if ('close' in bitmap) bitmap.close()
    }
    out.push(await encodeCanvas(canvas))
  }
  return out
}

/** 要从一张图里裁出来的一块区域：坐标是源图像素，`rotate` = 这块区域在源图里被转过的角度 */
export interface RegionCrop {
  x: number
  y: number
  /** 区域**自身**的宽高（旋转前，也就是拆出来那张图的尺寸） */
  width: number
  height: number
  /** 0 / 90 / 180 / 270（缺省 0） */
  rotate?: number
}

/**
 * 把源图里若干块各自裁出来（旋转打包的转回原朝向）并编码为 PNG。
 *
 * 用在「图集拆碎图」上：图集页里的子图可能被转 90° 存放，碎图必须转正 ——
 * 附件的 UV 会按这块区域的**自身**坐标重新归一化（见 `applyAtlasSplit`）。
 *
 * 坐标口径与 `importers/uv.ts` 的 `mapRegionRelativeUvs` 一致：90°/270° 时区域在源图里
 * 占位的宽高是互换的，`x / y` 仍是这块占位矩形的左上角。
 */
export async function cropRegionPngs(
  bitmap: ImageBitmap,
  crops: readonly RegionCrop[]
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for (const crop of crops) {
    const width = Math.max(1, Math.round(crop.width))
    const height = Math.max(1, Math.round(crop.height))
    const canvas = createCanvas(width, height)
    const ctx = canvas?.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null
    if (!canvas || !ctx) {
      out.push(new Uint8Array())
      continue
    }
    const rotate = ((Math.round(crop.rotate ?? 0) % 360) + 360) % 360
    const [a, b, c, d, e, f] = cropMatrix(rotate, width, height)
    // 源图里的占位矩形：90°/270° 宽高互换
    const blockWidth = rotate % 180 === 0 ? width : height
    const blockHeight = rotate % 180 === 0 ? height : width
    ctx.setTransform(a, b, c, d, e, f)
    ctx.drawImage(
      bitmap as CanvasImageSource,
      crop.x,
      crop.y,
      blockWidth,
      blockHeight,
      0,
      0,
      blockWidth,
      blockHeight
    )
    out.push(await encodeCanvas(canvas))
  }
  return out
}

/**
 * 「源图里那块像素 (X, Y)」→「转正后碎图里那块像素 (U, V)」的变换矩阵（canvas setTransform 口径）。
 *
 * 与 `mapRegionRelativeUvs` 的四个分支互为逆运算（那边是区域坐标 → 页坐标），改一处必须改另一处：
 *   90°：(X, Y) → (width - Y, X)      270°：(X, Y) → (Y, height - X)
 *   180°：(X, Y) → (width - X, height - Y)
 *
 * 导出是为了让单测能按这套口径核对「裁出来的像素 ↔ 附件 UV」是一回事。
 */
export function cropMatrix(
  rotate: number,
  width: number,
  height: number
): [number, number, number, number, number, number] {
  switch (rotate) {
    case 90:
      return [0, 1, -1, 0, width, 0]
    case 180:
      return [-1, 0, 0, -1, width, height]
    case 270:
      return [0, -1, 1, 0, 0, height]
    default:
      return [1, 0, 0, 1, 0, 0]
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas | null {
  const w = Math.max(1, Math.ceil(width))
  const h = Math.max(1, Math.ceil(height))
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    return canvas
  }
  return null
}

async function encodeCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Uint8Array> {
  if ('convertToBlob' in canvas) {
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return new Uint8Array(await blob.arrayBuffer())
  }
  const blob = await new Promise<Blob | null>((resolve) =>
    (canvas as HTMLCanvasElement).toBlob((value) => resolve(value), 'image/png')
  )
  if (!blob) return new Uint8Array()
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * 加载一张图片为 ImageBitmap。
 *
 * 走 `<img>` 而不是 fetch：图片 URL 是 blob: / hao2d-file://，这两个 scheme 不在 CSP 的
 * connect-src 白名单里（img-src 里有），fetch 会被直接拦掉。
 */
export async function loadImageBitmap(url: string): Promise<ImageBitmap | null> {
  if (!url) return null
  const image = await loadImageElement(url).catch((error: unknown) => {
    console.error(`[hao2d] 读取图片失败：${url}`, error)
    return null
  })
  if (!image) return null
  return createImageBitmap(image).catch((error: unknown) => {
    console.error('[hao2d] 解码图片失败', error)
    return null
  })
}
