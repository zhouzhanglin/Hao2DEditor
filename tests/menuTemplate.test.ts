import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { buildMenuTemplate } from '../src/main/menuTemplate'

/** 把菜单模板摊平（含子菜单），方便逐项断言 */
function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const entry of items) {
    out.push(entry)
    if (Array.isArray(entry.submenu)) out.push(...flatten(entry.submenu))
  }
  return out
}

const template = (isMac: boolean): MenuItemConstructorOptions[] =>
  buildMenuTemplate({ appName: 'Hao2D Editor', isMac, dispatch: () => undefined })

describe('应用菜单模板', () => {
  it('编辑菜单：剪切/全选保留原生角色，拷贝/粘贴改为自定义命令（输入框文本复制仍由渲染进程转发原生）', () => {
    const roles = flatten(template(true))
      .map((entry) => entry.role)
      .filter(Boolean)
    // 剪切 / 全选仍是标准角色，输入框的文本编辑不丢
    expect(roles).toEqual(expect.arrayContaining(['cut', 'selectAll']))
    // 拷贝 / 粘贴不再挂原生角色：改走 edit:copy / edit:paste 自定义命令（见菜单命令派发测试）
    expect(roles).not.toContain('copy')
    expect(roles).not.toContain('paste')
  })

  it('不带 ⌘/Ctrl 的加速键只作提示、不注册（否则会在输入框里抢键：空格变播放、Delete 删对象）', () => {
    const entries = flatten(template(true))
    const plain = entries.filter((entry) => entry.accelerator && !/Cmd|Ctrl/.test(entry.accelerator))
    // 菜单里确实有这类提示键（Space / Left / Right / K / F / Delete）
    expect(plain.length).toBeGreaterThan(0)
    for (const entry of plain) {
      expect(entry.registerAccelerator, `${String(entry.label)} 的「${String(entry.accelerator)}」不能注册`).toBe(false)
    }
  })

  it('非 macOS：纯键加速键一条都不留（那边 registerAccelerator 不生效，会被菜单全局吃掉）', () => {
    const entries = flatten(template(false))
    const plain = entries.filter((entry) => entry.accelerator && !/Cmd|Ctrl/.test(entry.accelerator))
    expect(plain).toHaveLength(0)
    // ⌘/Ctrl 类的照旧保留
    expect(entries.some((entry) => entry.accelerator && /Cmd/.test(entry.accelerator))).toBe(true)
  })

  it('带 ⌘/Ctrl 的加速键照常注册（⌘S / ⌘Z … 不受影响）', () => {
    const entries = flatten(template(true)).filter(
      (entry) => entry.accelerator && /Cmd/.test(entry.accelerator)
    )
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) expect(entry.registerAccelerator).not.toBe(false)
  })

  it('菜单命令都交给渲染进程处理（模板本身不做事）', () => {
    const commands: string[] = []
    const items = buildMenuTemplate({
      appName: 'Hao2D Editor',
      isMac: false,
      dispatch: (command) => commands.push(command)
    })
    for (const entry of flatten(items)) if (entry.click) (entry.click as () => void)()
    expect(commands).toContain('edit:undo')
    expect(commands).toContain('edit:copy')
    expect(commands).toContain('edit:paste')
    expect(commands).toContain('edit:duplicate')
    expect(commands).toContain('project:save')
    expect(commands).toContain('anim:playPause')
  })

  it('macOS 才有 app 菜单；非 macOS 的「退出」在文件菜单里', () => {
    const macLabels = flatten(template(true)).map((entry) => entry.label)
    expect(macLabels).toContain('关于 Hao2D Editor')
    expect(flatten(template(true)).some((entry) => entry.role === 'quit')).toBe(true)

    const winEntries = flatten(template(false))
    expect(winEntries.some((entry) => entry.role === 'quit')).toBe(true)
    expect(winEntries.some((entry) => entry.role === 'about')).toBe(false)
  })
})
