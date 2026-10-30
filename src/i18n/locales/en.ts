/**
 * 英文词条：**中文原文 → 英文**。
 *
 * key 就是源码里的中文原文（见 `src/i18n/index.ts` 顶部说明）。
 * 占位符沿用 `{0}`（位置）/ `{name}`（命名）两种写法，与源码里的调用保持一致。
 *
 * 查找不到的 key 会原样回退成中文 —— 所以可以边用边补，不会因为漏翻而报错。
 * 想找还没翻的文案：`node scripts/extract-i18n.mjs` 后对照 scripts/i18n-extract.json。
 */
export const en: Record<string, string> = {
  // ── 通用 ──────────────────────────────────────────────────────────────
  '确定': 'OK',
  '取消': 'Cancel',
  '删除': 'Delete',
  '重命名': 'Rename',
  '关闭': 'Close',
  '完成': 'Done',
  '展开': 'Expand',
  '折叠': 'Collapse',

  // ── 左侧面板标题 / 提示 ────────────────────────────────────────────────
  '层级结构': 'Hierarchy',
  'slot 层级': 'Slot Order',
  '调整会写入绘制顺序帧': 'Edits are written as draw-order keyframes',
  '绘制顺序（setup）': 'Draw order (setup)',
  '曲线': 'Curves',
  '资源与皮肤': 'Assets & Skins',

  // ── 视口 ──────────────────────────────────────────────────────────────
  '视口': 'Viewport',
  '空白工程': 'Empty project',
  '顶部菜单「导入图片 / 导入 Spine / 导入 DragonBones」开始，或「打开」已有工程': 'Start from the top menu "Import Images / Import Spine / Import DragonBones", or open an existing project',
  '属性': 'Inspector',
  '当前选中对象': 'Current selection',

  // ── 编辑状态 / 工具标签 ────────────────────────────────────────────────
  '准备': 'Pose',
  '动画': 'Animate',
  '移动': 'Move',
  '旋转': 'Rotate',
  '缩放': 'Scale',
  '斜切': 'Shear',
  '选择': 'Select',
  'Pose（拖顶点改贴图 / 拖骨骼改绑定）': 'Pose (drag vertices to edit textures / drag bones to rebind)',
  '画骨骼（拖拽连续绑定）': 'Draw bones (drag to chain-bind)',
  '权重刷': 'Weight brush',
  '网格 / FFD 顶点': 'Mesh / FFD vertices',
  '绑定状态：编辑 setup 姿态、网格与权重（Tab 切换）': 'Bind mode: edit setup pose, meshes and weights (Tab to switch)',
  '动画编辑状态：时间轴与关键帧（Tab 切换）': 'Animate mode: timeline and keyframes (Tab to switch)',

  // ── 叠加层 ────────────────────────────────────────────────────────────
  '骨骼': 'Bones',
  '显示 / 隐藏骨骼骨架': 'Show / hide bone skeleton',
  '约束': 'Constraints',
  '显示 / 隐藏约束手柄（IK / 路径）': 'Show / hide constraint handles (IK / path)',
  '适配视野 (F)': 'Fit view (F)',

  // ── 菜单栏（渲染层） ───────────────────────────────────────────────────
  '新建项目': 'New Project',
  '新建项目 (Ctrl+N)': 'New Project (Ctrl+N)',
  '打开': 'Open',
  '打开工程 (Ctrl+O)': 'Open Project (Ctrl+O)',
  '保存': 'Save',
  '保存工程 (Ctrl+S)': 'Save Project (Ctrl+S)',
  '导入图片': 'Import Images',
  '导入或拖入碎图 / PSD (Ctrl+I)': 'Import or drop loose images / PSD (Ctrl+I)',
  '导出': 'Export',
  '导出运行时的数据（Ctrl+E）': 'Export runtime data (Ctrl+E)',
  '导出运行时': 'Export Runtime',
  '导出 {名称}_ske.json + {名称}_atlas.json + 图集 png (Ctrl+E)': 'Export {name}_ske.json + {name}_atlas.json + atlas png (Ctrl+E)',
  '导出 Unity': 'Export Unity',
  '导出给 Unity 的 .hao2d + 图集 png + 材质 (Ctrl+Shift+E)': 'Export .hao2d for Unity + atlas png + materials (Ctrl+Shift+E)',
  '导出 Spine': 'Export Spine',
  '导出 Spine 4.3 骨骼数据：{名称}.json + {名称}.atlas + 图集 png (Ctrl+Alt+E)': 'Export Spine 4.3 skeleton data: {name}.json + {name}.atlas + atlas png (Ctrl+Alt+E)',
  '最近打开的工程': 'Recently opened projects',
  '关闭最近列表': 'Close recent list',
  '还没有最近打开的工程': 'No recent projects yet',
  '关闭导出菜单': 'Close export menu',
  '撤销 (Ctrl+Z)': 'Undo (Ctrl+Z)',
  '重做 (Ctrl+Shift+Z)': 'Redo (Ctrl+Shift+Z)',
  '有未保存修改': 'Unsaved changes',
  '当前编辑状态（切换按钮在视口左上角）': 'Current edit mode (switch is at the top-left of the viewport)',
  '重置面板布局': 'Reset panel layout',
  '打开项目文件夹': 'Open project folder',

  // ── 骨架条 ────────────────────────────────────────────────────────────
  '骨架': 'Skeleton',
  '{0}（双击重命名；右键重命名 / 删除）': '{0} (double-click to rename; right-click to rename / delete)',
  '新建骨架': 'New Skeleton',
  '新建骨架：一套图片可以做多个骨骼（骨骼 / 插槽 / 皮肤 / 图层 / 动画各自独立，图片池共享）': 'New skeleton: one image set can drive multiple skeletons (bones / slots / skins / layers / animations are independent; the image pool is shared)',
  '项目里至少保留一个骨架': 'Keep at least one skeleton in the project',
  '删除这个骨架（图片池不受影响）': 'Delete this skeleton (the image pool is unaffected)',

  // ── 状态栏 ────────────────────────────────────────────────────────────
  '插槽': 'Slots',
  '顶点': 'Vertices',
  '三角面': 'Triangles',
  '有 {0} 张图片没加载出纹理，视口里会显示为白块': '{0} image(s) failed to load textures; they show as white blocks in the viewport',
  '图片纹理全部就绪': 'All image textures ready',
  '纹理': 'Textures',
  '未选择动画': 'No animation selected',
  '点击显示视口帧率': 'Show viewport frame rate',
  '点击隐藏帧率读数': 'Hide frame rate readout',
  '最差一帧 {0}ms': 'Worst frame {0}ms',

  // ── App 提示 / 反馈 ────────────────────────────────────────────────────
  '处理中…': 'Processing…',
  '正在新建项目…': 'Creating project…',
  '正在导入 PSD…': 'Importing PSD…',
  '正在读取 PSD…': 'Reading PSD…',
  '正在导入 Spine 资源…': 'Importing Spine assets…',
  '正在导入 DragonBones 资源…': 'Importing DragonBones assets…',
  '正在导入图片…': 'Importing images…',
  '已撤销': 'Undone',
  '已重做': 'Redone',
  '已适配视野': 'Fit view applied',
  '删除操作请使用层级树里的删除按钮': 'Use the delete button in the hierarchy tree to remove items',
  '已复制 {0} 项': 'Copied {0} item(s)',
  '已粘贴 {0} 项': 'Pasted {0} item(s)',
  '没有可粘贴的内容': 'Nothing to paste',
  '已复制生成 {0} 项': 'Duplicated {0} item(s)',
  '已结束绑定骨骼': 'Finished bone binding',
  '已切换到骨架「{0}」': 'Switched to skeleton "{0}"',
  '已新建骨架「{0}」：图片池与其它骨架共享': 'Created skeleton "{0}": the image pool is shared with other skeletons',
  '骨架已重命名为「{0}」': 'Skeleton renamed to "{0}"',
  '已删除骨架「{0}」（图片池未动）': 'Deleted skeleton "{0}" (image pool untouched)',
  'Animate 状态已切回选择工具（FFD 顶点仍可用）': 'Switched to the Select tool in Animate mode (FFD vertices are still available)',
  '新建空白工程：可导入图片或 Spine / DragonBones 资源开始': 'New empty project: import images or Spine / DragonBones assets to begin',
  '已打开上次的工程：{0}': 'Opened last project: {0}',
  '播放控制仅在 Animate 状态可用（Tab 切换）': 'Playback is only available in Animate mode (Tab to switch)',
  '当前工程还没有动画，可点时间轴上的「+ 动画」新建': 'No animations yet; click "+ Animation" on the timeline to create one',
  '已自动选择动画「{0}」': 'Auto-selected animation "{0}"',
  '打关键帧只在 Animate 状态可用（Tab 切换）': 'Keyframing is only available in Animate mode (Tab to switch)',
  '该命令将在对应模块接入后生效': 'This command will take effect once its module is wired up',
  '工具：{0}（{1}）': 'Tool: {0} ({1})',
  '骨骼工具：{0}（{1}）{2}': 'Bone tool: {0} ({1}){2}',
  '· 已退出绘制工具': ' · Exited drawing tool',
  '删除顶点改的是绑定网格：请切到 Pose 状态': 'Deleting vertices edits the bind mesh: switch to Pose mode',
  '顶点信息已过期：请在视口里重新点选顶点': 'Vertex info is stale: please re-select a vertex in the viewport',
  '已删除「{0}」的顶点 #{1}': 'Deleted vertex #{1} of "{0}"',
  '删除失败：顶点不存在或网格至少需要保留 3 个顶点': 'Delete failed: the vertex does not exist, or a mesh must keep at least 3 vertices',

  // ── 状态栏选中描述 ────────────────────────────────────────────────────
  '{0} 根骨骼（主选中「{1}」）': '{0} bones (primary "{1}")',
  '骨骼「{0}」': 'Bone "{0}"',
  '插槽「{0}」': 'Slot "{0}"',
  '附件「{0}」': 'Attachment "{0}"',
  '约束「{0}」': 'Constraint "{0}"',
  'Pose 状态': 'Pose mode',
  'Animate 状态': 'Animate mode',

  // ── 全局设置 ──────────────────────────────────────────────────────────
  '全局设置': 'Global Settings',
  '界面语言': 'Interface language',
  '语言': 'Language',
  '切换界面语言；首次启动会按系统语言自动选择': 'Switch the interface language; on first launch it follows the system language',
  '简体中文': '简体中文',
  'English': 'English',
  '在 atlas 文件名后追加 .txt，写成 xxx.atlas.txt（Spine 编辑器默认导出的形态，spine-unity 也认）': 'Append .txt to the atlas filename, e.g. xxx.atlas.txt (the Spine editor default export form; spine-unity also accepts it)',
  'Spine 导出：atlas 名追加 .txt': 'Spine export: append .txt to atlas name',
  '勾选后所有 Spine 导出都写成 {0}（全局生效，跨工程保留）': 'When checked, all Spine exports are written as {0} (applies globally, persists across projects)',
  '勾选后所有 Spine 导出都写成': 'When checked, all Spine exports are written as',
  '（全局生效，跨工程保留）': ' (applies globally, persists across projects)',
  '骨骼样式': 'Bone style',
  '恢复默认': 'Restore defaults',
  '恢复成默认长相': 'Restore the default look',
  '只影响视口里骨骼叠加层的长相（不写进工程、不影响导出）；改完立刻生效。': 'Affects only how the bone overlay looks in the viewport (not saved into the project, not affecting exports); applies immediately.',
  '宽': 'Width',
  '% 长度': '% length',
  '骨骼本体的半宽占骨骼长度的比例（默认 4%）': 'Half-width of the bone body as a ratio of bone length (default 4%)',
  '原点圈': 'Origin circle',
  '骨骼原点那个圆圈的大小（屏幕像素）；拾取它靠的也是这个大小': 'Size of the circle at the bone origin (screen pixels); picking it uses this size too',
  '骨骼颜色': 'Bone color',
  '骨骼本体的填充色（默认 #CCD2D8）': 'Fill color of the bone body (default #CCD2D8)',
  '描边颜色': 'Stroke color',
  '骨骼轮廓与原点圆圈的描边色': 'Stroke color of the bone outline and origin circle',
  '选中颜色': 'Selected color',
  '选中骨骼后整根（本体 + 原点圈）换成这个色': 'When a bone is selected, the whole bone (body + origin circle) uses this color',
  '透明度（alpha）': 'Opacity (alpha)',
  '透明度百分比（0–100）；失焦 / 回车生效': 'Opacity percentage (0–100); applies on blur / Enter',

  // ── 常量表：混合模式 / 缓动 / 时间轴分组（constants.ts） ──────────────
  'Erase（视口降级）': 'Erase (viewport fallback)',
  'Below（视口降级）': 'Below (viewport fallback)',
  'None（视口降级）': 'None (viewport fallback)',
  '变换': 'Transform',
  '路径': 'Path',
  '物理': 'Physics',
  '线性': 'Linear',
  '阶跃': 'Stepped',
  '贝塞尔': 'Bezier',
  '骨骼变换': 'Bone transform',
  '插槽颜色': 'Slot color',
  '附件切换': 'Attachment swap',
  'FFD 变形': 'FFD deform',
  '事件': 'Events',

  // ── 小坐标轴工具（toolStore.gizmoOrder） ─────────────────────────────
  '移动骨骼：拖 X/Y 轴只走单轴，拖中间方块自由移动；Shift 拖动改位移（Pose 改 setup / Animate 写关键帧）':
    'Move bone: drag the X/Y axes to move along one axis, drag the middle square to move freely; Shift-drag edits translation (Pose edits setup, Animate writes keyframes)',
  '旋转骨骼：拖圆环或骨骼本体都行': 'Rotate bone: drag the ring or the bone body itself',
  '缩放骨骼：X 轴改长度、Y 轴改粗细，拖中间方块等比缩放':
    'Scale bone: X axis changes length, Y axis changes thickness, drag the middle square to scale uniformly',
  '斜切骨骼：选中骨骼会被包围盒框住，拖动包围盒的边即可斜切（上下边横向拖改 shearY，左右边纵向拖改 shearX）':
    'Shear bone: the selected bone gets a bounding box — drag its edges to shear (drag the top/bottom edges horizontally for shearY, the left/right edges vertically for shearX)',

  // ── 网格子工具（toolStore.meshSubtools） ─────────────────────────────
  '网格子工具': 'Mesh subtool',
  '编辑顶点': 'Edit vertices',
  '编辑顶点（默认）：拖动顶点改网格几何；Pose 态改的是绑定网格，贴图留在原地':
    'Edit vertices (default): drag vertices to change the mesh geometry; in Pose mode you edit the bind mesh and the texture stays put',
  '添加顶点': 'Add vertex',
  '添加顶点：点网格的边或三角形内部插入一个顶点（UV / 权重按位置插值，等同按住 Alt 点击）':
    'Add vertex: click an edge or inside a triangle to insert a vertex (UV / weights interpolated by position; same as Alt-clicking)',
  '删除顶点': 'Remove vertex',
  '删除顶点：点一个顶点把它删掉，引用它的三角形会就地重新三角化补上':
    'Remove vertex: click a vertex to delete it; the triangles referencing it are re-triangulated in place',
  '自己绘制边界': 'Draw boundary yourself',
  '自己绘制边界：沿着轮廓依次点击（点不能超出图片的 region 框，画的时候只显示 region 框与轮廓，网格与顶点临时隐藏）；点回起点（第一个大圆点）或按右键即收尾闭合（闭合会丢弃原网格点、绑定权重与 FFD 关键帧），闭合后回到「编辑顶点」；点错了按 Ctrl+Z 撤回上一个点（此时 Ctrl+Z 只撤点，不动文档）':
    'Draw boundary yourself: click along the outline in order (points must stay inside the image region box; while drawing, only the region box and outline are shown and the mesh and vertices are hidden). Click back on the start point (the first large dot) or right-click to close the outline (closing discards the original mesh points, bind weights and FFD keyframes); afterwards you return to "Edit vertices". Clicked wrong? Press Ctrl+Z to undo the last point (in this mode Ctrl+Z only removes points and does not touch the document)',
  '自定义布线': 'Custom wiring',
  '自定义布线：从一个顶点按住拖到另一个顶点松手，即可在这两点之间连一条线（沿这条线重新三角化）':
    'Custom wiring: press on one vertex and drag to another, then release to connect the two with a line (re-triangulated along that line)',
  '重绘网格边线会删除当前选中图片上所有已添加的网格点，删除所有绑定的骨骼权重，并删除相对应的时间轴关键帧。\n\n您确定要手动重绘网格边线吗？':
    'Redrawing the mesh outline deletes every mesh point added to the currently selected image, removes all bound bone weights and deletes the corresponding timeline keyframes.\n\nAre you sure you want to redraw the mesh outline manually?',
  '重绘网格边线': 'Redraw mesh outline',
  '这一步可以用 Ctrl+Z 整步撤销': 'This step can be undone as a whole with Ctrl+Z',
  '重绘': 'Redraw',
  '{0} 个网格点': '{0} mesh point(s)',
  '{0} 根骨骼的绑定权重': 'bind weights of {0} bone(s)',
  '{0} 个 FFD 关键帧（{1} 个动画）': '{0} FFD keyframe(s) ({1} animation(s))',
  '对象：': 'Target: ',
  '本次将丢弃：': 'Will be discarded: ',
  '、': ', ',
  '{0}\n{1}': '{0}\n{1}',
  '网格工具：{0}': 'Mesh tool: {0}',
  '网格工具：{0}（右键回到「编辑顶点」）': 'Mesh tool: {0} (right-click to return to "Edit vertices")',

  // ── 编辑工具条（ViewportTools） ──────────────────────────────────────
  '选择工具': 'Select tool',
  '选中并变换骨骼 / 插槽 / 附件': 'Select and transform bones / slots / attachments',
  'Pose 工具': 'Pose tool',
  '调绑定：拖顶点只移动顶点（UV 不动）；拖骨骼改绑定姿态，蒙皮随之变形（仅 Pose 态）':
    'Edit the rig: dragging vertices moves only the vertices (UVs stay); dragging bones changes the bind pose and the skin follows (Pose mode only)',
  '画骨骼工具': 'Draw bone tool',
  '在视口拖拽画骨骼：起点落在骨骼上会吸附并以它为父，接着拖就能连成骨骼链（仅 Pose 态）':
    'Drag in the viewport to draw bones: the start point snaps to a bone and becomes its child; keep dragging to chain bones (Pose mode only)',
  '权重刷工具': 'Weight brush tool',
  '刷权重：先在层级树或视口里点一根骨骼作为目标，按住拖动刷权重（Alt=减少 / Shift=覆盖 / Ctrl=平滑 / Ctrl+Shift=只动已受该骨骼影响的顶点）；单击只选中顶点看它的权重':
    'Paint weights: first click a bone in the tree or viewport as the target, then drag to paint (Alt = subtract / Shift = replace / Ctrl = smooth / Ctrl+Shift = only vertices already influenced by that bone); a single click just selects a vertex to inspect its weights',
  '顶点工具': 'Vertex tool',
  '拖顶点：Pose 改绑定网格，Animate 写 FFD 帧；网格内 Alt+点击插入顶点':
    'Drag vertices: Pose edits the bind mesh, Animate writes FFD frames; Alt-click inside the mesh to insert a vertex',
  '网格工具': 'Mesh tool',
  '编辑网格顶点 / 三角面；网格内 Alt+点击插入顶点':
    'Edit mesh vertices / triangles; Alt-click inside the mesh to insert a vertex',
  '遮罩工具': 'Mask tool',
  '多边形遮罩：空白插槽单击加点、点回起点 / 右键闭合；已有遮罩时点边线插点、拖点移动、Delete 删除（仅 Pose 态）':
    'Polygon mask: click an empty slot to add points, click the first point / right-click to close; on an existing mask click an edge to insert a point, drag points to move, Delete to remove (Pose mode only)',
  '遮罩（多边形裁剪）': 'Mask (polygon clipping)',
  '遮罩': 'Mask',
  '结束插槽': 'End slot',
  '到末尾': 'To end',
  '反向遮罩': 'Inverse mask',
  '只保留多边形外部；Spine 要求此时按凸形处理': 'Keeps only the outside of the polygon; Spine requires a convex polygon',
  '凸多边形': 'Convex polygon',
  '多边形是凸的时候打开可加速；凹多边形请关掉': 'Enable for convex polygons to speed up clipping; turn off for concave shapes',
  '控制点 {0} 个 · 遮罩只影响绘制顺序中它之后、结束插槽之前的附件':
    '{0} control points · the mask affects attachments after it and before the end slot in draw order',
  '编辑遮罩点': 'Edit mask points',
  '转为遮罩': 'Convert to mask',
  '把当前显示转成多边形遮罩（保留附件名；加权网格暂不支持）':
    'Convert the current attachment to a polygon mask (keeps the name; weighted meshes are not supported yet)',
  'FFD 顶点工具': 'FFD vertex tool',
  '拖顶点写当前时间点的 FFD 帧；网格内 Alt+点击插入顶点':
    'Drag vertices to write an FFD frame at the current time; Alt-click inside the mesh to insert a vertex',
  '{0}（{1}）\n{2}': '{0} ({1})\n{2}',
  '{0}（{1}）': '{0} ({1})',
  '工具：{0}': 'Tool: {0}',
  '骨骼工具：{0} · 已退出绘制工具，鼠标现在用于{0}骨骼':
    'Bone tool: {0} · left the draw tool; the mouse now {0}s bones',
  '骨骼工具：{0}': 'Bone tool: {0}',
  '舞台（参考图）\n设置视口背景参考图：位置 / 大小 / 透明度，仅编辑器显示，不导出':
    'Stage (reference image)\nSet a viewport background reference image: position / size / opacity. Editor-only, never exported',
  '舞台：打开参考图设置': 'Stage: opened reference image settings',

  // ── 图片缩略图（ImageThumb） ────────────────────────────────────────
  '无法读取图片文件': 'Could not read the image file',
  '无法读取': 'Unreadable',
  '碎图': 'Loose image',
  '图集': 'Atlas',

  // ── 通用确认弹窗（ConfirmDialog） ───────────────────────────────────
  '关闭（Esc）': 'Close (Esc)',
  '按住标题栏可拖动窗口（双击回到屏幕中央）': 'Drag the title bar to move the window (double-click to recenter)',

  // ── 插槽层级右键菜单（slotLayerMenuItems） ───────────────────────────
  '移到顶层': 'Move to top',
  '上移一层': 'Move up one',
  '下移一层': 'Move down one',
  '移到底层': 'Move to bottom',
  '把「{0}」移到所有插槽的最前面（最后绘制）':
    'Move "{0}" to the front of all slots (drawn last)',
  '「{0}」往前画一层（盖住下面的）': 'Draw "{0}" one layer forward (covering the ones below)',
  '「{0}」往后画一层（被上面的盖住）': 'Draw "{0}" one layer back (covered by the ones above)',
  '把「{0}」移到所有插槽的最后面（最先绘制）':
    'Move "{0}" to the back of all slots (drawn first)',
  '删除插槽': 'Delete slot',
  '删除插槽「{0}」及其附件、动画轨道（不可撤销时 Ctrl+Z 也能回）':
    'Delete slot "{0}", its attachments and animation tracks (Ctrl+Z can bring it back even when not undoable)',
  '已删除插槽「{0}」': 'Deleted slot "{0}"',

  // ── PSD 导入弹窗 ────────────────────────────────────────────────────
  '在 PSD 中隐藏': 'Hidden in PSD',
  '组': 'Group',
  '无像素': 'No pixels',
  '导入 PSD': 'Import PSD',
  '图层（勾选要导入的层，编组可整组勾选）': 'Layers (check the ones to import; groups can be checked as a whole)',
  '已选 {0} / {1} 层': '{0} / {1} layers selected',
  '按 PSD 位置直接添加到场景': 'Add to the scene at their PSD positions',
  '导入': 'Import',

  // ── 新建项目弹窗 ────────────────────────────────────────────────────
  '选择项目的保存位置（会在里面建一个 <项目名>.hao2dproj）':
    'Choose where to save the project (a <project name>.hao2dproj will be created inside)',
  '项目名': 'Project name',
  '必填，不能含空格或 / \\ : * ? " < > |，例如 dragon_01 或 龙_01':
    'Required; no spaces or / \ : * ? " < > |, e.g. dragon_01',
  '保存位置': 'Location',
  '尚未选择': 'Not chosen yet',
  '尚未选择（点右侧按钮选一个目录）': 'Not chosen yet (click the button on the right to pick a folder)',
  '选择…': 'Choose…',
  '帧率': 'Frame rate',
  '{0} 帧 / 秒': '{0} fps',
  '项目文件：': 'Project file: ',
  '（填项目名并选好目录后显示）': '(shown once the project name and folder are set)',
  '项目名也是导出时的图集名与输出目录名；骨架名在骨架那一栏单独改。':
    'The project name is also the atlas name and output folder name on export; the skeleton name is edited separately in the skeleton bar.',
  '项目名不能为空': 'Project name cannot be empty',
  '项目名不能含空格或文件系统非法字符（/ \\ : * ? " < > |）':
    'Project name cannot contain spaces or filesystem-illegal characters (/ \ : * ? " < > |)',
  '请选择保存位置': 'Please choose a location',
  '创建项目并立刻写出工程文件': 'Create the project and write the project file immediately',
  '项目名不能含空格 / 文件系统非法字符，且需选择保存位置':
    'The project name cannot contain spaces or filesystem-illegal characters, and a location is required',
  '正在创建…': 'Creating…',
  '创建': 'Create',

  // ── AI 接入弹窗 ─────────────────────────────────────────────────────
  '安装失败': 'Installation failed',
  'AI 接入': 'AI Integration',
  '让 AI 工具把 Hao2DEditor 当成一个 MCP Server 自动加载：它启动后会在本机开一个只监听 127.0.0.1 的命令服务，AI 客户端填下面的地址即可读写当前工程。':
    'Let AI tools load Hao2DEditor automatically as an MCP Server: it starts a command service on this machine that only listens on 127.0.0.1, and an AI client can read/write the current project by using the address below.',
  '命令服务：': 'Command service: ',
  '运行中': 'Running',
  '未启动': 'Not started',
  '把下面的 MCP 地址填进 AI 客户端，或点「一键安装」。':
    'Paste the MCP address below into your AI client, or click "One-click install".',
  '请保持编辑器处于打开状态，命令服务随窗口启动。':
    'Keep the editor open — the command service runs with the window.',
  'MCP 地址（含访问 token）': 'MCP address (includes access token)',
  '命令服务未启动': 'Command service not started',
  '复制 MCP 地址': 'Copy MCP address',
  '已复制': 'Copied',
  '复制': 'Copy',
  '安装中…': 'Installing…',
  '一键安装到 AI 客户端': 'One-click install to AI clients',
  '安装结果': 'Installation result',
  '已写入配置': 'Config written',
  '失败：{0}': 'Failed: {0}',
  '需手动配置（{0}）': 'Manual setup required ({0})',
  '已检测到安装目录': 'install directory found',
  '未检测到安装目录': 'install directory not found',
  '标「需手动配置」的客户端（Codex / WorkBuddy / CodeBuddy / DeepSeek / Trae / ZCode）请把上面的 MCP 地址填进它们各自的 MCP 设置。':
    'For clients marked "Manual setup required" (Codex / WorkBuddy / CodeBuddy / DeepSeek / Trae / ZCode), paste the MCP address above into their own MCP settings.',

  // ── AI 接入弹窗 · 骨骼动画 Skill ─────────────────────────────────────
  '骨骼动画 Skill': 'Skeletal animation Skill',
  '随包': 'bundled',
  '未装到客户端': 'not installed to any client',
  '工程副本已关': 'project copy off',
  '工程副本：总是复制': 'project copy: always',
  '工程副本：同版本时跳过': 'project copy: skipped when same version',
  '已装 {0}': 'installed: {0}',
  '复制引导语': 'Copy prompt',
  '已复制引导语': 'Prompt copied',
  '复制给 AI 的一句话：让它自己去读 skill': 'Copy a one-liner telling the AI to read the Skill itself',
  '详情': 'Details',
  '收起': 'Collapse',
  '打开 Skill 目录': 'Open Skill folder',
  '打开目录': 'Open folder',
  '随编辑器带了一份「Hao2D 骨骼动画」Skill：写明坐标约定、搭骨架 / 打帧 / 蒙皮的步骤和导出方式。装进 AI 客户端的 skills 目录后，它就知道该怎么调用上面的命令。':
    'The editor ships with a "Hao2D skeletal animation" Skill: coordinate conventions, the steps for rigging / keyframing / skinning, and how to export. Once it is in an AI client\'s skills folder, the AI knows how to drive the commands above.',
  '未找到随包分发的 Skill 目录': 'Bundled Skill folder not found',
  '复制路径': 'Copy path',
  '安装到 CodeBuddy / Claude': 'Install to CodeBuddy / Claude',
  '选择目录…': 'Choose folder…',
  '选择 AI 客户端的 skills 目录': "Choose the AI client's skills folder",
  'Skill 安装结果': 'Skill installation result',
  '已安装': 'Installed',
  '需手动复制': 'Copy manually',
  '未检测到该客户端': 'Client not detected',
  '复制安装命令': 'Copy install command',
  '已复制命令': 'Command copied',
  'Codex / WorkBuddy / Trae 等若未识别到 Skills 目录，把上面的路径或命令交给它，或点「选择目录…」指定它读取技能的位置。':
    'If Codex / WorkBuddy / Trae did not report a Skills folder, hand it the path or command above, or click "Choose folder…" to point at the folder it reads skills from.',
  '浏览器模式没有随包 Skill，请在桌面版里使用':
    'The browser build has no bundled Skill — use the desktop app.',
  '未检测到': 'Not detected',
  '未安装': 'Not installed',
  '已装 v{0}': 'v{0} installed',
  '可更新：v{0} → v{1}': 'Update available: v{0} → v{1}',
  '更新到 v{0}': 'Update to v{0}',
  '重新安装 Skill': 'Reinstall Skill',
  '保存工程时复制到 <工程>/ai/skills/（给 Codex 这类只读工作区的 AI 用）':
    'Copy into <project>/ai/skills/ when saving — for workspace-scoped agents like Codex',
  '客户端已装同版本时也复制（共享工程 / 换机器用）':
    'Also copy when a client already has the same version (sharing the project / moving machines)',

  // ── 舞台参考图弹窗 ──────────────────────────────────────────────────
  '图片': 'Images',
  '请先保存工程：参考图要存到工程目录的 stage/ 下':
    'Save the project first: the reference image is stored in the project folder under stage/',
  '读不到图片文件': 'Could not read the image file',
  '更换舞台参考图': 'Replace stage reference image',
  '设置舞台参考图': 'Set stage reference image',
  '删除舞台参考图': 'Delete stage reference image',
  '舞台参考图': 'Stage reference image',
  '舞台参考图预览': 'Stage reference image preview',
  '无预览': 'No preview',
  '文件：{0}': 'File: {0}',
  '仅编辑器显示 · 不导出 · 存于工程 stage/ 目录':
    'Editor-only · not exported · stored in the project stage/ folder',
  '位置（世界坐标，y 向上）': 'Position (world coordinates, +y up)',
  '调整参考图位置': 'Adjust reference image position',
  '大小（显示像素）': 'Size (display pixels)',
  '高': 'Height',
  '调整参考图大小': 'Adjust reference image size',
  '透明度': 'Opacity',
  '调整参考图透明度': 'Adjust reference image opacity',
  '更换图片': 'Replace image',
  '删除图片': 'Delete image',
  '还没有参考图': 'No reference image yet',
  '选一张图铺在视口后面当背景参照（构图 / 姿态），它只显示在编辑器里，导出时不会带上。':
    'Pick an image to lay behind the viewport as a background reference (composition / pose). It only shows in the editor and is never included in exports.',
  '选择参考图片…': 'Choose a reference image…',

  // ── 资源与皮肤面板 ──────────────────────────────────────────────────
  '图片「{0}」正被 {1} 个附件引用。\n删除后这些附件会丢失贴图、退化为纯色块（附件本身保留）。\n确定删除？':
    'Image "{0}" is referenced by {1} attachment(s).\nAfter deleting, those attachments lose their texture and fall back to a solid color block (the attachments themselves are kept).\nDelete anyway?',
  '已删除「{0}」（{1} 个附件的贴图已清空）':
    'Deleted "{0}" (textures of {1} attachment(s) cleared)',
  '已删除「{0}」': 'Deleted "{0}"',
  '替换图片「{0}」': 'Replace image "{0}"',
  '读取「{0}」失败，替换取消': 'Failed to read "{0}"; replace cancelled',
  '已用「{0}」替换「{1}」（{2}×{3}）': 'Replaced "{1}" with "{0}" ({2}×{3})',
  '拆分「{0}」失败：{1}': 'Failed to split "{0}": {1}',
  '替换图片…': 'Replace image…',
  '选一张新图，保持原名（引用它的附件自动跟随）':
    'Pick a new image and keep the name (attachments referencing it follow automatically)',
  '从工程移除该图片（被引用的附件退化为纯色）':
    'Remove this image from the project (referencing attachments fall back to a solid color)',
  '松开导入到「资源与皮肤」': 'Release to import into "Assets & Skins"',
  '皮肤': 'Skins',
  '{0} 个附件': '{0} attachment(s)',
  '新建皮肤': 'New skin',
  '新建皮肤（每套皮肤一套附件，用于换装 / 换色）':
    'New skin (each skin has its own attachments; use it for outfit / color swaps)',
  '皮肤「{0}」': 'Skin "{0}"',
  '{0}：{1} 个附件（右键重命名 / 删除）':
    '"{0}": {1} attachment(s) (right-click to rename / delete)',
  '重命名皮肤': 'Rename skin',
  '皮肤名不能为空': 'The skin name cannot be empty',
  '不能重命名默认皮肤 default': 'The default skin cannot be renamed',
  '默认皮肤不能重命名 / 删除': 'The default skin cannot be renamed or deleted',
  '改名（变形帧与链接网格里的皮肤归属会一起跟随）':
    'Rename it (deform keys and linked-mesh skin ownership follow along)',
  '删除这套皮肤（里面的附件一起消失，可撤销）':
    'Delete this skin (its attachments go with it; undoable)',
  '已删除皮肤「{0}」': 'Deleted skin "{0}"',
  '皮肤「{0}」里有 {1} 个附件，删除后这些附件一起消失（引用它们的显示帧 / 链接网格要另行处理）。确定删除？':
    'Skin "{0}" has {1} attachment(s); deleting it removes them too (display keys / linked meshes referencing them must be handled separately). Delete?',
  '图片 / 图集页': 'Images / Atlas pages',
  '已选 {0} 张 · 拖入场景可一起创建': '{0} selected · drag into the scene to create them together',
  '⌘/Ctrl 多选': '⌘/Ctrl to multi-select',
  '导入图片 / 图集（⌘/Ctrl+I）；也可以把文件 / 文件夹直接拖进这个面板':
    'Import images / atlas (⌘/Ctrl+I); you can also drag files or folders straight into this panel',
  '尚无图片': 'No images yet',
  '点右上角「导入」选文件，或把图片 / 图集直接拖进这个面板；导入后即可作为附件贴图使用，导出时会自动打包成图集。':
    'Click "Import" in the top-right to choose files, or drag images / atlas straight into this panel; once imported they can be used as attachment textures and are packed into an atlas on export.',
  '拖到视口 = 在落点新建插槽（先多选可以一次拖多张）；拖到层级树的插槽行 = 给该插槽加一个 display；拖到骨骼行 = 在该骨骼下新建插槽；右键可替换 / 删除':
    'Drag into the viewport = create a slot at the drop point (multi-select first to drag several at once); drag onto a slot row in the tree = add a display to that slot; drag onto a bone row = create a slot under that bone; right-click to replace / delete',
  '拆成碎图：图集里的每块子图各写出一张 png（被旋转存放的会转正），引用它的附件自动改用碎图，图集从工程移除（磁盘上的原 png 保留，可 ⌘/Ctrl+Z 撤销）':
    'Split into loose images: each sub-image in the atlas is written out as its own png (rotated ones are straightened), attachments referencing it switch to the loose images, and the atlas is removed from the project (the original png on disk is kept; undoable with ⌘/Ctrl+Z)',
  '在骨骼「{0}」下新建插槽，并用这张图片作为它的 display（也可以直接把图片拖进场景）':
    'Create a slot under bone "{0}" using this image as its display (you can also drag the image straight into the scene)',
  '先新建一根骨骼，再用图片创建附件': 'Create a bone first, then use the image to make an attachment',
  '用图片创建附件': 'Create attachment from image',
  '图片「{0}」': 'Image "{0}"',

  // ── 层级树：行悬浮说明（HierarchyTree.rowTitle） ─────────────────────
  '{0} 根子骨骼': '{0} child bone(s)',
  '{0} 个插槽': '{0} slot(s)',
  '{0} 个约束': '{0} constraint(s)',
  '父级：{0}': 'Parent: {0}',
  '（根骨骼）': '(root bone)',
  '挂载：{0}': 'Attached: {0}',
  '（空）': '(empty)',
  '长度 {0}px · {1}': 'Length {0}px · {1}',
  '相对父级旋转 {0}°': 'Rotation {0}° relative to parent',
  '旋转 {0}°': 'Rotation {0}°',
  '{0}约束「{1}」寄宿在本骨骼 · 骨链 {2} · 参数在属性面板':
    '{0} constraint "{1}" is hosted on this bone · chain {2} · parameters in the inspector',
  '（未设置）': '(not set)',
  '已锁定：视口里点不中它（层级树里照常可操作）':
    'Locked: cannot be picked in the viewport (still operable in the tree)',
  '挂载于：{0}': 'Attached to: {0}',
  '根层': 'root level',
  '绘制层序 {0}（越小越先绘制）· display {1} 个':
    'Draw order {0} (smaller draws first) · {1} display(s)',
  '已隐藏：视口与导出都不绘制它（点行首眼睛恢复）':
    'Hidden: not drawn in the viewport or on export (click the eye at the row start to restore)',
  '当前显示：{0}': 'Currently showing: {0}',
  '当前一个 display 都不显示（点 display 行的小图标显示它）':
    'No display is currently shown (click the icon on a display row to show it)',
  'display「{0}」 · {1}': 'display "{0}" · {1}',
  '宿主插槽：{0}': 'Host slot: {0}',
  '图片：{0}': 'Image: {0}',
  '显示中：点前面的小图标可隐藏它（该插槽将不显示任何 display）':
    'Shown: click the icon in front to hide it (the slot will show no display at all)',
  '未显示：点前面的小图标切换到它（点文字只选中，不改显示）':
    'Not shown: click the icon in front to switch to it (clicking the text only selects, it does not change what is shown)',
  '{0}约束「{1}」': '{0} constraint "{1}"',
  '骨骼链：{0}': 'Bone chain: {0}',
  '（没有骨骼）': '(no bones)',
  '目标：{0}': 'Target: {0}',
  '权重 {0} · 弯曲方向 {1}': 'Weight {0} · Bend direction {1}',
  '继承模式：{0}{1}{2}': 'Inherit mode: {0}{1}{2}',
  ' · 相对叠加': ' · relative add',
  ' · 取局部变换': ' · use local transform',
  '位置 {0} · 间距 {1}': 'Position {0} · Spacing {1}',
  '仅保留数据：不参与求解，导出直通': 'Data only: not solved, passed through on export',
  '已停用（enabled = false）': 'Disabled (enabled = false)',
  'IK {0} 骨': 'IK {0} bone(s)',

  // ── 层级树：右键菜单与操作反馈 ──────────────────────────────────────
  '场景里还没有骨骼：先用工具栏的「骨骼」新建一根骨骼，再把图片拖进来':
    'No bones in the scene yet: create one with the "Bones" tool first, then drag an image in',
  '删除「{0}」': 'Delete "{0}"',
  '「{0}」是层级根骨骼，不能删除': '"{0}" is the hierarchy root bone and cannot be deleted',
  '至少保留一根骨骼': 'At least one bone must remain',
  '删除骨骼': 'Delete bone',
  '删除约束': 'Delete constraint',
  '新建骨骼': 'New bone',
  '新建插槽': 'New slot',
  '新建约束': 'New constraint',
  '删除 display': 'Delete display',
  '移动 display': 'Move display',
  '调整骨骼层级': 'Reparent bone',
  '调整插槽层级': 'Reparent slot',
  '切换骨骼锁定': 'Toggle bone lock',
  '切换插槽可见性': 'Toggle slot visibility',
  '切换插槽锁定': 'Toggle slot lock',
  '{0}关键帧': '{0} keyframe',
  '全部参数关键帧': 'Keyframe all parameters',
  '全部参数': 'all parameters',
  '位置关键帧': 'Position keyframe',
  '位置': 'Position',
  '旋转关键帧': 'Rotate keyframe',
  '缩放关键帧': 'Scale keyframe',
  '斜切关键帧': 'Shear keyframe',
  '全部通道关键帧': 'Keyframe all channels',
  '显示关键帧': 'Display keyframe',
  '颜色关键帧': 'Color keyframe',
  '可见性关键帧': 'Visibility keyframe',
  '显示': 'Display',
  '颜色': 'Color',
  '可见性': 'Visibility',
  '添加骨骼': 'Add bone',
  '添加插槽': 'Add slot',
  '挂在「{0}」下': 'Under "{0}"',
  '挂在根骨骼「{0}」下': 'Under the root bone "{0}"',
  '挂在根骨骼下': 'Under the root bone',
  '挂在骨骼「{0}」上': 'On bone "{0}"',
  '挂到第一根骨骼': 'Attach to the first bone',
  '添加 IK 约束': 'Add IK constraint',
  '添加变换约束': 'Add transform constraint',
  '继承位移 / 旋转 / 缩放 / 斜切': 'Inherit translation / rotation / scale / shear',
  '添加路径约束': 'Add path constraint',
  '骨骼沿路径曲线排布': 'Lay bones out along a path curve',
  '未指定驱动骨骼：先选中骨骼再点': 'No driven bones specified: select bones first, then click',
  '新建 IK 节点骨驱动：{0}（节点骨挂在 root 下，可拖动 / 可打帧）':
    'Creates an IK node bone driving: {0} (the node bone lives under the root bone and can be dragged / keyframed)',
  '解锁': 'Unlock',
  '锁定': 'Lock',
  '解锁（视口中可再次选中）': 'Unlock (selectable in the viewport again)',
  '锁定（视口中不可选中）': 'Lock (not selectable in the viewport)',
  '隐藏插槽': 'Hide slot',
  '显示插槽': 'Show slot',
  '显示中 · 网格': 'Shown · Mesh',
  '显示中': 'Shown',
  '网格': 'Mesh',
  '点击隐藏（该插槽不显示任何 display）': 'Click to hide (the slot will show no display)',
  '点击显示它': 'Click to show it',
  '{0} 个 display': '{0} display(s)',
  '切到 Pose 状态才能改绑定数据（骨骼 / 插槽 / display / 约束）':
    'Switch to Pose mode to edit binding data (bones / slots / displays / constraints)',
  '拖入 {0} 张图片添加 display': 'Drag in {0} images to add displays',
  '拖入图片添加 display': 'Drag in an image to add a display',
  '拖入 {0} 张图片新建插槽': 'Drag in {0} images to create slots',
  '拖入图片新建插槽': 'Drag in an image to create a slot',
  '无法用「{0}」新建插槽': 'Could not create a slot from "{0}"',
  '已新建插槽「{0}」挂到骨骼「{1}」下（图片「{2}」是它的 display）':
    'Created slot "{0}" under bone "{1}" (image "{2}" is its display)',
  '已新建 {0} 个插槽挂到骨骼「{1}」下（{2}）': 'Created {0} slots under bone "{1}" ({2})',
  '隐藏 display': 'Hide display',
  '切换显示的 display': 'Switch the shown display',
  '插槽「{0}」不再显示任何 display': 'Slot "{0}" no longer shows any display',
  '插槽「{0}」显示「{1}」': 'Slot "{0}" now shows "{1}"',
  '骨骼只能放到骨骼下面（拖到列表空白处 = 挂到根骨骼下）':
    'Bones can only be dropped under a bone (dropping on empty list space = under the root bone)',
  '插槽只能放到骨骼下面（不能挂到插槽或 display 之下）':
    'Slots can only be dropped under a bone (they cannot go under a slot or display)',
  'display 只能放到插槽下面': 'A display can only be dropped under a slot',
  '新建骨骼（挂在当前选中骨骼下；未选中时挂在根骨骼 root 下）':
    'New bone (under the selected bone; under the root bone when nothing is selected)',
  '新建插槽（挂到当前选中骨骼；未选中时挂到第一根骨骼）':
    'New slot (on the selected bone; on the first bone when nothing is selected)',
  '新建 IK 约束（自动新建一根 IK 节点骨挂在根骨骼 root 下、摆在链尾末端；先多选链根 → 链尾再点，可一次配好骨链）':
    'New IK constraint (creates an IK node bone under the root bone at the end of the chain; multi-select from chain root to chain tip first to set up the whole chain at once)',
  '新建变换约束': 'New transform constraint',
  '新建路径约束': 'New path constraint',
  '全部展开（骨骼 / 插槽 / display）': 'Expand all (bones / slots / displays)',
  '全部折叠（只留顶层骨骼，再点一次全部展开）':
    'Collapse all (only top-level bones remain; click again to expand all)',
  '隐藏 display 行（树里只留骨骼 / 插槽）': 'Hide display rows (leaving only bones / slots in the tree)',
  '显示 display 行': 'Show display rows',
  '搜索骨骼 / 插槽 / 约束…': 'Search bones / slots / constraints…',
  '清空搜索': 'Clear search',
  '「{0}」· display「{1}」': '"{0}" · display "{1}"',
  '显示关键帧（从这里开始显示）': 'Display keyframe (shown from here on)',
  '在当前时间切到「{0}」': 'Switch to "{0}" at the current time',
  '隐藏关键帧（从这里开始不显示）': 'Hide keyframe (hidden from here on)',
  '在当前时间把该插槽切成「不显示」': 'Switch this slot to "not shown" at the current time',
  '新建对象': 'Create object',
  '{0}「{1}」· 打关键帧{2}': '{0} "{1}" · keyframe{2}',
  '（工程里还没有动画：先在时间轴点「+ 动画」）':
    '(the project has no animation yet: click "+ Animation" in the timeline first)',
  '{0}「{1}」': '{0} "{1}"',
  '工程里还没有动画：先在时间轴点「+ 动画」':
    'The project has no animation yet: click "+ Animation" in the timeline first',

  // ── 约束通道名（timeline/model.CONSTRAINT_CHANNEL_LABEL） ────────────
  '权重': 'Weight',
  '旋转混合': 'Rotate mix',
  'X 位移混合': 'X translate mix',
  'Y 位移混合': 'Y translate mix',
  'X 缩放混合': 'X scale mix',
  'Y 缩放混合': 'Y scale mix',
  '斜切混合': 'Shear mix',
  '旋转偏移': 'Rotate offset',
  'X 位移偏移': 'X translate offset',
  'Y 位移偏移': 'Y translate offset',
  'X 缩放偏移': 'X scale offset',
  'Y 缩放偏移': 'Y scale offset',
  '斜切偏移': 'Shear offset',
  '间距': 'Spacing',
  '位移混合': 'Translate mix',

  // ── 时间轴轨道分组名（timeline/model.groupLabel） ────────────────────
  '插槽层级': 'Slot order',

  // ── 关键帧值浮动条（KeyframeValueBar） ──────────────────────────────
  '位移': 'Translate',
  '绘制顺序': 'Draw order',
  'FFD 偏移': 'FFD offsets',
  '修改显示关键帧': 'Edit display keyframe',
  '不显示': 'Not shown',
  '事件名': 'Event name',
  '修改事件名': 'Edit event name',
  '字符串': 'String',
  '可空': 'optional',
  '修改事件字符串参数': 'Edit event string parameter',
  '整数': 'Int',
  '修改事件整数参数': 'Edit event int parameter',
  '浮点': 'Float',
  '修改事件浮点参数': 'Edit event float parameter',
  '关键帧': 'Keyframe',
  '已选中 {0} 个（{1}）': '{0} selected ({1})',
  '值': 'Value',
  '修改关键帧值': 'Edit keyframe value',
  '修改关键帧颜色': 'Edit keyframe color',
  '该通道没有可直接编辑的值': 'This channel has no directly editable value',

  // ── 插槽层级面板（SlotOrderPanel） ──────────────────────────────────
  '绘制顺序关键帧': 'Draw order keyframe',
  '已在 {0}s 写入绘制顺序帧（{1} 个插槽）':
    'Wrote a draw order frame at {0}s ({1} slot(s))',
  '已调整插槽绘制顺序（setup）': 'Adjusted the setup draw order',
  '清除绘制顺序帧': 'Clear draw order frame',
  '已清除 {0}s 的绘制顺序帧（该时段回到 setup 顺序）':
    'Cleared the draw order frame at {0}s (that span falls back to the setup order)',
  '上移一层（更晚绘制，盖住下面的）': 'Move up one layer (drawn later, covers the ones below)',
  '下移一层（更早绘制，被上面的盖住）': 'Move down one layer (drawn earlier, covered by the ones above)',
  'Animate：拖动或点箭头会在 {0}s 写入绘制顺序帧':
    'Animate: dragging or using the arrows writes a draw order frame at {0}s',
  '删除当前时刻的绘制顺序帧（该时段回到 setup 顺序）':
    'Delete the draw order frame at the current time (that span falls back to the setup order)',
  '清除此帧': 'Clear this frame',
  '上面的行画在更前面；调整的是 setup 绘制顺序':
    'Rows higher up are drawn in front; this edits the setup draw order',
  '{0}（挂载于「{1}」）：拖动调整绘制顺序':
    '{0} (attached to "{1}"): drag to change the draw order',
  '，Animate 态自动打关键帧，右键可写层级帧':
    '; in Animate mode keyframes are written automatically, right-click to key the layer',
  '插槽「{0}」· 层级': 'Slot "{0}" · Layer',
  '（当前没有可打帧的动画：先在时间轴点「+ 动画」）':
    '(there is no animation to key right now: click "+ Animation" in the timeline first)',
  '层级关键帧': 'Layer keyframe',
  '{0} 所在层级 · 把当前绘制顺序写入 {1}s':
    'Layer of {0} · write the current draw order at {1}s',

  // ── 曲线编辑器（CurveEditor） ───────────────────────────────────────
  '缓入缓出': 'Ease in-out',
  '缓入': 'Ease in',
  '缓出': 'Ease out',
  '回弹': 'Back',
  '强缓入': 'Strong ease in',
  '强缓出': 'Strong ease out',
  '急停': 'Snap stop',
  '缓入回弹': 'Back in',
  '缓出回弹': 'Back out',
  '先在 dope sheet 里选中关键帧': 'Select keyframes in the dope sheet first',
  '修改缓动': 'Edit easing',

  // ── 视口属性栏 / 打帧条（PropertyKeyBar） ───────────────────────────
  '当前帧（{0}）已有关键帧 —— 点菱形重打一帧':
    'The current frame ({0}) already has a keyframe — click the diamond to re-key it',
  '点右侧菱形在当前帧（{0}）打一帧': 'Click the diamond on the right to key the current frame ({0})',
  '「{0}」': '"{0}"',
  '插槽颜色关键帧': 'Slot color keyframe',
  '点开系统拾色器改颜色（当前 {0}）': 'Open the system color picker to change the color (now {0})',
  '颜色 #RRGGBB；失焦 / 回车生效（透明度看下一行）':
    'Color #RRGGBB; applies on blur / Enter (alpha is on the next row)',
  '插槽透明度关键帧': 'Slot alpha keyframe',
  '透明度 0 ~ 100；失焦 / 回车生效（中键左右拖动可调）':
    'Alpha 0 ~ 100; applies on blur / Enter (middle-drag left/right to scrub)',
  '在当前帧打关键帧': 'Key the current frame',
  '（X / Y，像素）': ' (X / Y, px)',
  '（度）': ' (deg)',
  '（比例，1 = 原大）': ' (ratio, 1 = original size)',
  '（比例，不换算）': ' (ratio, no unit conversion)',
  '视口未就绪': 'Viewport not ready',
  '（#RRGGBB）': ' (#RRGGBB)',
  '（0 ~ 100）': ' (0 ~ 100)',
  '左右拖动调透明度；右侧读数可打字或中键拖动微调':
    'Drag left/right to change alpha; the readout on the right can be typed or middle-dragged',
  '「{0}」显示选择': '"{0}" display selection',
  '视口还没就绪，暂时读不到显示列表': 'The viewport is not ready yet, the display list cannot be read',
  '不显示任何附件': 'Show no attachment',
  '显示选择': 'Display selection',
  '当前：{0}': 'Current: {0}',

  // ── 导出对话框（ExportDialog） ──────────────────────────────────────
  '导出运行时数据': 'Export runtime data',
  '至少要勾选一个骨架': 'Select at least one skeleton',
  '没有可预览的骨架': 'No skeleton available for preview',
  '预览失败：{0}': 'Preview failed: {0}',
  '预览已启动：手机扫码，或访问 {0}': 'Preview started: scan the QR code on your phone, or visit {0}',
  '预览已启动，但没找到局域网地址（手机可能连不上）':
    'Preview started, but no LAN address was found (your phone may not be able to connect)',
  '预览已启动（hao2d 运行时）：手机扫码，或访问 {0}':
    'Preview started (hao2d runtime): scan the QR code on your phone, or visit {0}',
  '已停止在线预览': 'Live preview stopped',
  '停止预览失败：{0}': 'Failed to stop the preview: {0}',
  '本机链接已复制': 'Local link copied',
  '手机扫码链接已复制': 'Phone QR link copied',
  '复制失败，请手动选中上面的地址复制': 'Copy failed, select the address above and copy it manually',
  '选择导出目录（会在里面新建工程文件夹）':
    'Choose an export directory (a project folder is created inside it)',
  '请先选择导出目录': 'Choose an export directory first',
  '共 {0} 页 · {1} 张图片': '{0} page(s) · {1} image(s)',
  '没有可导出的图片': 'No images to export',
  '导出目录': 'Export directory',
  '导出骨架': 'Skeletons to export',
  '{0}（{1} 骨骼 / {2} 动画）': '{0} ({1} bones / {2} animations)',
  '勾选全部骨架': 'Select every skeleton',
  '全选': 'All',
  '只勾选当前编辑的骨架': 'Select only the skeleton being edited',
  '仅当前': 'Current only',
  '导出时会在所选目录内新建': 'On export a folder is created inside the selected directory:',
  '文件夹（目录、图集名与图集页名都用骨架名「':
    ' (the directory, atlas name and atlas page names all use the skeleton name "',
  '」），产物都放在里面：': '"); all outputs go inside it:',
  '{0} 张图集页': '{0} atlas page(s)',
  '；其中 {0} 张本来就是图集（原图整页复制，逐字节照搬）':
    '; {0} of them are already atlases (copied whole-page, byte for byte)',
  '文件夹（目录、图集页名与材质名都用项目名「':
    ' (the directory, atlas page names and material names all use the project name "',
  '」；每个 .hao2d 用各自骨架名），产物都放在里面：':
    '"; each .hao2d uses its own skeleton name); all outputs go inside it:',
  '{0} 个骨架各自一个 .hao2d / 共用 {1} 张图集页与 {2} 个材质（Hao2D/Sprite）':
    '{0} skeleton(s) each get a .hao2d / sharing {1} atlas page(s) and {2} material(s) (Hao2D/Sprite)',
  '；其中 {0} 张本来就是图集（原图整页复制，不重打包、不重编码）':
    '; {0} of them are already atlases (copied whole-page, no repacking or re-encoding)',
  '文件夹（目录、图集名与图集页名都用项目名「':
    ' (the directory, atlas name and atlas page names all use the project name "',
  '共用 {0}': 'shared {0}',
  '图集范围': 'Atlas scope',
  '图集里装上项目里所有骨架用到的图（默认）':
    'Pack every image used by any skeleton in the project (default)',
  '所有骨架用到的图': 'Images used by all skeletons',
  '图集里只装这次要导出的骨架用到的图':
    'Pack only the images used by the skeletons being exported',
  '只含选中骨架用到的图': 'Only images used by selected skeletons',
  '图集缩放': 'Atlas scale',
  '源图已是图集（整页复制，不重打包），图集缩放不生效，已隐藏。':
    'The source images are already atlases (copied whole-page, not repacked), so the atlas scale has no effect and is hidden.',
  '单页最大': 'Max page size',
  'atlas名追加.txt': 'append .txt to the atlas name',
  '图集预览': 'Atlas preview',
  '第 {0} / {1} 页': 'Page {0} / {1}',
  '原图整页复制（{0}）': 'source image copied whole-page ({0})',
  '{0} 张碎图': '{0} tiles',
  '上一页': 'Previous page',
  '下一页': 'Next page',
  '当前工程没有使用任何图片，图集为空（导出后角色以纯色块渲染）':
    'This project uses no images, so the atlas is empty (characters render as solid blocks after export)',
  '{0}（{1}×{2}）': '{0} ({1}×{2})',
  '手机扫码看角色': 'Scan the QR code to view the character',
  '（页面里能切换骨架 / 皮肤 / 动画）': ' (switch skeleton / skin / animation in the page)',
  '手机与电脑连同一个 Wi-Fi，用相机扫码即可；页面已适配手机（拖拽平移、双指缩放）。':
    'Connect your phone and computer to the same Wi-Fi and scan the code with the camera; the page is mobile-ready (drag to pan, pinch to zoom).',
  '这里再点「更新预览」＝ 换一版资源，已开着的页面会自动重载，不用重新扫码。':
    'Clicking "Update preview" here swaps in a new build of the assets; open pages reload automatically, no need to scan again.',
  '用系统默认浏览器打开本机预览地址': 'Open the local preview URL in the system default browser',
  '在浏览器打开': 'Open in browser',
  '浏览器没能自动打开，点下面「在浏览器打开」即可（预览服务已经就绪）。':
    'The browser could not be opened automatically — click "Open in browser" below (the preview server is already running).',
  '复制本机链接': 'Copy local link',
  '停掉本地服务并释放内存里的图集': 'Stop the local server and release the in-memory atlases',
  '停止预览': 'Stop preview',
  '复制手机链接（{0}）': 'Copy phone link ({0})',
  '切换扫码地址：': 'Switch the QR address:',
  '二维码改成扫这个地址：{0}': 'Point the QR code at this address: {0}',
  '在浏览器里用 spine 官方运行时播放这个角色（可切换骨架 / 皮肤 / 动画，手机扫码也能看）':
    'Play this character in the browser with the official spine runtime (switch skeleton / skin / animation, viewable on a phone by scanning the code)',
  '正在生成…': 'Generating…',
  '更新预览': 'Update preview',
  '预览': 'Preview',
  '缩放不影响角色大小，只改变纹理分辨率：调小可以把更多碎图塞进更少的页':
    'Scale does not change the character size, only the texture resolution: lowering it fits more tiles into fewer pages',
  '正在导出…': 'Exporting…',

  // ── 关键帧表（DopeSheet） ───────────────────────────────────────────
  '轨道 / 对象': 'Tracks / Objects',
  '{0} 轨 · {1} 关键帧': '{0} tracks · {1} keyframes',
  '当前已缩放，点击恢复「完整适配」': 'Zoomed in; click to restore "fit all"',
  '关键帧区：左键拖动框选关键帧（Shift / Ctrl 点击加选或减选），选中后可整段左右拖动；单击空白定位播放头；滚轮上下翻轨道，Shift+滚轮横向平移；缩放用底部工具栏':
    'Keyframe area: drag with the left button to marquee-select keyframes (Shift / Ctrl click to add or remove), then drag the selection left/right; click empty space to move the playhead; scroll to page through tracks, Shift+scroll to pan horizontally; zoom from the toolbar at the bottom',
  '插槽层级（绘制顺序）：每帧是一份完整顺序快照，在 slot 层级面板调完顺序后打帧；点选后按 Delete 可删除整条通道':
    'Slot order (draw order): each frame is a full order snapshot, key it after adjusting the order in the slot order panel; select it and press Delete to remove the whole channel',
  '{0}「{1}」的通道（点击选中该对象）': 'Channels of {0} "{1}" (click to select that object)',
  '{0} · 显示 · 单击选中插槽，按 K 在当前时间打显示帧':
    '{0} · Display · click to select the slot, press K to key the display at the current time',
  '{0} · {1} · 点击选中该通道（按 K 只给它打帧，Delete 删除整条通道）':
    '{0} · {1} · click to select this channel (K keys only this one, Delete removes the whole channel)',
  '折叠 / 展开该骨骼的通道': 'Collapse / expand this bone\u2019s channels',
  '没有轨道：在 Pose 状态调整骨骼/插槽后按 K 打关键帧；子骨架参数在视口下方的属性条里打帧':
    'No tracks yet: adjust bones/slots in Pose mode and press K to key; sub-armature values are keyed from the property bar below the viewport',
  '左右拖动缩放选中关键帧': 'Drag left/right to scale the selected keyframes',
  '{0} @ {1}s（事件；拖动改时间，Delete 删除）':
    '{0} @ {1}s (event; drag to change the time, Delete to remove)',
  '{0} · {1} @ {2}s（拖动整组改时间，Delete 删除）':
    '{0} · {1} @ {2}s (drag the whole group to change the time, Delete to remove)',
  '洋葱皮：显示前后帧的骨骼姿态': 'Onion skin: show bone poses from the surrounding frames',
  '智能过滤：「{0}」的轨道（再点一次恢复全部）': 'Smart filter: tracks of "{0}" (click again to show all)',
  '智能过滤已开启，但还没选中对象：选中骨骼 / 插槽 / 约束后只显示它的轨道（再点一次恢复全部）':
    'Smart filter is on but nothing is selected: select a bone / slot / constraint to show only its tracks (click again to show all)',
  '智能过滤：只显示当前选中对象的轨道': 'Smart filter: show only the tracks of the current selection',
  '再点一次「智能过滤」恢复全部轨道': 'Click "Smart filter" again to show all tracks',
  '左右滑动时间轴（拖到最右 = 时间轴末尾）':
    'Pan the timeline left/right (drag to the far right = the end of the timeline)',
  '缩小时间轴（看得更全）': 'Zoom out (see more)',
  '时间轴缩放': 'Timeline zoom',
  '放大时间轴（逐帧精修）': 'Zoom in (frame-by-frame editing)',
  '恢复「完整适配」': 'Restore "fit all"',

  // ── 时间轴面板（TimelinePanel） ─────────────────────────────────────
  '{0} 帧': '{0} fr',
  '已经有一个叫「{0}」的动画了': 'An animation named "{0}" already exists',
  '重命名动画': 'Rename animation',
  '动画「{0}」已重命名为「{1}」': 'Animation "{0}" renamed to "{1}"',
  '复制动画': 'Duplicate animation',
  '已复制出动画「{0}」': 'Duplicated animation "{0}"',
  '删除动画': 'Delete animation',
  '已删除动画「{0}」': 'Deleted animation "{0}"',
  '，已切到「{0}」': ', switched to "{0}"',
  '（可撤销）': ' (undoable)',
  '请先在时间轴选择动画': 'Select an animation in the timeline first',
  '（未选择动画）': '(no animation selected)',
  '新建动画（建好自动切过去）': 'New animation (switches to it automatically)',
  '新建动画': 'New animation',
  '+ 动画': '+Anim',
  '输入新名字，回车确认 / Esc 取消': 'Type a new name, Enter to confirm / Esc to cancel',
  '重命名当前动画': 'Rename the current animation',
  '复制当前动画（连同全部关键帧）': 'Duplicate the current animation (with all keyframes)',
  '删除当前动画（可撤销）': 'Delete the current animation (undoable)',
  '动画时长（帧）。这是可编辑范围（改大就能在后面继续加帧）；播放与导出按最后一个关键帧算':
    'Animation duration (frames). This is the editable range (increase it to keep keying further out); playback and export follow the last keyframe',
  '时长': 'Duration',
  '动画时长（帧）。失焦 / 回车生效；中键左右拖动可调；播放按最后一个关键帧算':
    'Animation duration (frames). Applies on blur / Enter; middle-drag left/right to scrub; playback follows the last keyframe',
  '修改动画时长': 'Edit animation duration',
  '时长不能短于最后一个关键帧（{0} 帧 / {1}s），已按 {0} 帧设置':
    'The duration cannot be shorter than the last keyframe ({0} frames / {1}s); set to {0} frames',
  '帧': 'fr',
  '把当前姿态写成关键帧（K）': 'Key the current pose (K)',
  // 「添加事件帧」已在文件末尾的命令文案区定义（同一句被按钮 title 与命令结果共用）
  '事件帧': 'Event frame',
  '删除选中的关键帧（Delete）': 'Delete the selected keyframes (Delete)',
  '展开时间轴': 'Expand timeline',
  '折叠时间轴': 'Collapse timeline',
  '上一帧 (←)': 'Previous frame (←)',
  '播放 / 暂停 (空格)': 'Play / pause (Space)',
  '下一帧 (→)': 'Next frame (→)',
  '循环播放': 'Loop playback',
  '播放倍速': 'Playback speed',
  '关键帧吸附到帧': 'Snap keyframes to frames',
  '移动关键帧': 'Move keyframes',
  '关键帧时间已更新': 'Keyframe times updated',
  '（按 K 只给「{0}」打帧）': ' (K keys only "{0}")',
  '选中骨骼「{0}」': 'Selected bone "{0}"',
  '选中插槽「{0}」': 'Selected slot "{0}"',
  '选中附件「{0} / {1}」': 'Selected attachment "{0} / {1}"',
  '选中约束「{0}」': 'Selected constraint "{0}"',
  '事件轨道：在检查器里编辑事件参数': 'Event track: edit the event parameters in the inspector',

  // ── 视口画布（ViewportCanvas） ──────────────────────────────────────
  '插入顶点改的是绑定网格：请切到 Pose 状态':
    'Inserting vertices edits the binding mesh: switch to Pose mode',
  '插入位置不在附件上': 'The insertion point is not on the attachment',
  '插入网格顶点': 'Insert mesh vertex',
  '该位置不在网格内部：点在网格覆盖的区域内才能插入顶点':
    'That position is not inside the mesh: click within the area the mesh covers to insert a vertex',
  '已插入顶点 #{0}（UV 与权重按位置插值，落在网格线上时会把那条边一分为二）':
    'Inserted vertex #{0} (UVs and weights are interpolated by position; landing on a mesh edge splits it in two)',
  '请点在骨骼上（可连续点选多根；右键或再点按钮结束绑定）':
    'Click on a bone (keep clicking to add more; right-click or press the button again to finish)',
  '绑定权重骨骼': 'Bind weight bone',
  '已绑定「{0}」；可继续点选其它骨骼，完成后右键或再点按钮结束':
    'Bound "{0}"; keep picking other bones, then right-click or press the button again to finish',
  '「{0}」已在列表里；继续点选，或右键结束绑定':
    '"{0}" is already in the list; keep picking, or right-click to finish',
  '网格工具：已回到「编辑顶点」': 'Mesh tool: back to "Edit vertices"',
  '已选中 {0} 根骨骼（主选中「{1}」；Shift / Cmd 点击可加选 / 减选）':
    '{0} bone(s) selected (primary "{1}"; Shift / Cmd click to add or remove)',
  '已取消骨骼选择': 'Bone selection cleared',
  '顶点 #{0}（{1} 个顶点）': 'Vertex #{0} ({1} vertices)',
  '选中骨骼「{0}」（骨骼体=旋转 / 原点圈=移动 / 末端方块=缩放）':
    'Selected bone "{0}" (body = rotate / origin ring = move / tip handle = scale)',
  '已取消选择': 'Selection cleared',
  'Alt+点击插入顶点：先切到网格工具（Pose 按 M / Animate 按 D）':
    'Alt+click to insert a vertex: switch to the mesh tool first (M in Pose / D in Animate)',
  'Alt+点击插入顶点：先在层级树里选中要编辑的网格附件':
    'Alt+click to insert a vertex: select the mesh attachment to edit in the hierarchy tree first',
  '权重刷目标骨骼：「{0}」——按住拖动刷权重（Alt=减少 / Shift=覆盖）':
    'Weight brush target bone: "{0}" — hold and drag to paint weights (Alt = subtract / Shift = replace)',
  '切到 Pose 状态才能把图片放进场景：插槽 / 附件属于绑定数据':
    'Switch to Pose mode to drop images into the scene: slots / attachments are binding data',
  '找不到图片「{0}」（可能已被移除）': 'Image "{0}" not found (it may have been removed)',
  '场景里还没有骨骼：先用「绑骨骼 (B)」画一根骨骼，再把图片拖进来':
    'The scene has no bones yet: draw one with "Bind bone (B)", then drag images in',
  '拖入 {0} 张图片创建插槽': 'Drag in {0} images to create slots',
  '拖入图片创建插槽': 'Drag in an image to create a slot',
  '无法用「{0}」创建插槽': 'Could not create a slot from "{0}"',
  '；另有 {0} 张图片已不存在，未创建': '; {0} more image(s) no longer exist and were skipped',
  '已创建插槽「{0}」：图片「{1}」作为 display 挂到骨骼「{2}」下':
    'Created slot "{0}": image "{1}" is attached under bone "{2}" as a display',
  '已创建 {0} 个插槽（{1}）挂到骨骼「{2}」下':
    'Created {0} slots ({1}) under bone "{2}"',

  // ── 属性面板（InspectorPanel） ─────────────────────────────────────
  '修改约束目标': 'Edit constraint target',
  '修改IK权重': 'Edit IK weight',
  '调整受约束骨骼顺序': 'Reorder constrained bones',
  '{0}约束 · {1}': '{0} constraint · {1}',
  '{0}约束': '{0} constraint',
  '启用': 'Enabled',
  '启停约束': 'Toggle constraint',
  '目标': 'Target',
  '（无）': '(none)',
  '在层级树里定位「{0}」': 'Locate "{0}" in the hierarchy tree',
  '还没有可定位的目标骨骼': 'No target bone to locate yet',
  '目标骨骼「{0}」不存在，IK 不会生效': 'Target bone "{0}" does not exist; IK will not take effect',
  '没有目标骨骼，IK 不会生效': 'No target bone; IK will not take effect',
  '受约束骨骼链是空的，IK 不会生效': 'The constrained bone chain is empty; IK will not take effect',
  '受约束骨骼链（': 'Constrained bone chain (',
  '链根 → 链尾，IK 按这个顺序驱动（单骨 = 让链尾指向目标，两骨及以上逐节弯曲）':
    'Chain root → chain tip; IK drives in this order (one bone = point the tip at the target; two or more bend joint by joint)',
  '按顺序排布': 'Arranged in order',
  '）': ')',
  ' · 物理约束仅保留数据，不参与求解': ' · physics constraints keep data only and are not solved',
  '上移（越靠前越接近链根）': 'Move up (the earlier, the closer to the chain root)',
  '下移（越靠后越接近链尾）': 'Move down (the later, the closer to the chain tip)',
  '从受约束骨骼链里移除（约束本身不受影响）':
    'Remove from the constrained bone chain (the constraint itself is unaffected)',
  '移除受约束骨骼': 'Remove constrained bone',
  '（选择骨骼加到链尾）': '(pick a bone to append to the chain)',
  '（没有可添加的骨骼）': '(no bone available to add)',
  '添加受约束骨骼': 'Add constrained bone',
  '「目标」和「添加骨骼」都能从层级树拖骨骼进来':
    'Both "Target" and "Add bone" accept bones dragged in from the hierarchy tree',
  'IK 参数': 'IK parameters',
  '弯曲': 'Bend',
  '正向 (+1)': 'Forward (+1)',
  '反向 (-1)': 'Reverse (-1)',
  '修改IK弯曲方向': 'Edit IK bend direction',
  '用骨长': 'Use bone length',
  '修改IK长度取法': 'Edit IK length mode',
  '变换混合': 'Transform mix',
  'X 位移': 'X translate',
  'Y 位移': 'Y translate',
  'X 缩放': 'X scale',
  'Y 缩放': 'Y scale',
  '修改变换约束': 'Edit transform constraint',
  '路径参数': 'Path parameters',
  '修改路径位置': 'Edit path position',
  '修改路径间距': 'Edit path spacing',
  '修改路径旋转混合': 'Edit path rotate mix',
  '修改路径位移混合': 'Edit path translate mix',
  '移除这条约束：本骨骼还原为普通骨骼；它在时间轴上的关键帧轨道一并删除':
    'Remove this constraint: this bone reverts to a normal bone and its timeline keyframe track is also deleted',
  '移除{0}约束': 'Remove {0} constraint',
  '已删除约束「{0}」': 'Deleted constraint "{0}"',
  '重命名{0}': 'Rename {0}',
  '「{0}」已重命名为「{1}」': '"{0}" renamed to "{1}"',
  '找不到图片「{0}」：它可能已被删除，先在「图片」下拉里换一张':
    'Image "{0}" not found: it may have been deleted; pick another from the "Images" dropdown first',
  '恢复附件尺寸': 'Restore attachment size',
  '已把「{0}」的尺寸恢复到图片大小（{1} × {2} px）':
    'Restored the size of "{0}" to the image size ({1} × {2} px)',
  'Add and Subtract（增加 / Alt 减少）': 'Add and Subtract (add / Alt to subtract)',
  'Grow and Shrink（只动已受影响的顶点）': 'Grow and Shrink (only affect already-influenced vertices)',
  'Smooth（朝邻居平均）': 'Smooth (average toward neighbors)',
  '（未选）': '(none selected)',

  // ── 权重刷的子工具（刷权重 / 框选顶点） ──
  '刷权重': 'Paint weights',
  '框选顶点': 'Box-select vertices',
  '刷权重（默认）：按住拖动按 Mode / Strength / Feather 刷；有选中顶点时只刷这些顶点':
    'Paint weights (default): hold and drag to paint with Mode / Strength / Feather; when vertices are selected only those are painted',
  '框选顶点：拖出矩形选中顶点（Shift 追加）；之后刷权重只影响这些顶点，点空白处取消选择':
    'Box-select vertices: drag a rectangle to select (Shift adds); painting then only affects these vertices — click empty space to clear',
  '权重刷：{0}': 'Weight brush: {0}',
  '框选顶点属于绑定编辑：切到 Pose 状态再用':
    'Box-selecting vertices edits the bind pose: switch to Pose mode first',
  '框选顶点：拖出矩形；松手后刷权重只影响这些顶点，点空白处取消选择':
    'Box select vertices: drag a rectangle; painting will then only affect these vertices — click empty space to clear',
  '框选顶点（Shift：加进当前选择）：拖出矩形；松手后刷权重只影响这些顶点，点空白处取消选择':
    'Box select vertices (Shift: add to current selection): drag a rectangle; painting will then only affect these vertices — click empty space to clear',
  '已取消顶点选择：之后刷权重又影响整块网格':
    'Vertex selection cleared: painting affects the whole mesh again',
  '框选：矩形里没有顶点（选择没有变化）': 'Box select: no vertices inside the rectangle (selection unchanged)',
  '已框选 {0} 个顶点（共 {1} 个）：之后只刷这些顶点的权重，点空白处取消选择':
    'Box-selected {0} vertices ({1} in total): painting now only affects these — click empty space to clear',
  '刷过的顶点权重归一到 1；关掉就只改目标骨骼，权重和可能不等于 1':
    'Normalize painted vertex weights to 1; when off, only the target bone changes and the weight sum may not equal 1',
  'Strength = 一笔能刷到的权重上限；Feather = 边缘衰减占笔刷半径的比例（0 = 硬边）；按住修饰键临时改方向：Alt=减少 / Shift=覆盖 / Ctrl=平滑 / Ctrl+Shift=生长':
    'Strength = the maximum weight one stroke can reach; Feather = share of the brush radius used to fade out (0 = hard edge); hold a modifier to change direction: Alt = subtract / Shift = replace / Ctrl = smooth / Ctrl+Shift = grow',
  // ── 权重修剪 ──
  '修剪权重': 'Prune weights',
  '修剪权重（{0} 骨）': 'Prune weights ({0} bones)',
  '上限': 'Max',
  '阈值': 'Threshold',
  '修剪：丢掉小于阈值的权重，并把每个顶点的影响骨骼数压到上限；有选中顶点时只处理选中的那些。移除的权重按比例分给剩下的骨骼':
    'Prune: drop weights below the threshold and cap the influences per vertex; when vertices are selected only those are processed. Removed weight is shared out to the remaining bones',
  '每顶点最多保留几根骨骼（1~4）：运行时与导出固定只有 4 槽，调小是给「骨骼越少越省」的管线留余量':
    'How many bones to keep per vertex (1–4): runtime and export only have 4 slots, so lowering it leaves headroom for pipelines that prefer fewer bones',
  '丢掉小于这个百分比的权重（0 = 只按上限截断）；每个顶点至少保留权重最大的一项':
    'Drop weights below this percentage (0 = only cap the influence count); the largest weight of each vertex is always kept',
  '导出/运行时每顶点只取 4 根骨骼：先在这里修剪，刷出来的百分比才和导出结果一致':
    'Runtime and export take only the top 4 bones per vertex: prune here first so the painted percentages match the export',
  '{0} 个顶点受超过 {1} 根骨骼影响：导出/运行时只保留权重最高的 {1} 根':
    '{0} vertices are influenced by more than {1} bones: export and runtime keep only the {1} heaviest',
  '一键修剪到 {0} 根': 'Prune to {0} bones',
  '只按上限修剪、不动阈值：直接把每顶点的影响骨骼数压到上限':
    'Prune to the cap only, ignoring the threshold: forces each vertex within the influence limit',
  '将移除 {0} 个骨骼影响，{1} 个顶点会被改写（点上面的按钮才生效）':
    'Will remove {0} bone influences and rewrite {1} vertices (nothing changes until you press the button)',
  '修剪权重改的是绑定姿态：请切到 Pose 状态': 'Pruning weights edits the bind pose: switch to Pose mode first',
  '已修剪 {0} 个顶点：丢掉 {1} 个骨骼影响，{2} 个顶点压到 {3} 根骨骼以内':
    'Pruned {0} vertices: dropped {1} bone influences, {2} vertices were capped to {3} bones',
  '已把 {0} 个顶点修剪到 {1} 根骨骼以内（丢掉 {2} 个骨骼影响）':
    'Pruned {0} vertices down to {1} bones (dropped {2} bone influences)',
  '没有顶点需要修剪：都在 {0} 根骨骼以内，也没有小于 {1}% 的权重':
    'Nothing to prune: every vertex is within {0} bones and no weight is below {1}%',
  '没有顶点需要修剪：受超过 {0} 根骨骼影响的顶点不在当前选择里':
    'Nothing to prune: the vertices influenced by more than {0} bones are not in the current selection',
  '选中的顶点不在这个网格上：请重新框选，或点空白取消选择':
    'The selected vertices are not on this mesh: box-select again, or click empty space to clear',
  '裁不了：{0} / {1} 不是网格附件': 'Cannot prune: {0} / {1} is not a mesh attachment',
  // ── 权重刷的子工具「直接拖动」 ──
  '直接拖动': 'Direct drag',
  '直接拖动：先在视口里点选 / 框选顶点，再按住上下拖动调整它们在这根骨骼上的权重（上=加 / 下=减）':
    'Direct drag: select vertices in the viewport, then drag up or down to adjust their weight for this bone (up = add / down = subtract)',
  '直接拖动属于绑定编辑：切到 Pose 状态再用': 'Direct drag edits the bind pose: switch to Pose mode first',
  '已取消顶点选择：再点选顶点后可上下拖动调权重':
    'Vertex selection cleared: pick vertices again, then drag up or down to adjust weights',
  '直接拖动：先在层级树里选一根骨骼，再上下拖动调整选中顶点的权重':
    'Direct drag: select a bone in the hierarchy first, then drag up or down to adjust the selected vertices',
  '直接拖动：先在视口里点选或框选要调的顶点': 'Direct drag: pick or box-select the vertices to adjust first',
  '直接拖动「{0}」的权重：按住上下拖（上=加 / 下=减），共 {1} 个顶点':
    'Direct drag for "{0}": hold and drag up or down (up = add / down = subtract), {1} vertices',
  '「{0}」的权重：{1}%（上下拖动调整；点空白取消选择）':
    'Weight for "{0}": {1}% (drag up or down to adjust; click empty space to clear)',
  '调整顶点权重': 'Adjust vertex weights',
  // ── 自动权重 ──
  '自动权重算法': 'Auto-weight algorithm',
  '热扩散（默认）': 'Heat diffusion (default)',
  '表面距离': 'Surface distance',
  '直线距离': 'Straight-line distance',
  '热扩散：沿网格表面平滑扩散，骨骼弯曲处也连续；最慢，网格太大时自动退回「表面距离」':
    'Heat diffusion: spreads smoothly across the mesh surface and stays continuous around bent bones; slowest, and large meshes fall back to "surface distance"',
  '表面距离：沿网格表面量距离再按 1/d 衰减分配，比热扩散快，骨骼弯曲处过渡会有突跳':
    'Surface distance: measures distance along the surface and allocates by a 1/d falloff; faster than heat diffusion, but the transition can jump around bent bones',
  '直线距离：按空间直线距离衰减，最快；手臂贴着身体这类贴身部件会串味，只作兜底':
    'Straight-line distance: falls off by straight-line distance in space, fastest; neighbouring parts such as an arm resting on the body may bleed into each other, so use it only as a fallback',
  '（网格较大，本次实际用表面距离计算）': ' (mesh is large, surface distance was used this time)',
  '已绑定「{0}」并自动算好 {1} 个顶点的权重；可继续点选其它骨骼':
    'Bound "{0}" and computed weights for {1} vertices; keep clicking other bones to bind more',
  '已按绑定骨骼重算选中的 {0} 个顶点': 'Recomputed weights for the {0} selected vertices',
  // ── 权重操作（交换 / 复制粘贴） ──
  '权重操作': 'Weight actions',
  '交换 A': 'Swap A',
  '交换 B': 'Swap B',
  '在选中顶点上交换这两根骨骼的权重；没选顶点时改整块网格':
    'Swap the weights of these two bones on the selected vertices; with nothing selected the whole mesh is changed',
  '交换这两根骨骼的权重': 'Swap these two bones',
  '复制选中顶点的权重（没选就整块网格），可粘到别的顶点或别的网格；目标网格没绑的骨骼会被丢掉':
    'Copy the weights of the selected vertices (whole mesh when nothing is selected); you can paste onto other vertices or meshes — bones not bound to the target are dropped',
  '复制顶点权重': 'Copy weights',
  '把剪贴板按顺序贴到选中顶点；数量不一致时只贴前面能对上的那些':
    'Paste the clipboard onto the selected vertices in order; when the counts differ only the first matching ones are pasted',
  '粘贴顶点权重': 'Paste weights',
  '剪贴板里有 {0} 个顶点的权重（不写进工程文件）':
    'Clipboard holds weights for {0} vertices (not saved into the project file)',
  '交换 / 粘贴都只改绑定姿态下的权重；复制的内容不写进工程文件':
    'Swap and paste only change the bind-pose weights; copied data is never written into the project file',
  '交换权重改的是绑定数据：请切到 Pose 状态': 'Swapping weights edits bind data: switch to Pose mode first',
  '先选两根不同的骨骼再交换': 'Pick two different bones before swapping',
  '交换骨骼权重': 'Swap bone weights',
  '已在 {0} 个顶点上交换「{1}」与「{2}」的权重': 'Swapped "{1}" and "{2}" weights on {0} vertices',
  '没有可交换的权重：「{0}」与「{1}」在这些顶点上没有区别':
    'Nothing to swap: "{0}" and "{1}" are identical on these vertices',
  '没有可交换的权重：两根骨骼都要在该网格的权重列表里，且至少一个顶点上两者权重不同':
    'Nothing to swap: both bones must be in the mesh\'s weight list and differ on at least one vertex',
  '已复制 {0} 个顶点的权重': 'Copied weights of {0} vertices',
  '没有可复制的顶点：先在视口里点选或框选': 'Nothing to copy: pick or box-select vertices in the viewport first',
  '粘贴权重改的是绑定数据：请切到 Pose 状态': 'Pasting weights edits bind data: switch to Pose mode first',
  '剪贴板是空的：先复制一批顶点的权重': 'Clipboard is empty: copy some vertex weights first',
  '已粘贴 {0} 个顶点的权重': 'Pasted weights onto {0} vertices',
  '粘贴没有改动任何顶点：骨骼名对不上，或权重本来就一样':
    'Paste changed nothing: the bone names do not match, or the weights were already the same',
  'vertices 里没有落在这个网格上的顶点下标': 'None of the indices in vertices belong to this mesh',
  '已交换 {0} 个顶点的「{1}」与「{2}」权重': 'Swapped "{1}" and "{2}" weights on {0} vertices',
  // ── 顶点选择的快捷键 ──
  '已选中「{0}」的全部 {1} 个顶点': 'Selected all {1} vertices of "{0}"',
  '整体染色': 'Global tint',
  '说明': 'Help',
  '整体染色（与插槽色、附件色相乘）；双击复位为白色':
    'Global tint (multiplies with slot and attachment colors); double-click to reset to white',
  '染色透明度': 'Tint opacity',
  '未选中对象': 'Nothing selected',
  '在层级树或视口中选中骨骼、插槽、附件或约束后，可在此编辑其属性。':
    'Select a bone, slot, attachment or constraint in the hierarchy tree or viewport to edit its properties here.',
  '骨骼不存在': 'Bone not found',
  '该骨骼可能已被删除，请重新选择。': 'This bone may have been deleted; select again.',
  '插槽不存在': 'Slot not found',
  '该插槽可能已被删除，请重新选择。': 'This slot may have been deleted; select again.',
  '约束不存在': 'Constraint not found',
  '该约束可能已被删除，请重新选择。': 'This constraint may have been deleted; select again.',
  '名称': 'Name',
  '父级': 'Parent',
  '（层级根骨骼）': '(hierarchy root bone)',
  '（未挂载）': '(unattached)',
  '修改骨骼父级': 'Edit bone parent',
  '层级根骨骼：其他骨骼都在它之下，它没有父级':
    'Hierarchy root bone: every other bone is under it, and it has no parent',
  '长度': 'Length',
  '修改骨骼长度': 'Edit bone length',
  '父级 / 长度属于绑定数据，切到 Pose 状态再改':
    'Parent / length are binding data; switch to Pose mode to edit',
  '动画变换 · {0}s（改动即打关键帧）': 'Animated transform · {0}s (edits key the frame)',
  '局部变换（Setup）': 'Local transform (Setup)',
  '{0}（{1}s 打关键帧）': '{0} ({1}s keyframe)',
  '修改骨骼{0}': 'Edit bone {0}',
  '继承': 'Inherit',
  '继承旋转': 'Inherit rotation',
  '修改继承旋转': 'Edit inherit rotation',
  '继承缩放': 'Inherit scale',
  '修改继承缩放': 'Edit inherit scale',
  '显示色': 'Display color',
  '修改骨骼颜色': 'Edit bone color',
  '画法': 'Style',
  '空心（默认实心）': 'Hollow (solid by default)',
  '修改骨骼画法': 'Edit bone style',
  '修改插槽骨骼': 'Edit slot bone',
  '混合': 'Blend',
  '修改混合模式': 'Edit blend mode',
  '层序': 'Layer order',
  '修改插槽层序': 'Edit slot layer order',
  '修改插槽颜色': 'Edit slot color',
  '显示（关键帧）': 'Display (keyframe)',
  '（不显示）': '(not shown)',
  '关键帧：切换显示': 'Keyframe: toggle display',
  '已在 {0}s 打关键帧：插槽「{1}」显示「{2}」': 'Keyed at {0}s: slot "{1}" shows "{2}"',
  '已在 {0}s 打关键帧：插槽「{1}」不显示': 'Keyed at {0}s: slot "{1}" shows nothing',
  '修改 setup 附件': 'Edit setup attachment',
  '可见（关键帧）': 'Visible (keyframe)',
  '可见': 'Visible',
  '关键帧：切换可见性': 'Keyframe: toggle visibility',
  '修改插槽可见性': 'Edit slot visibility',
  '附件': 'Attachment',
  '附件 · {0}': 'Attachment · {0}',
  '（纯色）': '(solid color)',
  '修改附件图片': 'Edit attachment image',
  '修改附件位置': 'Edit attachment position',
  '修改附件旋转': 'Edit attachment rotation',
  '修改附件缩放': 'Edit attachment scale',
  '尺寸': 'Size',
  '修改附件尺寸': 'Edit attachment size',
  '恢复到图片大小（按图片像素 ÷ PPU 折算，与拖图创建时一致）':
    'Restore to image size (image pixels ÷ PPU, same as when created by dragging)',
  '原图（含裁剪留白）：{0} × {1} px —— 选中轮廓/手柄按它走，渲染仍只有上面「尺寸」那块':
    'Source image (including trimmed padding): {0} × {1} px — the selection outline / handles follow it, but rendering still uses only the "Size" above',
  '修改附件颜色': 'Edit attachment color',
  '骨内FFD': 'Bone-space FFD',
  '偏移已按骨骼 bindpose 换算过；正常保持关闭':
    'Offsets are converted by the bone bindpose; keep it off normally',
  '修改FFD空间': 'Edit FFD space',
  '顶点 {0} · 三角面 {1} · 加权 {2}': 'Vertices {0} · Triangles {1} · Weighted {2}',
  '用网格 / FFD 工具在网格内 Alt+点击插入顶点，选中顶点后可在下面删除':
    'With the mesh / FFD tool, Alt-click inside the mesh to insert a vertex; select a vertex to delete it below',
  '权重骨骼列表': 'Weight bone list',
  '结束绑定：已点选的骨骼会保留在列表里': 'Finish binding: the bones already picked stay in the list',
  '进入绑定骨骼状态后，在视口里点选骨骼加入列表（可以连续点选多根），右键或再点这个按钮结束':
    'After entering bone-binding mode, click bones in the viewport to add them to the list (keep clicking for several), then right-click or press this button again to finish',
  '绑定骨骼：在视口里点选骨骼加入列表（可连续多根），完成后右键或再点这个按钮':
    'Bind bones: click bones in the viewport to add them to the list (several in a row), then right-click or press this button again to finish',
  '完成绑定骨骼': 'Finish binding bones',
  '添加绑定骨骼': 'Add weight bone',
  '按列表里的骨骼重算所有顶点权重：顶点离哪根骨骼近，它在那根骨骼上的权重就高（列表外的骨骼不参与）':
    'Recompute all vertex weights from the listed bones: the closer a vertex is to a bone, the higher its weight on that bone (bones outside the list are not used)',
  '自动计算权重写的是绑定姿态：请切到 Pose 状态': 'Auto weights write the bind pose: switch to Pose mode',
  '已按绑定骨骼重算 {0} 个顶点的权重': 'Recomputed the weights of {0} vertex/vertices from the weight bones',
  '权重没有变化：列表里只有 {0} 根骨骼，结果就是全部 100%。先点「添加绑定骨骼」把相关骨骼加进来再算':
    'No change: the list has only {0} bone(s), so every vertex is 100%. Click "Add weight bone" to add the relevant bones, then recompute',
  '权重没有变化：当前权重已是最新结果': 'No change: the current weights are already up to date',
  '自动计算权重': 'Auto weights',
  '还没有绑定骨骼：点上面的按钮进入绑定状态，再在视口里点选骨骼（可连续点选多根）':
    'No weight bones yet: click the button above to enter binding mode, then click bones in the viewport (several in a row)',
  '这个网格只绑了一根骨骼：它在每个顶点上必然是 100%':
    'This mesh has only one bound bone: it is necessarily 100% on every vertex',
  '「{0}」在顶点 #{1} 上的权重（其余骨骼按比例分享剩余部分）':
    'Weight of "{0}" on vertex #{1} (other bones share the remainder proportionally)',
  '修改顶点权重': 'Edit vertex weight',
  '权重百分比：失焦 / 回车生效；中键左右拖动可调':
    'Weight percentage: applies on blur / Enter; middle-drag left/right to scrub',
  '从列表移除，并清掉该骨骼在所有顶点上的权重':
    'Remove from the list and clear the weights of this bone on all vertices',
  '移除权重骨骼': 'Remove weight bone',
  '已移除权重骨骼「{0}」': 'Removed weight bone "{0}"',
  '「{0}」不在权重列表里': '"{0}" is not in the weight list',
  '先在视口里点选一个顶点（网格 / FFD 工具）': 'First click a vertex in the viewport (mesh / FFD tool)',
  '删除选中的顶点，并用它的邻居重新三角化补洞':
    'Delete the selected vertex and re-triangulate using its neighbors to fill the hole',
  '删除网格顶点': 'Delete mesh vertex',
  '删除选中顶点': 'Delete selected vertex',
  '清空网格顶点，退回成一张图片显示（由 Region 转来的会精确还原原尺寸与 UV）':
    'Clear the mesh vertices and fall back to a single image (ones converted from a Region restore their exact size and UVs)',
  '还原为 Region': 'Convert back to Region',
  '已把「{0}」还原为 Region（顶点与 FFD 帧已一并清空）':
    'Converted "{0}" back to Region (vertices and FFD frames were cleared too)',
  '还原失败（附件类型不是网格）': 'Convert failed (the attachment is not a mesh)',
  '删除附件': 'Delete attachment',
  '已删除附件「{0}」': 'Deleted attachment "{0}"',
  '网格 / FFD': 'Mesh / FFD',
  '密度': 'Density',
  '生成 / 重设网格时的栅格细分（{0}×{1}）：越大顶点越密、越贴合形状':
    'Grid subdivision when generating / resetting a mesh ({0}×{1}): higher means denser vertices and a closer fit to the shape',
  '把选中的图片（Region）按密度切分成规则栅格网格并三角化，之后可用权重刷 / 顶点工具编辑':
    'Split the selected image (Region) into a regular grid mesh by density and triangulate it; afterwards edit it with the weight brush / vertex tools',
  '转为网格（{0}×{1}）': 'Convert to mesh ({0}×{1})',
  '沿图片不透明像素的轮廓生成贴合网格（透明区域不占三角形）；密度控制顶点数量级，也可用来重设手动编辑过的网格':
    'Generate a fitted mesh along the outline of the opaque pixels of the image (transparent areas take no triangles); density controls the vertex count and can also reset a hand-edited mesh',
  '自动生成网格': 'Auto-generate mesh',
  '修改约束顺序': 'Edit constraint order',
  '顺序': 'Order',

  // ── 字段组件（fields.tsx / ColorPickerPopover.tsx） ──────────────────
  '调整数值': 'Adjust value',
  '失焦 / 回车生效；中键左右拖动可调': 'Applies on blur / Enter; middle-drag left/right to scrub',
  '透明度百分比（0–100）；失焦 / 回车生效，中键左右拖动可调':
    'Opacity percentage (0–100); applies on blur / Enter, middle-drag left/right to scrub',
  '颜色 #RRGGBBAA（回车 / 失焦生效）': 'Color #RRGGBBAA (applies on Enter / blur)',

  // ── 骨架嵌套（nesting） ─────────────────────────────────────────────
  子骨架: 'Sub-armature',
  嵌套骨架: 'Nested armature',
  '骨架 {0}': 'Armature {0}',
  '显示中 · 骨架 {0}': 'Shown · armature {0}',
  引用骨架: 'Armature',
  默认动画: 'Default animation',
  播放次数: 'Play times',
  起始偏移: 'Start offset',
  倍速: 'Speed',
  次数: 'Times',
  偏移: 'Offset',
  '（未引用）': '(none)',
  '不能把骨架拖到它自己的层级里': "You can't drop an armature into its own hierarchy",
  '{0}（当前骨架；双击重命名；右键重命名 / 删除）':
    '{0} (current armature; double-click to rename; right-click to rename / delete)',
  '{0}（拖到另一个骨架的插槽行 = 嵌套；双击重命名；右键重命名 / 删除）':
    '{0} (drag onto a slot row of another armature to nest it; double-click to rename; right-click to rename / delete)',
  '嵌套骨架「{0}」': 'Nest armature "{0}"',
  '骨架只能拖到插槽上（对着插槽行中间松手）': 'Armatures can only be dropped on a slot (release over the middle of the row)',
  '在当前时间打一帧（用嵌套骨架的 setup 值）':
    'Key at the current time (using the nested armature setup values)',
  '{0} · 子骨架 · 控制嵌套骨架播哪个动画；点右侧闪电图标在当前位置打一帧':
    '{0} · Sub-armature · controls which animation the nested armature plays; click the bolt icon to key at the playhead',
  '修改嵌套骨架': 'Edit nested armature',
  '修改子骨架默认动画': 'Edit sub-armature default animation',
  '修改子骨架播放次数': 'Edit sub-armature play times',
  '修改子骨架起始偏移': 'Edit sub-armature start offset',
  '修改子骨架倍速': 'Edit sub-armature speed',
  '修改子骨架动画': 'Edit sub-armature animation',
  '删除整条通道（{0} 个关键帧）': 'Delete this channel ({0} keys)',
  '删除「{0}」的全部通道（{1} 个关键帧）': 'Delete all channels of "{0}" ({1} keys)',
  '已删除通道「{0}」（{1} 个关键帧）': 'Deleted channel "{0}" ({1} keys)',
  '通道「{0}」已经没有关键帧了': 'Channel "{0}" has no keys any more',
  '通道「{0}」没有可删除的关键帧': 'Channel "{0}" has no keys to delete',
  '清理帧：清掉当前动画里没有关键帧的通道':
    'Clean keys: remove channels that have no keys in this animation',
  '已清理 {0} 条没有关键帧的通道': 'Removed {0} channel(s) with no keys',
  '当前动画没有空通道需要清理': 'No empty channels to clean in this animation',
  子骨架动画: 'Sub-armature animation',
  '打子骨架控制帧': 'Key sub-armature',
  '骨架名不能为空': 'Armature name cannot be empty',
  '父骨架「{0}」不存在': 'Parent armature "{0}" does not exist',
  '子骨架「{0}」不存在': 'Child armature "{0}" does not exist',
  '会形成循环引用：{0} → … → {1} → {0}': 'This creates a cycle: {0} → … → {1} → {0}',
  '嵌套层数超过上限（{0} 层）': 'Nesting depth exceeds the limit ({0} levels)',
  '（setup 姿态）': '(setup pose)',
  次: 'x',
  秒: 's',
  '插槽「{0}」的「{1}」引用了自身骨架，已断开':
    'Slot "{0}" display "{1}" referenced its own armature; the reference was cleared',
  '骨架「{0}」的插槽「{1}」引用了不存在的骨架「{2}」，已断开':
    'Armature "{0}" slot "{1}" referenced a missing armature "{2}"; the reference was cleared',
  '骨架嵌套存在循环引用（{0}），已断开「{1}」里的引用':
    'Armature nesting has a cycle ({0}); the reference in "{1}" was cleared',
  '骨架「{0}」的嵌套层数超过上限，相关引用已断开':
    'Armature "{0}" nesting depth exceeds the limit; related references were cleared',
  '包含嵌套子骨架：{0}（已一并导出；运行时按 ske 的 nested 清单加载）':
    'Includes nested sub-armatures: {0} (exported together; the runtime loads them from the ske "nested" list)',
  '骨架「{0}」有 {1} 个嵌套骨架 display：Spine 不支持骨架嵌套，已跳过这些 display':
    'Armature "{0}" has {1} nested-armature display(s): Spine cannot express armature nesting, so they were skipped',
  '编辑网格顶点 / 三角面；Shift+点击多选顶点（拖动整组移动）；网格内 Alt+点击插入顶点':
    'Edit mesh vertices / triangles; Shift+click to multi-select vertices (drag to move them together); Alt+click inside the mesh to insert a vertex',
  '拖顶点写当前时间点的 FFD 帧；Shift+点击多选顶点（拖动整组移动）；插入 / 删除顶点需切到 Pose':
    'Drag vertices to key FFD frames at the current time; Shift+click to multi-select (drag to move them together); switch to Pose to insert / delete vertices',
  '{0}（拖到骨骼行 / 插槽行 / 视口 = 嵌套；双击重命名；右键重命名 / 删除）':
    '{0} (drop on a bone row / slot row / the viewport to nest it; double-click to rename; right-click to rename / delete)',
  '骨架只能拖到骨骼或插槽上（拖到骨骼行 = 自动新建插槽）':
    'Armatures can only be dropped on a bone or a slot (dropping on a bone creates a slot automatically)',
  '已在骨骼「{0}」下新建插槽「{1}」，并挂上嵌套骨架「{2}」':
    'Created slot "{1}" under bone "{0}" and nested armature "{2}" into it',
  '已把骨架「{0}」挂到插槽「{1}」': 'Nested armature "{0}" into slot "{1}"',
  '切到 Pose 状态才能把骨架放进场景：插槽 / 附件属于绑定数据':
    'Switch to Pose to drop an armature into the scene: slots / attachments are bind-pose data',
  '场景里还没有骨骼：先用「绑骨骼 (B)」画一根骨骼，再把骨架拖进来':
    'The scene has no bones yet: draw one with the Bone tool (B) before dropping an armature',
  '无法把骨架「{0}」放进场景': 'Could not place armature "{0}" into the scene',
  '已取消选择（左键在空白处拖动可框选顶点）':
    'Selection cleared (left-drag on empty space to box-select vertices)',
  '.hao2d 的 iks 段只能表达 IK 约束：已丢弃 {0} 个非 IK 约束（{1}），Unity 侧不会有这些约束': '.hao2d iks can only express IK constraints: dropped {0} non-IK constraint(s) ({1}); they will not exist on the Unity side',
  '该资源 runtimeIK = false：Unity 运行期不会再解算 IK（IK 已烘焙进骨骼轨道）': 'This asset has runtimeIK = false: the Unity runtime will not solve IK (IK is already baked into bone tracks)',
  '包含嵌套骨架：{0}。Unity 侧需要把它们的 .hao2d 一起导出到同一目录（导入器按 armatureName 自动关联；缺文件时该 display 不渲染）': 'Contains nested sub-armatures: {0}. Export their .hao2d files into the same folder for Unity (the importer resolves nestedAssets by armatureName; without the file that display will not render)',
  '有 {0} 个插槽被眼睛隐藏（{1}）：.hao2d 二进制不携带该状态，Unity 侧这些插槽仍会显示': '{0} slot(s) are hidden with the eye toggle ({1}): the .hao2d binary does not carry that state, so they will still show on the Unity side',
  '存在「加权网格 + 骨内 FFD」的组合：Unity 端 Hao2D 运行时会跳过该 FFD，编辑器会正常应用': 'Found weighted meshes combined with in-bone FFD: the Unity-side Hao2D runtime skips that FFD, while the editor applies it',
  '动画包含非 IK 约束的关键帧轨道，这些轨道无法写入 .hao2d': 'Some animations have keyframe tracks for non-IK constraints; those tracks cannot be written to .hao2d',
  '约束关键帧会写入 iks 段（仅 mix 生效），其余约束参数不会被导出': 'Constraint keyframes are written to the iks section (only mix takes effect); other constraint parameters are not exported',
  '存在插槽可见性轨道：Unity 端 Hao2D 运行时不采样该轨道（编辑器会采样）': 'Found slot visibility tracks: the Unity-side Hao2D runtime does not sample them (the editor does)',
  '图集页「{0}」缺少尺寸信息，按 1×1 记录（原图仍然整页复制）': 'Atlas page "{0}" has no size info; recorded as 1×1 (the source image is still copied whole)',
  '图片「{0}」缺少尺寸信息，导出时按 1×1 占位处理': 'Image "{0}" has no size info; exported as a 1×1 placeholder',
  '{0} 张已经是图集的页按原图复制，不参与「缩放」': '{0} page(s) are already atlases and are copied as-is, not affected by Scale',
  '图片「{0}」超过单页最大尺寸 {1}px，未被打包（导出后该附件会缺图）': 'Image "{0}" exceeds the max page size {1}px and was not packed (that attachment will be missing after export)',
  '骨架「{0}」引用了工程里不存在的骨架「{1}」，导出时会是一个空 display': 'Armature "{0}" references a missing armature "{1}"; it will be an empty display after export',
  '本次导出的骨架没有使用任何图片，导出的图集将为空（角色会以纯色块渲染）': 'The exported armature(s) use no images, so the atlas will be empty (characters render as solid blocks)',
  '当前皮肤：{0}（作为叠加皮肤导出：基底 default + {0}；运行期仍可切换）': 'Current skin: {0} (exported as an overlay skin: base default + {0}; still switchable at runtime)',
  '图集页 {0} 读不出内容（源图缺失或无法读取）': 'Atlas page {0} could not be read (source image missing or unreadable)',
  '图集页 {0} 读不出内容（源图缺失或无法读取），对应的材质也未生成': 'Atlas page {0} could not be read (source image missing or unreadable); its material was not generated either',
  '区域 {0} 被多个附件以不同裁剪引用，已按原样写出（不做裁剪换算）': 'Region {0} is referenced by multiple attachments with different cropping; written as-is (no crop conversion)',
  '存在重名骨骼「{0}」，仅保留第一个': 'Duplicate bone name "{0}"; only the first one is kept',
  '骨骼「{0}」的父链存在环，已按原顺序处理': 'Bone "{0}" has a cycle in its parent chain; processed in original order',
  '骨骼「{0}」的父骨骼「{1}」不存在，已作为根骨骼': 'Bone "{0}" references a missing parent "{1}"; treated as a root bone',
  '插槽「{0}」挂载的骨骼「{1}」不存在，已挂到根骨骼': 'Slot "{0}" references a missing bone "{1}"; attached to the root bone',
  '遮罩「{0}」的结束插槽「{1}」不存在，已改为裁到末尾': 'Clipping attachment "{0}" has a missing end slot "{1}"; clipping extended to the end',
  '遮罩「{0}」少于 3 个控制点，不会生效': 'Clipping attachment "{0}" has fewer than 3 control points and will not take effect',
  '约束「{0}」引用了不存在的骨骼，已忽略': 'Constraint "{0}" references missing bones and was ignored',
  '约束「{0}」没有有效骨骼链，已跳过': 'Constraint "{0}" has no valid bone chain and was skipped',
  'IK 约束「{0}」的目标骨骼不存在，不会生效': 'IK constraint "{0}" targets a missing bone and will not take effect',
  'IK 约束「{0}」没有目标骨骼，不会生效': 'IK constraint "{0}" has no target bone and will not take effect',
  '动画「{0}」的骨骼轨道「{1}」不存在，已忽略': 'Animation "{0}" has a bone track "{1}" for a missing bone; ignored',
  '动画「{0}」的插槽轨道「{1}」不存在，已忽略': 'Animation "{0}" has a slot track "{1}" for a missing slot; ignored',
  '动画「{0}」的 FFD 轨道「{1}」不存在，已忽略': 'Animation "{0}" has an FFD track "{1}" for a missing slot; ignored',
  '动画「{0}」的约束轨道「{1}」不存在，已忽略': 'Animation "{0}" has a constraint track "{1}" for a missing constraint; ignored',
  '网格「{0}」有顶点的 bindpose 退化，这部分 FFD 偏移按原值导出': 'Mesh "{0}" has degenerate bindposes at some vertices; those FFD offsets are exported as-is',
  '插槽「{0}」使用了已移除的混合模式 Mask，已迁移为 Normal；遮罩请改用遮罩附件': 'Slot "{0}" used the removed Mask blend mode; migrated to Normal. Use a clipping attachment for masks',
  '工程文件内容不是对象，已创建空工程': 'Project file is not an object; created an empty project',
  '工程文件版本 {0} 高于当前编辑器支持的 {1}，可能丢失部分数据': 'Project version {0} is newer than the supported {1}; some data may be lost',
  '工程缺少皮肤，已补一个空的默认皮肤': 'Project has no skins; added an empty default skin',
  '动画包含 iks 轨道但资源没有 IK 约束，这些轨道会被忽略': 'Animation contains iks tracks but the asset has no IK constraints; those tracks are ignored',
  '插槽「{0}」使用了已移除的混合模式 Mask，已迁移为 Normal': 'Slot "{0}" used the removed Mask blend mode; migrated to Normal',
  '图片「{0}」尺寸读取失败，可能不是有效的图片文件': 'Could not read the size of image "{0}"; it may not be a valid image file',
  '图片名「{0}」重复，已重命名为「{1}」': 'Duplicate image name "{0}"; renamed to "{1}"',
  '骨骼「{0}」父链过深或存在环，已截断': 'Bone "{0}" has a too-deep parent chain or a cycle; truncated',
  '插槽「{0}」的混合模式 mask 不受支持，已按 Normal 导入（遮罩请用 clipping 附件）': 'Slot "{0}" uses the unsupported mask blend mode; imported as Normal (use a clipping attachment for masks)',
  '附件的图集区域「{0}」不存在，贴图可能显示异常': 'Atlas region "{0}" for this attachment does not exist; textures may render incorrectly',
  'linkedmesh「{0}」的源网格在另一个槽位（Spine 4.x 的 slot 字段），当前只支持同槽位查找': 'The source mesh of linkedmesh "{0}" lives in another slot (Spine 4.x "slot" field); only same-slot lookup is supported for now',
  '官方运行库烘焙失败，动画改用内置解析（老版本格式常见：3.3 及更早；缓动 / IK 可能与官方有差异）': 'Official runtime baking failed; animations fall back to the built-in parser (common with old formats 3.3 and earlier; easing / IK may differ from the official runtime)',
  'IK「{0}」的目标或骨骼链无效，已跳过': 'IK "{0}" has an invalid target or bone chain; skipped',
  '变换约束「{0}」的目标或骨骼链无效，已跳过': 'Transform constraint "{0}" has an invalid target or bone chain; skipped',
  '路径约束「{0}」不支持编辑，求解结果已烘进骨骼姿态':
    'Path constraint "{0}" is not editable; its solved result is baked into the bone pose',
  '图集区域「{0}」出现在任何图集页之前，已忽略': 'Atlas region "{0}" appears before any atlas page; ignored',
  '图集页「{0}」的 size 无法解析：{1}': 'Could not parse the size of atlas page "{0}": {1}',
  '图集中没有解析出任何区域': 'No regions were parsed from the atlas',
  '动画「{0}」的 IK 轨道「{1}」不存在，已忽略': 'Animation "{0}" has an IK track "{1}" for a missing IK; ignored',
  '插槽「{0}」的混合模式 5（原 Mask）不受支持，已按 Normal 导入': 'Slot "{0}" uses blend mode 5 (formerly Mask), which is unsupported; imported as Normal',
  '嵌套骨架「{0}」引用的 armature 在文件里不存在，已留空': 'Nested armature "{0}" references an armature missing from the file; left empty',
  '附件「{0}」的图集区域不存在': 'Atlas region for attachment "{0}" does not exist',
  'DragonBones 数据里没有 armature 段': 'DragonBones data has no armature section',
  'armature 名「{0}」重复：第 {1} 个改名为「{2}」，其嵌套引用仍指向「{3}」': 'Duplicate armature name "{0}": the {1} one was renamed to "{2}"; its nested references still point to "{3}"',
  '骨架「{0}」的默认动画「{1}」不存在，已忽略': 'Armature "{0}" has a missing default animation "{1}"; ignored',
  '图片「{0}」源文件读不到，未复制到 {1}/': 'Could not read the source of image "{0}"; not copied to {1}/',
  '复制图片到 {0}/ 失败：{1}': 'Failed to copy images into {0}/: {1}',
  '合并 {0} 张图集页': 'Merged {0} atlas page(s)',
  '动画「{0}」插槽「{1}」的 actions 里没有 gotoAndPlay / gotoAndStop，已忽略': 'Animation "{0}" slot "{1}" has actions without gotoAndPlay / gotoAndStop; ignored',

  // —— 工程保存 / 打开 / 导入的提示（此前是硬编码中文）——
  '保存到（内存路径）': 'Save to (in-memory path)',
  '已新建项目（含根骨骼 root）': 'New project created (with root bone)',
  '请先选择保存位置': 'Choose a save location first',
  '已新建项目「{0}」：{1}': 'Created project "{0}": {1}',
  '已取消': 'Cancelled',
  '无法读取工程文件：{0}': 'Cannot read project file: {0}',
  '工程文件解析失败：{0}': 'Failed to parse project file: {0}',
  '（{0} 个骨架）': ' ({0} skeletons)',
  '已打开 {0}{1}': 'Opened {0}{1}',
  '{0} 张图片已复制到 {1}/': '{0} image(s) copied to {1}/',
  '{0} 张图片已在工程内': '{0} image(s) already inside the project',
  '已保存到 {0}': 'Saved to {0}',
  '正在打开工程…': 'Opening project…',
  '（后缀已升级为 .{0}）': ' (extension upgraded to .{0})',
  '（{0}）': ' ({0})',
  '，': ', ',
  '；{0}': '; {0}',
  'Spine 骨骼 JSON': 'Spine skeleton JSON',
  'DragonBones 骨骼 JSON': 'DragonBones skeleton JSON',
  '无法读取 {0}': 'Cannot read {0}',
  '同目录下没有找到 .atlas 图集文件：{0}': 'No .atlas file found next to it: {0}',
  '同目录下没有找到图集（texture_*.json）：{0}': 'No texture atlas (texture_*.json) found next to it: {0}',
  '已导入 Spine：{0} 骨骼 / {1} 插槽 / {2} 动画': 'Imported Spine: {0} bones / {1} slots / {2} animations',
  '不是 DragonBones 骨骼文件（检测到 {0}）': 'Not a DragonBones skeleton file (detected {0})',
  '{0} 个骨架（{1}），当前编辑「{2}」': '{0} skeletons ({1}), now editing "{2}"',
  '已导入 DragonBones：{0} / {1} 骨骼 / {2} 插槽 / {3} 动画':
    'Imported DragonBones: {0} / {1} bones / {2} slots / {3} animations',
  '图片 / PSD': 'Images / PSD',
  '（选了 {0} 个 PSD，已打开第一个的导入窗口）':
    ' ({0} PSDs selected; the first one is open in the import dialog)',
  '（PSD 已打开导入窗口，勾选要导入的图层）': ' (PSD import dialog is open; pick the layers to import)',
  'PSD 已打开导入窗口，勾选要导入的图层': 'PSD import dialog is open; pick the layers to import',
  '已导入 {0} 张图片': 'Imported {0} image(s)',
  '没有新增图片（可能已存在）': 'No new images (they may already exist)',
  '拖入的文件夹里没有可导入的图片（支持 png / jpg / webp / gif / bmp / psd）':
    'The dropped folder has no importable images (png / jpg / webp / gif / bmp / psd)',
  '{0}（文件夹里找到 {1} 张图片）': '{0} ({1} image(s) found in the folder)',
  '已导入 Spine（拖入）：{0} 骨骼 / {1} 动画': 'Imported Spine (dropped): {0} bones / {1} animations',
  '请同时拖入同目录的 .atlas 图集文件（或使用「导入 Spine」菜单）':
    'Also drop the .atlas file from the same folder (or use File > Import Spine)',
  '拖入的内容里没有可导入的图片（支持 png / jpg / webp / gif / bmp；文件夹会递归查找）':
    'Nothing importable was dropped (png / jpg / webp / gif / bmp; folders are scanned recursively)',

  // —— 补齐此前遗漏的界面文案 ——
  '修改遮罩结束插槽': 'Change mask end slot',
  '修改遮罩反向': 'Toggle mask inverted',
  '修改遮罩凸形': 'Toggle mask convex',
  'Animate 态用顶点工具（D）拖这些控制点写 FFD 关键帧':
    'In Animate mode, drag these control points with the vertex tool (D) to key FFD',
  '遮罩工具：点边线插入点；拖点移动；Delete 删除；点空白取消选中':
    'Mask tool: click an edge to insert a point, drag to move, Delete to remove, click empty space to deselect',
  '切到 Pose 状态才能把附件转为遮罩': 'Switch to Pose mode to convert the attachment into a mask',
  '已把「{0}」转为遮罩并切换到遮罩工具：点边线插点、拖点调整、Delete 删除':
    'Converted "{0}" to a mask and switched to the mask tool: click edges to insert points, drag to adjust, Delete to remove',
  '转换失败：加权网格暂不支持，请先解除权重或手工绘制遮罩':
    'Conversion failed: weighted meshes are not supported yet; unrig the weights or draw the mask manually',
  '左右拖动调整「轨道 / 对象」列的宽度': 'Drag to resize the "Track / Object" column',
  '插槽「{0}」已经在这个位置': 'Slot "{0}" is already here',
  '找不到插槽「{0}」': 'Slot "{0}" not found',
  '插槽「{0}」已移到「{1}」{2}': 'Moved slot "{0}" {2} "{1}"',
  '上方': 'above',
  '下方': 'below',
  '插槽只能放到骨骼或另一条插槽旁边': 'Slots can only be dropped next to a bone or another slot',
  '显示中 · 遮罩': 'Visible · Mask',
  '骨骼「{0}」已挂到根骨骼「{1}」下，并排到骨骼列表末尾（骨骼顺序不影响插槽绘制顺序）':
    'Bone "{0}" parented to root bone "{1}" and moved to the end of the bone list (bone order does not affect slot draw order)',
  '骨骼「{0}」已经在骨骼列表末尾；骨骼不能排到插槽行之间（插槽绘制顺序请拖 slot 行）':
    'Bone "{0}" is already at the end of the bone list; bones cannot be placed between slot rows (drag slot rows to reorder draw order)',
  '插槽「{0}」已移到最底层（root 下）': 'Slot "{0}" moved to the bottom (under root)',
  '放到最底层': 'Move to bottom',

  // —— 打帧 / 删帧 / 清理帧的状态栏提示 ——
  '工程里还没有动画：先在时间轴点「+ 动画」建一个，再打关键帧':
    'This project has no animations yet: create one from the timeline ("+ Animation") and then key',
  '视口尚未就绪': 'Viewport is not ready yet',
  '没有可打关键帧的骨架': 'No skeleton available for keying',
  '没有可打关键帧的目标': 'Nothing to key on the selected object',
  '已在 {0}s 为「{1}」打关键帧': 'Keyed "{1}" at {0}s',
  '已在 {0}s 为选中对象打关键帧': 'Keyed the selection at {0}s',
  '当前对象没有可打关键帧的数据（FFD 需要先编辑过顶点）':
    'The current object has no keyable data (FFD needs edited vertices first)',
  '当前皮肤里没有「{0}」': 'Attachment "{0}" is not in the current skin',
  '已在 {0}s 打「{1}」的显示帧 → 「{2}」': 'Keyed display of "{1}" at {0}s → "{2}"',
  '已在 {0}s 打「{1}」的显示帧 → 不显示': 'Keyed display of "{1}" at {0}s → hidden',
  '插槽「{0}」上没有嵌套骨架': 'Slot "{0}" has no nested armature',
  '已在 {0}s 打「{1}」的子骨架帧 → 「{2}」': 'Keyed sub-armature of "{1}" at {0}s → "{2}"',
  '已在 {0}s 打「{1}」的子骨架帧（setup 姿态）':
    'Keyed sub-armature of "{1}" at {0}s (setup pose)',
  '找不到动画「{0}」': 'Animation "{0}" not found',
  '已在 {0}s 添加事件帧「{1}」（在视口下方值栏改名 / 设参数）':
    'Added event key "{1}" at {0}s (rename / set params in the value bar below the viewport)',
  '{0}s 已有事件帧「{1}」：同一时间点只能有一个事件帧，已选中它（可直接改名 / 改参数）':
    'An event key "{1}" already exists at {0}s: only one event key is allowed per time point (selected it — rename / set params directly)',
  '请先选中骨骼、插槽、网格附件或约束': 'Select a bone, slot, mesh attachment or constraint first',
  '已在 {0}s 为{1}打关键帧': 'Keyed {1} at {0}s',
  '已在 {0}s 打了 {1} 处关键帧': 'Keyed {1} properties at {0}s',
  '已删除 {0} 个关键帧': 'Removed {0} keyframe(s)',
  '先在时间轴上点选一条通道，再按 Delete 删除它':
    'Click a channel in the timeline first, then press Delete to remove it',
  '已在 {0}s 打「{1}」关键帧': 'Keyed "{1}" at {0}s',
  '事件 {0}': 'Event {0}',
  '选择文件': 'Choose a file',
  '预览服务未就绪：请完全退出并重新启动编辑器（主进程还是旧版本）':
    'Preview service is not ready: fully quit and restart the editor (the main process is still an old build)',
  '命令服务未就绪：请完全退出并重新启动编辑器（主进程还是旧版本）':
    'Command service is not ready: fully quit and restart the editor (the main process is still an old build)',
  '浏览器模式没有本地预览服务，请在桌面版里使用':
    'Browser mode has no local preview service; use the desktop app',
  '浏览器模式没有命令服务，请在桌面版里使用':
    'Browser mode has no command service; use the desktop app',
  '骨架「{0}」正在被引用，先删除这些嵌套 display：{1}':
    'Armature "{0}" is still referenced; remove these nested displays first: {1}',
  '已存在名为「{0}」的骨架，请换一个名字': 'An armature named "{0}" already exists; pick another name',
  '已在 {0}s 写入「{1}」的层级关键帧': 'Keyed draw order of "{1}" at {0}s',
  '已移动「{0}」（setup 绘制顺序）': 'Moved "{0}" (setup draw order)',
  '已在 {0}s 打关键帧：插槽「{1}」颜色 / 透明度': 'Keyed color / alpha of slot "{1}" at {0}s',
  '已修改插槽「{0}」的 setup 颜色': 'Changed the setup color of slot "{0}"',
  '插槽「{0}」已不存在': 'Slot "{0}" no longer exists',
  '找不到动画「{0}」：先在时间轴选一个动画':
    'Animation "{0}" not found: pick an animation in the timeline first',
  '已导出到 {0}/：{1} / {2} / {3} 张图集页': 'Exported to {0}/: {1} / {2} / {3} atlas page(s)',
  '选择导出目录（.hao2d）': 'Choose an export folder (.hao2d)',
  '已导出 {0}（有 {1} 条与 Unity 运行时的差异提示）':
    'Exported {0} ({1} differences from the Unity runtime reported)',
  '已导出 {0}': 'Exported {0}',
  '{0} 个材质（Hao2D/Sprite）': '{0} material(s) (Hao2D/Sprite)',
  '已导出到 {0}/：{1}': 'Exported to {0}/: {1}',
  '；{0} 条与 Unity 运行时的差异提示': '; {0} differences from the Unity runtime reported',
  '{0} 等 {1} 个': '{0} and {1} in total',
  '没有可导出的骨架': 'No skeleton to export',
  '已导出到 {0}/：{1}.json / {2} / {3} 张图集页':
    'Exported to {0}/: {1}.json / {2} / {3} atlas page(s)',
  '「{0}」里没有带像素的图层（文本 / 调整层无法导入）':
    '"{0}" has no pixel layers (text / adjustment layers cannot be imported)',
  '解析 PSD 失败：{0}': 'Failed to parse the PSD: {0}',
  'Photoshop 文档': 'Photoshop document',
  '请先保存或创建工程：PSD 的图层图片要落到工程目录的 images/ 下（与「导入图片」同一规则）':
    'Save or create the project first: PSD layer images must be written into the project images/ folder (same rule as Import Images)',
  '没有勾选任何带像素的图层': 'No pixel layers are selected',
  '写入图层图片失败：{0}': 'Failed to write layer images: {0}',
  '没有可导出的图层（选中项都没有像素）': 'No exportable layers (none of the selected layers have pixels)',
  '已导入 {0} 层图片': 'Imported {0} layer image(s)',
  '按 PSD 位置添加了 {0} 个插槽（画布中心对齐根骨骼）':
    'Added {0} slot(s) at their PSD positions (canvas center aligned to the root bone)',
  'PSD「{0}」导入完成：{1}': 'PSD "{0}" imported: {1}',
  '「{0}」已拆成 {1} 张碎图（{2}），图集已从工程移除':
    'Split "{0}" into {1} loose image(s) ({2}); the atlas was removed from the project',
  '有附件对不上区域名，另拆了一张整页兜底':
    'Some attachments did not match region names; also split one full page as a fallback',
  '跳过 {0} 个空区域': 'Skipped {0} empty region(s)',
  '图片「{0}」不存在': 'Image "{0}" does not exist',
  '「{0}」已经是碎图，不用再拆': '"{0}" is already a loose image; no need to split it',
  '「{0}」不是磁盘文件，拆出来的碎图没地方写':
    '"{0}" is not a file on disk, so the split images have nowhere to be written',
  '读取「{0}」失败，无法拆分': 'Failed to read "{0}", cannot split it',
  '「{0}」里没有记录任何子区域，拆不出碎图': '"{0}" has no recorded sub-regions to split',
  '碎图编码失败（当前环境没有可用的画布）':
    'Failed to encode the loose image (no canvas available in this environment)',
  '写入碎图失败：{0}': 'Failed to write loose images: {0}',
  '「{0}」在拆分过程中被改动，已放弃（磁盘上的碎图文件可自行删除）':
    '"{0}" changed while splitting; aborted (you can delete the written loose images manually)',
  '不是 Spine 骨骼文件（检测到 {0}），请选择含 "skeleton" 段的 JSON':
    'Not a Spine skeleton file (detected {0}); pick a JSON with a "skeleton" section',
  '这是图集文件，请选择含 "armature" 段的骨骼 JSON':
    'This is a texture atlas file; pick a skeleton JSON with an "armature" section',
  'Hao2D 工程': 'Hao2D project',
  '贴图': 'Image',
  '包围盒': 'Bounding box',
  '编组': 'Group',
  '图层': 'Layer',
  '未命名': 'Untitled',
  '混合模式 Erase 需要额外遮罩流程，视口中降级为 Normal':
    'Blend mode Erase needs an extra mask pass; downgraded to Normal in the viewport',
  '混合模式 Below 依赖绘制顺序语义，视口中降级为 Normal':
    'Blend mode Below depends on draw-order semantics; downgraded to Normal in the viewport',
  '混合模式 None 的“不绘制”语义在视口中降级为 Normal':
    'Blend mode None means "do not draw"; downgraded to Normal in the viewport',
  '不是 hao2d-ske 格式的骨骼数据': 'Not hao2d-ske skeleton data',
  '不是 hao2d-atlas 格式的图集描述': 'Not an hao2d-atlas description',
  '不支持的 hao2d-ske 版本 {0}': 'Unsupported hao2d-ske version {0}',
  '不支持的 hao2d-atlas 版本 {0}': 'Unsupported hao2d-atlas version {0}',
  '图层「{0}」没有像素数据': 'Layer "{0}" has no pixel data',
  '图层「{0}」导出 PNG 失败': 'Failed to export layer "{0}" as PNG',
  'Hao2D: 文件头不匹配（0x{0}），不是 .hao2d 资源':
    'Hao2D: file header mismatch (0x{0}); this is not a .hao2d asset',
  'Hao2D: 不支持的数据版本 {0}（支持 5 / 6 / 7 / 8 / {1}），请重新导出':
    'Hao2D: unsupported data version {0} (supports 5 / 6 / 7 / 8 / {1}); please re-export',

  // ── 遮罩绘制 / 编辑提示 ───────────────────────────────────────────────
  '遮罩至少需要 3 个点': 'A mask needs at least 3 points',
  '没有新增遮罩点，原多边形未修改': 'No new mask point added; the original polygon is unchanged',
  '遮罩点换算失败（插槽没有绑定骨骼，或骨骼缩放为 0）':
    'Failed to convert the mask point (the slot has no bound bone, or the bone scale is 0)',
  '已更新遮罩「{0}」：在检查器里设置结束插槽 / 反向，或继续拖控制点':
    'Updated mask "{0}": set the end slot / reverse in the inspector, or keep dragging control points',
  '已创建遮罩「{0}」：在检查器里设置结束插槽 / 反向，或继续拖控制点':
    'Created mask "{0}": set the end slot / reverse in the inspector, or keep dragging control points',
  '已取消遮罩绘制': 'Mask drawing cancelled',
  '已撤回上一个新增遮罩点：还剩 {0} 个新增点，原多边形未变':
    'Undid the last new mask point: {0} new point(s) left; the original polygon is unchanged',
  '已撤回上一个遮罩点：还剩 {0} 个（继续点 / 点回起点 / 右键收尾）':
    'Removed the last mask point: {0} left (keep clicking / click the start point / right-click to finish)',
  '已撤回最后一个遮罩点：单击继续，Esc 取消':
    'Removed the last mask point: click to continue, Esc to cancel',
  '遮罩至少保留 3 个控制点': 'A mask must keep at least 3 control points',
  '删除遮罩控制点失败': 'Failed to delete the mask control point',
  '已删除遮罩控制点': 'Mask control point deleted',
  '遮罩绑定数据在 Pose 编辑；Animate 态请用顶点工具（D）拖遮罩点写 FFD':
    'Mask binding data is edited in Pose; in Animate, use the vertex tool (D) to drag mask points and write FFD',
  '先在层级树里选中一个插槽，再画遮罩': 'Select a slot in the hierarchy first, then draw the mask',
  '正在给另一个插槽画遮罩：先点回起点 / 右键闭合，或 Esc 取消':
    'A mask is being drawn for another slot: click back on the start point / right-click to close, or press Esc to cancel',
  '已删除一个遮罩控制点': 'Deleted a mask control point',
  '已选中遮罩控制点 #{0}：拖动移动，Delete 删除':
    'Selected mask control point #{0}: drag to move, Delete to remove',
  '插入遮罩控制点失败': 'Failed to insert the mask control point',
  '已在遮罩边上插入控制点：拖动调整，Delete 删除':
    'Inserted a control point on the mask edge: drag to adjust, Delete to remove',
  '已取消选中遮罩点；点边线插入点，拖点移动，Delete 删除':
    'Mask point deselected; click an edge to insert a point, drag a point to move it, Delete to remove',
  '新建遮罩：单击加点；点回起点 / 右键闭合；Ctrl+Z 撤点；Esc 取消':
    'New mask: click to add points; click the start point / right-click to close; Ctrl+Z to undo a point; Esc to cancel',
  '遮罩控制点不支持权重刷；遮罩的动画请用顶点工具（D）写 FFD':
    "Weight painting doesn't apply to mask control points; animate the mask with the vertex tool (D) to write FFD",

  // ── 权重刷 / 顶点 / 边界 / 布线提示 ────────────────────────────────────
  '权重刷只在 Pose 状态可用（动画状态的角色姿态不是绑定姿态）':
    'Weight painting is only available in Pose (the character pose in Animate is not the setup pose)',
  '先在层级树里选中要刷权重的网格附件（Region 请先转为网格）':
    'Select the mesh attachment to weight paint in the hierarchy first (convert a Region to a mesh first)',
  '骨骼属于绑定数据：切到 Pose 状态再画': 'Bones are setup data: switch to Pose to draw',
  '该顶点不支持编辑（Region 请先转为网格）':
    "This vertex can't be edited (convert a Region to a mesh first)",
  '已插入顶点 #{0}（UV 与权重按位置插值；落在网格线上会把那条边一分为二）':
    'Inserted vertex #{0} (UV and weights are interpolated by position; dropping it on a mesh edge splits that edge in two)',
  '删除顶点：对准要删的顶点再点（网格至少得留 3 个顶点）':
    'Delete vertex: aim at the vertex to remove, then click (a mesh must keep at least 3 vertices)',
  '删不掉：网格至少得保留 3 个顶点': "Can't delete: a mesh must keep at least 3 vertices",
  '已删除顶点 #{0}（引用它的三角形就地重新三角化补上）':
    'Deleted vertex #{0} (triangles referencing it were re-triangulated in place)',
  '插入位置不在附件上：点在网格覆盖的区域内':
    "The insert position isn't on the attachment: click inside the area covered by the mesh",
  '框选：矩形里没有顶点（右键可取消当前选择）':
    'Marquee: no vertices inside the rectangle (right-click to cancel the current selection)',
  '框选到 {0} 个顶点（共选中 {1} 个；拖动任意一个整组移动）':
    'Marquee selected {0} vertices ({1} selected in total; drag any of them to move the whole group)',
  '边界点要落在附件所在的插槽上':
    'Boundary points must lie on the slot that owns the attachment',
  '这个点离上一个点太近，没有落下':
    'This point is too close to the previous one; it was not placed',
  '绘制边界已取消：至少要 3 个点才围得成一个边界；已回到「编辑顶点」':
    'Boundary drawing cancelled: you need at least 3 points to enclose a boundary; back to "Edit Vertices"',
  '边界重建失败：这 3 个点几乎共线，或附件已经不是网格了':
    'Failed to rebuild the boundary: these 3 points are almost collinear, or the attachment is no longer a mesh',
  '已按新边界重建网格：{0} 个顶点 / {1} 个三角面（贴图停在原位；原网格点、绑定权重与 FFD 关键帧已清除，要蒙皮请重新绑骨骼并算权重）；已回到「编辑顶点」':
    'Mesh rebuilt from the new boundary: {0} vertices / {1} triangles (the texture stays in place; the original mesh points, binding weights and FFD keyframes were cleared — re-bind bones and compute weights if you need skinning); back to "Edit Vertices"',
  '还没有落下边界点；要撤销文档命令，请先退出「自己绘制边界」':
    'No boundary points placed yet; to undo document commands, leave "Draw Boundary Yourself" first',
  '已撤回最后一个边界点：重新开始点（点回起点或右键收尾）':
    'Removed the last boundary point: start clicking again (click the start point or right-click to finish)',
  '已撤回上一个边界点：还剩 {0} 个（继续点 / 点回起点 / 右键收尾）':
    'Removed the last boundary point: {0} left (keep clicking / click the start point / right-click to finish)',
  '自定义布线：从网格的一个顶点上按住，拖到另一个顶点上松手':
    'Custom topology: press on one mesh vertex, drag to another vertex and release',
  '从顶点 #{0} 拖到另一个顶点：松手即在这两点之间连一条线':
    'Dragging from vertex #{0} to another vertex: release to connect a line between them',
  '自定义布线：要落到**另一个**顶点上才会连线，这次什么都没改':
    'Custom topology: you must drop on **another** vertex to connect; nothing changed this time',
  '这两点之间连不上：已经连着线了，或这条线没有横穿网格内部':
    "Can't connect these two points: they are already connected, or the line doesn't cross the mesh interior",
  '已在顶点 #{0} 与 #{1} 之间连上线（只重排这条通道上的三角形）':
    'Connected vertices #{0} and #{1} (only triangles along this channel were re-triangulated)',

  // ── 选择 / 变换提示 ──────────────────────────────────────────────────
  '插槽「{0}」已锁定：在层级树里解锁后才能选中':
    'Slot "{0}" is locked: unlock it in the hierarchy to select it',
  '插槽「{0}」已锁定：在层级树里解锁后才能拖动':
    'Slot "{0}" is locked: unlock it in the hierarchy to drag it',
  '骨骼「{0}」已锁定，先解锁再编辑': 'Bone "{0}" is locked; unlock it before editing',
  '已选中附件「{0}」（{1}）：可编辑其顶点':
    'Selected attachment "{0}" ({1}): its vertices can be edited',
  '已选中附件「{0}」（{1}）：拖动即可{2}':
    'Selected attachment "{0}" ({1}): drag to {2}',
  '已选中附件「{0}」（{1}）：位置属于绑定数据，切到 Pose 态才能拖动':
    'Selected attachment "{0}" ({1}): position is setup data, switch to Pose to drag it',
  '斜切不支持附件：「{0}」请用移动 / 旋转 / 缩放，或斜切它所在的骨骼':
    'Shear does not apply to attachments: use move / rotate / scale for "{0}", or shear its bone',
  '斜切骨骼「{0}」：拖动斜切包围盒的边（上下边横向拖 / 左右边纵向拖）':
    'Shear bone "{0}": drag the edges of the shear box (top/bottom edges drag horizontally, left/right edges drag vertically)',
  '移动骨骼「{0}」{1} · 拖动骨骼原点圆圈':
    'Move bone "{0}" {1} · drag the bone origin circle',
  '{0}骨骼「{1}」{2} · {3}{4}': '{0} bone "{1}" {2} · {3}{4}',
  '斜切骨骼「{0}」{1} · 拖动包围盒{2}{3}':
    'Shear bone "{0}" {1} · drag the {2} of the box{3}',
  '拖动距离太短，未生成骨骼': 'Drag distance too short; no bone was created',
  '「{0}」要先选中一个网格附件（Region 可右键「转为网格」再改）':
    '"{0}": select a mesh attachment first (right-click a Region and choose "Convert to Mesh")',
  '「{0}」改的是绑定网格：请切到 Pose 状态（Animate 态拖顶点写的是 FFD 帧）':
    '"{0}" edits the setup mesh: switch to Pose (dragging vertices in Animate writes FFD frames)',

  // ── 状态栏提示的拼接片段（作为 t() 的参数传入） ────────────────────────
  '（写入关键帧）': '(keyed)',
  '（修改 setup）': '(setup)',
  '（同时作用于 {0} 根选中骨骼）': ' (applies to {0} selected bones)',
  '整体': 'whole',
  '{0} 轴': '{0} axis',
  '上边': 'top edge',
  '下边': 'bottom edge',
  '左边': 'left edge',
  '右边': 'right edge',

  // ── 视口交互状态提示（描边 / 权重刷 / 画骨骼 / 顶点 / 边界） ──────────
  '修改遮罩失败': 'Failed to modify the mask',
  '创建遮罩失败': 'Failed to create the mask',
  '没有新增的遮罩点可撤销（原多边形未变）；按 Esc 取消本次绘制':
    'No new mask points to undo (the original polygon is unchanged); press Esc to cancel this drawing',
  '还没有落下遮罩点：单击继续，Esc 取消':
    'No mask points placed yet: click to continue, Esc to cancel',
  '顶点 #{0}（{1} / {2}）': 'Vertex #{0} ({1} / {2})',
  '顶点 #{0} 等 {1} 个（{2} / {3}）：拖动整组移动':
    'Vertex #{0} (group of {1}) ({2} / {3}): drag to move the group',
  '{0}：在层级树里选一根骨骼后按住拖动即可刷权重':
    '{0}: select a bone in the hierarchy, then drag to paint weights',
  '请先在层级树里选中要刷权重的骨骼': 'Select the bone to paint in the hierarchy first',
  '平滑权重（朝邻居平均）': 'smooth weights (averaged toward neighbours)',
  '{0}「{1}」的权重': '{0} weights of "{1}"',
  '权重刷「{0}」': 'Weight brush "{0}"',
  '{0}：按住拖动{1}': '{0}: hold and drag to {1}',
  '（Mode {0} / Size {1}px / Strength {2}% / Feather {3}%{4}；临时改方向：Alt=减少 / Shift=覆盖 / Ctrl=平滑 / Ctrl+Shift=生长）':
    ' (Mode {0} / Size {1}px / Strength {2}% / Feather {3}%{4}; temporary direction: Alt=subtract / Shift=replace / Ctrl=smooth / Ctrl+Shift=grow)',
  '{0}：按住拖动{1}（只刷选中的 {2} 个顶点；点空白处取消选择）':
    '{0}: hold and drag to {1} (only the {2} selected vertices; click empty space to clear the selection)',
  '；只刷选中的 {0} 个顶点（点空白处取消选择）':
    '; only the {0} selected vertices (click empty space to clear the selection)',
  ' / Normalize 关': ' / Normalize off',
  '增加': 'Add',
  '增长': 'Grow',
  '减少': 'Subtract',
  '覆盖': 'Replace',
  '平滑': 'Smooth',
  '已吸附到「{0}」的骨骼端点：拖动决定长度与方向，松开生成（一根接一根就是骨骼链）':
    'Snapped to the bone tip of "{0}": drag to set length and direction, release to create (chain them one after another)',
  '从「{0}」接着画：拖动决定长度与方向，松开生成（可以一根接一根拖成骨骼链）':
    'Continuing from "{0}": drag to set length and direction, release to create (drag one after another to build a chain)',
  '拖动决定长度与方向，松开生成骨骼（挂在根骨骼下；从骨骼上起笔才会挂到它下面）':
    'Drag to set length and direction, release to create a bone (parented to the root bone; start the drag on a bone to parent it there)',
  '；拖到插槽上松手会把该插槽挂过来（锁定中的插槽除外）':
    '; drop it on a slot to attach that slot to it (locked slots excluded)',
  '已选中 {0} 个顶点（Shift+点击加选 / 减选；拖任意一个即整组移动）':
    'Selected {0} vertices (Shift+click to add / remove; drag any of them to move the group)',
  '已取消顶点选择': 'Vertex selection cleared',
  '已新建骨骼「{0}」{1} · 长度 {2}': 'Created bone "{0}" {1} · length {2}',
  '，挂在「{0}」下': '(parented to "{0}")',
  ' · 插槽「{0}」已挂到它下面': ' · slot "{0}" is now attached to it',
  '已平滑 {0} 个顶点的权重': 'Smoothed weights of {0} vertices',
  '已为 {0} 个顶点刷上「{1}」的权重': 'Painted weights of "{1}" onto {0} vertices',
  '框选顶点（Shift：加进当前选择）：拖出矩形，松手选中框内的顶点；右键取消选择':
    'Box select vertices (Shift: add to current selection): drag a rectangle, release to select the vertices inside; right-click to cancel',
  '框选顶点：拖出矩形，松手选中框内的顶点；右键取消选择':
    'Box select vertices: drag a rectangle, release to select the vertices inside; right-click to cancel',
  '；该点在图片范围外，已贴到最近的框边':
    '; the point was outside the image bounds and was clamped to the nearest edge',
  '边界点 {0}：继续点（至少 3 个点，点回起点或右键收尾）；点错了按 Ctrl+Z 撤回上一个{1}':
    'Boundary point {0}: keep clicking (at least 3 points; click the start point or right-click to finish); press Ctrl+Z to undo the last one{1}',
  '边界点 {0}：点回起点（第一个大圆点）或按右键收尾闭合；点错了按 Ctrl+Z 撤回上一个{1}':
    'Boundary point {0}: click the start point (the first large dot) or right-click to close; press Ctrl+Z to undo the last one{1}',

  // ── 撤销 / 历史面板里的命令名 ─────────────────────────────────────────
  '修改遮罩多边形': 'Modify mask polygon',
  '创建遮罩': 'Create mask',
  '移动遮罩控制点': 'Move mask control point',
  '删除遮罩控制点': 'Delete mask control point',
  '插入遮罩控制点': 'Insert mask control point',
  '编辑 FFD': 'Edit FFD',
  '移动顶点': 'Move vertex',
  '编辑网格顶点': 'Edit mesh vertex',
  '移动骨骼': 'Move bone',
  '斜切骨骼': 'Shear bone',
  '旋转附件': 'Rotate attachment',
  '缩放附件': 'Scale attachment',
  '移动附件': 'Move attachment',
  '插槽挂到新骨骼': 'Attach slot to new bone',
  '自动权重（绑定骨骼）': 'Auto weights (bind bones)',
  '重绘网格边界': 'Redraw mesh boundary',
  '生成轮廓网格': 'Generate outline mesh',
  '粘贴节点': 'Paste node',
  '粘贴关键帧': 'Paste keyframe',
  'Region 转网格': 'Region to mesh',
  'AI：按轮廓生成网格': 'AI: generate mesh from outline',
  'AI：自动权重': 'AI: auto weights',
  '删除皮肤': 'Delete skin',
  '调整舞台参考图': 'Adjust stage reference image',
  '打关键帧': 'Key frame',
  '打显示关键帧': 'Key display frame',
  '添加事件帧': 'Add event frame',
  '删除关键帧': 'Delete keyframe',
  '删除动画通道': 'Delete animation channel',
  '清理帧': 'Clean up frames',

  // ── 命令执行结果（状态栏 message）─────────────────────────────────────
  // 动画 / 关键帧
  'value 必须是 {x,y}（{0} 通道），也可以传单个数字表示 x = y':
    'Value must be {x,y} (the {0} channel); a single number means x = y',
  'bone 轨道的 channel 只能是 {0}，收到 {1}':
    'A bone track channel must be one of {0}; received {1}',
  'slot 轨道的 channel 只能是 {0}，收到 {1}':
    'A slot track channel must be one of {0}; received {1}',
  'deform 轨道的 channel 只能是 frames，收到 {0}':
    'A deform track channel must be frames; received {0}',
  'drawOrder 轨道的 channel 只能是 order，收到 {0}':
    'A drawOrder track channel must be order; received {0}',
  '已给骨骼 {0} 的 {1} 在 {2} 秒打了一帧': 'Keyed {1} of bone {0} at {2}s',
  '那根骨骼在 {0} 秒本来就没有这个通道的关键帧':
    'That bone has no keyframe for this channel at {0}s',
  '已删除该关键帧': 'Deleted the keyframe',
  '缺少参数 attachment（附件名；空串表示不显示）':
    'Missing parameter attachment (attachment name; an empty string means "not shown")',
  '插槽 {0} 在 {1} 秒起显示「{2}」': 'Slot {0} shows "{2}" from {1}s',
  '插槽 {0} 在 {1} 秒起显示': 'Slot {0} is shown from {1}s',
  '插槽 {0} 在 {1} 秒起隐藏': 'Slot {0} is hidden from {1}s',
  '缺少参数 visible（true / false）': 'Missing parameter visible (true / false)',
  '插槽 {0} 在 {1} 秒的颜色设为 {2}': 'Color of slot {0} at {1}s set to {2}',
  '已在 {0} 秒打了一帧绘制顺序（{1}）': 'Keyed draw order at {0}s ({1})',
  '缺少参数 offsets（数字数组，长度 = 顶点数 × 2）':
    'Missing parameter offsets (number array, length = vertex count × 2)',
  '已给 {0} / {1}（{2} 顶点）在 {3} 秒打了 FFD 帧':
    'Keyed FFD for {0} / {1} ({2} vertices) at {3}s',
  '这个时间点本来就没有 FFD 帧': 'There is no FFD frame at this time',
  '已删除该 FFD 帧': 'Deleted the FFD frame',
  '两个时间点一样（都是 {0} 秒），不用挪': 'Both times are the same ({0}s); nothing to move',
  '已把关键帧从 {0} 秒挪到 {1} 秒': 'Moved the keyframe from {0}s to {1}s',
  '已把该帧缓动改为 {0}': 'Changed the frame easing to {0}',
  '这条轨道上本来就没有关键帧': 'This track has no keyframes',
  '已清掉 {0} 帧': 'Cleared {0} keyframes',
  '已清空动画 {0} 的全部关键帧': 'Cleared all keyframes of animation {0}',

  // 面板 / 视图开关
  '「{0}」叠加层已显示': '"{0}" overlay shown',
  '「{0}」叠加层已隐藏': '"{0}" overlay hidden',
  '洋葱皮已开启': 'Onion skin on',
  '洋葱皮已关闭': 'Onion skin off',
  '智能过滤已开启': 'Smart filter on',
  '智能过滤已关闭': 'Smart filter off',
  '时间轴缩放已设为 {0}×': 'Timeline zoom set to {0}×',
  '已复制 {0} 个节点': 'Copied {0} node(s)',
  '已复制 {0} 个关键帧': 'Copied {0} keyframe(s)',

  // 层级 / 插槽 / 附件
  '找不到骨骼「{0}」': 'Bone "{0}" not found',
  '骨骼不能拖到它自己下面': 'A bone cannot be dragged under itself',
  '「{0}」是层级根骨骼：其他骨骼都在它之下，它自己不能移动':
    '"{0}" is the hierarchy root bone: everything else sits below it, so it cannot be moved',
  '「{0}」在「{1}」的子树里，拖进去会形成环':
    '"{0}" is inside the subtree of "{1}"; dropping it there would create a cycle',
  '插槽必须挂在某根骨骼下': 'A slot must be attached to a bone',
  '插槽「{0}」已挂到骨骼「{1}」下': 'Slot "{0}" is now attached to bone "{1}"',
  '工程里还没有骨骼：插槽必须挂在某根骨骼下':
    'The project has no bones yet: a slot must be attached to a bone',
  '工程里没有皮肤': 'The project has no skins',
  '找不到对应的插槽附件清单': 'Could not find the matching slot attachment list',
  '插槽「{0}」里没有 display「{1}」': 'Slot "{0}" has no display "{1}"',
  '已调整 display「{0}」的顺序': 'Reordered display "{0}"',
  'display「{0}」已移到插槽「{1}」下': 'Display "{0}" moved under slot "{1}"',

  // 网格生成
  '生成 / 重设网格改的是绑定网格：请切到 Pose 状态':
    'Generating / resetting a mesh edits the setup mesh: switch to Pose',
  '先在层级树里选中要生成网格的图片附件':
    'Select the image attachment to mesh in the hierarchy first',
  '只有图片（Region）能转为规则栅格网格；已经是网格的请用「自动生成网格」按密度重设':
    'Only images (Region) can be converted to a regular grid mesh; if it is already a mesh, use "Auto-generate mesh" to reset its density',
  '已生成规则网格（{0}×{1}）：{2} 顶点 / {3} 三角面':
    'Generated a regular grid mesh ({0}×{1}): {2} vertices / {3} triangles',
  '生成失败：附件类型不是 Region': 'Generation failed: the attachment is not a Region',
  '视口尚未就绪，稍后再试': 'The viewport is not ready yet; try again in a moment',
  '找不到附件「{0}」': 'Attachment "{0}" not found',
  '只有图片（Region）或由图片转来的网格能自动生成轮廓网格':
    'Only images (Region) or meshes converted from images can auto-generate an outline mesh',
  '图片「{0}」还没解码完成，稍后再试':
    'Image "{0}" has not finished decoding; try again in a moment',
  '已自动生成轮廓网格：{0} 顶点 / {1} 三角面（贴合轮廓，孔洞已忽略）':
    'Auto-generated an outline mesh: {0} vertices / {1} triangles (fit to the outline, holes ignored)',
  '自动生成失败：图片没有可用的不透明像素区域':
    'Auto-generation failed: the image has no usable opaque pixels',

  // 工程 / 骨架 / 皮肤
  '工程还没有保存路径：先调 createProject 指定 dir，或给 saveProject 传 path':
    'The project has no save path yet: call createProject with dir, or pass path to saveProject',
  '工程名不能为空': 'Project name cannot be empty',
  '工程名已经是「{0}」': 'The project name is already "{0}"',
  '工程已重命名为「{0}」（保存后写进工程文件）':
    'Project renamed to "{0}" (written to the project file on save)',
  '缺少参数 paths（图片绝对路径数组，不能为空）':
    'Missing parameter paths (array of absolute image paths; cannot be empty)',
  '骨架下标越界：{0}（现有 {1} 个，用 getProjectState 查）':
    'Armature index out of range: {0} (there are {1}; check with getProjectState)',
  '骨架下标越界：{0}（现有 {1} 个）': 'Armature index out of range: {0} (there are {1})',
  '已经在这个骨架上了：{0}': 'Already on this armature: {0}',
  '已新建皮肤「{0}」': 'Created skin "{0}"',
  '皮肤不存在：{0}（用 listSkins 查现有皮肤名）':
    'Skin not found: {0} (use listSkins to see existing skin names)',
  '已有同名皮肤：{0}': 'A skin with that name already exists: {0}',
  '皮肤已重命名为「{0}」': 'Skin renamed to "{0}"',
  '不能删除默认皮肤 default': 'The default skin cannot be deleted',
  '已切换到皮肤「{0}」': 'Switched to skin "{0}"',
  'time 必须不小于 0（秒），收到 {0}': 'time must be >= 0 (seconds); received {0}',
  '播放头已移到 {0} 秒': 'Playhead moved to {0}s',
  '没有可播放的动画：先用 addAnimation 建一条':
    'No animation to play: create one with addAnimation first',
  '开始播放': 'Playing',
  '已暂停': 'Paused',
  '动画「{0}」在 {1}s 没有事件帧（用 getAnimationKeys 查现有事件）':
    'Animation "{0}" has no event frame at {1}s (use getAnimationKeys to see existing events)',
  '已更新事件帧': 'Event frame updated',
  '动画「{0}」在 {1}s 没有匹配的事件帧':
    'Animation "{0}" has no matching event frame at {1}s',
  '已删除事件帧「{0}」': 'Deleted event frame "{0}"',

  // 导出 / 撤销
  'mode 只能是 runtime / unity / spine，收到 {0}':
    'mode must be runtime / unity / spine; received {0}',
  '没有导出目录：给 exportProject 传 dir，或先把工程存到磁盘（saveProject）':
    'No export directory: pass dir to exportProject, or save the project to disk first (saveProject)',
  'atlasScope 只能是 all / selected，收到 {0}':
    'atlasScope must be all / selected; received {0}',
  'scale 必须大于 0，收到 {0}': 'scale must be greater than 0; received {0}',
  '导出缩放已设为 {0}': 'Export scale set to {0}',
  '没有可撤销的操作': 'Nothing to undo',
  '已撤销「{0}」': 'Undid "{0}"',
  '没有可重做的操作': 'Nothing to redo',
  '已重做「{0}」': 'Redid "{0}"',

  // 视口 / 舞台参考图
  'kind 只能是 bone / slot / display / constraint，收到 {0}':
    'kind must be bone / slot / display / constraint; received {0}',
  'kind = display 时需要同时给 slot（附件所在的插槽名）':
    'kind = display also requires slot (the slot that owns the attachment)',
  '场景未就绪：视口还没挂载好，稍后再试':
    'Scene not ready: the viewport is not mounted yet; try again in a moment',
  '聚焦失败：找不到 {0}「{1}」（名字可能不对，或该节点没有可框取的尺寸）':
    'Focus failed: {0} "{1}" not found (the name may be wrong, or the node has no size to frame)',
  '视口已聚焦到 {0}「{1}」': 'Viewport focused on {0} "{1}"',
  '视口已平移（dx={0}px, dy={1}px）': 'Viewport panned (dx={0}px, dy={1}px)',
  'zoom 必须大于 0，收到 {0}': 'zoom must be greater than 0; received {0}',
  '视口缩放已设为 {0}': 'Viewport zoom set to {0}',
  '视口已居中到世界坐标 ({0}, {1})': 'Viewport centered on world coordinates ({0}, {1})',
  '参考图后缀不在支持范围（{0}），收到 .{1}':
    'Reference image extension not supported ({0}); received .{1}',
  '请先保存工程：参考图要落到工程目录的 stage/ 下（先 createProject 或 saveProject）':
    "Save the project first: reference images go under the project's stage/ folder (createProject or saveProject first)",
  '读不到图片文件：{0}': 'Could not read the image file: {0}',
  '已更换舞台参考图「{0}」': 'Replaced the stage reference image with "{0}"',
  '已设置舞台参考图「{0}」': 'Set the stage reference image to "{0}"',
  '还没有舞台参考图：先调 setStage，或让用户用「舞台」弹窗选一张':
    'No stage reference image yet: call setStage, or have the user pick one in the "Stage" dialog',
  'width 必须大于 0，收到 {0}': 'width must be greater than 0; received {0}',
  'height 必须大于 0，收到 {0}': 'height must be greater than 0; received {0}',
  '舞台参考图在调整中消失了': 'The stage reference image disappeared while adjusting',
  '已调整舞台参考图': 'Stage reference image adjusted',
  '本来就没有舞台参考图': 'There was no stage reference image',
  '已删除舞台参考图「{0}」': 'Deleted stage reference image "{0}"',

  // 导入 / 复制粘贴 / 事务 / 嵌套骨架
  'data 不是合法 base64': 'data is not valid base64',
  '参数 zone 只能是 inside / above / below，收到 {0}':
    'zone must be inside / above / below; received {0}',
  '参数 side 只能是 before / after，收到 {0}': 'side must be before / after; received {0}',
  '给了 side 就要一并给 anchorSlot（排序锚点的插槽名）':
    'Providing side also requires anchorSlot (the slot used as the ordering anchor)',
  '插槽「{0}」不存在或骨架名无效': 'Slot "{0}" does not exist, or the armature name is invalid',
  '已把骨架「{0}」嵌到插槽「{1}」': 'Nested armature "{0}" into slot "{1}"',
  '缺少参数 order（插槽名数组，第 0 个最先画；用 listSlots 可以拿到当前顺序）':
    'Missing parameter order (array of slot names, index 0 draws first; use listSlots to get the current order)',
  'order 里有重复的插槽名': 'order contains duplicate slot names',
  'order 里有不存在的插槽：{0}（用 listSlots 查现有插槽名）':
    'order contains unknown slots: {0} (use listSlots to see existing slot names)',
  'order 少了 {0} 个插槽：{1}（必须给出全部插槽名）':
    'order is missing {0} slot(s): {1} (all slot names must be provided)',
  '已重排 {0} 个插槽的绘制顺序': "Reordered {0} slots' draw order",
  '附件改名要带上 slot（附件所在插槽名；用 listDisplays 查）':
    'Renaming an attachment requires slot (the slot that owns it; use listDisplays)',
  '改不了：找不到{0}「{1}」（用 listBones / listSlots / listDisplays / listConstraints 核对）':
    'Cannot rename: {0} "{1}" not found (check with listBones / listSlots / listDisplays / listConstraints)',
  '已把「{0}」改名为「{1}」': 'Renamed "{0}" to "{1}"',
  '图片不存在：{0}（用 listImages 查图片池）':
    'Image not found: {0} (use listImages to see the image pool)',
  '已删除图片「{0}」{1}': 'Deleted image "{0}"{1}',
  '（清空了 {0} 处引用）': ' (cleared {0} reference(s))',
  '已替换图片「{0}」的来源与尺寸': 'Replaced the source and size of image "{0}"',
  '已在 {0} 状态': 'Already in {0} mode',
  '当前不在 Animate 状态：请先调用 setMode 切到 animate 再做动画编辑':
    'Not in Animate mode: call setMode with animate before editing animation',
  '没有这个动画：{0}（用 listAnimations 查全部动画名）':
    'No such animation: {0} (use listAnimations to list all animation names)',
  '已切换到动画「{0}」': 'Switched to animation "{0}"',
  '视口还没就绪：等编辑器窗口画完一帧再试':
    'Viewport not ready: wait until the editor window has drawn a frame',
  'zoom 必须是正数': 'zoom must be a positive number',
  '没有指定动画：传 animation 参数，或先 setMode 切到 animate（会自动选中一个动画）':
    'No animation specified: pass the animation argument, or call setMode with animate (which selects one automatically)',
  '没有可复制的内容：先用 setSelection 选中骨骼（kind=bone）或插槽（kind=slot）':
    'Nothing to copy: use setSelection to select a bone (kind=bone) or a slot (kind=slot) first',
  '粘贴失败：剪贴板为空，或没有合适的落点。先 copyNodes，再用 setSelection 选中目标骨骼':
    'Paste failed: the clipboard is empty or there is no suitable target. Use copyNodes, then setSelection to select the target bone',
  '已粘贴 {0} 个节点': 'Pasted {0} node(s)',
  '没有可复制的选择：先用 setSelection 选中骨骼或插槽（关键帧的复制请用 copyKeyframes）':
    'Nothing selected to copy: use setSelection to select a bone or slot first (use copyKeyframes to copy keyframes)',
  '已复制并粘贴 {0} 个节点': 'Copied and pasted {0} node(s)',
  '没有选中的关键帧：这一步需要在时间轴上手动选中（或直接改用 keyBoneFrame / moveKeyframe 逐个编辑）':
    'No keyframes selected: select them on the timeline first (or use keyBoneFrame / moveKeyframe to edit them one by one)',
  '粘贴失败：剪贴板里没有关键帧（先 copyKeyframes），或目标动画不存在':
    'Paste failed: the clipboard has no keyframes (use copyKeyframes first), or the target animation does not exist',
  '已粘贴 {0} 个关键帧': 'Pasted {0} keyframe(s)',
  '视口还没就绪，取不到图片像素。等编辑器窗口画完一帧再试':
    'Viewport not ready, image pixels are unavailable. Wait until the editor window has drawn a frame',
  '找不到附件：{0} / {1}（用 listDisplays 查）':
    'Attachment not found: {0} / {1} (check with listDisplays)',
  '只有图片（Region）或由图片转来的网格能生成轮廓网格；纯网格请用 convertToMesh 的规则栅格':
    'Only images (Region) or meshes converted from images can generate an outline mesh; for a pure mesh use convertToMesh with a regular grid',
  '生成失败：图片没有可用的不透明像素区域（可能整张图都是透明的）':
    'Generation failed: the image has no usable opaque pixels (it may be fully transparent)',
  '没有正在进行的事务（rollbackTransaction 要跟在 beginTransaction 之后）':
    'No transaction in progress (rollbackTransaction must follow beginTransaction)',
  '已回滚到批量操作前的状态': 'Rolled back to the state before the batch operation',
  '请先保存或创建工程：导入的图片要落到工程目录的 images/ 下（可先调用 createProject 或 saveProject）':
    "Save or create the project first: imported images go under the project's images/ folder (call createProject or saveProject first)",
  '必须给 data（base64 / dataURL）或 path（本地图片绝对路径）其中一个':
    'Provide either data (base64 / dataURL) or path (absolute local image path)',
  '读不到图片字节（data 解码失败或 path 文件不存在）':
    'Could not read image bytes (data decoding failed, or the path does not exist)',
  '已导入图片 {0}（{1}×{2}）': 'Imported image {0} ({1}×{2})',

  // 网格 / 顶点 / 权重绑定
  '转不了：{0} / {1} 不是图片（Region）附件（已经转过网格，或用 listDisplays 看它的 type）':
    'Cannot convert: {0} / {1} is not an image (Region) attachment (it may already be a mesh; check its type with listDisplays)',
  '已转为网格：{0} 顶点 / {1} 三角形': 'Converted to a mesh: {0} vertices / {1} triangles',
  '找不到附件 {0} / {1}（用 listDisplays 查）':
    'Attachment {0} / {1} not found (check with listDisplays)',
  '只能对 Region 附件（或带快照的网格）用：先用 addDisplay 加碎图，或 convertToRegion 还原':
    'Only works on Region attachments (or meshes with a snapshot): add a piece with addDisplay first, or restore it with convertToRegion',
  '附件引用的图片「{0}」不在图片池（先用 importImage 导入）':
    'The image referenced by the attachment ("{0}") is not in the image pool (import it with importImage first)',
  '读不到图片「{0}」的像素，无法生成轮廓':
    'Cannot read pixels of image "{0}", so no outline can be generated',
  '生成网格失败：附件不是有效的 Region / 网格，或图片没有不透明像素':
    'Mesh generation failed: the attachment is not a valid Region / mesh, or the image has no opaque pixels',
  '转不了：{0} / {1} 不是网格（用 listDisplays 看它的 type）':
    'Cannot convert: {0} / {1} is not a mesh (check its type with listDisplays)',
  '已把 {0} / {1} 转回图片': 'Converted {0} / {1} back to an image',
  '缺少参数 point（附件局部坐标 {x,y}）':
    'Missing parameter point (attachment-local coordinates {x,y})',
  '已在边上插入顶点（新下标 {0}）': 'Inserted a vertex on the edge (new index {0})',
  '删不掉：目标不是网格、下标越界，或者删完会只剩不到 3 个顶点':
    'Cannot delete: the target is not a mesh, the index is out of range, or fewer than 3 vertices would remain',
  '已删除顶点 {0}': 'Deleted vertex {0}',
  '移动绑定网格顶点要在 Pose 态做：先 setMode 切到 pose（Animate 态改顶点形变请用 keyDeformFrame）':
    'Moving setup-mesh vertices must happen in Pose: call setMode with pose first (in Animate, use keyDeformFrame to key deformations)',
  '{0} / {1} 不是网格附件（用 listDisplays 看它的 type，Region 先 convertToMesh）':
    '{0} / {1} is not a mesh attachment (check its type with listDisplays; convert a Region with convertToMesh first)',
  '顶点下标越界：合法范围 0 ~ {0}（用 getAttachmentVertices 核对）':
    'Vertex index out of range: valid range is 0 ~ {0} (check with getAttachmentVertices)',
  '顶点本来就在这个位置': 'The vertex is already at that position',
  '绑不上：目标不是网格、骨骼名不存在，或者它已经被绑过了':
    'Cannot bind: the target is not a mesh, the bone name does not exist, or it is already bound',
  '已把 {0} / {1} 绑到骨骼 {2}': 'Bound {0} / {1} to bone {2}',
  '解绑不了：目标不是网格，或者它本来就没绑这根骨骼':
    'Cannot unbind: the target is not a mesh, or it was not bound to this bone',
  '已解绑骨骼 {0}': 'Unbound bone {0}',
  'weight 必须在 0 ~ 1 之间，收到 {0}': 'weight must be between 0 and 1; received {0}',
  '写不进去：目标不是网格、顶点下标越界，或者骨骼名不存在':
    'Cannot write: the target is not a mesh, the vertex index is out of range, or the bone name does not exist',
  '视口还没就绪，取不到顶点的世界坐标。等编辑器窗口画完一帧再试':
    'Viewport not ready, vertex world coordinates are unavailable. Wait until the editor window has drawn a frame',
  '没有可用的骨骼参与加权（层级根骨骼不参与，不然每个顶点都会被它抢走）':
    'No bones available for weighting (the hierarchy root bone is excluded, otherwise it would take every vertex)',
  '没有顶点被改动': 'No vertices were changed',
  'points 至少需要 3 个点才能围成一圈边界':
    'points needs at least 3 points to enclose a boundary',
  '重绘不了：{0} / {1} 不是网格（用 listDisplays 看它的 type），或 points 不足以围成闭合多边形':
    'Cannot rebuild: {0} / {1} is not a mesh (check its type with listDisplays), or points cannot form a closed polygon',
  '已在顶点 #{0} 与 #{1} 之间连上线': 'Connected vertices #{0} and #{1}',
  '参数 {0} 必须是点数组 [{x,y}…]': 'Parameter {0} must be an array of points [{x,y}…]',
  '参数 {0} 里每项必须是 {x,y}': 'Every item in parameter {0} must be {x,y}',
  '参数 {0} 里的点 x / y 必须是数字': 'Point x / y in parameter {0} must be numbers',

  // 骨骼 / 插槽 / 约束 / 动画的增删改
  '已新建骨骼 {0}（父级：{1}）': 'Created bone {0} (parent: {1})',
  '无': 'none',
  '已更新骨骼 {0} 的 {1}': 'Updated {1} of bone {0}',
  '骨骼不存在：{0}（用 listBones 查现有骨骼名）':
    'Bone not found: {0} (use listBones to see existing bone names)',
  '已删除骨骼 {0}': 'Deleted bone {0}',
  '已新建插槽 {0}（宿主骨骼：{1}）': 'Created slot {0} (host bone: {1})',
  '已更新插槽 {0} 的 {1}': 'Updated {1} of slot {0}',
  '已把插槽 {0} 挂到 {1} 下（全局位姿保持不变）':
    'Attached slot {0} under {1} (global pose unchanged)',
  '插槽不存在：{0}（用 listSlots 查现有插槽名）':
    'Slot not found: {0} (use listSlots to see existing slot names)',
  '已删除插槽 {0}': 'Deleted slot {0}',
  'kind 只能是 ik / transform / path，收到 {0}':
    'kind must be ik / transform / path; received {0}',
  '，并新建了节点骨 {0}': ', and created node bone {0}',
  '已新建 {0} 约束 {1}（骨链：{2}{3}）': 'Created {0} constraint {1} (bone chain: {2}{3})',
  '约束不存在：{0}（用 listConstraints 查现有约束名）':
    'Constraint not found: {0} (use listConstraints to see existing constraint names)',
  '目标骨骼不存在：{0}': 'Target bone not found: {0}',
  '只有 IK 约束能改骨链（变换 / 路径约束的第一根就是宿主骨）':
    'Only IK constraints can change the bone chain (for transform / path constraints the first bone is the host bone)',
  'IK 骨链必须「父 → 子」连续：{0} 不构成一条链':
    'An IK bone chain must be continuous parent → child: {0} is not a chain',
  '已更新约束 {0} 的 {1}': 'Updated {1} of constraint {0}',
  '已删除约束 {0}': 'Deleted constraint {0}',
  '已给插槽 {0} 加上附件 {1}': 'Added attachment {1} to slot {0}',
  '已删除附件 {0} / {1}': 'Deleted attachment {0} / {1}',
  '已新建动画 {0}（时长 {1} 秒）': 'Created animation {0} ({1}s long)',
  '已删除动画 {0}': 'Deleted animation {0}',
  '已把动画 {0} 改名为 {1}': 'Renamed animation {0} to {1}',
  '缺少参数 duration（数字，单位秒）': 'Missing parameter duration (a number, in seconds)',
  '动画 {0} 的时长已设为 {1} 秒': 'Duration of animation {0} set to {1}s',
  '已切换到动画 {0}': 'Switched to animation {0}',

  // 遮罩命令
  '找不到插槽「{0}」（用 listSlots 查现有插槽名）':
    'Slot "{0}" not found (use listSlots to see existing slot names)',
  '缺少参数 points（数组 [{x,y}, ...]，至少 3 个点，坐标是插槽骨骼局部坐标）':
    'Missing parameter points (array of [{x,y}, ...], at least 3 points, in slot-bone local coordinates)',
  'points 至少需要 3 个点，收到 {0} 个': 'points needs at least 3 points; received {0}',
  'points[{0}] 必须是 {x,y}': 'points[{0}] must be {x,y}',
  'points[{0}] 的 x / y 必须是有限数字': 'x / y of points[{0}] must be finite numbers',
  '找不到皮肤「{0}」（用 listSkins 查）': 'Skin "{0}" not found (use listSkins)',
  '找不到遮罩附件「{0} / {1}」（用 listMasks 查）':
    'Mask attachment "{0} / {1}" not found (use listMasks)',
  '找不到附件「{0} / {1}」（用 listDisplays 查）':
    'Attachment "{0} / {1}" not found (use listDisplays)',
  '结束插槽「{0}」不存在（用 listSlots 查）': 'End slot "{0}" does not exist (use listSlots)',
  '结束插槽不能是遮罩自己；要裁到末尾就把 endSlot 留空':
    'The end slot cannot be the mask itself; to clip to the end, leave endSlot empty',
  '创建遮罩失败：插槽「{0}」或皮肤不存在，或点数不足 3（用 listSlots / listSkins 查）':
    'Mask creation failed: slot "{0}" or the skin does not exist, or there are fewer than 3 points (use listSlots / listSkins)',
  '已创建遮罩 {0} / {1}（{2} 个点）': 'Created mask {0} / {1} ({2} points)',
  '附件「{0} / {1}」已经是遮罩（用 getMask 查它）':
    'Attachment "{0} / {1}" is already a mask (inspect it with getMask)',
  '遮罩控制点没有变化': 'Mask control points unchanged',
  '设置遮罩控制点失败：附件或皮肤已变化':
    'Failed to set mask control points: the attachment or skin changed',
  '已更新遮罩 {0} / {1}（{2} 个点）': 'Updated mask {0} / {1} ({2} points)',
  '缺少参数 point（新位置 {x,y}，插槽骨骼局部坐标）':
    'Missing parameter point (new position {x,y}, in slot-bone local coordinates)',
  'index 越界：该遮罩有 {0} 个点，index 应在 0..{1}':
    'index out of range: the mask has {0} points, index must be 0..{1}',
  '移动遮罩控制点失败：附件或皮肤已变化':
    'Failed to move the mask control point: the attachment or skin changed',
  '缺少参数 point（新点 {x,y}，插槽骨骼局部坐标）':
    'Missing parameter point (new point {x,y}, in slot-bone local coordinates)',
  'index 越界：该遮罩有 {0} 个点，index 应在 -1..{1}':
    'index out of range: the mask has {0} points, index must be -1..{1}',
  '插入遮罩控制点失败：附件或皮肤已变化':
    'Failed to insert the mask control point: the attachment or skin changed',
  '遮罩至少保留 3 个控制点，当前删不了':
    'A mask must keep at least 3 control points, so this one cannot be deleted',
  '已更新遮罩选项（{0}）': 'Updated mask options ({0})',

  // 参数校验 / 查询命令的报错
  '缺少参数 {0}（字符串）': 'Missing parameter {0} (string)',
  '参数 {0} 必须是数字': 'Parameter {0} must be a number',
  '缺少参数 {0}（数字）': 'Missing parameter {0} (number)',
  '参数 {0} 必须是 {x,y}': 'Parameter {0} must be {x,y}',
  '参数 {0} 的 x / y 必须是数字': 'x / y of parameter {0} must be numbers',
  '参数 {0} 必须是数组': 'Parameter {0} must be an array',
  '参数 {0} 里有不合法的一项：{1}': 'Parameter {0} contains an invalid item: {1}',
  '参数 {0} 只能是 {1}，收到 {2}': 'Parameter {0} must be one of {1}; received {2}',
  '至少要给一个要改的字段': 'Provide at least one field to change',
  '动画不存在：{0}（用 listAnimations 查现有动画名）':
    'Animation not found: {0} (use listAnimations to see existing animation names)',
  '视口场景还没就绪，取不到世界坐标（动画播放中或窗口未打开时会这样）':
    'The viewport scene is not ready, so world coordinates are unavailable (this happens while an animation is playing or when the window is not open)',
  '找不到插槽：{0}（用 listSlots 查）': 'Slot not found: {0} (use listSlots)',
  '视口场景还没就绪，取不到世界坐标（窗口未打开或正在初始化时会这样）':
    'The viewport scene is not ready, so world coordinates are unavailable (this happens when the window is not open or is still initializing)',
  '视口还没就绪（窗口未打开或正在初始化）':
    'The viewport is not ready (the window is not open or is still initializing)',
  'slot 与 attachment 都必须给（用 listDisplays 查）':
    'Both slot and attachment are required (use listDisplays)',
  '找不到附件：{0} / {1}（用 listDisplays 查插槽下的附件名）':
    'Attachment not found: {0} / {1} (use listDisplays to see the attachment names of that slot)',
  '命令重复注册：{0}': 'Command registered twice: {0}',
  'args 必须是对象（按参数名传，例如 {"name":"arm"}）':
    'args must be an object (passed by parameter name, e.g. {"name":"arm"})',

  // 关键帧操作（animOps）的报错
  '还没有任何动画：先用 addAnimation 建一条':
    'There is no animation yet: create one with addAnimation first',
  '(空)': '(empty)',
  '(无)': '(none)',
  '动画不存在：{0}（现有：{1}）': 'Animation not found: {0} (existing: {1})',
  'time 必须是不小于 0 的数字（单位：秒），收到 {0}':
    'time must be a number greater than or equal to 0 (in seconds); received {0}',
  'rotate 通道的 value 要传数字（度）': 'The value of the rotate channel must be a number (degrees)',
  '{0} 通道的 value 要传 {x,y} 或单个数字':
    'The value of the {0} channel must be {x,y} or a single number',
  '插槽「{0}」在皮肤「{1}」里没有附件「{2}」（用 listDisplays 查该插槽下的附件名）':
    'Slot "{0}" has no attachment "{2}" in skin "{1}" (use listDisplays to see the attachment names of that slot)',
  '插槽「{0}」上没有嵌套骨架 display（先用 nestArmature 把别的骨架挂上来）':
    'Slot "{0}" has no nested-armature display (use nestArmature to attach another skeleton first)',
  'offset 必须是数字（秒），收到 {0}': 'offset must be a number (in seconds); received {0}',
  'speed 必须是不小于 0 的数字，收到 {0}':
    'speed must be a number greater than or equal to 0; received {0}',
  '绘制顺序里有不存在的插槽：{0}（用 listSlots 查）':
    'The draw order contains slots that do not exist: {0} (use listSlots)',
  '绘制顺序必须是完整序列，漏了：{0}':
    'The draw order must be the complete sequence; missing: {0}',
  '附件「{0}」不是网格/遮罩，打不了 FFD（网格先用 convertToMesh；遮罩用 createMask / convertToMask）':
    'Attachment "{0}" is not a mesh/mask, so FFD cannot be keyed (convert to mesh with convertToMesh first; for masks use createMask / convertToMask)',
  'offsets 长度必须是点数的 2 倍：该附件有 {0} 个点（网格顶点 / 遮罩控制点），需要 {1} 个数字，收到 {2}':
    'offsets length must be twice the vertex count: this attachment has {0} points (mesh vertices / mask control points), so it needs {1} numbers; received {2}',
  '动画「{0}」里没有骨骼「{1}」的轨道':
    'Animation "{0}" has no track for bone "{1}"',
  '插槽不存在：{0}': 'Slot not found: {0}',
  '动画「{0}」里没有插槽「{1}」的轨道':
    'Animation "{0}" has no track for slot "{1}"',
  '插槽通道只能是 display / color / visible / subArmature，收到 {0}':
    'Slot channels must be display / color / visible / subArmature; received {0}',
  '动画「{0}」里没有 {1} / {2} 的 FFD 轨道':
    'Animation "{0}" has no FFD track for {1} / {2}',
  '没有落在 {0} 秒的关键帧': 'No keyframe at {0}s',
  'easing 只能是 linear / stepped / bezier，收到 {0}':
    'easing must be linear / stepped / bezier; received {0}',
  'easing = bezier 时必须给 curve：[cx1, cy1, cx2, cy2]（4 个数字）':
    'easing = bezier requires curve: [cx1, cy1, cx2, cy2] (4 numbers)',

  // 创建 / 设置类命令（skeletonOps）的报错
  '父骨骼': 'Parent bone',
  '宿主骨骼': 'Host bone',
  '新宿主骨骼': 'New host bone',
  '被驱动骨骼': 'Driven bone',
  '目标骨骼': 'Target bone',
  'IK 目标骨骼': 'IK target bone',
  '{0}不存在：{1}（用 listBones 查现有骨骼名）':
    '{0} not found: {1} (use listBones to see existing bone names)',
  '换父级失败：{0}': 'Failed to change the parent: {0}',
  '换宿主失败：{0} → {1}': 'Failed to change the host: {0} → {1}',
  '骨架里还没有骨骼，插槽必须挂在骨骼上：先用 addBone 建一根':
    'The skeleton has no bones yet, and a slot must be attached to a bone: create one with addBone first',
  '骨架里还没有骨骼：先用 addBone 建一根':
    'The skeleton has no bones yet: create one with addBone first',
  'blendMode 不合法：{0}（只能是 {1}）': 'Invalid blendMode: {0} (must be one of {1})',
  'IK 的骨链必须「父 → 子」连续：{0} 不构成一条链（顺序给反了会自动翻转）':
    'An IK bone chain must be continuous parent → child: {0} is not a chain (reversed order is flipped automatically)',
  'IK 至少需要一根被驱动的骨骼，并且必须是父 → 子连续的链':
    'IK needs at least one driven bone, and they must form a continuous parent → child chain',
  '至少要给一个要改的字段：armature / animation / playTimes / offset / speed':
    'Provide at least one field to change: armature / animation / playTimes / offset / speed',
  '新动画名不能为空': 'The new animation name cannot be empty',
  '动画名已被占用：{0}': 'Animation name already taken: {0}',
  'duration 必须是不小于 0 的数字（单位：秒）':
    'duration must be a number greater than or equal to 0 (in seconds)',

  // 命令执行 / 查找的报错
  '用 GET /commands 查全部命令名': 'Use GET /commands to list all command names',
  '没有这个命令：{0}（是不是想用 {1}？{2}）':
    'No such command: {0} (did you mean {1}? {2})',
  '没有这个命令：{0}（{1}）': 'No such command: {0} ({1})',

  // ── 导入外部骨架（Spine / DragonBones）：选择「新建工程 / 并入当前工程」 ──
  '导入 {0}': 'Import {0}',
  '请选择这份资源要导入到哪里：': 'Choose where this asset should go:',
  '创建新工程': 'Create a new project',
  '用导入的资源替换当前工程，适合把一个 Spine / DragonBones 资源单独做成工程':
    'Replace the current project with the imported asset — best when one Spine / DragonBones asset should become its own project',
  '导入当前工程': 'Import into the current project',
  '把导入的骨架加进当前工程，成为工程里的新骨架；图片池共享，可在顶部骨架栏切换':
    'Add the imported skeleton to the current project as a new skeleton; the image pool is shared and you can switch skeletons in the top bar',
  '当前工程有未保存的改动：创建新工程会整份替换当前文档，这些改动不会保留。':
    'The current project has unsaved changes: creating a new project replaces the whole document and those changes will not be kept.',
  '导入后仍可 Ctrl+Z 撤销': 'You can still undo the import with Ctrl+Z',
  '已取消导入': 'Import cancelled',
  '已把 Spine 骨架「{0}」并入当前工程：{1} 骨骼 / {2} 插槽 / {3} 动画':
    'Added the Spine skeleton "{0}" to the current project: {1} bones / {2} slots / {3} animations',
  '已把 Spine 骨架「{0}」并入当前工程：{1} 骨骼 / {2} 动画':
    'Added the Spine skeleton "{0}" to the current project: {1} bones / {2} animations',
  '已把 DragonBones 骨架「{0}」并入当前工程：{1} 骨骼 / {2} 插槽 / {3} 动画':
    'Added the DragonBones skeleton "{0}" to the current project: {1} bones / {2} slots / {3} animations',
  '已把 {0} 个 DragonBones 骨架并入当前工程（{1}），当前编辑「{2}」':
    'Added {0} DragonBones skeletons to the current project ({1}); now editing "{2}"',
  '骨架「{0}」与现有骨架重名，已重命名为「{1}」':
    'The skeleton name "{0}" is already taken, so it was renamed to "{1}"',
  '图片「{0}」与现有图片重名，已重命名为「{1}」':
    'The image name "{0}" is already taken, so it was renamed to "{1}"',

  // ── LinkedMesh（链接网格：一套几何 + 多套皮肤换贴图） ────────────────────
  '链接网格': 'Linked mesh',
  '链接网格「{0}」找不到源网格：先修好源皮肤 / 源网格，或在属性面板里「解链为独立网格」':
    'Linked mesh "{0}" has no source mesh: fix the source skin / mesh first, or use "Unlink to independent mesh" in the inspector',
  '目标皮肤不存在：{0}': 'Target skin does not exist: {0}',
  '源皮肤不存在：{0}': 'Source skin does not exist: {0}',
  '源皮肤「{0}」的插槽「{1}」里没有附件「{2}」': 'Skin "{0}" has no attachment "{2}" in slot "{1}"',
  '源附件「{0}」是 {1}，链接网格的几何只能来自网格（先用 convertToMesh）':
    'Source attachment "{0}" is {1}; a linked mesh can only take geometry from a mesh (convert it with convertToMesh first)',
  '源网格「{0}」没有顶点，链接不出可见几何':
    'Source mesh "{0}" has no vertices, so the linked mesh would have no visible geometry',
  '没能按「{0}」的图集区域重算 UV：贴图会沿用源网格那块（画出来是源皮肤的样子），换一张有区域信息的图或手动调 UV':
    'Could not recompute UVs from the atlas region of "{0}": the source mesh UVs are reused (it will look like the source skin). Pick an image with region info or adjust the UVs manually',
  '皮肤不存在：{0}': 'Skin does not exist: {0}',
  '找不到附件：{0} / {1}': 'Attachment not found: {0} / {1}',
  '附件「{0}」不是链接网格（{1}）': 'Attachment "{0}" is not a linked mesh ({1})',
  '源附件「{0}」不是可用网格（{1}）': 'Source attachment "{0}" is not a usable mesh ({1})',
  '链接网格不能把自己当源网格': 'A linked mesh cannot use itself as its source mesh',
  '没能按「{0}」的图集区域重算 UV：贴图会沿用源网格那块（画出来是源皮肤的样子）':
    'Could not recompute UVs from the atlas region of "{0}": the source mesh UVs are reused (it will look like the source skin)',
  '新图「{0}」里找不到对应区域：UV 已清空，运行期会沿用源网格那块':
    'The new image "{0}" has no matching region: UVs were cleared and the runtime falls back to the source mesh UVs',
  '找不到源网格：链接的几何复制不了，先修好源皮肤 / 源网格再解链':
    'Source mesh not found: there is no geometry to copy; fix the source skin / mesh before unlinking',
  '{0}改的是绑定数据：先 setMode 切到 pose（Animate 态只动关键帧）':
    '{0} changes rig data: switch to pose with setMode first (the Animate mode only edits keyframes)',
  '新建链接网格': 'New linked mesh',
  '新建链接网格…': 'New linked mesh…',
  '已创建链接网格：{0} / {1}': 'Created linked mesh: {0} / {1}',
  '修改链接源': 'Change linked mesh source',
  '已把「{0}」的源网格改成「{1}」': 'Changed the source mesh of "{0}" to "{1}"',
  '给链接网格换图': 'Change linked mesh image',
  '已把「{0}」换成图片「{1}」': 'Changed "{0}" to image "{1}"',
  '解链为独立网格': 'Unlink to independent mesh',
  '解链': 'Unlink',
  '已解链为独立网格：{0} / {1}（{2} 顶点）': 'Unlinked to an independent mesh: {0} / {1} ({2} vertices)',
  '已解链为独立网格（{0} 顶点）': 'Unlinked to an independent mesh ({0} vertices)',
  '「{0}」是链接网格：几何来自源网格「{1}」，请切到源网格编辑，或在属性面板里「解链为独立网格」':
    '"{0}" is a linked mesh: its geometry comes from the source mesh "{1}". Edit the source mesh, or use "Unlink to independent mesh" in the inspector',
  '「{0}」是链接网格，但找不到源网格：先修好源皮肤 / 源网格，或解链为独立网格':
    '"{0}" is a linked mesh but its source mesh is missing: fix the source skin / mesh, or unlink it',
  '几何来自「{0}」（{1}）：改形状请编辑源网格，这里只决定贴图与 UV':
    'Geometry comes from "{0}" ({1}): edit the source mesh to change the shape; this attachment only controls texture and UVs',
  '找不到源网格：先修好源皮肤 / 源网格（层级树右键这条 display 可改源），或解链为独立网格':
    'Source mesh not found: fix the source skin / mesh (right-click this display in the hierarchy to change the source), or unlink it',
  '默认皮肤': 'Default skin',
  '默认皮肤（{0}）': 'Default skin ({0})',
  '源皮肤': 'Source skin',
  '源网格': 'Source mesh',
  '附件名': 'Attachment name',
  '与源网格同名': 'Same name as the source mesh',
  '（沿用源网格的图）': '(use the source mesh image)',
  '改链接网格的源': 'Change linked mesh source',
  '改源网格…': 'Change source mesh…',
  '当前源：{0}': 'Current source: {0}',
  '当前源：与自身同名': 'Current source: same name as itself',
  '已把源网格改成「{0}」': 'Changed the source mesh to "{0}"',
  '把源网格的几何 / 权重复制到这一条，之后与源网格无关（可 Ctrl+Z 撤销）':
    'Copy the source mesh geometry / weights into this attachment so it no longer depends on the source (Ctrl+Z to undo)',
  '顶点 {0} · 三角面 {1}（来自源网格，只读）': 'Vertices {0} · Triangles {1} (from the source mesh, read-only)',
  '顶点数未知：源网格缺失': 'Vertex count unknown: source mesh missing',
  '链接网格的几何 / 权重在源网格上编辑；Animate 态仍可给这一条单独打 FFD 帧':
    'Linked mesh geometry / weights are edited on the source mesh; in Animate mode you can still key FFD frames on this attachment',
  '添加链接网格…': 'Add linked mesh…',
  '复用其它皮肤同插槽的网格几何，只换这一条自己的贴图':
    'Reuse the mesh geometry of another skin in the same slot, with its own texture',
  '以「{0}」的几何为源，只换这一条自己的贴图':
    'Use the geometry of "{0}" as the source and give this attachment its own texture',
  '复制源网格的几何与权重，之后与源网格无关':
    'Copy the source mesh geometry and weights; it will no longer depend on the source',
  '会把源网格的顶点 / 三角面 / 权重复制到「{0}」名下，之后它就是普通网格：源网格再改形状也不会影响它。':
    'Copies the source mesh vertices / triangles / weights into "{0}", which becomes a regular mesh and no longer follows the source shape.',
  '顶点数不变，已有的 FFD 关键帧仍然有效。':
    'The vertex count stays the same, so existing FFD keyframes remain valid.',
  '可 Ctrl+Z 撤销': 'Ctrl+Z to undo',
  '创建后可 Ctrl+Z 撤销': 'Ctrl+Z to undo the creation',
  '源皮肤的这个插槽里没有网格：先在源皮肤里把图片转成网格，或换一个皮肤':
    'No mesh in this slot of the source skin: convert an image to a mesh in that skin first, or pick another skin',
  '改源只换几何来源，贴图与 UV 会按新源重算':
    'Changing the source only swaps the geometry source; texture and UVs are recomputed',
  '几何（顶点 / 三角面 / 权重）来自源网格，这里只决定贴图与 UV。附件名与源同名 = 覆盖该插槽的显示':
    'Geometry (vertices / triangles / weights) comes from the source mesh; this dialog only decides texture and UVs. Using the same name as the source replaces what this slot displays',

  // ── 资源面板：图片多选删除 ──────────────────────────────────────────
  '已选中 {0} 张图片': '{0} images selected',
  '删除 {0} 张图片': 'Delete {0} images',
  '从工程移除选中的所有图片（被引用的附件退化为纯色，可一次撤销）':
    'Remove all selected images from the project (attachments that use them fall back to a solid color; undone in one step)',
  '已删除 {0} 张图片': 'Deleted {0} images',
  '已删除 {0} 张图片（{1} 个附件的贴图已清空）':
    'Deleted {0} images ({1} attachments had their texture cleared)',
  '选中的 {0} 张图片共被 {1} 个附件引用。\n删除后这些附件会丢失贴图、退化为纯色块（附件本身保留）。\n确定删除？':
    'The {0} selected images are referenced by {1} attachments.\nAfter deleting, those attachments lose their texture and fall back to a solid color (the attachments themselves stay).\nDelete anyway?',

  // ── 导出视频（VideoExportDialog） ────────────────────────────────────
  '导出视频': 'Export Video',
  '把当前动画渲染成 mp4 视频：可选画幅 / 背景色 / 取景，按工程帧率导出':
    'Render the current animation to an mp4: pick the frame size / background color / framing; exports at the project frame rate',
  '选择视频导出目录': 'Choose the video output folder',
  '先选择导出目录': 'Choose an output folder first',
  '已取消导出': 'Export cancelled',
  '视频已导出': 'Video exported',
  '拖动平移 · 滚轮缩放 · {0} × {1} · {2} 帧 · {3} · {4} fps':
    'Drag to pan · wheel to zoom · {0} × {1} · {2} frames · {3} · {4} fps',
  '背景色': 'Background',
  '自定义': 'Custom',
  '宽（自动对齐到偶数）': 'Width (rounded up to an even number)',
  '高（自动对齐到偶数）': 'Height (rounded up to an even number)',
  '缩放 %': 'Zoom %',
  '偏移 X': 'Offset X',
  '偏移 Y': 'Offset Y',
  '重置取景': 'Reset framing',
  '目录': 'Folder',
  '（未选择）': '(none)',
  '选择目录': 'Choose folder',
  '第 {0} / {1} 帧': 'Frame {0} / {1}',
  '导出 MP4': 'Export MP4',
  '已导出：{0}': 'Exported: {0}',
  '在文件夹中显示': 'Show in folder',
  '导出中，先取消再关闭': 'Exporting — cancel before closing',
  '（没有动画）': '(no animations)',
  '视口还没就绪：等编辑器画完一帧再导出': 'The viewport is not ready yet: let the editor render one frame, then export',
  '浏览器模式不支持导出视频（请在桌面版里导出）':
    'Exporting video is not available in the browser build (use the desktop app)',
}
