import type { CommandArgSpec, CommandSpec } from './commandTypes'

/**
 * MCP 工具描述（与具体传输无关）。
 *
 * 命令系统已经把「每件事」注册成带名字、带参数描述的 `CommandSpec`，
 * 这里只是把它翻译成 MCP 的 tool 形状，让 AI 客户端（Claude / Cursor / VSCode…）
 * 通过 `tools/list` 拿到后，就能像调函数一样调编辑器的命令。
 *
 * 翻译规则很直白：名字直译、描述把标题 + 说明 + 返回值拼一起、参数映射成 JSON Schema。
 * 这一层**不碰** Electron、不碰网络，纯函数，方便单测。
 */

export interface McpJsonSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  description: string
  enum?: readonly string[]
  default?: unknown
}

export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, McpJsonSchema>
    required?: string[]
  }
}

/** 单个命令参数 → JSON Schema 属性 */
function argToSchema(arg: CommandArgSpec): McpJsonSchema {
  const schema: McpJsonSchema = {
    type: arg.type,
    description: arg.description
  }
  if (arg.values && arg.values.length > 0) {
    schema.enum = arg.values
  }
  if (arg.default !== undefined) {
    schema.default = arg.default
  }
  return schema
}

/** `CommandSpec` → MCP tool（AI 客户端 `tools/list` 返回的每一项） */
export function commandSpecToMcpTool(spec: CommandSpec): McpTool {
  const properties: Record<string, McpJsonSchema> = {}
  const required: string[] = []
  for (const [key, arg] of Object.entries(spec.args)) {
    properties[key] = argToSchema(arg)
    if (arg.required) required.push(key)
  }
  // MCP tool 没有独立的「示例」字段：把 JSON 调用示例拼进 description（AI 对 description 的遵从度最高）
  const example = spec.example ? `\n示例：{"name":"${spec.name}","args":${JSON.stringify(spec.example)}}` : ''
  return {
    name: spec.name,
    description: `${spec.title}：${spec.description}\n返回：${spec.returns}${example}`,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {})
    }
  }
}
