/**
 * AI 文档装载器：docs/ 下两份 markdown 的 `?raw` 内联（构建期打进 bundle）。
 *
 * **docs/*.md 是唯一权威来源**，这里只转发字符串、不持有内容——改文档只改 docs/，
 * 不存在「代码里第二份」。这些内容以前曾是 TS 字符串常量，与 docs/ 下的 markdown
 * 靠人肉保持一致，必然漂移；现在统一成一条路。
 *
 * main 与 renderer 都能 import（?raw 由 vite 在构建期内联，运行时零文件依赖，
 * 打包安装后也不需要 extraResources 副本）。各消费方：
 *
 * - AI_COMMAND_API_DOC → 保存 / 打开工程时写进工程 ai/hao2d-ai-command-api.md
 * - AI_PLAYBOOK        → MCP instructions / GET /commands 的 playbook / WS 握手 / ai/hao2d-ai-playbook.md
 */
import aiCommandApiDoc from '../../docs/ai-command-api.md?raw'
import aiPlaybook from '../../docs/ai-playbook.md?raw'

export const AI_COMMAND_API_DOC = aiCommandApiDoc
export const AI_PLAYBOOK = aiPlaybook
