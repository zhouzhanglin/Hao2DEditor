/**
 * 图片加载统一入口：一律走 `<img>` 元素。
 *
 * 为什么不直接用 `fetch` / Pixi 的 `Assets.load`：
 * 1. Pixi 的 loadTextures parser 靠 **URL 扩展名**挑选（.png/.jpg/…），而工程里的图片 URL 是
 *    `blob:` 或 `hao2d-file://<base64>`，末尾没有扩展名 —— parser 认不出来，Assets 只会打印
 *    「could not be loaded as we don't know how to parse it」并返回 null，纹理停在 Texture.WHITE（白块）。
 * 2. `fetch` 受 CSP 的 `connect-src` 约束，白名单里并没有这些 scheme；而 `img-src` 已经放行了
 *    `blob:` / `hao2d-file:` / `data:`。
 *
 * 跨源 URL（hao2d-file://）需要带上 crossOrigin 才能上传成 WebGL 纹理，主进程协议会回
 * `Access-Control-Allow-Origin`；同源的 blob: 不加，避免多余的限制。
 */
export function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    if (!url.startsWith('blob:') && !url.startsWith('data:')) image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`图片加载失败：${url.slice(0, 72)}`))
    image.src = url
  })
}
