/**
 * 「图集页名 → 已加载的源路径」记账。
 *
 * 为什么需要它：贴图缓存（TextureStore）与像素缓存（ImageAlphaCache）都按**图片名**做键，
 * 而不同资源常用**同名**图集页 —— DragonBones 示例里 4 个角色（Dragon / DragonOpening /
 * Ubbie_MeshAnim / Demon）的图集页都叫 `texture.png`。
 *
 * 只按名字判断「已加载」，第二次导入就会继续用上一份贴图：UV 是按新图集的页尺寸归一化的，
 * 贴在旧图上就整块错位 —— 表现是「零件张冠李戴 / 位置不对」。重启应用后又正常，
 * 也正是因为缓存空了。
 *
 * 这里按「名字 + 源路径」记账：路径变了（或清单里没有了）就报给调用方销毁重载。
 */
export class ImageSourceRegistry {
  private readonly loaded = new Map<string, string>()

  /**
   * 与当前图片清单对齐，返回**需要销毁重载**的名字（路径变了、或已从清单移除）。
   * 只做记账，不碰任何 GPU / DOM 资源 —— 释放由调用方执行。
   */
  sync(images: ReadonlyArray<{ name: string; path: string }>): string[] {
    const alive = new Map<string, string>()
    for (const image of images) alive.set(image.name, image.path)
    const stale: string[] = []
    for (const [name, path] of this.loaded) {
      if (alive.get(name) !== path) stale.push(name)
    }
    for (const name of stale) this.loaded.delete(name)
    return stale
  }

  /** 这张图是否**按当前路径**已经加载完成 */
  has(image: { name: string; path: string }): boolean {
    return this.loaded.get(image.name) === image.path
  }

  /** 加载完成后登记 */
  markLoaded(image: { name: string; path: string }): void {
    this.loaded.set(image.name, image.path)
  }

  clear(): void {
    this.loaded.clear()
  }

  /** 记账条数（状态检查 / 测试用） */
  get size(): number {
    return this.loaded.size
  }
}

/**
 * 编辑器全局的记账单例：只有记账，不占任何 GPU / DOM 资源。
 *
 * 它得是模块级单例（而不是挂在视口组件里）：换工程时由 `releaseDocumentAssets()` 统一清空，
 * 不依赖视口是否挂载 —— 视口没挂载时组件里的那份就没人清了。
 */
export const imageSources = new ImageSourceRegistry()
