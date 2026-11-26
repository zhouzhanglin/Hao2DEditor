import { describe, expect, it } from 'vitest'
import { planAssetFolderSync } from '@editor/services/assetFolderSync'
import type { AssetSnapshotEntry } from '@editor/services/assetFolderSync'
import type { AuthoringImage } from '@core/model/authoring'
import type { DirEntry } from '@shared/ipcTypes'

/** 资源目录对账：新增 / 修改 / 删除，以及「保存后从外部路径切到工程内路径」 */
function image(name: string, path: string): AuthoringImage {
  return { name, path, width: 10, height: 10, loose: true }
}

function entry(path: string, name: string, mtimeMs: number, size = 100): DirEntry {
  return { path, name, relativePath: name, isDirectory: false, size, mtimeMs }
}

function snapshot(entries: readonly DirEntry[]): Map<string, AssetSnapshotEntry> {
  return new Map(entries.map((item) => [item.path, { path: item.path, name: item.name, mtimeMs: item.mtimeMs, size: item.size }]))
}

const DIR = '/proj/images'

describe('images/ 目录对账', () => {
  it('新增磁盘文件 → 新增图片；非图片文件忽略', () => {
    const disk = [entry(`${DIR}/a.png`, 'a.png', 1), entry(`${DIR}/readme.txt`, 'readme.txt', 1)]
    const changes = planAssetFolderSync([], new Map(), disk)
    expect(changes.added.map((item) => item.path)).toEqual([`${DIR}/a.png`])
    expect(changes.modified).toEqual([])
    expect(changes.removed).toEqual([])
  })

  it('mtime 变了 → 修改；mtime/size 没变 → 不动', () => {
    const before = entry(`${DIR}/a.png`, 'a.png', 1)
    const images = [image('a.png', before.path)]
    const same = planAssetFolderSync(images, snapshot([before]), [entry(before.path, 'a.png', 1)])
    expect(same.modified).toEqual([])

    const changed = planAssetFolderSync(images, snapshot([before]), [entry(before.path, 'a.png', 2, 200)])
    expect(changed.modified.map((item) => item.image.name)).toEqual(['a.png'])
    expect(changed.added).toEqual([])
    expect(changed.removed).toEqual([])
  })

  it('磁盘文件消失 → 删除对应图片', () => {
    const before = entry(`${DIR}/a.png`, 'a.png', 1)
    const changes = planAssetFolderSync([image('a.png', before.path)], snapshot([before]), [])
    expect(changes.removed.map((item) => item.name)).toEqual(['a.png'])
  })

  it('保存时复制到 images/ 的副本 → 按名字认成同一张，改路径不算新增', () => {
    const before = entry(`${DIR}/a.png`, 'a.png', 1)
    // 工程里还是导入时的外部路径；images/ 里是按 image.name 命名的副本
    const images = [image('a.png', '/Downloads/a.png')]
    const changes = planAssetFolderSync(images, snapshot([before]), [entry(before.path, 'a.png', 2)])
    expect(changes.added).toEqual([])
    expect(changes.modified.map((item) => item.image.name)).toEqual(['a.png'])
    expect(changes.modified[0].info.path).toBe(before.path)
  })

  it('改名不反复：旧路径消失但同名图已在新路径上的不删除', () => {
    const oldPath = `${DIR}/a.png`
    const newPath = `${DIR}/b.png`
    const images = [image('b.png', newPath)]
    const changes = planAssetFolderSync(
      images,
      snapshot([entry(oldPath, 'a.png', 1)]),
      [entry(newPath, 'b.png', 2)]
    )
    expect(changes.modified.map((item) => item.image.name)).toEqual(['b.png'])
    expect(changes.removed).toEqual([])
  })
})
