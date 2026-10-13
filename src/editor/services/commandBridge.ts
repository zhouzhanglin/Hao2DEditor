import { executeCommand } from '../commands'

/**
 * 把主进程的本地命令服务与渲染进程的命令注册表接起来。
 *
 * 主进程通过 IPC 送进来一条 `{ id, name, args }`，这里在**渲染进程**执行
 * （文档状态只在这里），再把结果原样送回。执行失败不抛异常：`executeCommand`
 * 已经把错误折成 `{ ok:false, error }`。
 *
 * 返回取消监听的函数；浏览器里（无 preload 桥）直接返回空函数。
 */
export function connectCommandBridge(): () => void {
  const bridge = window.hao
  if (!bridge) return () => {}
  return bridge.onCommandRequest((request) => {
    const result = executeCommand(request.name, request.args)
    bridge.sendCommandResult({ id: request.id, ...result })
  })
}
