import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useProjectStore } from '@editor/store/projectStore'
import ContextMenu from '@ui/widgets/ContextMenu'
import type { ContextMenuItem } from '@ui/widgets/ContextMenu'

interface SkeletonBarProps {
  /** 切换骨架：清选中 / 停播 / 重置视口这些收尾由外面做（这里只点一下） */
  onSwitch: (index: number) => void
  onAdd: () => void
  onRename: (index: number, name: string) => void
  onRemove: (index: number) => void
  onStatus: (message: string) => void
}

/**
 * 菜单栏下面那一行：**项目的骨架列表 + 新建骨架**。
 *
 * 一个项目可以有多个骨架（一套图片做多个骨骼）：
 * 骨骼 / 插槽 / 皮肤 / 图层 / 动画各自独立，**图片资源池由所有骨架共享**。
 * 这里只做「选中 + 增删改」的入口，真正的切换在命令层（要连带清选中、停播、重置视口）。
 *
 * 列表订阅的是**名字拼出的签名**而不是 `skeletons` 数组本身 —— 后者每次编辑都会换新引用
 * （`update` 里替换了当前骨架），逐个渲染时会让这一行跟着每次拖拽重渲染。
 */
export default function SkeletonBar({ onSwitch, onAdd, onRename, onRemove, onStatus }: SkeletonBarProps) {
  const signature = useProjectStore((state) => state.skeletons.map((skeleton) => skeleton.armatureName).join('\u0000'))
  const active = useProjectStore((state) => state.activeSkeleton)
  const names = signature.length > 0 ? signature.split('\u0000') : ['']
  const [editing, setEditing] = useState(-1)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (editing >= 0) inputRef.current?.select()
  }, [editing])

  const beginRename = (index: number): void => {
    setEditing(index)
    setDraft(names[index] ?? '')
  }

  const commitRename = (): void => {
    if (editing < 0) return
    const index = editing
    const name = draft.trim()
    setEditing(-1)
    if (name.length === 0 || name === names[index]) return
    onRename(index, name)
  }

  return (
    <div className="flex h-[28px] shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-ink-900/70 px-2">
      <span className="shrink-0 pr-1 text-3xs text-content-lo">骨架</span>
      {names.map((name, index) => {
        if (index === editing) {
          return (
            <input
              key={`rename-${index}`}
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitRename()
                if (event.key === 'Escape') setEditing(-1)
              }}
              className="h-[20px] w-[104px] shrink-0 rounded-[4px] border border-accent bg-ink-800 px-1.5 text-3xs text-content-hi outline-none"
            />
          )
        }
        const isActive = index === active
        return (
          <button
            key={`skeleton-${index}`}
            type="button"
            title={`${name}（双击重命名；右键重命名 / 删除）`}
            onClick={() => onSwitch(index)}
            onDoubleClick={() => beginRename(index)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ x: event.clientX, y: event.clientY, index })
            }}
            className={[
              'hao-btn h-[20px] max-w-[170px] shrink-0 border-transparent px-2 text-3xs',
              isActive ? 'bg-accent-deep text-white' : 'bg-transparent text-content-mid hover:bg-ink-700'
            ].join(' ')}
          >
            <span className="truncate">{name}</span>
          </button>
        )
      })}
      <button
        type="button"
        title="新建骨架：一套图片可以做多个骨骼（骨骼 / 插槽 / 皮肤 / 图层 / 动画各自独立，图片池共享）"
        onClick={onAdd}
        className="hao-btn h-[20px] shrink-0 border border-dashed border-line/70 bg-transparent px-2 text-3xs text-content-mid hover:bg-ink-700 hover:text-content-hi"
      >
        <Plus size={11} />
        <span>新建骨架</span>
      </button>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={names[menu.index]}
          items={
            [
              {
                key: 'rename',
                label: '重命名',
                icon: <Pencil size={11} />,
                onSelect: () => beginRename(menu.index)
              },
              {
                key: 'remove',
                label: '删除',
                icon: <Trash2 size={11} />,
                danger: true,
                disabled: names.length <= 1,
                hint: names.length <= 1 ? '项目里至少保留一个骨架' : '删除这个骨架（图片池不受影响）',
                onSelect: () => {
                  if (names.length <= 1) {
                    onStatus('项目里至少保留一个骨架')
                    return
                  }
                  onRemove(menu.index)
                }
              }
            ] satisfies ContextMenuItem[]
          }
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}
