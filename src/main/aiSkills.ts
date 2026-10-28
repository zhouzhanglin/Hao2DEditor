import { app, shell } from 'electron'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  SkillBundleInfo,
  SkillInfo,
  SkillInstallReport,
  SkillTargetResult,
  SkillTargetState
} from '@shared/ipcTypes'

/**
 * 随包分发的 AI Skill。
 *
 * Skill 就是「给 AI 的工作手册」：一个目录 + `SKILL.md`（YAML frontmatter：name / description），
 * 放进 AI 客户端的 skills 目录后，客户端会在需要时自动加载它。这里随 App 带一份
 * `hao2d-skeletal-animation`，让用户不必自己去写（也不必知道 Skill 是什么格式）。
 *
 * 位置：
 * - 打包后：`process.resourcesPath/skills`（macOS 是 `Hao2D Editor.app/Contents/Resources/skills`，
 *   Windows 是安装目录下的 `resources/skills`）——由 package.json 的 `extraResources` 放进去；
 * - 开发时：仓库根的 `resources/skills`。
 *
 * 安装策略（与 MCP 一键安装同一套思路：能安全写的才写，其余给路径 / 命令）：
 * - CodeBuddy（`~/.codebuddy/skills`）、Claude Code（`~/.claude/skills`）已知支持 Skills，
 *   且客户端目录存在时直接复制过去；
 * - 其它客户端（Codex / WorkBuddy / Trae…）不冒然往它们的目录里塞文件，只报告是否检测到安装目录，
 *   并给一条可复制的命令；用户也可以用「选择目录…」自己指定。
 */

const home = (): string => homedir()

/** 随包 skill 的根目录 */
export function skillsRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills')
}

interface SkillTarget {
  id: string
  label: string
  /** 客户端的数据目录（用它判断客户端是否装过） */
  parent: () => string
  /** 该客户端的 skills 目录 */
  skillsDir: () => string
  /** 已知支持 Skills 格式、可安全直接写入 */
  auto: boolean
}

const targets: SkillTarget[] = [
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    parent: () => join(home(), '.codebuddy'),
    skillsDir: () => join(home(), '.codebuddy', 'skills'),
    auto: true
  },
  {
    id: 'claude',
    label: 'Claude Code',
    parent: () => join(home(), '.claude'),
    skillsDir: () => join(home(), '.claude', 'skills'),
    auto: true
  },
  // 以下客户端对 Skills 的支持未确认：只探测，不自动写
  {
    id: 'codex',
    label: 'Codex',
    parent: () => join(home(), '.codex'),
    skillsDir: () => join(home(), '.codex', 'skills'),
    auto: false
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    parent: () => join(home(), '.workbuddy'),
    skillsDir: () => join(home(), '.workbuddy', 'skills'),
    auto: false
  },
  {
    id: 'trae',
    label: 'Trae',
    parent: () => join(home(), '.trae'),
    skillsDir: () => join(home(), '.trae', 'skills'),
    auto: false
  }
]

/** 解析 SKILL.md 的 frontmatter（只取简单 `key: value`，够用且不引依赖） */
function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const out: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}

async function countFiles(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true })
  let total = 0
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    total += entry.isDirectory() ? await countFiles(join(dir, entry.name)) : 1
  }
  return total
}

/** 扫描根目录下所有带 SKILL.md 的子目录 */
async function listSkills(root: string): Promise<SkillInfo[]> {
  if (!existsSync(root)) return []
  const entries = await readdir(root, { withFileTypes: true })
  const skills: SkillInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)
    const skillFile = join(dir, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    const meta = frontmatter(await readFile(skillFile, 'utf8'))
    skills.push({
      name: meta.name || entry.name,
      dirName: entry.name,
      version: meta.version,
      description: meta.description ?? '',
      path: dir,
      files: await countFiles(dir)
    })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** 手动安装用的复制命令（Windows 走 xcopy） */
function installCommand(src: string, destDir: string, dirName: string): string {
  if (process.platform === 'win32') {
    return `xcopy "${src}" "${join(destDir, dirName)}" /E /I /Y`
  }
  return `mkdir -p "${destDir}" && cp -R "${src}" "${destDir}/"`
}

/** 读某个 skills 目录里同名 Skill 的版本（没有就返回 undefined） */
async function installedVersionOf(skillsDir: string, dirName: string): Promise<string | undefined> {
  const file = join(skillsDir, dirName, 'SKILL.md')
  if (!existsSync(file)) return undefined
  try {
    const meta = frontmatter(await readFile(file, 'utf8'))
    return meta.version
  } catch {
    return undefined
  }
}

/** 面板显示用：Skill 在哪、有哪些、各客户端装到哪一版 */
export async function skillsInfo(): Promise<SkillBundleInfo> {
  const root = skillsRoot()
  const skills = await listSkills(root)
  const first = skills[0]
  const bundledVersion = first?.version

  const states: SkillTargetState[] = []
  for (const target of targets) {
    const dir = target.skillsDir()
    const detected = existsSync(target.parent())
    const installedVersion = detected && first ? await installedVersionOf(dir, first.dirName) : undefined
    const installed = installedVersion !== undefined
    states.push({
      id: target.id,
      label: target.label,
      path: dir,
      detected,
      auto: target.auto,
      installed,
      installedVersion,
      // 两边都有版本号才比；随包没写 version 就没法判新旧，按「已装」处理
      outdated: installed && Boolean(bundledVersion) && installedVersion !== bundledVersion
    })
  }

  return {
    path: root,
    exists: existsSync(root),
    skills,
    copyCommand: first ? installCommand(first.path, '<目标 skills 目录>', first.dirName) : '',
    targets: states
  }
}

/** 在系统文件管理器里打开 Skill 目录 */
export async function openSkillsFolder(): Promise<{ path: string }> {
  const root = skillsRoot()
  if (!existsSync(root)) {
    throw new Error(`没找到随包分发的 Skill 目录：${root}（打包时是否漏了 extraResources？）`)
  }
  const message = await shell.openPath(root)
  if (message) throw new Error(message)
  return { path: root }
}

async function copySkill(src: string, dest: string): Promise<void> {
  // 先删再拷：避免上一版遗留的多余文件（比如重命名过的 references/*.md）
  await rm(dest, { recursive: true, force: true })
  await mkdir(join(dest, '..'), { recursive: true })
  await cp(src, dest, { recursive: true })
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 把随包 Skill 安装到 AI 客户端。
 * - 不传 `dir`：只写已知支持 Skills 的客户端（CodeBuddy / Claude Code），其余给 manual 报告；
 * - 传 `dir`：直接装进这个目录（用户自己选的 skills 目录）。
 */
export async function installSkillToClients(
  options: { name?: string; dir?: string } = {}
): Promise<SkillInstallReport> {
  const root = skillsRoot()
  const all = await listSkills(root)
  const wanted = options.name ? all.filter((s) => s.name === options.name || s.dirName === options.name) : all
  if (wanted.length === 0) {
    throw new Error(
      options.name ? `找不到 Skill：${options.name}（在 ${root} 下）` : `随包没有可安装的 Skill（${root}）`
    )
  }

  const items: SkillTargetResult[] = []

  if (options.dir) {
    for (const skill of wanted) {
      const dest = join(options.dir, skill.dirName)
      try {
        await copySkill(skill.path, dest)
        items.push({ id: 'custom', label: options.dir, status: 'written', path: dest })
      } catch (err) {
        items.push({ id: 'custom', label: options.dir, status: 'error', error: reason(err) })
      }
    }
    return { items }
  }

  for (const target of targets) {
    const installed = existsSync(target.parent())
    if (!installed) {
      items.push({ id: target.id, label: target.label, status: 'manual', detected: false })
      continue
    }
    if (!target.auto) {
      items.push({
        id: target.id,
        label: target.label,
        status: 'manual',
        detected: true,
        path: target.skillsDir(),
        copyCommand: installCommand(wanted[0].path, target.skillsDir(), wanted[0].dirName)
      })
      continue
    }
    try {
      for (const skill of wanted) {
        await copySkill(skill.path, join(target.skillsDir(), skill.dirName))
      }
      items.push({
        id: target.id,
        label: target.label,
        status: 'written',
        detected: true,
        path: target.skillsDir()
      })
    } catch (err) {
      items.push({
        id: target.id,
        label: target.label,
        status: 'error',
        detected: true,
        error: reason(err)
      })
    }
  }

  return { items }
}
