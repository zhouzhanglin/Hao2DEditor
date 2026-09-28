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
 */
export async function encodeAtlasPages(
  plans: readonly PageEncodePlan[],
  loadImage: (name: string) => Promise<ImageBitmap | null>
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for (const plan of plans) {
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

/** 加载一张图片为 ImageBitmap（Electron 用 hao2d-file://，浏览器用 blob:） */
export async function loadImageBitmap(url: string): Promise<ImageBitmap | null> {
  if (!url) return null
  const response = await fetch(url).catch((error: unknown) => {
    console.error(`[hao2d] 读取图片失败：${url}`, error)
    return null
  })
  if (!response || !response.ok) return null
  const blob = await response.blob()
  return createImageBitmap(blob).catch((error: unknown) => {
    console.error('[hao2d] 解码图片失败', error)
    return null
  })
}
