/**
 * 预览页（spine / pixi / three.js 三种 HTML）的多语言。
 *
 * 预览页是主进程用 `?raw` 内联后直接返回给浏览器的静态 HTML / JS，里面没有渲染层的 i18n，
 * 所以这里维护一份「中文原文 → 英文」词条，在 `previewServer` 返回内容前按编辑器当前语言替换。
 *
 * 词条按**长度降序**替换：先换长句（`插槽 / 换装`、`失败（…）`），再换短词（`插槽`、`失败`），
 * 避免 `插槽` 把 `插槽 / 换装` 拆坏。词条只覆盖界面文案；源码里的中文注释保持原样（用户看不到）。
 */
export type PreviewLocale = 'zh-CN' | 'en'

export const PREVIEW_EN: Record<string, string> = {
  // ---- 页面标题 / 状态 ----
  'Hao2D · Three.js 预览': 'Hao2D · Three.js Preview',
  'Hao2D 预览': 'Hao2D Preview',
  '正在加载…': 'Loading…',
  '正在加载 ': 'Loading ',
  '加载失败：': 'Load failed: ',
  '骨架加载失败：': 'Skeleton load failed: ',
  '图片加载失败：': 'Image load failed: ',
  '无法读取预览清单：': 'Cannot read preview manifest: ',
  '清单里没有骨架 ': 'No skeleton in manifest ',
  '这份导出里没有骨架': 'No skeleton in this export',
  '当前浏览器不支持 WebGL，无法预览': 'WebGL is not supported in this browser; cannot preview',
  'spine 运行时未能加载（spine-core.js 缺失）': 'spine runtime failed to load (spine-core.js missing)',
  '着色器编译失败：': 'Shader compile failed: ',
  '着色器链接失败：': 'Shader link failed: ',

  // ---- 通用控件 ----
  '控制': 'Controls',
  '切换骨架': 'Switch skeleton',
  '动画': 'Animation',
  '皮肤': 'Skin',
  '进度': 'Progress',
  '速度': 'Speed',
  '循环播放': 'Loop',
  '暂停': 'Pause',
  '播放': 'Play',
  '重播': 'Replay',
  '适配': 'Fit',
  '拖拽平移 · 滚轮 / 双指缩放': 'Drag to pan · Wheel / pinch to zoom',

  // ---- IHao2DView：插槽 / 换装 / 嵌套 ----
  '插槽 / 换装': 'Slot / Equip',
  '插槽': 'Slot',
  '附件': 'Attachment',
  '换装': 'Equip',
  '还原': 'Reset',
  '显示该插槽': 'Show this slot',
  '显示下标': 'Display index',
  '强制覆盖动画轨道': 'Force over animation tracks',
  '应用下标': 'Apply index',
  '清除覆盖': 'Clear override',
  '嵌套子骨架': 'Nested skeleton',
  '子皮肤': 'Child skin',
  '给子骨架换肤': 'Set nested skin',
  '当前插槽有子骨架（共 ': 'This slot has a nested skeleton (',
  ' 个），可用 setNested* 操作内部插槽': ' total); use setNested* to edit its slots',
  '当前插槽没有子骨架（共 ': 'This slot has no nested skeleton (',
  ' 个激活）': ' active)',

  // ---- API 面板提示 ----
  'SetSkin → 已切换到 ': 'SetSkin → switched to ',
  'SetSkin → 皮肤不存在，保持当前皮肤': 'SetSkin → skin not found, keeping current skin',
  '成功：': 'Success: ',
  '成功': 'Success',
  '失败（插槽 / 附件不存在）': 'Failed (slot / attachment not found)',
  '失败（没有子骨架或皮肤不存在）': 'Failed (no nested skeleton or skin not found)',
  '失败': 'Failed',
  '已还原': 'Reset',
  '已清除': 'Cleared',
  '没有强制覆盖': 'No forced override'
}

/** 长词条先换，避免短词把长句拆坏 */
const ENTRIES = Object.entries(PREVIEW_EN).sort((a, b) => b[0].length - a[0].length)

/**
 * 按语言替换预览页 HTML / JS 里的中文文案。
 * 简中直接原样返回；英文下额外把 `<html lang="zh-CN">` 改成 `en`。
 */
export function localizePreview(source: string, locale: PreviewLocale | undefined): string {
  if (locale !== 'en') return source
  let out = source
  for (const [zh, en] of ENTRIES) out = out.split(zh).join(en)
  return out.replace(/<html lang="zh-CN">/g, '<html lang="en">')
}
