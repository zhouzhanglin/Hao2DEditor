/**
 * electron-builder 的 afterPack 钩子：给 macOS 产物做 **ad-hoc 代码签名**。
 *
 * 为什么需要：
 * - Apple Silicon 上每个可执行文件都必须带**有效**签名，否则 macOS 直接报
 *   「「Hao2D Editor」已损坏，无法打开。你应该将它移到废纸篓」—— 注意这不是
 *   「未验证的开发者」（那说明签名有效、只是没公证）。
 * - 本机没有 Apple 开发证书时，electron-builder 会**静默跳过**签名，打出来的 .app
 *   连 `Contents/_CodeSignature` 都没有；Electron 主程序只剩链接器塞的临时 ad-hoc 戳
 *   （`Identifier=Electron`、`Info.plist=not bound`），`codesign --verify --deep --strict`
 *   直接失败 —— dmg 装到 arm64 机器上就是上面那句「已损坏」。
 *
 * 这里在打包完成后用 `--sign -`（ad-hoc）自签一遍：签名封条覆盖整个 bundle，
 * `codesign --verify` 能过，app 可以正常启动。
 *
 * 局限（ad-hoc 的边界，不是这里能解决的）：
 * - 没有 Developer ID + 公证，下载来的 dmg 仍会被 Gatekeeper 拦（`spctl` 依然 rejected）。
 *   首次打开要右键 → 打开，或 `xattr -dr com.apple.quarantine "/Applications/Hao2D Editor.app"`。
 * - 等以后有证书了：electron-builder 会在本钩子**之后**用真证书重签（`--force`），
 *   这份 ad-hoc 签名会被覆盖，不用改配置。
 *
 * 时机：afterPack 在 app 目录成型之后、打 dmg / zip 之前执行，所以 dmg 里装的就是签好的 app。
 */
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

/** 跑一个命令，失败时把 stdout / stderr 一起抛出来（比只报个 exit code 好排查） */
function run(command, args) {
  try {
    execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8' })
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} 失败：${detail || error.message}`)
  }
}

exports.default = async function afterPack(context) {
  // 只处理 macOS；Windows 走 NSIS，不需要这一步
  if (context.electronPlatformName !== 'darwin') return

  const { appOutDir, packager } = context
  const appPath = join(appOutDir, `${packager.appInfo.productFilename}.app`)
  if (!existsSync(appPath)) {
    throw new Error(`afterPack：找不到 macOS 产物：${appPath}`)
  }

  // --deep：连同 Frameworks / Helper（Renderer/GPU/crashpad…）一起签，顺序由 codesign 处理；
  // 逐个手签要反着嵌套层级来，容易漏掉 helper 导致「签名无效」
  run('codesign', ['--force', '--deep', '--sign', '-', appPath])
  // 立刻验一次：签坏了宁可让打包失败，也别把装不上的 dmg 发出去
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])

  console.log(`  • ad-hoc 签名完成（无证书模式，未公证）  ${appPath}`)
}
