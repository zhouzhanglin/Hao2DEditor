import { Texture, TilingSprite } from 'pixi.js'

/**
 * 棋盘格两档底色。
 * 比面板底色亮一档，方便一眼看出「这里是透明画布」；深浅相差不大，长时间盯着不刺眼。
 * 想调整观感直接改这两个常量即可。
 */
const LIGHT = '#3a3a3c'
const DARK = '#2c2c2e'

/**
 * 视口棋盘格背景。
 *
 * 用 2×2 的最近邻纹理 + TilingSprite 铺满整块画布，开销只有一次 draw call；
 * 格子尺寸与偏移由相机驱动（世界原点对齐格点），因此缩放/平移时背景跟着走，
 * 观感与 DragonBones / Spine 的画布一致。
 */
export class Checkerboard {
  readonly sprite: TilingSprite

  constructor() {
    const source = document.createElement('canvas')
    source.width = 2
    source.height = 2
    const ctx = source.getContext('2d')
    if (ctx) {
      ctx.fillStyle = LIGHT
      ctx.fillRect(0, 0, 2, 2)
      ctx.fillStyle = DARK
      ctx.fillRect(0, 0, 1, 1)
      ctx.fillRect(1, 1, 1, 1)
    }
    const texture = Texture.from(source)
    // 只放大 2×2 纯色块，必须最近邻，否则边缘会被插值糊掉
    texture.source.scaleMode = 'nearest'
    // 让棋盘格平铺到 2×2 之外时也保持像素边缘
    texture.source.addressMode = 'repeat'
    this.sprite = new TilingSprite({ texture, width: 1, height: 1 })
    this.sprite.label = 'checkerboard'
  }

  /**
   * @param width  视口宽度（屏幕像素）
   * @param height 视口高度（屏幕像素）
   * @param cell   单个格子的屏幕边长
   * @param originX 世界原点的屏幕 x（保证格点与世界坐标对齐）
   * @param originY 世界原点的屏幕 y
   */
  layout(width: number, height: number, cell: number, originX: number, originY: number): void {
    this.sprite.width = width
    this.sprite.height = height
    this.sprite.tileScale.set(cell, cell)
    this.sprite.tilePosition.set(originX, originY)
  }

  /**
   * 释放 sprite 与纹理。
   * 注意先从场景摘除：否则紧接着的 `app.destroy({ children: true })` 会对同一个
   * sprite 再销毁一次，pixi 内部会在已释放的纹理源上抛 `reading 'clear'`。
   */
  destroy(): void {
    this.sprite.removeFromParent()
    this.sprite.destroy({ texture: true, textureSource: true })
  }
}

/**
 * 自适应的格子边长（世界单位）：保证屏幕上的格子边长落在 [minPx, maxPx]，
 * 以 2 的幂次为步长，这样缩放到任何倍率背景都不会糊成一片或者变成大色块。
 */
export function pickCellSize(zoom: number, base = 1, minPx = 12, maxPx = 32): number {
  if (!(zoom > 0)) return base
  let cell = base
  let guard = 0
  while (cell * zoom > maxPx && guard++ < 40) cell /= 2
  guard = 0
  while (cell * zoom < minPx && guard++ < 40) cell *= 2
  return cell
}
