/**
 * three.js 的「外部桥」：让**瘦版**运行库（resources/runtimes/hao2d-three.js）从全局 `THREE` 取 three，
 * 而不是把整个 three 再打一份进去。
 *
 * 用法：`scripts/build-threejs-runtime.mjs` 的瘦版构建用 esbuild alias 把 `import ... from 'three'`
 * 重定向到本文件；宿主页面 / 游戏工程先加载自己的 three 并挂到 `globalThis.THREE`，再加载本运行库。
 *
 * 预览页用的 `threejsRuntime.generated.js` 不走这里（那份是自包含的，three 已打包，预览页开箱即用）。
 *
 * 若某天运行库用到下面没列出的 three 导出，构建会报错，照着加一行即可（值 + 同名类型别名）。
 */
type ThreeNamespace = typeof import('three')

const globalThree = (globalThis as unknown as { THREE?: ThreeNamespace }).THREE

if (!globalThree) {
  throw new Error(
    '[hao2d] 没有找到全局 THREE：hao2d-three.js 只包含 hao2d 功能，请先加载 three.js 并把命名空间挂到 globalThis.THREE' +
      '（例如 `import * as THREE from "three"; window.THREE = THREE`），再加载本文件'
  )
}

const THREE = globalThree

export default THREE

// 值：运行库内部用到的 three 符号
export const AddEquation = THREE.AddEquation
export const AdditiveBlending = THREE.AdditiveBlending
export const BufferAttribute = THREE.BufferAttribute
export const BufferGeometry = THREE.BufferGeometry
export const Color = THREE.Color
export const CustomBlending = THREE.CustomBlending
export const DataTexture = THREE.DataTexture
export const DoubleSide = THREE.DoubleSide
export const Group = THREE.Group
export const LinearFilter = THREE.LinearFilter
export const Mesh = THREE.Mesh
export const MeshBasicMaterial = THREE.MeshBasicMaterial
export const MultiplyBlending = THREE.MultiplyBlending
export const NormalBlending = THREE.NormalBlending
export const Object3D = THREE.Object3D
export const OneFactor = THREE.OneFactor
export const OneMinusSrcAlphaFactor = THREE.OneMinusSrcAlphaFactor
export const OneMinusSrcColorFactor = THREE.OneMinusSrcColorFactor
export const OrthographicCamera = THREE.OrthographicCamera
export const RGBAFormat = THREE.RGBAFormat
export const Scene = THREE.Scene
export const SrcAlphaFactor = THREE.SrcAlphaFactor
export const SRGBColorSpace = THREE.SRGBColorSpace
export const Texture = THREE.Texture
export const WebGLRenderer = THREE.WebGLRenderer

// 类型：`Three.Texture` / `Three.Mesh<...>` 这类类型标注需要同名类型别名
export type BufferAttribute = import('three').BufferAttribute
export type BufferGeometry = import('three').BufferGeometry
export type DataTexture = import('three').DataTexture
export type Group = import('three').Group
export type Mesh = import('three').Mesh
export type MeshBasicMaterial = import('three').MeshBasicMaterial
export type Object3D = import('three').Object3D
export type OrthographicCamera = import('three').OrthographicCamera
export type Scene = import('three').Scene
export type Texture = import('three').Texture
export type WebGLRenderer = import('three').WebGLRenderer
