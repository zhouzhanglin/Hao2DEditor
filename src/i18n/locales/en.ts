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
  '单棵树：插槽挂在宿主骨骼下，约束挂在驱动骨骼下': 'Single tree: slots sit under their host bone, constraints under their driving bone',
  '图标区分类型': 'Icons distinguish types',
  'slot 层级': 'Slot Order',
  '调整会写入绘制顺序帧': 'Edits are written as draw-order keyframes',
  '绘制顺序（setup）': 'Draw order (setup)',
  '曲线': 'Curves',
  '选中关键帧后拖控制点': 'Select a keyframe, then drag a control point',
  '资源与皮肤': 'Assets & Skins',
  '拖动上方分隔条调高': 'Drag the divider above to resize',

  // ── 视口 ──────────────────────────────────────────────────────────────
  '视口': 'Viewport',
  'Pose · 绑定状态（编辑 setup）': 'Pose · Bind mode (edit setup)',
  'Animate · 动画编辑状态': 'Animate · Animation editing mode',
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

  // ── 曲线面板 ────────────────────────────────────────────────────────
  '选中关键帧后拖控制点，或点预设按钮；多选时预设作用于全部选中帧。':
    'After selecting keyframes, drag the control points or click a preset; with multiple keyframes selected the preset applies to all of them.',

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
  '选择项目的保存位置（会在里面建一个 <项目名>.hao2d.proj）':
    'Choose where to save the project (a <project name>.hao2d.proj will be created inside)',
  '项目名': 'Project name',
  '必填，不能含空格或 / \\ : * ? " < > |，例如 dragon_01 或 龙_01':
    'Required; no spaces or / \\ : * ? " < > |, e.g. dragon_01',
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
    'Project name cannot contain spaces or filesystem-illegal characters (/ \\ : * ? " < > |)',
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
  '阶跃：保持前一帧直到下一关键帧': 'Stepped: hold the previous frame until the next keyframe',
  '线性：匀速插值': 'Linear: constant-rate interpolation',
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
  '没有轨道：在 Pose 状态调整骨骼/插槽后按 K 打关键帧':
    'No tracks yet: adjust bones/slots in Pose mode and press K to key',
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
  '+ 动画': '+ Animation',
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
  '在当前时间插入事件帧（事件名 / 字符串 / 整数 / 浮点在视口下方的值栏里改）':
    'Insert an event frame at the current time (edit the name / string / int / float in the value bar below the viewport)',
  '事件帧': 'Event frame',
  '删除选中的关键帧（Delete）': 'Delete the selected keyframes (Delete)',
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
  '刷过的顶点权重归一到 1；关掉就只改目标骨骼，权重和可能不等于 1':
    'Normalize painted vertex weights to 1; when off, only the target bone changes and the weight sum may not equal 1',
  'Hardness 100 = 一次刷满；按住修饰键临时改方向：Alt=减少 / Shift=覆盖 / Ctrl=平滑 / Ctrl+Shift=生长':
    'Hardness 100 = fully painted in one pass; hold a modifier to temporarily change direction: Alt = subtract / Shift = replace / Ctrl = smooth / Ctrl+Shift = grow',
  '整体染色': 'Global tint',
  '染色与插槽色、附件色相乘，用于快速检查叠加效果':
    'Tint multiplies with slot and attachment colors; handy for quickly checking the blended result',
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
  '「{0}」还没有关键帧': '"{0}" has no keys yet',
  '没有关键帧可删（显示 / 子骨架 是常驻入口行）':
    'No keys to delete (Display / Sub-armature rows are always-visible entry rows)',
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
}
