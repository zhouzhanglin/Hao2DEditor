import { describe, expect, it } from 'vitest'
import { commandSpecToMcpTool } from '@shared/mcpSchema'
import type { CommandSpec } from '@shared/commandTypes'

const sample: CommandSpec = {
  name: 'addBone',
  title: '新建骨骼',
  kind: 'write',
  description: '在骨架里加一根骨骼',
  args: {
    name: { type: 'string', required: true, description: '骨骼名' },
    parent: { type: 'string', description: '父骨骼名', default: 'root' },
    mode: { type: 'string', description: '类型', values: ['translate', 'rotate'] }
  },
  returns: 'boneName'
}

describe('commandSpecToMcpTool', () => {
  it('把命令名映射成 tool name', () => {
    expect(commandSpecToMcpTool(sample).name).toBe('addBone')
  })

  it('标题 + 说明 + 返回值拼进 description', () => {
    const desc = commandSpecToMcpTool(sample).description
    expect(desc).toContain('新建骨骼')
    expect(desc).toContain('在骨架里加一根骨骼')
    expect(desc).toContain('boneName')
  })

  it('参数翻译成 JSON Schema 的 properties', () => {
    const props = commandSpecToMcpTool(sample).inputSchema.properties
    expect(props.name.type).toBe('string')
    expect(props.parent.default).toBe('root')
    expect(props.mode.enum).toEqual(['translate', 'rotate'])
  })

  it('只把 required 参数放进去，且 inputSchema 为 object', () => {
    const tool = commandSpecToMcpTool(sample)
    expect(tool.inputSchema.type).toBe('object')
    expect(tool.inputSchema.required).toEqual(['name'])
  })

  it('没有必填参数时不输出 required 字段', () => {
    const noRequired: CommandSpec = {
      ...sample,
      args: { x: { type: 'number', description: 'x' } }
    }
    expect(commandSpecToMcpTool(noRequired).inputSchema.required).toBeUndefined()
  })

  it('spec 带 example 时把 JSON 调用示例拼进 description；没有则不拼', () => {
    const withExample = commandSpecToMcpTool({ ...sample, example: { name: 'chest', length: 0.9 } })
    expect(withExample.description).toContain('示例：{"name":"addBone","args":{"name":"chest","length":0.9}}')
    expect(commandSpecToMcpTool(sample).description).not.toContain('示例')
  })
})
