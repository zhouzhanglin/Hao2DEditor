# 常用配方（可直接改造的批量命令）

> 下面的 JSON 都是 `POST /batch` 的 body。数值是**示例**，落地前用 `listImages` / `listBones` 换成真实名字。
> 时间单位秒，默认 30fps 工程里 1 帧 ≈ 0.0333 秒。

## 0. 四条通用约定

**直接打帧，一次做完。** 配方里的命令可以直接整批执行，不要先出缩略图等用户确认；
打完用 `getAnimationKeys` 自查，需要看画面就自己截图（`scripts/shot.py`）看一眼，
不要把图发给用户等回复（见 `pipeline.md` 的 S5）。

**骨骼初始旋转给 0。** 编辑器里骨线的朝向只影响骨线本身（`length` 沿骨骼局部 +x），
附件位置 / 旋转归附件自己管，所以把 `rotation` 初始值留 0 有两个好处：

- 打帧时 `value` 就是**绝对局部角度**，不用心算「基准 90° + 偏移」；
- 关节旋转永远绕骨骼原点，和骨线朝向无关。

若工程是从 Spine / DragonBones 导入的，骨骼已有真实朝向，这时打 `rotate` 帧必须给**绝对局部角度**
（看 `listBones` 的 `rotation`，在它基础上做增量）。**别混用两套思路。**

**装配对位优先用 `setSlotHost`。** 先把插槽挂在根骨骼下、按世界坐标摆好图，再绑到目标骨骼——
命令会保持全局位姿，自动补掉宿主骨骼的旋转/缩放，不用手算补偿角。

**首尾同帧。** 循环动画最后一帧的时间点 = `duration`，数值与第 0 帧一致，否则循环会跳。

---

## 1. 从零搭一个两足角色（无参考图）

目标：9 根骨骼 + 每根一根插槽，图用占位名。

```json
{
  "transaction": true,
  "label": "搭两足骨架",
  "commands": [
    { "name": "createProject", "args": { "name": "hero", "dir": "/Users/me/hao2d/hero" } },
    { "name": "importImages", "args": { "paths": [
      "/Users/me/art/head.png", "/Users/me/art/torso.png", "/Users/me/art/arm_l.png",
      "/Users/me/art/arm_r.png", "/Users/me/art/leg_l.png", "/Users/me/art/leg_r.png"
    ] } },
    { "name": "addBone", "args": { "name": "root", "length": 0.2 } },
    { "name": "addBone", "args": { "name": "hip", "parent": "root", "localPosition": { "x": 0, "y": 1.0 }, "length": 0.2 } },
    { "name": "addBone", "args": { "name": "torso", "parent": "hip", "localPosition": { "x": 0, "y": 0.1 }, "length": 0.6 } },
    { "name": "addBone", "args": { "name": "head", "parent": "torso", "localPosition": { "x": 0, "y": 0.55 }, "length": 0.3 } },
    { "name": "addBone", "args": { "name": "arm_l", "parent": "torso", "localPosition": { "x": -0.2, "y": 0.4 }, "length": 0.3 } },
    { "name": "addBone", "args": { "name": "forearm_l", "parent": "arm_l", "localPosition": { "x": 0, "y": -0.28 }, "length": 0.3 } },
    { "name": "addBone", "args": { "name": "arm_r", "parent": "torso", "localPosition": { "x": 0.2, "y": 0.4 }, "length": 0.3 } },
    { "name": "addBone", "args": { "name": "forearm_r", "parent": "arm_r", "localPosition": { "x": 0, "y": -0.28 }, "length": 0.3 } },
    { "name": "addBone", "args": { "name": "thigh_l", "parent": "hip", "localPosition": { "x": -0.12, "y": -0.05 }, "length": 0.4 } },
    { "name": "addBone", "args": { "name": "shin_l", "parent": "thigh_l", "localPosition": { "x": 0, "y": -0.4 }, "length": 0.4 } },
    { "name": "addBone", "args": { "name": "thigh_r", "parent": "hip", "localPosition": { "x": 0.12, "y": -0.05 }, "length": 0.4 } },
    { "name": "addBone", "args": { "name": "shin_r", "parent": "thigh_r", "localPosition": { "x": 0, "y": -0.4 }, "length": 0.4 } }
  ]
}
```

装配（zOrder 从后往前：后臂 → 后腿 → 躯干 → 头 → 前腿 → 前臂）：

```json
{
  "transaction": true,
  "label": "装配角色",
  "commands": [
    { "name": "addSlot", "args": { "name": "arm_r_slot", "bone": "arm_r", "zOrder": 0 } },
    { "name": "addDisplay", "args": { "slot": "arm_r_slot", "image": "arm_r" } },
    { "name": "addSlot", "args": { "name": "leg_r_slot", "bone": "thigh_r", "zOrder": 1 } },
    { "name": "addDisplay", "args": { "slot": "leg_r_slot", "image": "leg_r" } },
    { "name": "addSlot", "args": { "name": "torso_slot", "bone": "torso", "zOrder": 2 } },
    { "name": "addDisplay", "args": { "slot": "torso_slot", "image": "torso" } },
    { "name": "addSlot", "args": { "name": "head_slot", "bone": "head", "zOrder": 3 } },
    { "name": "addDisplay", "args": { "slot": "head_slot", "image": "head" } },
    { "name": "addSlot", "args": { "name": "leg_l_slot", "bone": "thigh_l", "zOrder": 4 } },
    { "name": "addDisplay", "args": { "slot": "leg_l_slot", "image": "leg_l" } },
    { "name": "addSlot", "args": { "name": "arm_l_slot", "bone": "arm_l", "zOrder": 5 } },
    { "name": "addDisplay", "args": { "slot": "arm_l_slot", "image": "arm_l" } }
  ]
}
```

然后逐张微调：`setDisplayTransform {slot, attachment, position:{x,y}, rotation, size}`，
用 `captureViewport` 看截图，或 `getDisplayWorldBounds` 取数值。**摆完停手让用户确认，再打帧。**

---

## 2. 有参考底图时的对位流程（顺序不能乱）

```
1. createProject → saveProject（底图需要工程已保存）
2. setStage {imagePath:'/abs/ref.png', opacity:0.5}
3. 标定尺寸：量参考图里某部件的像素高 h_ref；listImages 读该部件真实图片的像素高 h_img
   k = h_img / h_ref；底图世界尺寸 = 参考图像素 × k ÷ 100
   updateStage {width, height, x, y}
4. 一张一张放：addSlot（**不传 bone** → 挂根骨骼）+ addDisplay
   → setDisplayTransform 摆位置/旋转/尺寸 → setDrawOrder 调层级
   → captureViewport 与底图比对，直到重合
5. 【停手】把截图和当前进度告诉用户，等确认
6. 确认后：setSlotHost {slot, bone} 一张张绑骨（保持全局位姿，画面不动）
7. removeStage → saveProject
```

**不要**在外部把所有坐标算完一次灌进去——以编辑器返回的几何与截图为准。

---

## 3. idle 呼吸循环（2 秒，30fps）

```json
{
  "transaction": true,
  "label": "idle 循环",
  "commands": [
    { "name": "addAnimation", "args": { "name": "idle", "duration": 2 } },
    { "name": "keyBoneFrame", "args": { "bone": "torso", "channel": "rotate", "time": 0, "value": 0 } },
    { "name": "keyBoneFrame", "args": { "bone": "torso", "channel": "rotate", "time": 1, "value": 1.5 } },
    { "name": "keyBoneFrame", "args": { "bone": "torso", "channel": "rotate", "time": 2, "value": 0 } },
    { "name": "keyBoneFrame", "args": { "bone": "torso", "channel": "translate", "time": 0, "value": { "x": 0, "y": 0 } } },
    { "name": "keyBoneFrame", "args": { "bone": "torso", "channel": "translate", "time": 1, "value": { "x": 0, "y": 0.03 } } },
    { "name": "keyBoneFrame", "args": { "bone": "torso", "channel": "translate", "time": 2, "value": { "x": 0, "y": 0 } } },
    { "name": "keyBoneFrame", "args": { "bone": "arm_r", "channel": "rotate", "time": 0, "value": 0 } },
    { "name": "keyBoneFrame", "args": { "bone": "arm_r", "channel": "rotate", "time": 1, "value": -3 } },
    { "name": "keyBoneFrame", "args": { "bone": "arm_r", "channel": "rotate", "time": 2, "value": 0 } },
    { "name": "keyBoneFrame", "args": { "bone": "arm_l", "channel": "rotate", "time": 0, "value": 0 } },
    { "name": "keyBoneFrame", "args": { "bone": "arm_l", "channel": "rotate", "time": 1, "value": 3 } },
    { "name": "keyBoneFrame", "args": { "bone": "arm_l", "channel": "rotate", "time": 2, "value": 0 } }
  ]
}
```

缓动（呼吸要柔和；`time` 是**这一帧向后**的插值方式）：

```json
{ "name": "setKeyframeEasing", "args": { "kind": "bone", "target": "torso", "channel": "translate", "time": 0,
  "easing": "bezier", "curve": [0.42, 0, 0.58, 1] } }
```

复核定稿：`getAnimationKeys {animation:'idle'}` 确认每根骨骼的 keys 数量与时间点。

---

## 4. walk 循环（1 秒，两接触 + 两过渡）

节奏表（时间 → 动作），左右镜像即可：

| 时间 | thigh_r | shin_r | thigh_l | shin_l | arm_r | arm_l | torso |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.00 | -25 | 8 | 20 | -12 | 18 | -18 | 0 |
| 0.25 | 5 | -20 | -5 | 5 | 5 | -5 | 2 |
| 0.50 | 20 | -8 | -25 | 8 | -18 | 18 | 0 |
| 0.75 | -5 | 5 | 5 | -20 | -5 | 5 | 2 |
| 1.00 | -25 | 8 | 20 | -12 | 18 | -18 | 0 |

写法（只演示一条腿，其余照表批量补）：

```json
{ "name": "keyBoneFrame", "args": { "bone": "thigh_r", "channel": "rotate", "time": 0, "value": -25 } }
```

要点：
- **接触帧**（0 / 0.5）脚落地的那条腿几乎伸直，**过渡帧**（0.25 / 0.75）膝盖抬起；
- 手臂摆幅与对侧腿同相，方向相反（左腿前 → 右臂前）；
- 躯干只在过渡帧轻微起伏（rotate ±2 或 translate y +0.02），别做成弹簧；
- 首尾同帧，避免循环打嗝。

---

## 5. 网格 + 自动蒙皮 + 布料 FFD

```json
{
  "transaction": true,
  "label": "斗篷蒙皮",
  "commands": [
    { "name": "autoMeshFromImage", "args": { "slot": "cape_slot", "attachment": "cape", "divisions": 6 } },
    { "name": "autoWeightMesh", "args": { "slot": "cape_slot", "attachment": "cape", "method": "heat", "maxBones": 4 } }
  ]
}
```

要点：
- `autoWeightMesh` 依赖视口像素，报「场景未就绪」就等一拍再重试，别改参数硬撞；
- 层级根骨骼不参与加权（否则每个顶点都被它抢走），骨架至少要有一根子骨；
- 读顶点：`getAttachmentVertices {slot, attachment}` → 记下 `vertexCount`；
- 打 FFD 帧时 `offsets` 长度 = `vertexCount × 2`，数组顺序是 `[v0.x, v0.y, v1.x, v1.y, …]`：

```json
{ "name": "keyDeformFrame", "args": {
  "slot": "cape_slot", "attachment": "cape", "time": 0.5,
  "offsets": [0,0, 0.02,0, 0.05,-0.02]
}}
```

- 形状不会回到原位时补一帧全 0 复位；
- `redrawMeshBoundary` 会**清空该附件的 FFD 帧**，改拓扑要放在打帧之前。

---

## 6. 换装：皮肤 + 链接网格

一套几何、多套贴图（最优做法）：

```json
{
  "transaction": true,
  "label": "goblin 皮肤",
  "commands": [
    { "name": "addSkin", "args": { "name": "goblin" } },
    { "name": "createLinkedMesh", "args": { "slot": "front-foot", "source": "front-foot", "skin": "goblin", "image": "goblin_foot.png" } }
  ]
}
```

- `createLinkedMesh` 的附件名与源同名 = **覆盖**该插槽显示（换装标准写法）；异名 = 追加一件；
- 几何 / 三角面 / 权重永远来自源网格，源网格改形状时自动跟随，**不要**为每套皮肤复制网格；
- 换图用 `setLinkedMeshImage`（只改这一条并重算 UV）；想独立编辑用 `unlinkLinkedMesh`；
- 对链接网格打 FFD 必须传 `skin`，`offsets` 长度按**源网格**点数算：

```json
{ "name": "keyDeformFrame", "args": { "slot": "front-foot", "attachment": "front-foot", "skin": "goblin",
  "time": 0.2, "offsets": [0,0, 0.01,0] } }
```

动画里换装用 `keySlotDisplayFrame {slot, time, attachment, skin}`：
`attachment` 空串 = 该帧起不显示；切皮肤只影响预览，真正的切换靠这条帧。

---

## 7. 骨架嵌套（换武器 / 挂特效）

```json
{
  "transaction": true,
  "label": "挂刀",
  "commands": [
    { "name": "addSlot", "args": { "name": "weapon_slot", "bone": "forearm_r", "zOrder": 9 } },
    { "name": "nestArmature", "args": { "slot": "weapon_slot", "armature": "Sword" } },
    { "name": "setNestedArmature", "args": { "slot": "weapon_slot", "attachment": "Sword", "animation": "idle", "playTimes": 0, "speed": 1 } }
  ]
}
```

- `nestArmature` 作用于**当前编辑骨架**，`armature` 必须是工程内另一个骨架名；
  工程里的骨架清单与各自的 `animationNames` 从 `getProjectState` 的 `skeletons[]` 直接读，不用先切换；
- 动画里控制子骨架播哪个动画：`keySlotSubArmatureFrame {slot, time, clip, playTimes?, offset?, speed?}`，
  `clip` 空串 = 回 setup 姿态；`offset` 做「挥刀时刀光晚 3 帧起播」；
- 一个插槽挂多个嵌套 display，用 `keySlotDisplayFrame` 切显示（换武器）；
- 核对：`listDisplays` 的 `nested` 字段、`getAnimationKeys` 的 `slots[].subArmature`。

---

## 8. 遮罩裁剪（Spine Clipping）

```json
{ "name": "createMask", "args": {
  "slot": "mask_slot",
  "points": [{ "x": -0.5, "y": -0.6 }, { "x": 0.5, "y": -0.6 }, { "x": 0.5, "y": 0.6 }, { "x": -0.5, "y": 0.6 }],
  "endSlot": "cape_slot"
} }
```

- `points` 是**插槽骨骼局部坐标**，不是世界坐标；
- 裁的是绘制顺序里遮罩**之后**、`endSlot` **之前**的附件；`endSlot` 不传 = 裁到末尾；
- 已有图片 / 网格转遮罩：`convertToMask {slot, attachment, endSlot?, inverse?}`；
- 遮罩也能做 FFD：`keyDeformFrame` 的 `offsets` 长度 = 点数 × 2。

---

## 9. 事件帧（音效 / 判定）

```json
{ "name": "keyEvent", "args": { "time": 0.4, "name": "footstep", "stringParam": "stone", "intParam": 1 } }
```

事件轨在时间轴最上面；`time` 不传用当前播放头。改 / 删用 `setEvent` / `removeEvent`。

---

## 10. 已有 Spine / DragonBones 工程二次加工

```
1. importSpine {jsonPath} | importDragonBones {jsonPath}      （整份替换，先确认用户没改没存）
2. getProjectState → listImages 看是否有 loose=false 的整页图集
3. 有图集页：splitAtlas {name} 拆成碎图（附件自动改指）
4. getProjectState 的 skeletons[] 确认骨架名 → 需要时 setActiveSkeleton {index}
5. 按需补动画 / 调曲线 / 加皮肤 / 加嵌套
6. saveProject → exportProject {mode:'spine', dir}（回吐 Spine 4.3 json + atlas + 图集页）
```

注意：导入的骨骼有真实初始旋转，打 `rotate` 帧给**绝对局部角度**，与「从零搭骨架」的 0 基准不同。

---

## 11. 导出与验收

```json
{
  "transaction": false,
  "commands": [
    { "name": "saveProject", "args": {} },
    { "name": "exportProject", "args": { "mode": "runtime", "dir": "/Users/me/hao2d/hero/export" } }
  ]
}
```

| mode | 产出 |
| --- | --- |
| `runtime` | 自定义运行时数据（游戏里直接读） |
| `unity` | `.hao2d` + 图集 + 材质 |
| `spine` | Spine 4.3 的 `json` + `atlas` + 图集页 |

验收清单：
1. `getProjectState` → `dirty:false`、`projectPath` 正确；
2. `getAnimationKeys` → 每条动画的轨道数与时间点符合预期；
3. `captureViewport` → 打几个关键时刻看一眼姿态；
4. `exportProject` 返回的 `warnings` 为空；有 warning 就复述给用户。
