import { getActiveScene } from '../activeScene'
import { getPlatform } from '../platform'
import { imageSources } from '@render/imageSourceRegistry'

/**
 * 丢弃「上一份资源」在内存里留下的一切：GPU 贴图、像素遮罩、图集页来源记账，
 * 以及平台层缓存的图片 URL（`blob:` 会 revoke，字节随之可回收）。
 *
 * **整份换文档**的入口都要在替换前调它：新建项目、导入 Spine / 导入 DragonBones
 *（两条拖入分派也走同一个 `finishImport`）。
 *
 * 为什么必须在「替换前」：新文档一进 store（zustand 的订阅是同步的）视口就会重建视图、
 * 开始读新图集页 —— 那时旧贴图已经没人引用，销毁是安全的；拖到替换之后再清，会把新文档
 * 刚加载好的贴图一起清掉，而且新的加载请求还会被旧的 `loading` 标记挡住。
 *
 * 不清的后果：每个导入过的工程的图集页都会一直留在内存里（文件字节 + 解码后的贴图 +
 * 逐像素 alpha），而且**同名图集页**（DragonBones 示例里 4 个角色都叫 `texture.png`）
 * 会继续用上一份贴图，新资源的 UV 按新页尺寸归一化 → 零件整块错位。
 */
export function releaseDocumentAssets(): void {
  const scene = getActiveScene()
  scene?.textures.clear()
  scene?.imageAlpha.clear()
  // 记账一起清掉：否则下一次加载会以为「这张图还在」，跳过加载
  imageSources.clear()
  getPlatform().releaseImageCache()
}
