# Hao2DEditor 命令速查（骨骼动画相关）

> 本文件由 `scripts/gen-skill-commands.mjs` 从**命令注册表**生成，不要手改；
> 改了命令就跑 `npm run gen:skill-docs` 重新生成。
>
> 唯一权威来源是编辑器本身：`GET {url}/commands`（含每条的 `example` 与实时参数说明）。
> 这里按「做动画时用到的顺序」重排过，方便当离线速查。
> 所有命令统一返回 `{ ok, changed, data, message, error, label }`；`ok:false` 时读 `error`。

参数写法：`名字`*(类型) 表示必填；`名字`?(类型=默认值) 表示可选；`'a'|'b'` 表示取值枚举。

共 136 条命令，分 11 组。

## 状态与查询（开工前、收工后）

| 命令 | 参数 | 说明 | 返回 |
| --- | --- | --- | --- |
| `captureViewport` | — | 把视口当前画面截成 PNG（含背景棋盘格、角色与叠加层），返回 base64 data URL。AI 想「亲眼看到」编辑器里显示的画面时用它。窗口在后台 / 没激活也能截（命令执行前会自己刷新一帧），失败直接重试即可 | dataUrl（data:image/png;base64,…）/ width / height |
| `getAnimationKeys` | `animation`?(string) 动画名（可选，默认当前编辑动画）<br>`bone`?(string) 只查这根骨骼的轨道（可选）<br>`slot`?(string) 只查这个插槽的轨道（可选） | 把某条动画的关键帧明细拉出来（可只查一根骨骼 / 一个插槽），用来核对打帧结果或做批量改帧前的读取 | animation / duration / bones[{ bone, channel, keys:[{time,value,easing}] }] / slots[...] / deforms[...] / drawOrder[...] |
| `getAttachmentVertices` | `slot`*(string) 插槽名<br>`attachment`*(string) 附件名<br>`skin`?(string) 皮肤名（可选，默认当前皮肤） | 拉出某个网格或遮罩附件的全部顶点：坐标 + 每根骨骼的权重。蒙皮调试、手写权重或给遮罩打 FFD 前读它 | type / vertexCount / vertices: [{ index, x, y, weights: [{bone, weight}] }] / triangles / boundBones |
| `getBoneWorldTransform` | `bone`*(string) 骨骼名 | 骨骼在视口世界坐标下的位置 / 旋转 / 缩放（含父级累积）。要在世界坐标里摆东西（IK 节点骨、附件落点）时用它换算 | x / y / rotation（度）/ scaleX / scaleY；场景未就绪时 ok:false |
| `getDisplayWorldBounds` | `slot`*(string) 插槽名<br>`attachment`*(string) 附件名<br>`skin`?(string) 皮肤名（可选，默认当前皮肤） | 附件在视口世界坐标下的 AABB（当前 setup pose）。**参考图对位的主力命令**：挂上一个部件就读它，与参考图量出的目标框对比，再用 setDisplayTransform 修——数值闭环，不用截图也不用在外部自己算坐标。网格按绑定姿态顶点近似（蒙皮形变不含在内） | type / worldBounds{minX,minY,maxX,maxY} / center{x,y} / width / height |
| `getHierarchy` | — | 一次性拿出当前骨架全貌：骨骼父子树（嵌套）+ 插槽与附件 + 约束 + 动画。等价于「读整个编辑器结构」，AI 先读它掌握全局，不必逐个 list* | armatureName / skeletonCount / skeletons[{armatureName, active, animations}] / boneTree[…] / slots[…]（displays 里嵌套骨架带 nested）/ constraints[…] / animations[…] |
| `getMask` | `slot`*(string) 插槽名<br>`attachment`*(string) 遮罩附件名<br>`skin`?(string) 皮肤名；不传 = 跨皮肤查找 | 读一个遮罩的全部控制点与选项。points 是插槽骨骼局部坐标；用这些 index 调 setMaskPoint / insertMaskPoint / deleteMaskPoint，或给 keyDeformFrame 算 offsets | { skin, slot, bone, attachment, pointCount, points, endSlot, inverse, convex, displayed, zOrder } |
| `getProjectState` | — | 当前工程名、保存路径、是否有未保存改动、有几个骨架、撤销栈状态。AI 开工前先读它 | projectName / projectPath / dirty / activeSkeleton / skeletonCount / canUndo / canRedo / warnings / next（建议的下一步） |
| `getSelection` | — | 层级树 / 视口里当前选中的对象与顶点。AI 想「对用户选中的东西做事」时读它 | kind（none/bone/slot/attachment/constraint）/ bone / bones / slot / skin / attachment / constraint / vertices |
| `getViewport` | — | 视口相机与可见范围：像素尺寸、缩放、平移量、当前可见的世界矩形、角色包围盒，以及当前模式 / 皮肤 / 动画 / 播放状态。AI 想「看屏幕」或做屏幕↔世界坐标换算时用它 | width / height / zoom / offset{x,y} / unitsPerPixel / worldView{minX,minY,maxX,maxY} / contentBounds / mode / activeSkin / animation / playing / time / next（建议的下一步） |
| `listAnimations` | — | 列出全部动画：时长、各轨道的关键帧数量与最后一帧时间。打帧前先读它确认动画名 | animations: [{ name, duration, lastKeyTime, bones, slots, deforms, drawOrder, active }] |
| `listBones` | `name`?(string) 只看某一根（可选，按名字精确匹配） | 列出全部骨骼（按工程里的顺序），含父级、局部变换、骨长。构建骨架前先读它拿准名字 | bones: [{ name, parent, localPosition, rotation, localScale, length, color, locked, children }] |
| `listConstraints` | — | 列出全部约束：类型、被驱动的骨链、目标骨、是否启用、优先级 | constraints: [{ name, type, bones, target, order, enabled }] |
| `listDisplays` | `slot`?(string) 插槽名（可选，不传则列全部）<br>`skin`?(string) 皮肤名（可选，默认当前皮肤） | 列出某个插槽（或全部插槽）在各皮肤下的附件：类型、图片、顶点数、权重绑了哪些骨骼；嵌套骨架 display 还带引用的骨架与默认播放参数 | displays: [{ slot, skin, name, type, image, size, vertexCount, bones, nested?: { armature, animation, playTimes, offset, speed } }] |
| `listImages` | — | 列出图片池里可用的图片（名字与像素尺寸）。addDisplay 要用这里的名字 | images: [{ name, path, width, height }] |
| `listMasks` | — | 列出工程里所有遮罩附件（按皮肤 / 插槽）。要控制点明细用 getMask | { masks: [{ skin, slot, bone, attachment, pointCount, endSlot, inverse, convex, displayed }] } |
| `listSkins` | — | 列出全部皮肤与各自槽数，标出当前皮肤 | active / skins: [{ name, slots, active }] |
| `listSlots` | `name`?(string) 只看某一个（可选）<br>`withDisplays`?(boolean=true) 是否带上附件名清单，默认 true | 列出全部插槽，含宿主骨骼、绘制层序、setup pose 显示的附件、以及它的附件名清单 | slots: [{ name, bone, zOrder, attachment, visible, locked, blendMode, color, displays }] |

## 工程与素材

| 命令 | 参数 | 说明 | 返回 |
| --- | --- | --- | --- |
| `createProject` | `name`*(string) 项目名（不能为空，也用于工程文件名）<br>`dir`*(string) 保存目录（绝对路径）<br>`frameRate`?(number) 帧率 24 / 30 / 60；不传用 30 | 新建工程并**立刻写出**工程文件到 dir 目录下（文件名为 <name>.hao2d.proj）。新工程图片池是空的，随后的图片靠 importImage / splitAtlas 等补 | { projectName, path, next } |
| `deleteImage` | `image`*(string) 图片名（用 listImages 查）<br>`force`?(boolean=false) 有附件引用时也照删 | 从图片池删掉一张图。仍被附件引用时默认拒绝执行，确认要删就带 force: true（引用它的附件会退化成纯色，附件本身保留） | { image, references } |
| `importDragonBones` | `jsonPath`*(string) DragonBones 骨骼 JSON 的绝对路径 | 按路径导入 DragonBones 骨骼 JSON（**整份替换**当前文档，不弹「新建工程 / 并入当前工程」确认框）。同目录的 texture_*.json 图集会被自动收集 | { bones, slots, animations } |
| `importImage` | `data`?(string) 图片字节：base64 或 dataURL（与 path 二选一）<br>`path`?(string) 本地图片绝对路径（与 data 二选一）<br>`name`?(string) 图片名（不含目录与扩展名）；不传用原文件名<br>`ext`?(string) data 模式下的格式（png/jpg/jpeg/webp/gif），不传从 dataURL 推断或默认 png | 把一张图片写进工程目录的 images/ 并登记到图片池，供 addDisplay 做成附件。图片来源二选一：data（base64 或 dataURL）/ path（本地绝对路径）。工程需先保存或创建（确定 images/ 目录）。name 不传用原文件名自动命名，重名自动加序号 | { name, width, height, path } |
| `importImages` | `paths`*(array) 图片绝对路径数组（png / jpg / webp / gif / bmp） | 把多张外部图片按路径登记进图片池（自动去重）。要单张带内容导入用 importImage（支持 dataURL / base64） | { added, total, next } |
| `importSpine` | `jsonPath`*(string) Spine 骨骼 JSON 的绝对路径 | 按路径导入 Spine 骨骼 JSON（**整份替换**当前文档，不弹「新建工程 / 并入当前工程」确认框）。同目录需有 .atlas 图集文件，会被自动读取 | { bones, slots, animations } |
| `newProject` | — | 新建一个**空白**工程（默认项目名 + 一根根骨骼 root），但不写盘、不留保存路径；要落盘请接着调 saveProject，或直接用 createProject | { projectName, path } |
| `openProject` | `path`*(string) 工程文件绝对路径 | 打开指定路径的工程文件（按内容解析，不看后缀）。失败时不会动当前文档 | { path, skeletons } |
| `replaceImage` | `image`*(string) 图片名<br>`path`*(string) 新的图片文件路径<br>`width`*(number) 新图宽度（像素）<br>`height`*(number) 新图高度（像素） | 把图片池里某张图的来源换成另一个文件并更新尺寸（名字不变，所有附件引用自动跟随）。width / height 是**像素尺寸**，要自己量好再传 | { image, path, width, height } |
| `saveProject` | `path`?(string) 另存到的文件路径；不传则写回当前工程路径 | 把工程写到磁盘（图片会一并复制到 <工程目录>/images/）。工程已有保存路径时直接写回；否则用 path 指定目标文件。**不会弹保存对话框** | { path, warnings } |
| `setExportScale` | `scale`*(number) 缩放（0.25 ~ 1，>0） | 写入导出图集缩放（纯偏好，保存工程时落地） | { scale } |
| `setProjectName` | `name`*(string) 新的工程名（不能为空） | 改工程名（窗口标题与导出标题用它，保存时写进工程文件）。**不会**重命名磁盘上的工程文件 | { projectName } |
| `splitAtlas` | `name`*(string) 图集图片名 | 把图集页（loose=false，即用 Spine / DragonBones 导入带来的整页图集）按记录的区域拆成独立碎图，写到 <图集名>_split/，并让所有引用它的附件改指碎图。图集图片名用 listImages 查 | { message } |

## 骨骼

| 命令 | 参数 | 说明 | 返回 |
| --- | --- | --- | --- |
| `addBone` | `name`?(string) 骨骼名；不传则按「父名_child」自动生成<br>`parent`?(string) 父骨骼名；不传则挂到层级根骨骼下<br>`localPosition`?(object) 相对父级的局部位置 {x,y}<br>`rotation`?(number) 相对父级的旋转（度）<br>`length`?(number) 骨长，默认 0.4<br>`color`?(string) 骨骼显示颜色，如 #ff8800 | 新建一根骨骼。不传 parent 就挂到层级根骨骼下；名字重名会自动加序号 | { name, parent } —— name 是最终落定的名字（可能带序号），后续命令都用它 |
| `deleteBone` | `bone`*(string) 骨骼名 | 删除骨骼（连带它的子骨骼与挂在它上面的插槽） | { bone } |
| `moveBone` | `bone`*(string) 要移动的骨骼名<br>`target`?(string) 目标骨骼名；空串 = 层级根骨骼<br>`zone`?('inside'\|'above'\|'below'=inside) 落点：inside = 成为目标的子级；above / below = 与目标同级并排在它前 / 后 | 把骨骼挂到另一根骨骼下（inside）或排到它旁边（above / below）。视口就绪时保持全局位姿不变。target 传空串 = 挂回层级根骨骼 | { bone, target, zone, keptWorldPose } |
| `renameNode` | `kind`*('bone'\|'slot'\|'attachment'\|'constraint') 改什么<br>`name`*(string) 现在的名字（附件 = 附件名）<br>`nextName`*(string) 新名字<br>`slot`?(string) 附件所在插槽名（kind=attachment 时必给） | 给骨骼 / 插槽 / 附件 / 约束改名，文档里所有引用（父级、宿主、动画轨道、display 帧…）自动级联更新 | { kind, from, to } |
| `setBoneTransform` | `bone`*(string) 骨骼名<br>`parent`?(string) 换父级到这根骨骼；空串 = 变成顶层骨骼<br>`localPosition`?(object) 局部位置 {x,y}<br>`rotation`?(number) 局部旋转（度）<br>`localScale`?(object) 局部缩放 {x,y}<br>`localShear`?(object) 局部斜切 {x,y}<br>`length`?(number) 骨长<br>`color`?(string) 显示颜色<br>`locked`?(boolean) 锁定（视口里点不中）<br>`hollow`?(boolean) 空心显示<br>`inheritRotation`?(boolean) 继承父级旋转<br>`inheritScale`?(boolean) 继承父级缩放 | 一次性写入骨骼的一组属性（只改传了的字段）。换父级也用它：传 parent，会自动保持全局位姿 | { bone, changedFields: [...] } |

## 插槽与附件

| 命令 | 参数 | 说明 | 返回 |
| --- | --- | --- | --- |
| `addConstraint` | `kind`*('ik'\|'transform'\|'path') 约束类型<br>`name`?(string) 约束名；不传则用类型名，重名自动加序号<br>`bones`?(array) 被驱动的骨链，父 → 子顺序（字符串数组）<br>`target`?(string) 目标骨骼名（IK 目标 / 变换来源骨 / 路径骨）<br>`nodePosition`?(object) IK 自动新建节点骨时的落点（世界坐标 {x,y}）<br>`nodeName`?(string) IK 自动新建节点骨的名字，默认「链尾_ik」 | 新建 IK / 变换 / 路径约束。IK 的 bones 要给「父 → 子」连续的骨链（顺序反了会自动翻转）；不传 target 会自动新建一根 IK 节点骨摆在链尾末端 | { name, kind, bones, target, nodeBone? } |
| `addDisplay` | `slot`*(string) 插槽名<br>`image`*(string) 图片名（用 listImages 查）<br>`name`?(string) 附件名；不传则用图片名去扩展名，重名自动加序号<br>`position`?(object) 附件在骨骼局部空间的位置 {x,y}<br>`skin`?(string) 目标皮肤；不传则用当前皮肤 | 往插槽里加一个图片附件。尺寸自动从图片池取，不用自己算 | { slot, attachment } |
| `addSlot` | `name`?(string) 插槽名；不传则为 slot<br>`bone`?(string) 宿主骨骼名；不传则用层级根骨骼<br>`zOrder`?(number) 绘制层序（越小越先画）；不传则排到最后<br>`color`?(string) 插槽颜色 #RRGGBBAA<br>`visible`?(boolean) 是否可见<br>`locked`?(boolean) 锁定 | 新建插槽（插槽是附件的载体，必须挂在骨骼上）。不传 bone 就挂到层级根骨骼下 | { name, bone } |
| `deleteConstraint` | `constraint`*(string) 约束名 | 删除约束（不会删掉它引用的骨骼） | { constraint } |
| `deleteDisplay` | `slot`*(string) 插槽名<br>`attachment`*(string) 附件名 | 删除附件（跨所有皮肤）；若 setup pose 正显示它，会一并清空显示引用 | { slot, attachment } |
| `deleteSlot` | `slot`*(string) 插槽名 | 删除插槽（连带它的附件与相关动画轨道） | { slot } |
| `moveDisplay` | `slot`*(string) 附件当前所在插槽<br>`display`*(string) 附件名<br>`toSlot`*(string) 目标插槽名<br>`anchorDisplay`?(string) 排序锚点：放到这个附件的前 / 后（目标插槽内）<br>`side`?('before'\|'after'=after) 相对锚点的位置<br>`skin`?(string) 皮肤名；不传用当前皮肤 | 把附件搬到另一个插槽（会自动换算保持世界位姿、并同步 display 帧），或在同一插槽内排序。anchorDisplay / side 指定落点 | { slot, display, toSlot } |
| `moveSlot` | `slot`*(string) 插槽名<br>`bone`*(string) 新的宿主骨骼名<br>`anchorSlot`?(string) 排序锚点：插到这个插槽的前 / 后<br>`side`?('before'\|'after'=after) 相对锚点的位置（只在给了 anchorSlot 时有意义） | 把插槽挂到另一根骨骼下，并用 anchorSlot / side 指定在目标骨骼插槽列表里的落点（不传 anchorSlot 则排到末尾）。会把附件换算到新骨骼空间，画面位置不变 | { slot, bone } |
| `setConstraint` | `constraint`*(string) 约束名<br>`enabled`?(boolean) 是否启用<br>`target`?(string) 新的目标骨骼名<br>`order`?(number) 优先级（越小越先算）<br>`bones`?(array) IK 的新骨链，父 → 子顺序（字符串数组） | 改约束的启用状态 / 目标骨 / 优先级（计算顺序）。IK 也可以重设骨链 | { constraint, changedFields: [...] } |
| `setDisplayTransform` | `slot`*(string) 插槽名<br>`attachment`*(string) 附件名<br>`position`?(object) 位置 {x,y}（骨骼局部空间）<br>`rotation`?(number) 旋转（度）<br>`scale`?(object) 缩放 {x,y}<br>`size`?(object) Region 显示尺寸 {x,y}<br>`color`?(string) 附件颜色 #RRGGBBAA<br>`image`?(string) 换图（图片名） | 写入附件的位移 / 旋转 / 缩放 / 尺寸 / 颜色 / 换图（跨所有皮肤同步改） | { slot, attachment, changedFields: [...] } |
| `setDrawOrder` | `order`*(array) 插槽名数组（绘制顺序：先画的在前） | 一次性重排全部插槽的绘制顺序。order 必须**包含所有插槽名**（只给一部分无法确定唯一顺序），第 0 个最先画（最底层） | { order } |
| `setSlotHost` | `slot`*(string) 插槽名<br>`bone`*(string) 新的宿主骨骼名 | 把插槽挂到另一根骨骼下，并保持内容的全局位置 / 旋转 / 缩放不变 | { slot, bone } |
| `setSlotProps` | `slot`*(string) 插槽名<br>`color`?(string) 插槽颜色 #RRGGBBAA（与附件颜色相乘）<br>`blendMode`?('Normal'\|'Additive'\|'Multiply'\|'Screen') 混合模式<br>`attachment`?(string) setup pose 显示的附件名；空串 = 不显示<br>`visible`?(boolean) 是否可见<br>`locked`?(boolean) 锁定 | 写入插槽的颜色 / 混合模式 / 可见性 / 锁定 / setup 显示项。换宿主骨骼请用 setSlotHost（那个会保持全局位姿） | { slot, changedFields: [...] } |

## 网格与蒙皮

| 命令 | 参数 | 说明 | 返回 |
| --- | --- | --- | --- |
| `autoMeshFromImage` | `slot`*(string) 插槽名<br>`attachment`*(string) 附件名（Region）<br>`divisions`?(number=8) 细分数（顶点数量级），默认 8 | 把 Region 附件（碎图）按不透明像素轮廓自动生成贴合的多边形网格，透明区不占三角形，比 convertToMesh 更省顶点、更贴合图形。需要视口已就绪（取图片像素）。divisions 控制顶点数量级，默认 8 | { slot, attachment, vertices, triangles, coverage } |
| `autoWeightMesh` | `slot`*(string) 插槽名<br>`attachment`*(string) 网格附件名<br>`bones`?(array) 参与加权的骨骼名数组；不传则用除层级根外的全部骨骼<br>`falloff`?(number=2) 距离衰减指数，越大越「硬」，默认 2<br>`maxBones`?(number=4) 每个顶点最多绑几根骨骼（最多 4），默认 4<br>`method`?(string=heat) 算法：heat（表面热扩散，默认）/ geodesic（表面距离 + 1/d^k）/ distance（直线距离）<br>`vertices`?(array) 只重算这些顶点下标；不传则整块网格 | 按「顶点离哪根骨骼近」自动分配权重（这是 AI 蒙皮的主力命令）。不传 bones 就用除层级根之外的全部骨骼。需要视口已就绪 | { slot, attachment, touched, bones } |
| `bindWeightBone` | `slot`*(string) 插槽名<br>`attachment`*(string) 网格附件名<br>`bone`*(string) 骨骼名 | 把一个网格附件绑到某根骨骼（让它出现在权重候选里，不影响已有权重） | { slot, attachment, bone } |
| `connectMeshVertices` | `slot`*(string) 插槽名<br>`attachment`*(string) 网格附件名<br>`from`*(number) 起点顶点下标<br>`to`*(number) 终点顶点下标 | 在网格的两个顶点之间连一条线（自定义布线）：沿这条线段把横穿的三角形重新三角化，其余区域不变。from / to 是顶点下标（用 getAttachmentVertices 取） | { slot, attachment, from, to } |
| `convertToMesh` | `slot`*(string) 插槽名<br>`attachment`*(string) 附件名<br>`divisions`?(number=2) 栅格细分数，默认 2 | 把图片附件转成可形变的网格（divisions 决定栅格密度，2 就是 2×2 网格）。转完才能打 FFD 帧、才能刷权重 | { slot, attachment, vertices, triangles } |
| `convertToOutlineMesh` | `slot`*(string) 插槽名<br>`attachment`*(string) 附件名<br>`divisions`?(number=8) 细分数，越大越贴合（顶点也越多），默认 8 | 沿图片不透明像素的轮廓生成贴合网格（比 convertToMesh 的规则栅格更贴合）。可重复执行；需要图片已解码（窗口已画过一帧） | { slot, attachment, vertices, triangles, coverage } |
| `convertToRegion` | `slot`*(string) 插槽名<br>`attachment`*(string) 附件名 | 把网格转回普通图片附件（会丢掉顶点与权重） | { slot, attachment } |
| `deleteMeshVertex` | `slot`*(string) 插槽名<br>`attachment`*(string) 网格附件名<br>`vertexIndex`*(number) 顶点下标 | 删除网格上的一个顶点（只剩 3 个顶点时不允许再删） | { slot, attachment, vertexIndex } |
| `insertMeshVertex` | `slot`*(string) 插槽名<br>`attachment`*(string) 网格附件名<br>`point`*(object) 插入位置（附件局部坐标 {x,y}） | 在网格的一条边上插入顶点并自动重连三角形。point 用**附件局部坐标**（与 getAttachmentVertices 读出来的一致），必须落在大致落在某条边上 | { slot, attachment, vertexIndex } |
| `moveMeshVertex` | `slot`*(string) 插槽名<br>`attachment`*(string) 网格附件名<br>`vertexIndex`*(number) 顶点下标<br>`point`*(object) 新位置（附件局部坐标 {x,y}） | 把绑定网格的一个顶点挪到新位置（改的是绑定网格，需 Pose 态；Animate 态改顶点形变用 keyDeformFrame）。point 用**附件局部坐标**（与 getAttachmentVertices 读出的一致）。内部顶点的 UV 会按邻居自动重算（贴图不跟着跑），边界顶点只挪位置不动 UV | { slot, attachment, vertexIndex, point, uvUpdated } |
| `redrawMeshBoundary` | `slot`*(string) 插槽名<br>`attachment`*(string) 网格附件名<br>`points`*(array) 依次点击的轮廓点 [{x,y}…]（附件局部坐标，与 getAttachmentVertices 一致） | 用一串依次点击的轮廓点（附件局部坐标）整块重画网格外边界：丢弃旧顶点、清空绑定权重与该附件的 FFD 关键帧，并重新三角化。首尾会自动闭合，至少需要 3 个点 | { slot, attachment, vertices, triangles } |
| `setVertexWeight` | `slot`*(string) 插槽名<br>`attachment`*(string) 网格附件名<br>`vertexIndex`*(number) 顶点下标<br>`bone`*(string) 骨骼名<br>`weight`*(number) 权重 0~1 | 精确写入一个顶点在某根骨骼上的权重（0~1）。骨骼不存在时会自动绑上。所有权重不足 1 的部分会归到宿主骨骼 | { slot, attachment, vertexIndex, bone, weight } |
| `swapWeightBones` | `slot`*(string) 插槽名<br>`attachment`*(string) 网格附件名<br>`boneA`*(string) 第一根骨骼名<br>`boneB`*(string) 第二根骨骼名<br>`vertices`?(array) 只改这些顶点下标；不传则整块网格 | 交换两根骨骼在这块网格上的权重。两根骨骼都要已绑到该网格；不传顶点就改整块网格 | { slot, attachment, boneA, boneB, touched } |
| `trimWeights` | `slot`*(string) 插槽名<br>`attachment`*(string) 网格附件名<br>`maxInfluences`?(number=4) 每顶点最多保留几根骨骼（1~4），默认 4<br>`threshold`?(number=0.01) 丢掉小于这个值的权重（0~1），默认 0.01<br>`vertices`?(array) 只处理这些顶点下标；不传则处理整块网格 | 权重修剪：丢掉过小的骨骼权重，并把每个顶点的影响骨骼数压到上限以内（默认丢掉 < 1%、每顶点最多 4 根，与导出/运行时一致）。同名骨骼会先合并，移除的权重按比例分给剩下的骨骼 | { slot, attachment, touched, removed, capped } |
| `unbindWeightBone` | `slot`*(string) 插槽名<br>`attachment`*(string) 网格附件名<br>`bone`*(string) 骨骼名 | 解绑一根权重骨骼，并把它在所有顶点上的权重清零 | { slot, attachment, bone } |

## 动画与关键帧（时间单位：秒，绝对时间点）

| 命令 | 参数 | 说明 | 返回 |
| --- | --- | --- | --- |
| `addAnimation` | `name`?(string) 动画名；不传则为 animation，重名自动加序号<br>`duration`?(number) 时长（秒），默认 1<br>`activate`?(boolean) 是否切为当前编辑动画，默认 true | 新建一条空动画，默认顺手切为当前编辑动画 | { name, duration } |
| `clearAnimationKeys` | `animation`?(string) 动画名；不传则用当前编辑动画 | 清空整条动画的所有关键帧（保留动画本身与时长），用于「推倒重做」 | { animation } |
| `clearTrack` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`kind`*('bone'\|'slot'\|'deform'\|'drawOrder') 轨道种类<br>`target`?(string) 骨骼名 / 插槽名；kind=drawOrder 时忽略<br>`attachment`?(string) kind=deform 时的附件名<br>`channel`*(string) 通道：bone 用 translate/rotate/scale/shear，slot 用 display/color/visible/subArmature<br>`time`?(number) 只删这一帧（秒）；不传则清空整条轨道 | 清空一条轨道上全部关键帧；只给 time 时删那一帧 | { cleared, animation } |
| `copyKeyframes` | — | 把时间轴上当前选中的关键帧复制进剪贴板（不改文档）。粘贴用 pasteKeyframes；轨道上有哪些关键帧用 getAnimationKeys 查 | { count } |
| `keyBoneFrame` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`bone`*(string) 骨骼名<br>`channel`*('translate'\|'rotate'\|'scale'\|'shear') 变换通道<br>`time`*(number) 时间点（秒）<br>`value`?(object) rotate 传数字（度）；translate / scale / shear 传 {x,y} | 给某根骨骼的某个变换通道打一帧。同一时间点重复打即覆盖，单位是秒 | { animation, bone, channel, time, value } |
| `keyDeformFrame` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`slot`*(string) 插槽名<br>`attachment`*(string) 网格 / 遮罩 / 链接网格附件名<br>`time`*(number) 时间点（秒）<br>`offsets`*(array) 顶点偏移数组，长度 = 顶点数 × 2（全 0 表示复位）<br>`skin`?(string) 附件所在皮肤；不传则按默认皮肤 + 当前皮肤解析 | 打一帧网格 / 遮罩形变（FFD）。offsets 是每个顶点的偏移 [x0,y0,x1,y1,...]，长度必须是顶点数的 2 倍（链接网格按源网格的点数算）；遮罩顶点用 getMask 读 | { animation, slot, attachment, time, vertexCount } |
| `keyDrawOrderFrame` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`time`*(number) 时间点（秒）<br>`order`?(array) 完整插槽名序列（第 0 个最先画） | 打一帧绘制顺序。order 必须是**完整**的插槽名序列（第 0 个最先画）；不传则按当前层序 | { animation, time, order } |
| `keyEvent` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`time`?(number) 时间点（秒）；不传用当前播放头<br>`name`?(string) 事件名；不传自动取 event / event2…<br>`stringParam`?(string) 字符串参数<br>`intParam`?(number) 整数参数<br>`floatParam`?(number) 浮点参数 | 在指定时间点插入一个事件帧（时间轴最上面那条事件轨）。不传 time 用当前播放头，不传 name 自动取 event / event2…。**同一时间点只有一个事件帧**：该时刻已有事件时只覆盖传入的字段（不会叠出第二个） | { animation, time, name } |
| `keySlotColorFrame` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`slot`*(string) 插槽名<br>`time`*(number) 时间点（秒）<br>`color`*(string) 颜色 #RRGGBB 或 #RRGGBBAA | 打一帧插槽颜色（与附件颜色相乘，常用来做受击闪白 / 渐隐） | { animation, slot, time, color } |
| `keySlotDisplayFrame` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`slot`*(string) 插槽名<br>`time`*(number) 时间点（秒）<br>`attachment`*(string) 要显示的附件名；空串 = 不显示<br>`skin`?(string) 皮肤名；不传则用当前皮肤 | 打一帧「显示哪个附件」（换装动画的基础）。附件名给空串表示这一帧起不显示 | { animation, slot, time, attachment, displayIndex } |
| `keySlotSubArmatureFrame` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`slot`*(string) 挂了嵌套骨架 display 的插槽名<br>`time`*(number) 时间点（秒）<br>`clip`*(string) 子骨架里要播的动画名；空串 = 回 setup 姿态（可用 getProjectState 看别的骨架有哪些动画）<br>`playTimes`?(number) 播放次数：0 或负数 = 无限循环（默认 0；写 -1 更直白），正数 = 播几次后定格<br>`offset`?(number) 起始偏移（秒）：从子动画的第几秒开始（默认 0）<br>`speed`?(number) 倍速，1 = 原速（默认 1） | 打一帧「嵌套骨架播什么」：子骨架动画名（空串 = 回 setup 姿态）+ 播放次数（0 或负数 = 循环，每轮从 offset 起播）/ 起始偏移 / 倍速。用于「挥刀时刀光从第 3 帧起播」这类效果；插槽上要先有嵌套骨架 display | { animation, slot, time, clip, playTimes, offset, speed } |
| `keySlotVisibleFrame` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`slot`*(string) 插槽名<br>`time`*(number) 时间点（秒）<br>`visible`*(boolean) 是否可见 | 打一帧插槽的显示 / 隐藏 | { animation, slot, time, visible } |
| `moveKeyframe` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`kind`*('bone'\|'slot'\|'deform'\|'drawOrder') 轨道种类<br>`target`?(string) 骨骼名 / 插槽名；kind=drawOrder 时忽略<br>`attachment`?(string) kind=deform 时的附件名<br>`channel`*(string) 通道：bone 用 translate/rotate/scale/shear，slot 用 display/color/visible/subArmature<br>`from`*(number) 原时间点（秒）<br>`to`*(number) 新时间点（秒） | 把一条轨道上的关键帧从 from 秒挪到 to 秒。落点已有帧会覆盖它 | { moved, from, to, animation } |
| `pasteKeyframes` | `time`?(number) 粘贴起点（秒）；不传用当前播放头时间 | 把剪贴板里的关键帧粘贴到指定时间（不传 time 就贴到当前播放头）。关键帧之间相对间距保持不变 | { count, time } |
| `removeAnimation` | `animation`*(string) 动画名 | 删除一条动画 | { animation } |
| `removeBoneFrame` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`bone`*(string) 骨骼名<br>`channel`*('translate'\|'rotate'\|'scale'\|'shear') 变换通道<br>`time`*(number) 时间点（秒） | 删掉某根骨骼某个通道在指定时间点的关键帧 | { removed, animation } |
| `removeDeformFrame` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`slot`*(string) 插槽名<br>`attachment`*(string) 网格或遮罩附件名<br>`time`*(number) 时间点（秒） | 删掉某个网格或遮罩附件在指定时间点的 FFD 帧 | { removed, animation } |
| `removeEvent` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`time`*(number) 事件帧所在时间点（秒）<br>`name`?(string) 事件名（同一时间有多个事件时用它区分） | 删掉某个时间点上的事件帧（同名同时间只删一个） | { removed, animation, time } |
| `renameAnimation` | `animation`*(string) 原动画名<br>`next`*(string) 新动画名 | 重命名一条动画 | { name } |
| `setActiveAnimation` | `animation`*(string) 动画名 | 切换正在编辑 / 播放的动画（时间轴与视口会跟着换） | { name } |
| `setAnimation` | `name`*(string) 目标动画名（工程里已存在的） | 在 Animate（动画编辑）态下切换当前正在编辑的动画。name 必须是工程中已存在的动画名。要先 setMode 切到 animate 才能用；切换会清空时间轴选择与播放头归零 | { animation } |
| `setAnimationDuration` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`duration`*(number) 时长（秒） | 设置动画时长（秒）。注意：缩短到最后一帧之前会在播放时截掉后面的帧 | { name, duration } |
| `setAnimationFrames` | `frames`*(number) 时长（帧数），至少 1<br>`animation`?(string) 动画名；不传 = 当前选中的动画 | 按帧数设置动画时长（帧数 ÷ 工程帧率 = 秒）。这是「可编辑范围」——改大就能在后面继续加帧；播放与导出仍按最后一个关键帧算。不能短于最后一个关键帧，不够时会自动抬高并说明 | { name, frames, duration } |
| `setEvent` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`time`*(number) 事件帧所在时间点（秒）<br>`name`?(string) 新事件名<br>`stringParam`?(string) 字符串参数（空串 = 清空）<br>`intParam`?(number) 整数参数<br>`floatParam`?(number) 浮点参数 | 修改某个时间点上事件帧的名字 / 参数（只改给出的字段） | { time, name, stringParam, intParam, floatParam } |
| `setKeyframeEasing` | `animation`?(string) 动画名；不传则用当前编辑动画<br>`kind`*('bone'\|'slot'\|'deform'\|'drawOrder') 轨道种类<br>`target`?(string) 骨骼名 / 插槽名；kind=drawOrder 时忽略<br>`attachment`?(string) kind=deform 时的附件名<br>`channel`*(string) 通道：bone 用 translate/rotate/scale/shear，slot 用 display/color/visible/subArmature<br>`time`*(number) 时间点（秒）<br>`easing`*('linear'\|'stepped'\|'bezier') 缓动方式<br>`curve`?(array) bezier 的 4 个控制量 [cx1, cy1, cx2, cy2] | 改某一帧的缓动方式。bezier 必须同时给 curve：[cx1, cy1, cx2, cy2] | { ok, easing, animation } |

## 皮肤与换装

| 命令 | 参数 | 说明 | 返回 |
| --- | --- | --- | --- |
| `addSkin` | `name`?(string) 皮肤名；不传用 skinN | 新建一套空皮肤（每个现有插槽都建一条空附件表），可用于后续打换装帧 | { name } |
| `createLinkedMesh` | `slot`*(string) 插槽名<br>`source`*(string) 源网格附件名（同插槽，必须是 mesh）<br>`skin`?(string) 目标皮肤；不传 = 默认皮肤<br>`sourceSkin`?(string) 源皮肤；不传 = 默认皮肤<br>`name`?(string) 附件名；不传沿用源网格名（同名覆盖该插槽显示）<br>`image`?(string) 自己的图片（图片池里的名字）；不传沿用源网格的图 | 在目标皮肤里创建一条链接网格：几何（顶点 / 三角面 / 权重）取自同插槽的源网格，自己只决定贴图与 UV。附件名与源同名 = 覆盖该插槽的显示（换装标准写法），异名 = 追加一个 display | { slot, attachment, warning? } |
| `removeSkin` | `name`*(string) 皮肤名 | 删除某套皮肤（default 不可删）。若删的是当前皮肤，当前皮肤会退回 default | { name, count } |
| `renameSkin` | `name`*(string) 原皮肤名<br>`newName`*(string) 新皮肤名（不能与已有皮肤重复） | 改皮肤名。**不能和已有皮肤重名**，default 也不可改名。变形（FFD）轨道的皮肤归属、链接网格的源皮肤、当前皮肤会一起跟着改 | { name, newName } |
| `setActiveSkin` | `name`?(string) 皮肤名；空串 / default = 默认皮肤 | 切换当前皮肤（空串或 default 表示默认皮肤）。只改编辑器状态，不进撤销记录 | { skin } |
| `setLinkedMeshImage` | `slot`*(string) 插槽名<br>`attachment`*(string) 链接网格附件名<br>`image`*(string) 新图片（图片池里的名字）<br>`skin`?(string) 链接网格自己所在的皮肤；不传 = 默认皮肤 | 只改这一条链接网格的图片（不会动同名源网格），并按新图的区域重算 UV；新图里找不到区域时 UV 清空，运行期退回源网格那块 | { slot, attachment, warning? } |
| `setLinkedMeshSource` | `slot`*(string) 插槽名<br>`attachment`*(string) 链接网格附件名<br>`source`*(string) 新源网格附件名<br>`skin`?(string) 链接网格自己所在的皮肤；不传 = 默认皮肤<br>`sourceSkin`?(string) 新源皮肤；不传 = 默认皮肤 | 把链接网格换成另一个源皮肤 / 源网格，改完按新源重算 UV。源必须是同插槽的网格（不能是链接网格本身） | { slot, attachment, warning? } |
| `unlinkLinkedMesh` | `slot`*(string) 插槽名<br>`attachment`*(string) 链接网格附件名<br>`skin`?(string) 链接网格自己所在的皮肤；不传 = 默认皮肤 | 把源网格的几何 / 权重 / UV 深拷贝到自己名下，变成普通网格；之后源网格的变化不再影响它。顶点数不变，原有 FFD 关键帧仍然有效 | { slot, attachment, vertices, triangles } |

## 多骨架与嵌套

| 命令 | 参数 | 说明 | 返回 |
| --- | --- | --- | --- |
| `addSkeleton` | `name`?(string) 骨架名；不传用「骨架 N」 | 新建一个空骨架（含根骨骼 root）并切过去。图片池与其它骨架共享 | { name, activeSkeleton, count } |
| `nestArmature` | `slot`*(string) 目标插槽名<br>`armature`*(string) 被引用的骨架名（必须是工程里的另一个骨架）<br>`name`?(string) 新 display 的名字；缺省用骨架名（重名自动加序号）<br>`skin`?(string) 皮肤名；不传用当前皮肤 | 把工程里的另一个骨架作为 display 挂到指定插槽上（同工程按名字引用，不复制数据），并切换为当前显示项。会拒绝自引用 / 循环引用 / 超深 | { slot, attachment } |
| `removeSkeleton` | `index`?(number) 骨架下标；不传 = 当前骨架 | 删除指定下标的骨架（至少保留一个）。不传 index 则删当前骨架。**被别的骨架嵌套引用时删不掉**：先删掉父骨架里指向它的嵌套 display（或 setNestedArmature 换成别的骨架） | { count, activeSkeleton } |
| `renameSkeleton` | `index`?(number) 骨架下标；不传 = 当前骨架<br>`name`*(string) 新名字 | 改某个骨架的 armatureName（不影响项目名 / 导出目录名）。不传 index 则改当前骨架 | { index, name } |
| `setActiveSkeleton` | `index`*(number) 骨架下标 | 切换当前编辑的骨架（只换引用，不动数据），并清空针对旧骨架的选中 / 时间轴状态 | { name, activeSkeleton } |
| `setNestedArmature` | `slot`*(string) 插槽名<br>`attachment`*(string) 嵌套骨架 display 名<br>`armature`?(string) 引用哪个骨架（同工程里的骨架名；空串 = 断开引用）<br>`animation`?(string) setup 默认播放的子动画名；空串 = setup 姿态<br>`playTimes`?(number) 播放次数：0 或负数 = 无限循环（每轮从 offset 起播）；正数 = 播几次后定格<br>`offset`?(number) 起始偏移（秒）<br>`speed`?(number) 倍速，1 = 原速 | 改嵌套骨架 display 的引用与默认播放参数：引用骨架名 / 默认子动画 / 播放次数（0=循环）/ 起始偏移 / 倍速。只对 type=armature 的 display 有效 | { slot, attachment, changedFields } |

## 遮罩（Spine Clipping）

| 命令 | 参数 | 说明 | 返回 |
| --- | --- | --- | --- |
| `convertToMask` | `slot`*(string) 插槽名<br>`attachment`*(string) 附件名<br>`skin`?(string) 皮肤名；不传 = 跨皮肤查找<br>`endSlot`?(string) 结束插槽名；不传保持默认（裁到末尾）<br>`inverse`?(boolean) 是否反向遮罩<br>`convex`?(boolean) 是否凸多边形 | 把 Region / 非加权 Mesh 转成遮罩（保留附件名）。Region 取内容矩形，Mesh 取顶点凸包；加权网格不支持。转换后可用 setMaskOptions 设结束插槽 / 反向 | { skin, slot, attachment, pointCount, points, endSlot, inverse, convex, displayed } |
| `createMask` | `slot`*(string) 插槽名（遮罩从这条插槽开始生效）<br>`name`?(string) 遮罩附件名；不传则用 mask，重名自动加序号<br>`points`*(array) 多边形控制点 [{x,y},...]（插槽骨骼局部坐标，至少 3 个）<br>`endSlot`?(string) 结束插槽名；留空 = 裁到绘制顺序末尾<br>`inverse`?(boolean) 反向遮罩（只保留多边形外部）；会自动把 convex 设为 true<br>`convex`?(boolean) 多边形是凸的（加速标记，默认 false）<br>`skin`?(string) 目标皮肤；不传 = 当前皮肤<br>`display`?(boolean) 是否把插槽显示切到遮罩，默认 true | 在插槽上创建 Clipping 遮罩附件。points 是插槽骨骼局部坐标（不是世界坐标），至少 3 个点；遮罩只裁绘制顺序中它之后、endSlot 之前的附件。默认会把该插槽显示切到遮罩 | { skin, slot, attachment, pointCount, points, endSlot, inverse, convex, displayed } |
| `deleteMaskPoint` | `slot`*(string) 插槽名<br>`attachment`*(string) 遮罩附件名<br>`index`*(number) 要删除的下标，从 0 开始<br>`skin`?(string) 皮肤名；不传 = 跨皮肤查找 | 删除遮罩的一个控制点（至少保留 3 个）。会清掉该遮罩旧 FFD 轨道 | { slot, attachment, pointCount } |
| `insertMaskPoint` | `slot`*(string) 插槽名<br>`attachment`*(string) 遮罩附件名<br>`index`?(number=-1) 插在这个下标之后；-1 = 插到最前<br>`point`*(object) 新点 {x,y}（插槽骨骼局部坐标）<br>`skin`?(string) 皮肤名；不传 = 跨皮肤查找 | 在指定控制点之后插入一个点（index = -1 表示插到最前）。会清掉该遮罩旧 FFD 轨道。point 是插槽骨骼局部坐标 | { slot, attachment, index, pointCount } |
| `setMaskOptions` | `slot`*(string) 插槽名<br>`attachment`*(string) 遮罩附件名<br>`endSlot`?(string) 结束插槽名；传空串 = 裁到末尾<br>`inverse`?(boolean) 反向遮罩<br>`convex`?(boolean) 凸多边形（inverse 时会自动为 true）<br>`display`?(boolean) true = 把插槽显示切到遮罩；false = 当前显示是它时清空<br>`skin`?(string) 皮肤名；不传 = 跨皮肤查找 | 修改遮罩结束插槽 / 反向 / 凸形 / 是否显示。endSlot 留空 = 裁到绘制顺序末尾；至少有 endSlot / inverse / convex / display 之一 | { skin, slot, attachment, pointCount, points, endSlot, inverse, convex, displayed } |
| `setMaskPoint` | `slot`*(string) 插槽名<br>`attachment`*(string) 遮罩附件名<br>`index`*(number) 控制点下标，从 0 开始<br>`point`*(object) 新位置 {x,y}（插槽骨骼局部坐标）<br>`skin`?(string) 皮肤名；不传 = 跨皮肤查找 | 修改遮罩的一个控制点。point 是插槽骨骼局部坐标；index 从 0 开始（getMask 返回的 index） | { slot, attachment, index, point, pointCount } |
| `setMaskPoints` | `slot`*(string) 插槽名<br>`attachment`*(string) 遮罩附件名<br>`points`*(array) [{x,y},...]（插槽骨骼局部坐标，至少 3 个）<br>`skin`?(string) 皮肤名；不传 = 跨皮肤查找 | 整体替换遮罩多边形。points 是插槽骨骼局部坐标，至少 3 个；点数变化会清掉该遮罩旧的 FFD 轨道。只改少量点优先用 setMaskPoint / insertMaskPoint / deleteMaskPoint | { skin, slot, attachment, pointCount, points, endSlot, inverse, convex } |

## 视口、预览与导出

| 命令 | 参数 | 说明 | 返回 |
| --- | --- | --- | --- |
| `beginTransaction` | `label`?(string=AI 批量操作) 撤销记录上显示的名字 | 把接下来的一批编辑合并成一条撤销记录（由 POST /batch 的 transaction:true 自动调用，不建议单独使用） | { started, label } |
| `centerViewport` | `x`*(number) 世界坐标 x<br>`y`*(number) 世界坐标 y（上为正） | 把某个世界坐标点移到视口正中（保持当前缩放）。只动相机，不改数据 | { x, y, zoom } |
| `endTransaction` | — | 把事务期间的改动合并为一条撤销记录（由 POST /batch 自动调用） | { ended } |
| `exportProject` | `mode`?('runtime'\|'unity'\|'spine'=runtime) 导出目标<br>`dir`?(string) 输出目录（绝对路径）；不传 = 工程文件所在目录<br>`scale`?(number) 图集缩放，默认用工程里记的值或 1<br>`maxSize`?(number) 单页最大边长，默认 2048<br>`skeletons`?(array) 要导出的骨架下标数组；不传 = 当前骨架<br>`atlasScope`?('all'\|'selected'=all) 图集范围：all = 所有骨架用到的图；selected = 只含本次导出的骨架 | 把工程导出到磁盘（**不弹对话框**）。runtime = 自定义运行时数据，unity = .hao2d + 图集 + 材质，spine = Spine 4.3 的 json + atlas + 图集页。目录不传则用工程文件所在目录 | { mode, dir, files, warnings } |
| `fitViewport` | — | 把视口缩放 / 平移到刚好框住整个角色（与右上角「适配视野」按钮、F 键等效）。captureViewport 前常用它先把角色摆正 | {} |
| `focusNode` | `kind`*('bone'\|'slot'\|'display'\|'constraint') 节点类型<br>`name`*(string) 节点名（display 时为附件名）<br>`slot`?(string) kind = display 时该附件所在的插槽名 | 把视口对准某个骨骼 / 插槽 / 附件 / 约束（等同层级树里双击该行）。只移动相机，不改数据 | { kind, name } |
| `panViewport` | `dx`*(number) 水平位移（屏幕像素）<br>`dy`*(number) 垂直位移（屏幕像素） | 按屏幕像素平移视口（相机拖动）。dx 正值 = 画面内容右移，dy 正值 = 画面内容下移。只动相机，不改数据 | { offset } |
| `redo` | — | 重做上一步被撤销的编辑（等价于 Cmd/Ctrl+Shift+Z） | { canUndo, canRedo, label } |
| `removeStage` | — | 删掉当前舞台参考图（同时删除工程 `stage/` 下的图片文件） | { removed } |
| `rollbackTransaction` | — | 放弃事务：文档恢复到 beginTransaction 时的状态，不留撤销记录（由 POST /batch 在批量失败时自动调用） | { rolledBack } |
| `setMode` | `mode`*('pose'\|'animate') 目标状态 | 在 Pose（绑定）态与 Animate（动画编辑）态之间切换。切到 Animate 时会自动选中一个动画（优先上次离开时选的，否则第一个）；切回 Pose 会记录当前动画并清空时间轴选择。时间轴只在 Animate 态出现，做关键帧编辑前要先切到 Animate | { mode, animation } |
| `setPlaying` | `playing`?(boolean=true) true = 播放，false = 暂停<br>`loop`?(boolean) 是否循环；不传则保持当前设置 | 开始或暂停播放当前动画。开始播放时若还没选动画，会自动选第一个（没有动画则报错） | { playing, animation } |
| `setStage` | `imagePath`*(string) 参考图文件的绝对路径<br>`x`?(number) 位置 x（世界单位，y 向上）；不传 0<br>`y`?(number) 位置 y（世界单位）；不传 0<br>`width`?(number) 显示宽度（世界单位）；不传按图片像素 / PPU 换算<br>`height`?(number) 显示高度（世界单位）；不传按图片像素 / PPU 换算<br>`opacity`?(number) 透明度 0–1；不传 0.5 | 按路径把一张图铺到视口当背景参照（存到工程 `stage/` 目录，随工程走）。会替换已有参考图；工程需已保存（先 saveProject / createProject）。仅编辑器显示，不参与导出 | { file, x, y, width, height, opacity } |
| `setTime` | `time`*(number) 时间点（秒） | 把时间轴播放头移到指定时间（秒），不改变播放状态 | { time } |
| `setViewportZoom` | `zoom`*(number) 缩放倍率（>0） | 设置视口缩放倍率（以屏幕中心为锚点，画面中心的位置不变）。只动相机，不改数据 | { zoom } |
| `undo` | — | 撤销上一步文档编辑（等价于 Cmd/Ctrl+Z）。绘制网格边界中途会先撤销上一个边界点 | { canUndo, canRedo, label } |
| `updateStage` | `x`?(number) 位置 x（世界单位）<br>`y`?(number) 位置 y（世界单位）<br>`width`?(number) 显示宽度（世界单位，>0）<br>`height`?(number) 显示高度（世界单位，>0）<br>`opacity`?(number) 透明度 0–1 | 改已有舞台参考图的位置 / 大小 / 透明度（世界单位；只改给出的字段） | { x, y, width, height, opacity } |

## 编辑器界面与剪贴板（AI 少用）

| 命令 | 参数 | 说明 | 返回 |
| --- | --- | --- | --- |
| `__catalog` | — | 内部命令：返回全部命令的自描述与 AI 使用手册，本地服务的 GET /commands 调用它。一般不用直接执行 | { commands, playbook } |
| `copyNodes` | — | 把当前选中的骨骼 / 插槽节点复制进剪贴板（不改文档）。先用 setSelection 选中；粘贴用 pasteNodes | { count } |
| `duplicateSelection` | — | 复制当前选择并立即粘贴（骨骼 / 插槽新副本，改名加序号）。依赖当前选择，配合 setSelection 使用 | { count } |
| `pasteNodes` | — | 把剪贴板里的节点粘贴到当前选择之下（粘贴骨骼时挂到选中骨骼下；粘贴插槽时挂到选中骨骼 / 插槽所在骨骼） | { count } |
| `setOnionSkin` | `enabled`?(boolean) true = 开，false = 关；不传 = 切换 | 显示 / 隐藏时间轴的洋葱皮（前后帧骨骼姿态）。enabled 不传 = 切换 | { onionSkin } |
| `setOverlay` | `key`*('bones'\|'constraints') 开关哪一层<br>`visible`?(boolean) true = 显示，false = 隐藏；不传 = 切换 | 显示 / 隐藏视口叠加层：bones = 骨骼骨架，constraints = 约束手柄（IK / 变换 / 路径）。与视口右上角的「骨骼 / 约束」开关等效。visible 不传 = 切换 | { overlay: { bones, constraints } } |
| `setSelection` | `kind`*('none'\|'bone'\|'slot'\|'attachment'\|'constraint') 选什么<br>`name`?(string) 骨骼 / 插槽 / 约束名<br>`bones`?(array) 骨骼名数组（多选；给了就用它，否则用 name）<br>`slot`?(string) 附件所在插槽（kind=attachment 时必给）<br>`attachment`?(string) 附件名（kind=attachment 时必给） | 改变编辑器里当前选中的对象（骨骼 / 插槽 / 附件 / 约束 / 取消选择）。copyNodes、pasteNodes 等依赖「当前选择」的操作要先用它定位 | { kind, bone, bones, slot, attachment, constraint } |
| `setSmartFilter` | `enabled`?(boolean) true = 开，false = 关；不传 = 切换 | 只显示当前选中对象（骨骼 / 插槽 / 约束）的时间轴轨道。先用 setSelection 选中对象再开过滤才有效。enabled 不传 = 切换 | { smartFilter } |
| `setTimelineZoom` | `zoom`*(number) 缩放倍数（0.5 ~ 2） | 设置时间轴时间缩放：1 = 完整适配动画长度；越大时间轴越长、关键帧越松散（逐帧精修），最小 0.5、最大 2。超范围会自动夹住 | { zoom } |

## 批量调用形状

```json
POST /batch
{
  "transaction": true,
  "label": "搭骨架",
  "commands": [
    { "name": "addBone", "args": { "name": "root" } },
    { "name": "addBone", "args": { "name": "hip", "parent": "root", "localPosition": { "x": 0, "y": 1.0 } } }
  ]
}
```

- 顺序执行，后面的命令能看到前面的结果
- `transaction: true` → 一条撤销记录；任一条失败 → 整体回滚，不留半套状态
- 整批无改动同样回滚，不留空记录
- 单批 ≤ 约 30 条（撤销栈只有 80 条）
