import { describe, expect, it } from 'vitest'
import { PREVIEW_EN, localizePreview } from '../src/main/preview/previewI18n'

/** 预览页是主进程直出的静态 HTML/JS：语言切换靠这里的文本替换，锁住几个容易漏的点 */
describe('预览页多语言', () => {
  it('简中 / 未指定语言时原样返回', () => {
    expect(localizePreview('<button>暂停</button>', 'zh-CN')).toBe('<button>暂停</button>')
    expect(localizePreview('<button>暂停</button>', undefined)).toBe('<button>暂停</button>')
  })

  it('英文下替换页面标题、控件与 html lang', () => {
    const source =
      '<html lang="zh-CN"><title>Hao2D 预览</title><button>暂停</button><span>插槽 / 换装</span>'
    expect(localizePreview(source, 'en')).toBe(
      '<html lang="en"><title>Hao2D Preview</title><button>Pause</button><span>Slot / Equip</span>'
    )
  })

  it('长词条优先：整句 / 动态拼接文案也正确', () => {
    expect(localizePreview('当前插槽没有子骨架（共 0 个激活）', 'en')).toBe(
      'This slot has no nested skeleton (0 active)'
    )
    expect(localizePreview('当前插槽有子骨架（共 2 个），可用 setNested* 操作内部插槽', 'en')).toBe(
      'This slot has a nested skeleton (2 total); use setNested* to edit its slots'
    )
    // 长句先换，短词「插槽」不会把「插槽 / 换装」拆坏
    expect(localizePreview('插槽 / 换装', 'en')).toBe('Slot / Equip')
    // 长句先换，短词「失败」不会把原因句拆坏
    expect(localizePreview('SetSlotAttachment → 失败（插槽 / 附件不存在）', 'en')).toBe(
      'SetSlotAttachment → Failed (slot / attachment not found)'
    )
  })

  it('三种预览页出现的关键中文片段都有词条', () => {
    for (const key of [
      '控制',
      '播放',
      '暂停',
      '重播',
      '适配',
      '动画',
      '皮肤',
      '进度',
      '速度',
      '循环播放',
      '插槽',
      '附件',
      '换装',
      '嵌套子骨架',
      '子皮肤',
      '正在加载…',
      '加载失败：',
      'Hao2D 预览',
      'Hao2D · Three.js 预览'
    ]) {
      expect(PREVIEW_EN[key], `缺少词条：${key}`).toBeTruthy()
    }
  })
})
