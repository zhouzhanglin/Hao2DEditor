import { registerAnimCommands } from './animCommands'
import { registerBindAllCommands } from './bindAll'
import { registerMeshCommands } from './meshCommands'
import { registerProjectCommands } from './projectCommands'
import { registerQueryCommands } from './queryCommands'
import { catalog, defineRead } from './registry'
import { registerSkeletonCommands } from './skeletonCommands'
import { registerViewCommands } from './viewCommands'
import { AI_PLAYBOOK } from '@shared/aiPlaybook'
import { AI_RIGGING_GUIDE } from '@shared/aiRiggingGuide'

export { catalog, clearRegistry, executeCommand, hasCommand, registerCommand } from './registry'
export type { Args, CommandOutcome } from './registry'

/**
 * 注册全部命令。渲染进程启动时调用一次（`src/ui/main.tsx`）。
 *
 * 顺序无关紧要，但都只注册一次：重复注册会直接抛错（早发现重复命令名）。
 * 想在测试里重装：先 `clearRegistry()`。
 */
export function installCommands(): void {
  registerSkeletonCommands()
  registerAnimCommands()
  registerMeshCommands()
  registerBindAllCommands()
  registerProjectCommands()
  registerViewCommands()
  registerQueryCommands()
  // 本地服务的 GET /commands 用它拉命令自描述（AI 通常不必直接调用）。
  // playbook 随数据一起透传：AI 拿目录的同时就拿到「怎么用对」的手册（见 aiPlaybook.ts）
  defineRead(
    {
      name: '__catalog',
      title: '命令目录',
      description: '内部命令：返回全部命令的自描述与 AI 使用手册，本地服务的 GET /commands 调用它。一般不用直接执行',
      args: {},
      returns: '{ commands, playbook }'
    },
    () => ({ commands: catalog(), playbook: AI_PLAYBOOK })
  )
  // 完整操作指南走命令下发：打包安装到用户机器后，开发仓库的 docs/ 不在「工程里」，
  // AI 的文件读取能力找不到（extraResources 副本也未必够得着）——编译进 bundle 的
  // 命令是打包环境唯一可靠的通道（内容见 aiRiggingGuide.ts）
  defineRead(
    {
      name: 'getAiGuide',
      title: '获取 AI 操作指南',
      description:
        '返回 AI 使用手册与「角色装配 + 动画」完整分阶段流程：报备门、参考图对位（含像素→世界坐标换算公式）、网格蒙皮、打帧自查循环、每步验收标准。做装配 / 动画任务前先调它',
      args: {},
      returns: '{ playbook, rigging }'
    },
    () => ({ playbook: AI_PLAYBOOK, rigging: AI_RIGGING_GUIDE })
  )
}
