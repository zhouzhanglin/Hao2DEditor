import { registerAnimCommands } from './animCommands'
import { registerBindAllCommands } from './bindAll'
import { registerMeshCommands } from './meshCommands'
import { registerProjectCommands } from './projectCommands'
import { registerQueryCommands } from './queryCommands'
import { catalog, defineRead } from './registry'
import { registerSkeletonCommands } from './skeletonCommands'
import { registerViewCommands } from './viewCommands'

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
  // 本地服务的 GET /commands 用它拉命令自描述（AI 通常不必直接调用）
  defineRead(
    {
      name: '__catalog',
      title: '命令目录',
      description: '内部命令：返回全部命令的自描述，本地服务的 GET /commands 调用它。一般不用直接执行',
      args: {},
      returns: '{ commands }'
    },
    () => ({ commands: catalog() })
  )
}
