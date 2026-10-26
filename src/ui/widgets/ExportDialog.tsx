import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ChevronLeft, ChevronRight, Copy, ExternalLink, FolderOpen, Loader2, Package, Play, QrCode, Square, X } from 'lucide-react'
import qrcode from 'qrcode-generator'
import { getPlatform, stripExtension } from '@editor/platform'
import { useProjectStore } from '@editor/store/projectStore'
import { useSettingsStore } from '@editor/store/settingsStore'
import { buildHao2dPreviewBundles, listFiles, prepareRuntimeExport, writeHao2dExport, writeRuntimeExport } from '@editor/services/exportService'
import { saveProject } from '@editor/services/projectIo'
import { buildSpineBundles, sanitize, writeSpineExport } from '@editor/services/spineExport'
import type { PageSource, RuntimeExportPlan } from '@editor/services/exportService'
import type { PageEncodePlan } from '@editor/services/pngEncoder'
import type { RuntimeAtlasPage } from '@core/codec/runtimeSkeJson'
import type { SpinePreviewInfo } from '@shared/ipcTypes'
import { collectHao2dWarnings } from '@core/codec/hao2dWriter'
import { loadImageElement } from '@render/imageLoader'
import { useDialogDrag } from './dialogDrag'
import { t } from '@i18n'

/** 三套导出目标：自定义运行时数据 / 给 Unity 的 .hao2d / Spine 4.3 骨骼数据 */
export type ExportMode = 'runtime' | 'unity' | 'spine'

export interface ExportDialogProps {
  /** 导出目标：自定义运行时数据 / 给 Unity 的 .hao2d（含图集与材质） */
  mode: ExportMode
  onClose: () => void
  onStatus?: (text: string) => void
}

/** 记住上次选的导出目录，下次打开直接沿用 */
const EXPORT_DIR_KEY = 'hao2d.exportDir'
const MAX_PREVIEW_WIDTH = 660
const MAX_PREVIEW_HEIGHT = 320
const SCALE_PRESETS = [0.25, 0.5, 0.75, 1]
const SIZE_PRESETS = [1024, 2048, 4096]

/** 三种导出模式的标题；文案随语言切换，故是函数 */
function modeTitle(mode: ExportMode): string {
  return t({ runtime: '导出运行时数据', unity: '导出 Unity', spine: '导出 Spine' }[mode])
}

/** 二维码的显示边长（按整数格 + 设备像素绘制，缩放后依然锐利） */
const QR_DISPLAY_SIZE = 168

/** `http://192.168.1.7:51234/p/xxx/` → `192.168.1.7:51234`（多网卡时用来区分是哪个地址） */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * 预览用的一页绘制计划。
 *
 * 打包页就是它自己；**复制页**（本来就是图集、导出时原图整页照搬）没有图块清单，
 * 这里合成一条「整页放这张原图」的图块 —— 预览因此和落盘结果一致（画的是同一张原图）。
 */
function previewPlanOf(
  source: PageSource | undefined,
  page: RuntimeAtlasPage | undefined
): PageEncodePlan | null {
  if (!source || !page) return null
  if (source.kind === 'packed') return source.plan
  return {
    width: page.width,
    height: page.height,
    blits: [{ name: source.sourceName, x: 0, y: 0, width: page.width, height: page.height }]
  }
}

/**
 * 导出弹窗：选目录 → 调图集缩放 / 单页尺寸 → 实时看图集预览 → 导出。
 *
 * 预览和真正导出的产物出自**同一份** `RuntimeExportPlan`（同样的打包与 UV 重映射），
 * 所以「预览里能装下」＝「导出结果就是这几页」。
 * 两种模式共用这套预览，只是最后写盘的文件清单不同。
 */
export default function ExportDialog({ mode, onClose, onStatus }: ExportDialogProps) {
  const doc = useProjectStore((s) => s.document)
  const skeletons = useProjectStore((s) => s.skeletons)
  const activeSkeleton = useProjectStore((s) => s.activeSkeleton)
  const projectName = useProjectStore((s) => s.projectName)
  const projectPath = useProjectStore((s) => s.projectPath)
  const setExportScale = useProjectStore((s) => s.setExportScale)
  const [dir, setDir] = useState(() => {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem(EXPORT_DIR_KEY) ?? ''
  })
  /** 图集缩放：沿用上次导出保存的值（有存档时持久化在 editorMeta 里），否则默认 1 */
  const [scale, setScale] = useState(() => doc.editorMeta.exportScale ?? 1)
  const [maxSize, setMaxSize] = useState(2048)
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  /** Spine 导出：图集文件名后缀 `.txt`（`xxx.atlas.txt`）—— 走全局设置，跨工程保留 */
  const atlasTxt = useSettingsStore((s) => s.spineAtlasTxt)
  const setAtlasTxt = useSettingsStore((s) => s.setSpineAtlasTxt)
  /** 勾选要导出的骨架：默认全选（一个项目可以有多个骨架，每个骨架单独出一份资源） */
  const [picked, setPicked] = useState<number[]>(() => skeletons.map((_, index) => index))
  /** 图集范围：默认装**所有骨架**用到的图；也可以只装这次要导出的骨架用到的图 */
  const [atlasScope, setAtlasScope] = useState<'all' | 'selected'>('all')
  const selected = useMemo(
    () => picked.filter((index) => index >= 0 && index < skeletons.length),
    [picked, skeletons]
  )
  const rootRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** 标题栏拖动弹窗（见 dialogDrag） */
  const { panelStyle, handleProps } = useDialogDrag()
  /** 预览用的已加载图片（按源图名缓存，切页 / 调参数不用重新解码） */
  const loadedRef = useRef(new Map<string, HTMLImageElement>())
  /** 在线预览：正在编译产物 */
  const [previewBusy, setPreviewBusy] = useState(false)
  /** 在线预览：主进程返回的地址（null = 当前没开预览） */
  const [preview, setPreview] = useState<SpinePreviewInfo | null>(null)
  /** 在线预览的告警（某张图集页读不出来之类），照实显示 */
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([])
  /** 在线预览失败的原因：编译报错 / 服务起不来 / 通道不存在，都必须写在界面上 */
  const [previewError, setPreviewError] = useState('')
  /** 自动打开浏览器的结果：非空 = 没打开成功，面板里提示用户自己点「在浏览器打开」 */
  const [browserHint, setBrowserHint] = useState('')
  /** 二维码里放的地址：默认第一个局域网地址，多网卡时可切换 */
  const [qrUrl, setQrUrl] = useState('')
  /** 当前预览的运行库种类：spine（官方）或 hao2d（项目自带的 pixi 运行库），用于停止时调对通道 */
  const [previewKind, setPreviewKind] = useState<'spine' | 'hao2d'>('spine')
  const qrRef = useRef<HTMLCanvasElement | null>(null)

  // 编译 + 打包 + UV 重映射（纯计算，不写盘）：改缩放 / 页尺寸后立刻重算预览。
  // Spine 走单骨架（当前骨架）导出；缩放同样生效——纹理按 ratio 缩小、附件 JSON 仍写原图尺寸，
  // 由 Spine 运行时的 regionScale 补偿，角色视觉大小不变（仅整页复制的旧图集页保持 1:1）。
  // 单文档工程里 store.skeletons 为空、activeSkeleton 为 -1，此时取索引 0（即 document 本身）。
  const spineSkeleton = skeletons.length > 0 ? Math.max(0, activeSkeleton) : 0
  const plan = useMemo<RuntimeExportPlan>(
    () =>
      mode === 'spine'
        ? prepareRuntimeExport({ scale, maxSize, skeletons: [spineSkeleton], atlasScope })
        : prepareRuntimeExport({ scale, maxSize, skeletons: selected, atlasScope }),
    [mode, scale, maxSize, doc, skeletons, selected, spineSkeleton, atlasScope]
  )
  const pages = plan.atlas.pages
  const current = Math.min(page, Math.max(0, pages.length - 1))
  /** Spine 导出用的文件主体：与 writeSpineExport 里算的一致，描述文本要对得上 */
  const spineBase = useMemo(() => {
    const skeleton = plan.skeletons[0]
    if (!skeleton) return 'skeleton'
    return sanitize(stripExtension(skeleton.name || skeleton.asset.armatureName) || 'skeleton')
  }, [plan])

  /**
   * .hao2d 的能力差异提示（变换 / 路径约束在 Unity 侧写不进去等）。
   * 只在这类导出里显示，运行时导出不受影响。
   */
  const warnings = useMemo(
    () =>
      mode === 'unity'
        ? [...new Set(plan.skeletons.flatMap((entry) => collectHao2dWarnings(entry.asset)))]
        : [],
    [mode, plan]
  )

  /** 勾选 / 取消一个骨架（至少留一个：全不勾等于没东西可导） */
  const toggleSkeleton = (index: number): void => {
    setPicked((prev) => {
      if (!prev.includes(index)) return [...prev, index].sort((a, b) => a - b)
      if (prev.length <= 1) {
        onStatus?.(t('至少要勾选一个骨架'))
        return prev
      }
      return prev.filter((item) => item !== index)
    })
  }

  /** Esc 关闭；弹窗内的按键不冒泡出去（否则会触发视口 / 工具的全局快捷键） */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (rootRef.current?.contains(event.target as Node)) event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  /** 预览绘制：棋盘底 + 当前页的图块（按显示比例缩放） */
  useEffect(() => {
    const canvas = canvasRef.current
    const pageInfo = pages[current]
    const pagePlan = previewPlanOf(plan.pageSources[current], pageInfo)
    if (!canvas || !pageInfo || !pagePlan) return

    let cancelled = false
    const fit = Math.min(MAX_PREVIEW_WIDTH / pageInfo.width, MAX_PREVIEW_HEIGHT / pageInfo.height, 1)
    const cssW = Math.max(1, Math.round(pageInfo.width * fit))
    const cssH = Math.max(1, Math.round(pageInfo.height * fit))
    const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2)
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const paint = (): void => {
      if (cancelled) return
      ctx.clearRect(0, 0, cssW, cssH)
      for (const blit of pagePlan.blits) {
        const image = loadedRef.current.get(blit.name)
        if (!image) continue
        ctx.drawImage(image, blit.x * fit, blit.y * fit, blit.width * fit, blit.height * fit)
      }
      // 分块描边：一眼能看出每张碎图落在哪
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
      ctx.lineWidth = 1
      for (const blit of pagePlan.blits) {
        ctx.strokeRect(blit.x * fit + 0.5, blit.y * fit + 0.5, Math.max(1, blit.width * fit - 1), Math.max(1, blit.height * fit - 1))
      }
    }
    paint()

    const missing = [...new Set(pagePlan.blits.map((blit) => blit.name))].filter(
      (name) => !loadedRef.current.has(name)
    )
    if (missing.length === 0) return

    const platform = getPlatform()
    void Promise.all(
      missing.map(async (name) => {
        const image = doc.images.find((entry) => entry.name === name)
        if (!image) return
        const url = await platform.imageUrl(image.path)
        if (!url) return
        const element = await loadImageElement(url).catch(() => null)
        if (element) loadedRef.current.set(name, element)
      })
    ).then(() => paint())

    return () => {
      cancelled = true
    }
  }, [plan, current, pages, doc.images])

  /** 二维码：把当前地址画成码（格子取整，扫起来才清楚） */
  useEffect(() => {
    const canvas = qrRef.current
    if (!canvas || !qrUrl) return
    const qr = qrcode(0, 'M')
    qr.addData(qrUrl)
    qr.make()
    const modules = qr.getModuleCount()
    const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 3)
    const cell = Math.max(2, Math.ceil((QR_DISPLAY_SIZE * dpr) / modules))
    const size = modules * cell
    canvas.width = size
    canvas.height = size
    canvas.style.width = `${Math.round(size / dpr)}px`
    canvas.style.height = `${Math.round(size / dpr)}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    qr.renderTo2dContext(ctx, cell)
  }, [qrUrl])

  /**
   * 起好预览后把浏览器叫起来。
   *
   * 走**渲染层**这条路（和「在浏览器打开」按钮完全同一条）：主进程里那一路 `shell.openExternal`
   * 在部分 macOS 环境下会被系统静默丢弃 —— 服务明明起好了、浏览器却没反应，只能手动点按钮。
   * 所以统一在这里打开；打不开就把「请点按钮」的提示摆到面板上，而不是静默失败。
   */
  const openPreviewInBrowser = async (url: string): Promise<void> => {
    try {
      await getPlatform().openExternal(url)
      setBrowserHint('')
    } catch {
      setBrowserHint(t('浏览器没能自动打开，点下面「在浏览器打开」即可（预览服务已经就绪）。'))
    }
  }

  /**
   * 起「在线预览」：把整份工程编译成 spine 产物，交给主进程的本地网页服务。
   *
   * 这里**不复用**导出计划：预览页要能切骨架，所以不管弹窗里勾了哪些，所有骨架都编进去
   * （缩放同样生效，见下方 scale——纹理缩小、附件 JSON 写原图尺寸，由 regionScale 补偿）。
   */
  const startPreview = async (): Promise<void> => {
    setPreviewBusy(true)
    setPreviewError('')
    setBrowserHint('')
    try {
      if (mode === 'runtime') {
        await startHao2dPreviewInternal()
        return
      }
      const previewPlan = prepareRuntimeExport({
        scale,
        maxSize,
        skeletons: skeletons.map((_, index) => index),
        atlasScope: 'all'
      })
      const { bundles, warnings } = await buildSpineBundles(previewPlan, {
        // 所有骨架共用同一份图集页：页名统一成 page<序号>，不然每个骨架都要各存一份
        pageName: (_base, index, ext) => `page${index}${ext}`
      })
      const first = bundles[0]
      if (!first) {
        setPreviewError(t('没有可预览的骨架'))
        return
      }
      const result = await getPlatform().startSpinePreview(
        {
          title: projectName || 'Hao2D',
          pages: first.pages.map((page) => ({ name: page.name, bytes: page.bytes })),
          skeletons: bundles.map((bundle, index) => ({
            id: `s${index}`,
            name: bundle.name,
            json: bundle.json,
            atlas: bundle.atlasText,
            animations: bundle.animations,
            skins: bundle.skins,
            defaultAnimation: bundle.defaultAnimation,
            defaultSkin: bundle.defaultSkin
          }))
        }
      )
      if (!result.ok) {
        setPreviewError(result.error)
        onStatus?.(t('预览失败：{0}', result.error))
        return
      }
      setPreview(result.data)
      setPreviewWarnings(warnings)
      setPreviewKind('spine')
      setQrUrl(result.data.lanUrls[0] ?? result.data.url)
      await openPreviewInBrowser(result.data.url)
      onStatus?.(
        result.data.lanUrls.length > 0
          ? t('预览已启动：手机扫码，或访问 {0}', result.data.lanUrls[0])
          : t('预览已启动，但没找到局域网地址（手机可能连不上）')
      )
    } catch (err) {
      /*
       * 这条链路上任何一步抛异常（编码图集、IPC 通道不存在……）都必须落到界面上。
       * 之前这里没有 catch，异常被无声吞掉，表现就是「点了预览按钮没反应」。
       */
      const message = err instanceof Error ? err.message : String(err)
      setPreviewError(message)
      onStatus?.(t('预览失败：{0}', message))
    } finally {
      setPreviewBusy(false)
    }
  }

  const startHao2dPreviewInternal = async (): Promise<void> => {
    const previewPlan = prepareRuntimeExport({
      scale,
      maxSize,
      skeletons: skeletons.map((_, index) => index),
      atlasScope: 'all'
    })
    const pack = await buildHao2dPreviewBundles(previewPlan)
    if (pack.skeletons.length === 0) {
      setPreviewError(t('没有可预览的骨架'))
      return
    }
    const result = await getPlatform().startHao2dPreview(
      {
        kind: 'hao2d',
        title: projectName || 'Hao2D',
        pages: pack.pages,
        skeletons: pack.skeletons.map((skeleton) => ({
          id: skeleton.id,
          name: skeleton.name,
          json: skeleton.skeText,
          atlas: skeleton.atlasText,
          animations: skeleton.animations,
          skins: skeleton.skins,
          defaultAnimation: skeleton.defaultAnimation,
          defaultSkin: skeleton.defaultSkin,
          nested: skeleton.nested
        }))
      }
    )
    if (!result.ok) {
      setPreviewError(result.error)
      onStatus?.(t('预览失败：{0}', result.error))
      return
    }
    setPreview(result.data)
    setPreviewWarnings(pack.warnings)
    setPreviewKind('hao2d')
    setQrUrl(result.data.lanUrls[0] ?? result.data.url)
    await openPreviewInBrowser(result.data.url)
    onStatus?.(
      result.data.lanUrls.length > 0
        ? t('预览已启动（hao2d 运行时）：手机扫码，或访问 {0}', result.data.lanUrls[0])
        : t('预览已启动，但没找到局域网地址（手机可能连不上）')
    )
  }

  const stopPreview = async (): Promise<void> => {
    const result =
      previewKind === 'hao2d'
        ? await getPlatform().stopHao2dPreview()
        : await getPlatform().stopSpinePreview()
    setPreview(null)
    setQrUrl('')
    setPreviewWarnings([])
    setPreviewError('')
    setBrowserHint('')
    setPreviewKind('spine')
    onStatus?.(result.ok ? t('已停止在线预览') : t('停止预览失败：{0}', result.error))
  }

  const copyLocalUrl = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(preview?.url ?? '')
      onStatus?.(t('本机链接已复制'))
    } catch {
      onStatus?.(t('复制失败，请手动选中上面的地址复制'))
    }
  }

  const copyQrUrl = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(qrUrl)
      onStatus?.(t('手机扫码链接已复制'))
    } catch {
      onStatus?.(t('复制失败，请手动选中上面的地址复制'))
    }
  }

  const pickDir = async (): Promise<void> => {
    const picked = await getPlatform().pickFiles({
      directory: true,
      multi: false,
      title: t('选择导出目录（会在里面新建工程文件夹）')
    })
    const next = picked[0]
    if (!next) return
    setDir(next)
    if (typeof localStorage !== 'undefined') localStorage.setItem(EXPORT_DIR_KEY, next)
  }

  const exportNow = async (): Promise<void> => {
    if (!dir) {
      onStatus?.(t('请先选择导出目录'))
      return
    }
    setBusy(true)
    try {
      const result =
        mode === 'spine'
          ? await writeSpineExport(dir, plan, { atlasTxt })
          : mode === 'unity'
            ? await writeHao2dExport(dir, plan)
            : await writeRuntimeExport(dir, plan)
      onStatus?.(result.message)
      // 有存档：把这次选的图集缩放写进工程文件，下次导出默认沿用（不重选）
      if (projectPath) {
        setExportScale(scale)
        await saveProject(false)
      }
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const totalBlocks = plan.pageSources.reduce(
    (sum, item) => sum + (item.kind === 'packed' ? item.plan.blits.length : 1),
    0
  )
  const copyPages = plan.pageSources.filter((item) => item.kind === 'copy').length
  /** 源图全部是图集（整页复制，不重打包）：缩放无意义，隐藏「图集缩放」控件 */
  const allAtlas = copyPages === pages.length && pages.length > 0
  const pageInfo = pages[current]
  const pageSource = plan.pageSources[current]
  const pagePlan = previewPlanOf(pageSource, pageInfo)
  /** 除当前二维码之外的其他局域网地址（多网卡时可切换，别的网段手机未必连得上） */
  const otherLanUrls = preview ? preview.lanUrls.filter((url) => url !== qrUrl) : []
  const canPreview = (mode === 'spine' || mode === 'runtime') && getPlatform().isElectron

  return createPortal(
    // 预览面板是可展开的，窗口矮的时候弹窗会变高：所以这里让遮罩可滚动，别把内容顶出屏幕
    <div className="fixed inset-0 z-[900] flex items-start justify-center overflow-auto bg-black/55 p-4">
      <div
        ref={rootRef}
        className="my-auto flex w-[780px] max-w-[94vw] flex-col rounded border border-line bg-ink-800 shadow-2xl shadow-black/60"
        style={panelStyle}
      >
        {/* 标题栏 */}
        <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line bg-ink-700 px-2.5" {...handleProps}>
          <Package size={13} className="text-accent" />
          <span className="text-panel font-semibold text-content-hi">{modeTitle(mode)}</span>
          <span className="hao-label ml-1">
            {pages.length > 0
              ? t('共 {0} 页 · {1} 张图片', [pages.length, totalBlocks])
              : t('没有可导出的图片')}
          </span>
          <button
            type="button"
            title={t('关闭（Esc）')}
            className="hao-tool-button ml-auto"
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </div>

        {/* 导出目录 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-line/60 px-2.5 py-2">
          <span className="hao-label w-[54px] shrink-0">{t('导出目录')}</span>
          <div
            className="hao-field flex min-w-0 flex-1 items-center truncate text-content-mid"
            title={dir || t('尚未选择')}
          >
            {dir || t('尚未选择（点右侧按钮选一个目录）')}
          </div>
          <button type="button" className="hao-btn shrink-0" onClick={() => void pickDir()}>
            <FolderOpen size={12} /> {t('选择…')}
          </button>
        </div>

        {/* 导出骨架：一个项目可以有多个骨架，这里勾选要导出的（默认全选） */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line/60 px-2.5 py-2">
          <span className="hao-label w-[54px] shrink-0">{t('导出骨架')}</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {skeletons.map((skeleton, index) => (
              <label
                key={`${skeleton.armatureName}-${index}`}
                className="flex cursor-pointer items-center gap-1 rounded-[4px] border border-line/60 px-1.5 py-[2px] text-3xs text-content-mid hover:bg-ink-700"
                title={t('{0}（{1} 骨骼 / {2} 动画）', [
                  skeleton.armatureName,
                  skeleton.bones.length,
                  skeleton.animations.length
                ])}
              >
                <input
                  type="checkbox"
                  className="h-[11px] w-[11px] accent-cyan-400"
                  checked={picked.includes(index)}
                  onChange={() => toggleSkeleton(index)}
                />
                <span className="max-w-[150px] truncate text-content-hi">{skeleton.armatureName}</span>
              </label>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="hao-btn h-[18px] px-1.5 text-3xs"
              title={t('勾选全部骨架')}
              onClick={() => setPicked(skeletons.map((_, index) => index))}
            >
              {t('全选')}
            </button>
            <button
              type="button"
              className="hao-btn h-[18px] px-1.5 text-3xs"
              title={t('只勾选当前编辑的骨架')}
              disabled={picked.length === 1 && picked[0] === activeSkeleton}
              onClick={() => setPicked([activeSkeleton])}
            >
              {t('仅当前')}
            </button>
          </div>
        </div>

        {/* 产物提示：会放进新建的子文件夹 */}
        <div className="shrink-0 border-b border-line/60 px-2.5 py-1.5">
          {mode === 'spine' ? (
            <span className="hao-label">
              {t('导出时会在所选目录内新建')} <span className="text-accent">{spineBase}/</span>{' '}
              {t('文件夹（目录、图集名与图集页名都用骨架名「')}
              <span className="text-accent">{plan.skeletons[0]?.name ?? spineBase}</span>
              {t('」），产物都放在里面：')}
              {spineBase}.json / {spineBase}.atlas{atlasTxt ? '.txt' : ''} / {t('{0} 张图集页', pages.length)}
              {copyPages > 0
                ? t('；其中 {0} 张本来就是图集（原图整页复制，逐字节照搬）', copyPages)
                : ''}
            </span>
          ) : mode === 'unity' ? (
            <span className="hao-label">
              {t('导出时会在所选目录内新建')} <span className="text-accent">{plan.stem}/</span>{' '}
              {t('文件夹（目录、图集页名与材质名都用项目名「')}
              <span className="text-accent">{projectName}</span>
              {t('」；每个 .hao2d 用各自骨架名），产物都放在里面：')}
              {t('{0} 个骨架各自一个 .hao2d / 共用 {1} 张图集页与 {2} 个材质（Hao2D/Sprite）', [
                plan.skeletons.length,
                pages.length,
                pages.length
              ])}
              {copyPages > 0
                ? t('；其中 {0} 张本来就是图集（原图整页复制，不重打包、不重编码）', copyPages)
                : ''}
            </span>
          ) : (
            <span className="hao-label">
              {t('导出时会在所选目录内新建')} <span className="text-accent">{plan.stem}/</span>{' '}
              {t('文件夹（目录、图集名与图集页名都用项目名「')}
              <span className="text-accent">{projectName}</span>
              {t('」），产物都放在里面：')}
              {listFiles(plan.skeletons.map((entry) => entry.fileName))} /{' '}
              {t('共用 {0}', plan.atlasName)} / {t('{0} 张图集页', pages.length)}
              {copyPages > 0
                ? t('；其中 {0} 张本来就是图集（原图整页复制，不重打包、不重编码）', copyPages)
                : ''}
            </span>
          )}
        </div>

        {/* 参数区 */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="hao-label shrink-0">{t('图集范围')}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                title={t('图集里装上项目里所有骨架用到的图（默认）')}
                className={['hao-btn h-[18px] px-1.5 text-3xs', atlasScope === 'all' ? 'hao-btn-accent' : ''].join(' ')}
                onClick={() => setAtlasScope('all')}
              >
                {t('所有骨架用到的图')}
              </button>
              <button
                type="button"
                title={t('图集里只装这次要导出的骨架用到的图')}
                className={[
                  'hao-btn h-[18px] px-1.5 text-3xs',
                  atlasScope === 'selected' ? 'hao-btn-accent' : ''
                ].join(' ')}
                onClick={() => setAtlasScope('selected')}
              >
                {t('只含选中骨架用到的图')}
              </button>
            </div>
          </div>

          {!allAtlas && (
            <div className="flex items-center gap-2">
              <span className="hao-label w-[54px] shrink-0">{t('图集缩放')}</span>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={scale}
                className="h-[14px] w-[150px] cursor-pointer accent-cyan-400"
                onChange={(event) => setScale(Number(event.target.value))}
              />
              <span className="w-[38px] shrink-0 text-panel text-content-hi">{Math.round(scale * 100)}%</span>
              <div className="flex items-center gap-1">
                {SCALE_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={[
                      'hao-btn h-[18px] px-1.5 text-3xs',
                      Math.abs(scale - preset) < 1e-6 ? 'hao-btn-accent' : ''
                    ].join(' ')}
                    onClick={() => setScale(preset)}
                  >
                    {Math.round(preset * 100)}%
                  </button>
                ))}
              </div>
            </div>
          )}
          {allAtlas ? (
            <div className="hao-label text-content-lo">
              {t('源图已是图集（整页复制，不重打包），图集缩放不生效，已隐藏。')}
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <span className="hao-label shrink-0">{t('单页最大')}</span>
            <div className="flex items-center gap-1">
              {SIZE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={[
                    'hao-btn h-[18px] px-1.5 text-3xs',
                    maxSize === preset ? 'hao-btn-accent' : ''
                  ].join(' ')}
                  onClick={() => setMaxSize(preset)}
                >
                  {preset}
                </button>
              ))}
            </div>
            {/* Spine 图集文本后缀：勾上写 `xxx.atlas.txt`（Spine 编辑器默认导出的形态） */}
            {mode === 'spine' && (
              <label
                className="ml-1 flex cursor-pointer items-center gap-1 rounded-[4px] border border-line/60 px-1.5 py-[2px] text-3xs text-content-mid hover:bg-ink-700"
                title={t('在 atlas 文件名后追加 .txt，写成 xxx.atlas.txt（Spine 编辑器默认导出的形态，spine-unity 也认）')}
              >
                <input
                  type="checkbox"
                  className="h-[11px] w-[11px] accent-cyan-400"
                  checked={atlasTxt}
                  onChange={(event) => setAtlasTxt(event.target.checked)}
                />
                <span className="text-content-hi">{t('atlas名追加.txt')}</span>
              </label>
            )}
          </div>
        </div>

        {/* 图集预览 */}
        <div className="mx-2.5 mb-2 flex min-h-0 flex-col rounded border border-line/60 bg-ink-900/40">
          <div className="flex h-[24px] shrink-0 items-center gap-2 border-b border-line/50 px-2">
            <span className="hao-label">{t('图集预览')}</span>
            {pageInfo ? (
              <span className="text-3xs text-content-lo">
                {t('第 {0} / {1} 页', [current + 1, pages.length])} · {pageInfo.width}×
                {pageInfo.height} ·{' '}
                {pageSource?.kind === 'copy'
                  ? t('原图整页复制（{0}）', pageSource.sourceName)
                  : t('{0} 张碎图', pagePlan?.blits.length ?? 0)}
              </span>
            ) : null}
            {pages.length > 1 ? (
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  title={t('上一页')}
                  className="hao-btn h-[18px] w-[18px] justify-center p-0"
                  disabled={current <= 0}
                  onClick={() => setPage(Math.max(0, current - 1))}
                >
                  <ChevronLeft size={12} />
                </button>
                <button
                  type="button"
                  title={t('下一页')}
                  className="hao-btn h-[18px] w-[18px] justify-center p-0"
                  disabled={current >= pages.length - 1}
                  onClick={() => setPage(Math.min(pages.length - 1, current + 1))}
                >
                  <ChevronRight size={12} />
                </button>
              </div>
            ) : null}
          </div>
          <div className="flex min-h-[180px] items-center justify-center p-2">
            {pages.length === 0 ? (
              <span className="text-panel text-content-lo">
                {t('当前工程没有使用任何图片，图集为空（导出后角色以纯色块渲染）')}
              </span>
            ) : (
              <div className="hao-checkerboard-sm rounded border border-line/70 p-px">
                <canvas ref={canvasRef} className="block" />
              </div>
            )}
          </div>
          {pages.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
              {pages.map((item, index) => (
                <button
                  key={item.image}
                  type="button"
                  title={t('{0}（{1}×{2}）', [item.image, item.width, item.height])}
                  className={[
                    'hao-btn h-[16px] min-w-[16px] justify-center px-1 text-3xs',
                    index === current ? 'hao-btn-accent' : ''
                  ].join(' ')}
                  onClick={() => setPage(index)}
                >
                  {index + 1}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* 警告（打包时放不下的图、以及 .hao2d 与 Unity 运行时的能力差异） */}
        {plan.warnings.length + warnings.length > 0 ? (
          <div className="mx-2.5 mb-2 max-h-[52px] shrink-0 overflow-auto hao-scroll rounded border border-warn/30 bg-warn/10 px-2 py-1">
            {[...plan.warnings, ...warnings].map((warning, index) => (
              <div key={`${index}-${warning}`} className="text-3xs text-warn/90">
                {warning}
              </div>
            ))}
          </div>
        ) : null}

        {/* 在线预览面板：二维码 + 地址 + 停止。
            地址跟着服务走（不随点击变化），所以手机扫一次码就够 —— 再点预览只是换一版资源，页面会自己重载 */}
        {preview ? (
          <div className="mx-2.5 mb-2 flex shrink-0 items-stretch gap-3 rounded border border-accent/45 bg-accent/[0.08] p-2.5">
            <div className="shrink-0 self-center rounded-[6px] bg-white p-1.5">
              <canvas ref={qrRef} className="block" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-center gap-1.5 text-panel font-semibold text-content-hi">
                <QrCode size={12} className="text-accent" />
                {t('手机扫码看角色')}
                <span className="hao-label">{t('（页面里能切换骨架 / 皮肤 / 动画）')}</span>
              </div>
              <div className="hao-label">
                {t('手机与电脑连同一个 Wi-Fi，用相机扫码即可；页面已适配手机（拖拽平移、双指缩放）。')}
                {t('这里再点「更新预览」＝ 换一版资源，已开着的页面会自动重载，不用重新扫码。')}
              </div>
              {browserHint ? <div className="text-3xs text-warn/90">{browserHint}</div> : null}
              <div
                className="hao-field h-auto min-h-[22px] w-full select-text break-all py-[3px] text-3xs"
                title={preview.url}
              >
                {preview.url}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  className="hao-btn h-[18px] px-1.5 text-3xs"
                  title={t('用系统默认浏览器打开本机预览地址')}
                  onClick={() => void getPlatform().openExternal(preview.url)}
                >
                  <ExternalLink size={11} /> {t('在浏览器打开')}
                </button>
                <button
                  type="button"
                  className="hao-btn h-[18px] px-1.5 text-3xs"
                  onClick={() => void copyLocalUrl()}
                >
                  <Copy size={11} /> {t('复制本机链接')}
                </button>
                <button
                  type="button"
                  className="hao-btn h-[18px] px-1.5 text-3xs"
                  title={t('停掉本地服务并释放内存里的图集')}
                  onClick={() => void stopPreview()}
                >
                  <Square size={10} /> {t('停止预览')}
                </button>
                {preview.lanUrls.length > 0 ? (
                  <button
                    type="button"
                    className="hao-btn h-[18px] px-1.5 text-3xs"
                    onClick={() => void copyQrUrl()}
                  >
                    <Copy size={11} /> {t('复制手机链接（{0}）', hostOf(qrUrl))}
                  </button>
                ) : null}
              </div>
              {otherLanUrls.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="hao-label ml-1">{t('切换扫码地址：')}</span>
                  {preview.lanUrls.map((url) => (
                    <button
                      key={url}
                      type="button"
                      className={`hao-btn h-[18px] px-1.5 text-3xs ${url === qrUrl ? 'bg-accent/20' : ''}`}
                      title={t('二维码改成扫这个地址：{0}', url)}
                      onClick={() => setQrUrl(url)}
                    >
                      {hostOf(url)}
                    </button>
                  ))}
                </div>
              ) : null}
              {previewWarnings.length > 0 ? (
                <div className="hao-label text-warn/90">{previewWarnings.join(' / ')}</div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* 预览失败原因：宁可写得直白，也不能让「点了没反应」这种情况发生 */}
        {previewError ? (
          <div className="mx-2.5 mb-2 flex shrink-0 items-start gap-1.5 rounded border border-warn/40 bg-warn/10 px-2 py-1">
            <AlertTriangle size={12} className="mt-[2px] shrink-0 text-warn" />
            <span className="select-text break-all text-3xs text-warn/90">{previewError}</span>
          </div>
        ) : null}

        {/* 底部操作 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-ink-700/60 px-2.5 py-2">
          {/* 在线预览：本地起个网页，用 spine 官方 JS 运行时播放，手机扫码也能看 */}
          {canPreview ? (
            <button
              type="button"
              title={t('在浏览器里用 spine 官方运行时播放这个角色（可切换骨架 / 皮肤 / 动画，手机扫码也能看）')}
              className="hao-btn hao-btn-accent h-[24px] shrink-0 gap-1.5 px-3 font-semibold"
              disabled={previewBusy}
              onClick={() => void startPreview()}
            >
              {previewBusy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              {previewBusy ? t('正在生成…') : preview ? t('更新预览') : t('预览')}
            </button>
          ) : null}
          <span className="hao-label mr-auto">
            {t('缩放不影响角色大小，只改变纹理分辨率：调小可以把更多碎图塞进更少的页')}
          </span>
          <button type="button" className="hao-btn" onClick={onClose} disabled={busy}>
            {t('取消')}
          </button>
          <button
            type="button"
            className="hao-btn hao-btn-accent"
            disabled={busy || !dir}
            onClick={() => void exportNow()}
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            {busy ? t('正在导出…') : t('导出')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
