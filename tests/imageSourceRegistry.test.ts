import { describe, expect, it } from 'vitest'
import { ImageSourceRegistry } from '@render/imageSourceRegistry'

/**
 * 背景：贴图 / 像素缓存按**图片名**做键，而不同资源的图集页常常同名
 * （DragonBones 示例里 Dragon / DragonOpening / Ubbie_MeshAnim / Demon 都叫 texture.png）。
 * 只按名字判断「已加载」会让第二次导入继续用上一份贴图 —— 零件张冠李戴，重启应用又正常。
 */
describe('图集页来源记账', () => {
  it('同名同路径不报失效；同名不同路径 / 已移除才报', () => {
    const registry = new ImageSourceRegistry()
    const demon = { name: 'texture.png', path: '/demon/texture.png' }

    // 第一次：还没加载过 → 调用方会去加载
    expect(registry.sync([demon])).toEqual([])
    expect(registry.has(demon)).toBe(false)
    registry.markLoaded(demon)
    expect(registry.has(demon)).toBe(true)

    // 同一份资源再同步：不失效、不重载
    expect(registry.sync([demon])).toEqual([])
    expect(registry.has(demon)).toBe(true)

    // 换成另一个角色的同名图集页：必须交出来销毁重载
    const other = { name: 'texture.png', path: '/dragon/texture.png' }
    expect(registry.sync([other])).toEqual(['texture.png'])
    expect(registry.has(other)).toBe(false)

    // 图片从清单里消失（切到没有贴图的工程）：也要交出来释放
    registry.markLoaded(other)
    expect(registry.sync([])).toEqual(['texture.png'])
    expect(registry.has(other)).toBe(false)
  })

  it('has 看「名字 + 路径」，只有名字对上不算已加载', () => {
    const registry = new ImageSourceRegistry()
    registry.markLoaded({ name: 'a.png', path: '/one/a.png' })
    expect(registry.has({ name: 'a.png', path: '/one/a.png' })).toBe(true)
    expect(registry.has({ name: 'a.png', path: '/two/a.png' })).toBe(false)
  })

  it('clear 之后一律视为未加载（视图卸载 / 重新挂载时用）', () => {
    const registry = new ImageSourceRegistry()
    const image = { name: 'a.png', path: '/one/a.png' }
    registry.markLoaded(image)
    registry.clear()
    expect(registry.has(image)).toBe(false)
  })
})
