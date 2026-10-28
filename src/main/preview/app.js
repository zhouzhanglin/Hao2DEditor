/**
 * 在线预览页逻辑（由主进程 previewServer.ts 以 ?raw 内联、原样返回浏览器）。
 *
 * 运行时：导出的 spine JSON + 官方 spine-core（全局 `spine`）。
 * 渲染：这里自带一个极简 WebGL 后端，直接消费 core 的 SkeletonRendererCore.render() 产出的
 * RenderCommand（positions / uvs / colors / indices / blendMode / texture），因此不需要 spine-webgl 依赖。
 */
(function () {
  'use strict'

  var spine = window.spine
  var $ = function (id) { return document.getElementById(id) }
  var canvas = $('stage')
  var bg = $('bg')
  var bgctx = bg.getContext('2d')
  var dpr = 1
  var statusBox = $('status')
  var errorBox = $('error')

  // 棋盘格两档底色，与编辑器视口一致（checkerboard.ts 的 LIGHT / DARK）
  var LIGHT = '#3a3a3c'
  var DARK = '#2c2c2e'

  function fail(message) {
    statusBox.hidden = true
    errorBox.hidden = false
    errorBox.textContent = message
  }
  function note(message) {
    errorBox.hidden = true
    statusBox.hidden = false
    statusBox.textContent = message
  }
  function ready() {
    statusBox.hidden = true
  }

  if (!spine) { fail('spine 运行时未能加载（spine-core.js 缺失）'); return }

  // ------------------------------------------------------------------ WebGL
  var gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true })
    || canvas.getContext('experimental-webgl')
  if (!gl) { fail('当前浏览器不支持 WebGL，无法预览'); return }

  var VERTEX_SHADER = [
    'attribute vec2 a_position;',
    'attribute vec2 a_uv;',
    'attribute vec4 a_color;',
    'uniform vec2 u_scale;',
    'uniform vec2 u_offset;',
    'varying vec2 v_uv;',
    'varying vec4 v_color;',
    'void main() {',
    '  v_uv = a_uv;',
    '  v_color = a_color;',
    '  gl_Position = vec4(a_position * u_scale + u_offset, 0.0, 1.0);',
    '}'
  ].join('\n')

  // 图集页不做预乘（.atlas 里没有 pma），顶点色也不预乘，直接相乘即可
  var FRAGMENT_SHADER = [
    'precision mediump float;',
    'uniform sampler2D u_texture;',
    'varying vec2 v_uv;',
    'varying vec4 v_color;',
    'void main() {',
    '  gl_FragColor = texture2D(u_texture, v_uv) * v_color;',
    '}'
  ].join('\n')

  function compileShader(type, source) {
    var shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error('着色器编译失败：' + gl.getShaderInfoLog(shader))
    }
    return shader
  }

  var program = gl.createProgram()
  gl.attachShader(program, compileShader(gl.VERTEX_SHADER, VERTEX_SHADER))
  gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    fail('着色器链接失败：' + gl.getProgramInfoLog(program))
    return
  }
  gl.useProgram(program)

  var loc = {
    position: gl.getAttribLocation(program, 'a_position'),
    uv: gl.getAttribLocation(program, 'a_uv'),
    color: gl.getAttribLocation(program, 'a_color'),
    scale: gl.getUniformLocation(program, 'u_scale'),
    offset: gl.getUniformLocation(program, 'u_offset'),
    texture: gl.getUniformLocation(program, 'u_texture')
  }
  var buffers = {
    position: gl.createBuffer(),
    uv: gl.createBuffer(),
    color: gl.createBuffer(),
    index: gl.createBuffer()
  }
  gl.enableVertexAttribArray(loc.position)
  gl.enableVertexAttribArray(loc.uv)
  gl.enableVertexAttribArray(loc.color)
  gl.uniform1i(loc.texture, 0)
  gl.activeTexture(gl.TEXTURE0)

  // 顶点色是 (A<<24)|(R<<16)|(G<<8)|B 的打包整数，展开成 float；缓冲区复用，避免每帧新建
  var colorScratch = new Float32Array(1024 * 4)
  function expandColors(packed, count) {
    if (colorScratch.length < count * 4) colorScratch = new Float32Array(count * 4)
    for (var i = 0; i < count; i++) {
      var c = packed[i]
      var j = i * 4
      colorScratch[j] = ((c >>> 16) & 0xff) / 255
      colorScratch[j + 1] = ((c >>> 8) & 0xff) / 255
      colorScratch[j + 2] = (c & 0xff) / 255
      colorScratch[j + 3] = ((c >>> 24) & 0xff) / 255
    }
    return colorScratch.subarray(0, count * 4)
  }

  // spine.BlendMode：0 Normal / 1 Additive / 2 Multiply / 3 Screen
  function applyBlend(mode) {
    if (mode === 1) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE)
    else if (mode === 2) gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA)
    else if (mode === 3) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_COLOR)
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  var textureHandles = [] // [Texture, WebGLTexture] 对，按对象复用
  function textureHandle(texture) {
    for (var i = 0; i < textureHandles.length; i++) {
      if (textureHandles[i][0] === texture) return textureHandles[i][1]
    }
    var image = texture && texture.getImage ? texture.getImage() : texture && texture.image
    if (!image) return null
    var handle = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, handle)
    // 不翻转：spine 图集的 v 从图片顶部量起，GL 纹理坐标 t=0 也对应上传数据的首行
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    textureHandles.push([texture, handle])
    return handle
  }

  // ------------------------------------------------------------------ 状态
  var app = {
    manifest: null,
    /** 已加载骨架缓存：id -> { data, atlas, meta } */
    cache: {},
    data: null,
    meta: null,
    skeleton: null,
    state: null,
    renderer: new spine.SkeletonRendererCore(),
    playing: true,
    /** 相机：世界单位/像素，中心点（世界坐标，y 轴向上） */
    zoom: 1,
    centerX: 0,
    centerY: 0,
    viewWidth: 1,
    viewHeight: 1,
    /** 用户自己拖过 / 缩过：这时视口变化不再自动取景，免得把人家调好的视角冲掉 */
    touched: false,
    /** 画面脏了才需要重绘：暂停且相机/骨架都没动时跳过 render，省 CPU */
    dirty: true
  }

  function currentEntry() {
    // 4.3 起取轨道条目叫 getTrack（旧名字 getCurrent 已不存在）
    return app.state ? app.state.getTrack(0) : null
  }

  /** 同步画布像素尺寸与视口，返回 css 视口尺寸是否变了（首次进来、转屏、拉窗口都算） */
  function viewportSize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    var cssWidth = canvas.clientWidth || 1
    var cssHeight = canvas.clientHeight || 1
    var resized = cssWidth !== app.viewWidth || cssHeight !== app.viewHeight
    app.viewWidth = cssWidth
    app.viewHeight = cssHeight
    var width = Math.max(1, Math.floor(cssWidth * dpr))
    var height = Math.max(1, Math.floor(cssHeight * dpr))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    if (bg.width !== width || bg.height !== height) {
      bg.width = width
      bg.height = height
    }
    gl.viewport(0, 0, width, height)
    return resized
  }

  function render() {
    // 首帧时视口尺寸才刚确定（fitView 要按它算缩放），所以这里补一次自动取景
    if (viewportSize() && app.skeleton && !app.touched) fitView()
    drawBackground()
    // 透明清屏：背景棋盘格 / 轴线由下层 #bg 画布提供，角色经混合后透出来
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (!app.skeleton) return
    gl.enable(gl.BLEND)
    var scaleX = (app.zoom * 2) / app.viewWidth
    var scaleY = (app.zoom * 2) / app.viewHeight
    gl.uniform2f(loc.scale, scaleX, scaleY)
    gl.uniform2f(loc.offset, -app.centerX * scaleX, -app.centerY * scaleY)

    var command = app.renderer.render(app.skeleton, false, undefined, 2, 0)
    while (command) {
      if (command.numVertices > 0 && command.numIndices > 0) {
        var handle = textureHandle(command.texture)
        if (handle) {
          gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position)
          gl.bufferData(gl.ARRAY_BUFFER, command.positions, gl.DYNAMIC_DRAW)
          gl.vertexAttribPointer(loc.position, 2, gl.FLOAT, false, 0, 0)

          gl.bindBuffer(gl.ARRAY_BUFFER, buffers.uv)
          gl.bufferData(gl.ARRAY_BUFFER, command.uvs, gl.DYNAMIC_DRAW)
          gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 0, 0)

          gl.bindBuffer(gl.ARRAY_BUFFER, buffers.color)
          gl.bufferData(gl.ARRAY_BUFFER, expandColors(command.colors, command.numVertices), gl.DYNAMIC_DRAW)
          gl.vertexAttribPointer(loc.color, 4, gl.FLOAT, false, 0, 0)

          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index)
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, command.indices, gl.DYNAMIC_DRAW)

          applyBlend(command.blendMode)
          gl.bindTexture(gl.TEXTURE_2D, handle)
          gl.drawElements(gl.TRIANGLES, command.numIndices, gl.UNSIGNED_SHORT, 0)
        }
      }
      command = command.next
    }
  }

  /** 按当前姿势的世界顶点自动取景 */
  function fitView() {
    if (!app.skeleton) return
    var command = app.renderer.render(app.skeleton, false, undefined, 2, 0)
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    while (command) {
      var positions = command.positions
      for (var i = 0; i < command.numVertices * 2; i += 2) {
        var x = positions[i]
        var y = positions[i + 1]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      command = command.next
    }
    if (!isFinite(minX) || !isFinite(minY)) return
    var pad = 1.12
    var width = Math.max(maxX - minX, 1)
    var height = Math.max(maxY - minY, 1)
    app.centerX = (minX + maxX) / 2
    app.centerY = (minY + maxY) / 2
    app.zoom = Math.min(app.viewWidth / (width * pad), app.viewHeight / (height * pad))
    app.dirty = true
  }

  /** 自适应格子边长（世界单位）：保证屏幕上的格子边长落在 [minPx, maxPx]，2 的幂次步进。
   *  与编辑器 checkerboard.ts 的 pickCellSize 同算法，所以预览和编辑器同一缩放下格子大小一致。 */
  function pickCellSize(zoom, base, minPx, maxPx) {
    base = base || 1
    minPx = minPx || 12
    maxPx = maxPx || 32
    if (!(zoom > 0)) return base
    var cell = base
    var guard = 0
    while (cell * zoom > maxPx && guard++ < 40) cell /= 2
    guard = 0
    while (cell * zoom < minPx && guard++ < 40) cell *= 2
    return cell
  }

  /** 画背景：棋盘格 + 沿世界原点的 XY 轴线，与编辑器视口一致。盖在 WebGL 画布之下。
   *  背景只在相机 / 视口尺寸变化时才重画（脏标记），动画播放但相机不动时整帧跳过，
   *  否则每帧几千次 fillRect 软件渲染会吃满 CPU。 */
  var bgState = null
  function drawBackground() {
    var same = bgState &&
      bgState.zoom === app.zoom &&
      bgState.centerX === app.centerX &&
      bgState.centerY === app.centerY &&
      bgState.w === app.viewWidth &&
      bgState.h === app.viewHeight
    if (same) return
    bgState = { zoom: app.zoom, centerX: app.centerX, centerY: app.centerY, w: app.viewWidth, h: app.viewHeight }

    var ctx = bgctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, app.viewWidth, app.viewHeight)

    var worldCell = pickCellSize(app.zoom)
    var cellPx = Math.max(1, worldCell * app.zoom)
    // 世界原点 (0,0) 的屏幕坐标（y 轴向上，所以屏幕 y 用减号）
    var ox = app.viewWidth / 2 - app.centerX * app.zoom
    var oy = app.viewHeight / 2 + app.centerY * app.zoom

    var kStart = Math.floor((0 - ox) / cellPx)
    var kEnd = Math.ceil((app.viewWidth - ox) / cellPx)
    var mStart = Math.floor((oy - app.viewHeight) / cellPx)
    var mEnd = Math.floor(oy / cellPx)
    for (var k = kStart; k <= kEnd; k++) {
      for (var m = mStart; m <= mEnd; m++) {
        var x = ox + k * cellPx
        var y = oy - (m + 1) * cellPx
        // 同奇偶（k+m 偶数）→ 深格，与编辑器纹理 (0,0) 处一致
        ctx.fillStyle = (((k & 1) ^ (m & 1)) === 0) ? DARK : LIGHT
        ctx.fillRect(x, y, cellPx, cellPx)
      }
    }

    // 坐标轴：沿世界 x=0 / y=0 的黑色细线，铺满可见范围，画在角色之下
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(Math.round(ox) + 0.5, 0)
    ctx.lineTo(Math.round(ox) + 0.5, app.viewHeight)
    ctx.moveTo(0, Math.round(oy) + 0.5)
    ctx.lineTo(app.viewWidth, Math.round(oy) + 0.5)
    ctx.stroke()
  }

  // ------------------------------------------------------------------ 数据加载
  function fetchText(url) {
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error(url + ' → HTTP ' + response.status)
      return response.text()
    })
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var image = new Image()
      image.onload = function () { resolve(image) }
      image.onerror = function () { reject(new Error('图片加载失败：' + url)) }
      image.src = url
    })
  }

  function loadSkeleton(id) {
    if (app.cache[id]) return Promise.resolve(app.cache[id])
    var meta = null
    app.manifest.skeletons.forEach(function (entry) { if (entry.id === id) meta = entry })
    if (!meta) return Promise.reject(new Error('清单里没有骨架 ' + id))
    note('正在加载 ' + meta.name + ' …')
    return Promise.all([fetchText('s/' + id + '.json'), fetchText('s/' + id + '.atlas')]).then(function (texts) {
      var atlas = new spine.TextureAtlas(texts[1])
      var jobs = atlas.pages.map(function (page) {
        return loadImage('pages/' + encodeURIComponent(page.name)).then(function (image) {
          page.texture = new spine.Texture(image)
        })
      })
      return Promise.all(jobs).then(function () {
        // 同一页的附件都从 region 取纹理，这里把页纹理补到 region 上
        atlas.regions.forEach(function (region) {
          if (!region.texture && region.page) region.texture = region.page.texture
        })
        var data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(texts[0])
        app.cache[id] = { data: data, atlas: atlas, meta: meta }
        return app.cache[id]
      })
    })
  }

  /**
   * 应用皮肤（Hao2D 的皮肤是**叠加**语义，不是替换）。
   *
   * 编辑器里「基底皮肤永远生效 + 当前皮肤同名覆盖」（见 compile.ts 的 defaultSkinIndex /
   * defaultSkin、以及运行期 buildRuntimeMaps），导出的 spine json 把两者写成**各自独立的皮肤**：
   * 基底一般叫 `default`（往往只有几个附件），真正的角色部件在 `goblin` / `goblingirl` 这类皮肤里。
   *
   * 所以这里必须合成一个皮肤再交给官方运行库：直接 `setSkin('goblin')` 会丢掉只存在于
   * default 的附件（武器之类），而直接 `setSkin('default')` 就是「皮肤列表正常、中间没图像」——
   * 上一版预览页就是这样，默认只挂了基底那套。
   */
  var BASE_SKIN = 'default'
  function applySkin(name) {
    if (!app.skeleton || !app.data) return
    var base = null
    var skins = app.data.skins
    for (var i = 0; i < skins.length; i++) if (skins[i].name === BASE_SKIN) base = skins[i]
    // 找不到名为 default 的基底时按编译侧的老规则退化成第一套（见 compile.ts）
    if (!base) base = skins.length > 0 ? skins[0] : null
    var extra = null
    if (name && (!base || name !== base.name)) {
      for (var j = 0; j < skins.length; j++) if (skins[j].name === name) extra = skins[j]
    }
    if (!base && !extra) return
    if (!extra) {
      app.skeleton.setSkin(base.name)
      return
    }
    var merged = new spine.Skin(base ? BASE_SKIN + '+' + extra.name : extra.name)
    if (base) merged.addSkin(base)
    merged.addSkin(extra)
    app.skeleton.setSkin(merged)
  }

  function fillSelect(select, items, selected) {
    select.innerHTML = ''
    items.forEach(function (item) {
      var option = document.createElement('option')
      option.value = item.value
      option.textContent = item.label
      option.selected = item.value === selected
      select.appendChild(option)
    })
  }

  function play(animationName) {
    if (!app.state || !animationName) return
    var entry = app.state.setAnimation(0, animationName, $('loopCheck').checked)
    if (entry) entry.trackTime = 0
    app.playing = true
    $('playBtn').textContent = '暂停'
  }

  function applySkeleton(id) {
    return loadSkeleton(id).then(function (entry) {
      app.data = entry.data
      app.meta = entry.meta
      app.skeleton = new spine.Skeleton(entry.data)
      app.state = new spine.AnimationState(new spine.AnimationStateData(entry.data))
      app.state.timeScale = Number($('speed').value) / 100

      var skinNames = entry.data.skins.map(function (skin) { return skin.name })
      var wantSkin = entry.meta.defaultSkin
      if (skinNames.indexOf(wantSkin) < 0) wantSkin = skinNames.length ? skinNames[0] : 'default'
      fillSelect($('skinSelect'), skinNames.map(function (name) { return { value: name, label: name } }), wantSkin)
      $('skinSelect').disabled = skinNames.length <= 1

      var animNames = entry.data.animations.map(function (anim) { return anim.name })
      var wantAnim = entry.meta.defaultAnimation
      if (animNames.indexOf(wantAnim) < 0) wantAnim = animNames.length ? animNames[0] : ''
      fillSelect($('animSelect'), animNames.map(function (name) { return { value: name, label: name } }), wantAnim)
      $('animSelect').disabled = animNames.length <= 1

      // 4.3 起是 setupPose()（旧名字 setToSetupPose 已不存在）。
      // 顺序：先回 setup pose、再挂皮肤 —— 反过来的话 setupPose 会把皮肤挂上的附件清掉
      //（Slot.setupPose 在 `attachmentName` 为空时直接 setAttachment(null)）
      app.skeleton.setupPose()
      // 基底 + 选中皮肤（叠加语义，见 applySkin）
      if (skinNames.length > 0) applySkin(wantSkin)
      app.skeleton.updateWorldTransform(spine.Physics.update)
      // 默认适配大小：加载完成后立刻按真实视口取一次景（用户手动拖过 / 缩过才解除）
      app.touched = false
      viewportSize()
      fitView()
      play(wantAnim)
      $('title').textContent = (app.manifest.title ? app.manifest.title + ' · ' : '') + entry.meta.name
      document.title = $('title').textContent
      ready()
      app.dirty = true
    })
  }

  // ------------------------------------------------------------------ 手势 / 相机
  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value
  }

  function zoomLimits() {
    return [0.02, 40]
  }

  function zoomAt(clientX, clientY, factor) {
    var rect = canvas.getBoundingClientRect()
    var worldX = app.centerX + (clientX - rect.left - app.viewWidth / 2) / app.zoom
    var worldY = app.centerY - (clientY - rect.top - app.viewHeight / 2) / app.zoom
    var limits = zoomLimits()
    app.zoom = clamp(app.zoom * factor, limits[0], limits[1])
    app.centerX = worldX - (clientX - rect.left - app.viewWidth / 2) / app.zoom
    app.centerY = worldY + (clientY - rect.top - app.viewHeight / 2) / app.zoom
    app.dirty = true
  }

  var pointers = []
  var drag = null

  function pointerCenter() {
    var total = { x: 0, y: 0 }
    pointers.forEach(function (p) { total.x += p.x; total.y += p.y })
    return { x: total.x / (pointers.length || 1), y: total.y / (pointers.length || 1) }
  }

  function pinchDistance() {
    if (pointers.length < 2) return 0
    var dx = pointers[0].x - pointers[1].x
    var dy = pointers[0].y - pointers[1].y
    return Math.sqrt(dx * dx + dy * dy)
  }

  function beginGesture() {
    var center = pointerCenter()
    var rect = canvas.getBoundingClientRect()
    drag = {
      mode: pointers.length >= 2 ? 'pinch' : 'pan',
      startX: center.x,
      startY: center.y,
      distance: pinchDistance(),
      zoom: app.zoom,
      centerX: app.centerX,
      centerY: app.centerY,
      // 手势起点对应的世界坐标（缩放时保持不动）
      anchorX: app.centerX + (center.x - rect.left - app.viewWidth / 2) / app.zoom,
      anchorY: app.centerY - (center.y - rect.top - app.viewHeight / 2) / app.zoom
    }
  }

  canvas.addEventListener('pointerdown', function (event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    try { canvas.setPointerCapture(event.pointerId) } catch (err) { /* 忽略 */ }
    app.touched = true
    pointers.push({ id: event.pointerId, x: event.clientX, y: event.clientY })
    beginGesture()
  })

  canvas.addEventListener('pointermove', function (event) {
    var index = -1
    for (var i = 0; i < pointers.length; i++) if (pointers[i].id === event.pointerId) index = i
    if (index < 0) return
    pointers[index].x = event.clientX
    pointers[index].y = event.clientY
    if (!drag) return
    var rect = canvas.getBoundingClientRect()
    if (pointers.length >= 2 && drag.distance > 1) {
      var center = pointerCenter()
      var limits = zoomLimits()
      app.zoom = clamp(drag.zoom * (pinchDistance() / drag.distance), limits[0], limits[1])
      app.centerX = drag.anchorX - (center.x - rect.left - app.viewWidth / 2) / app.zoom
      app.centerY = drag.anchorY + (center.y - rect.top - app.viewHeight / 2) / app.zoom
    } else {
      var now = pointerCenter()
      app.centerX = drag.centerX - (now.x - drag.startX) / app.zoom
      app.centerY = drag.centerY + (now.y - drag.startY) / app.zoom
    }
    app.dirty = true
  })

  function endPointer(event) {
    for (var i = 0; i < pointers.length; i++) {
      if (pointers[i].id === event.pointerId) pointers.splice(i, 1)
    }
    try { canvas.releasePointerCapture(event.pointerId) } catch (err) { /* 忽略 */ }
    if (pointers.length > 0) beginGesture()
    else drag = null
  }
  canvas.addEventListener('pointerup', endPointer)
  canvas.addEventListener('pointercancel', endPointer)

  canvas.addEventListener('wheel', function (event) {
    event.preventDefault()
    app.touched = true
    zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015))
    app.dirty = true
  }, { passive: false })

  // ------------------------------------------------------------------ UI
  var seeking = false
  function updateTimeUI() {
    var entry = currentEntry()
    var duration = entry && entry.animation ? entry.animation.duration : 0
    // trackTime 在循环播放时会一直往上累加，所以显示时对时长取余，进度条才会一圈一圈走
    var raw = entry ? entry.trackTime : 0
    var time = duration > 0 ? ((raw % duration) + duration) % duration : raw
    if (!seeking) {
      $('progress').value = duration > 0 ? String(Math.round((time / duration) * 1000)) : '0'
    }
    $('timeLabel').textContent = time.toFixed(2) + ' / ' + duration.toFixed(2)
  }

  $('panelToggle').addEventListener('click', function () {
    var panel = $('panel')
    panel.hidden = !panel.hidden
  })
  $('playBtn').addEventListener('click', function () {
    app.playing = !app.playing
    $('playBtn').textContent = app.playing ? '暂停' : '播放'
  })
  $('restartBtn').addEventListener('click', function () {
    play($('animSelect').value)
  })
  $('fitBtn').addEventListener('click', function () {
    // 对着 setup pose 取景更稳定，避免动画中途抖动
    app.skeleton.setupPose()
    app.skeleton.updateWorldTransform(spine.Physics.update)
    app.touched = false
    fitView()
  })
  $('skeletonSelect').addEventListener('change', function (event) {
    applySkeleton(event.target.value).catch(function (error) {
      fail('骨架加载失败：' + (error && error.message ? error.message : error))
    })
  })
  $('animSelect').addEventListener('change', function (event) {
    play(event.target.value)
  })
  $('skinSelect').addEventListener('change', function (event) {
    if (!app.skeleton) return
    app.skeleton.setupPoseSlots()
    applySkin(event.target.value)
    app.skeleton.updateWorldTransform(spine.Physics.update)
    app.dirty = true
  })
  $('loopCheck').addEventListener('change', function (event) {
    var entry = currentEntry()
    if (entry) entry.loop = event.target.checked
  })
  $('progress').addEventListener('input', function (event) {
    seeking = true
    var entry = currentEntry()
    if (!entry || !entry.animation) return
    entry.trackTime = (Number(event.target.value) / 1000) * entry.animation.duration
    if (app.state) app.state.update(0)
    app.dirty = true
  })
  $('progress').addEventListener('change', function () {
    seeking = false
  })
  $('speed').addEventListener('input', function (event) {
    var speed = Number(event.target.value) / 100
    if (app.state) app.state.timeScale = speed
    $('speedLabel').textContent = speed.toFixed(2) + '×'
  })

  // 手机上默认把面板收起来，先看角色
  if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) {
    $('panel').hidden = true
  }

  // 窗口大小变化后需要重绘（暂停时 frame 会跳过 render）
  window.addEventListener('resize', function () {
    app.dirty = true
  })

  // ------------------------------------------------------------------ 主循环
  var lastTime = 0
  function frame(now) {
    var delta = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 0
    lastTime = now
    var shouldRender = app.dirty || app.playing
    if (app.state && app.skeleton && (app.playing || app.dirty)) {
      if (app.playing) app.state.update(delta)
      app.state.apply(app.skeleton)
      app.skeleton.updateWorldTransform(spine.Physics.update)
      shouldRender = true
    }
    if (shouldRender) {
      render()
      app.dirty = false
    }
    updateTimeUI()
    requestAnimationFrame(frame)
  }

  /** 会话版本号：编辑器里再点一次「预览」会让它 +1，页面据此自动重载 —— 手机不用重新扫码 */
  var seenRev = 0
  /** 首次加载成功前不参与重载判断，否则清单还没读出来就先把自己刷一遍 */
  var loaded = false

  function revOf(data) {
    return data && typeof data.rev === 'number' ? data.rev : 0
  }

  // 每 2.5 秒问一次清单：资源换了一版就整页重载；服务停了请求会失败，那时什么都不做
  window.setInterval(function () {
    if (!loaded) return
    fetch('manifest.json', { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null })
      .then(function (data) {
        if (data && revOf(data) !== seenRev) location.reload()
      })
      .catch(function () { /* 忽略：服务已停或网络抖动 */ })
  }, 2500)

  fetchText('manifest.json')
    .then(function (text) {
      app.manifest = JSON.parse(text)
      seenRev = revOf(app.manifest)
      var skeletons = app.manifest.skeletons || []
      if (skeletons.length === 0) throw new Error('这份导出里没有骨架')
      fillSelect(
        $('skeletonSelect'),
        skeletons.map(function (entry) { return { value: entry.id, label: entry.name } }),
        skeletons[0].id
      )
      $('skeletonSelect').disabled = skeletons.length <= 1
      return applySkeleton(skeletons[0].id)
    })
    .then(function () {
      loaded = true
      requestAnimationFrame(frame)
    })
    .catch(function (error) {
      fail('加载失败：' + (error && error.message ? error.message : error))
    })
})()
