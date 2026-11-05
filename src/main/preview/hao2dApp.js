/* 导出运行时预览页逻辑：消费全局 Hao2dRuntime（由 hao2d-runtime.js 注入）。
 * 纯浏览器脚本，不依赖任何模块系统；相机 / 播放 / UI 交互在此处组装。 */
(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }
  var statusEl = $('status')
  var errorEl = $('error')
  var titleEl = $('title')
  var skeletonSelect = $('skeletonSelect')
  var animSelect = $('animSelect')
  var skinSelect = $('skinSelect')
  var playBtn = $('playBtn')
  var restartBtn = $('restartBtn')
  var fitBtn = $('fitBtn')
  var progress = $('progress')
  var timeLabel = $('timeLabel')
  var speed = $('speed')
  var speedLabel = $('speedLabel')
  var loopCheck = $('loopCheck')
  var slotSelect = $('slotSelect')
  var attSelect = $('attSelect')
  var slotVisible = $('slotVisible')
  var slotDisplay = $('slotDisplay')
  var displayLabel = $('displayLabel')
  var forceDisplay = $('forceDisplay')
  var apiResult = $('apiResult')
  var nestedSkinSelect = $('nestedSkinSelect')
  var nestedInfo = $('nestedInfo')
  var panelToggle = $('panelToggle')
  var panel = $('panel')
  var canvas = $('stage')
  var bgCanvas = $('bg')
  var bgctx = bgCanvas.getContext('2d')
  var dpr = 1
  // 棋盘格两档底色，与编辑器视口一致（checkerboard.ts 的 LIGHT / DARK），spine 预览同款
  var LIGHT = '#3a3a3c'
  var DARK = '#2c2c2e'
  // 自适应格子边长（世界单位），与 spine 预览、编辑器 checkerboard.ts 同一算法
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
  var bgState = null
  function drawBackground() {
    if (!stage) return
    var zoom = stage.zoom
    var centerX = stage.centerX
    var centerY = stage.centerY
    var vw = window.innerWidth
    var vh = window.innerHeight
    var same = bgState &&
      bgState.zoom === zoom && bgState.cx === centerX && bgState.cy === centerY &&
      bgState.w === vw && bgState.h === vh
    if (same) return
    bgState = { zoom: zoom, cx: centerX, cy: centerY, w: vw, h: vh }
    var ctx = bgctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#101218'
    ctx.fillRect(0, 0, vw, vh)
    var worldCell = pickCellSize(zoom)
    var cellPx = Math.max(1, worldCell * zoom)
    var ox = vw / 2 - centerX * zoom
    var oy = vh / 2 + centerY * zoom
    var kStart = Math.floor((0 - ox) / cellPx)
    var kEnd = Math.ceil((vw - ox) / cellPx)
    var mStart = Math.floor((oy - vh) / cellPx)
    var mEnd = Math.floor(oy / cellPx)
    for (var k = kStart; k <= kEnd; k++) {
      for (var m = mStart; m <= mEnd; m++) {
        var x = ox + k * cellPx
        var y = oy - (m + 1) * cellPx
        ctx.fillStyle = (((k & 1) ^ (m & 1)) === 0) ? DARK : LIGHT
        ctx.fillRect(x, y, cellPx, cellPx)
      }
    }
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(Math.round(ox) + 0.5, 0)
    ctx.lineTo(Math.round(ox) + 0.5, vh)
    ctx.moveTo(0, Math.round(oy) + 0.5)
    ctx.lineTo(vw, Math.round(oy) + 0.5)
    ctx.stroke()
  }
  function syncBgSize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    var w = Math.max(1, Math.floor(window.innerWidth * dpr))
    var h = Math.max(1, Math.floor(window.innerHeight * dpr))
    if (bgCanvas.width !== w || bgCanvas.height !== h) {
      bgCanvas.width = w
      bgCanvas.height = h
    }
    bgState = null
  }

  var token = location.pathname.split('/')[2]
  var base = '/p/' + token + '/'
  var manifest = null
  var rev = 0
  var stage = null
  var currentId = null
  var seeking = false
  var pointers = {}

  function fail(message) {
    errorEl.textContent = message
    errorEl.hidden = false
    statusEl.hidden = true
  }

  function showStatus(message) {
    statusEl.textContent = message
    statusEl.hidden = false
  }

  function hideStatus() {
    statusEl.hidden = true
  }

  function fillSelect(select, items, selected) {
    select.innerHTML = ''
    items.forEach(function (name) {
      var opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      if (name === selected) opt.selected = true
      select.appendChild(opt)
    })
  }

  function loadManifest() {
    return fetch(base + 'manifest.json').then(function (r) { return r.json() })
  }

  /**
   * 预取被嵌套引用的子骨架文本（含传递依赖：A 挂 B、B 挂 C 时三个都要）。
   *
   * 子骨架与父骨架共用同一套图集页，所以只需要额外的 ske 文本。
   */
  function loadNestedSkeletons(root) {
    var byId = {}
    ;((manifest && manifest.skeletons) || []).forEach(function (item) { byId[item.id] = item })
    var seen = {}
    var out = []
    function walk(node) {
      var links = node.nested || []
      return Promise.all(links.map(function (link) {
        if (!link.id || seen[link.id]) return Promise.resolve()
        seen[link.id] = true
        return fetch(base + 's/' + link.id + '.ske').then(function (r) { return r.text() })
          .then(function (text) {
            var name = link.armatureName || ''
            try { name = (JSON.parse(text) || {}).armatureName || name } catch (e) { /* 名字只用于提示 */ }
            out.push({ armatureName: name, skeText: text })
            if (byId[link.id]) return walk(byId[link.id])
            return undefined
          })
      }))
    }
    return walk(root).then(function () { return out })
  }

  function loadSkeleton(entry) {
    return fetch(base + 's/' + entry.id + '.ske').then(function (r) { return r.text() })
      .then(function (skeText) {
        return fetch(base + 's/' + entry.id + '.atlas').then(function (r) { return r.text() })
          .then(function (atlasText) {
            var atlas = JSON.parse(atlasText)
            var pageNames = (atlas.pages || []).map(function (page) { return page.image })
            return Promise.all(pageNames.map(function (name) {
              return fetch(base + 'pages/' + encodeURIComponent(name))
                .then(function (r) { return r.arrayBuffer() })
                .then(function (buf) { return { name: name, bytes: new Uint8Array(buf) } })
            })).then(function (pages) {
              return loadNestedSkeletons(entry).then(function (nested) {
                return { skeText: skeText, atlasText: atlasText, pages: pages, nested: nested }
              })
            })
          })
      })
  }

  /**
   * 换一个全新的 canvas 元素再交给 pixi。
   *
   * pixi 销毁 renderer 时会连带丢掉当前 canvas 的 WebGL 上下文，而同一个 canvas 上再次
   * getContext 拿到的仍是那个**已丢失**的 context：后续 createShader 返回 null，
   * gl.shaderSource(null, src) 直接抛
   * 「Failed to execute 'shaderSource' … parameter 1 is not of type 'WebGLShader'」。
   * 切换骨架 / 清单更新都要重建 stage（见 mount），所以这里必须换元素才能拿到新上下文。
   */
  function freshCanvas() {
    var next = document.createElement('canvas')
    next.id = 'stage'
    if (canvas.parentNode) canvas.parentNode.replaceChild(next, canvas)
    else document.body.appendChild(next)
    canvas = next
    // 手势状态跟着旧元素一起作废，重新绑定到新元素上
    pointers = {}
    bindCanvasEvents()
    return next
  }

  function apiNote(message) { apiResult.textContent = message }

  function currentView() { return stage && stage.view ? stage.view : null }

  /** 把插槽 / 附件 / 下标 / 嵌套子骨架的当前状态同步到面板 */
  function refreshSlotPanel() {
    var view = currentView()
    if (!view) return
    var slot = slotSelect.value
    var names = view.attachmentNames(slot)
    var index = view.getSlotDisplayIndex(slot)
    fillSelect(attSelect, names, index >= 0 ? (names[index] || '') : '')
    var max = Math.max(0, names.length - 1)
    slotDisplay.max = String(max)
    if (Number(slotDisplay.value) !== index) slotDisplay.value = String(index)
    displayLabel.textContent = String(index) + ' / ' + max
    slotVisible.checked = view.skeleton.slotVisible[view.findSlotIndex(slot)] !== 0

    var nested = view.getNested(slot)
    fillSelect(nestedSkinSelect, nested ? nested.skins : [], nested ? nested.activeSkin : '')
    nestedInfo.textContent = nested
      ? '当前插槽有子骨架（共 ' + view.nestedCount + ' 个），可用 setNested* 操作内部插槽'
      : '当前插槽没有子骨架（共 ' + view.nestedCount + ' 个激活）'
  }

  function mount(entry) {
    if (stage) { stage.destroy(); stage = null }
    currentId = entry.id
    // 必须在 createStage 之前换（原因见 freshCanvas）
    var target = freshCanvas()
    showStatus('正在加载…')
    loadSkeleton(entry).then(function (data) {
      return Hao2dRuntime.createStage({
        canvas: target,
        pages: data.pages,
        skeText: data.skeText,
        atlasText: data.atlasText,
        defaultSkin: entry.defaultSkin,
        nested: data.nested
      }).then(function (created) {
        stage = created
        window.hao2d = { stage: created, view: created.view }
        hideStatus()
        errorEl.hidden = true
        created.resize(window.innerWidth, window.innerHeight)
        fillSelect(animSelect, created.animations, created.defaultAnimation)
        fillSelect(skinSelect, created.skins, created.defaultSkin)
        fillSelect(slotSelect, created.view.slotNames)
        created.setLoop(loopCheck.checked)
        created.setSpeed(Number(speed.value) / 100)
        // 与 spine 预览的加载顺序一致：先按 setup pose 取景，再启动动画
        //（反过来会让动画第 0 帧的姿势把取景带偏，和 spine 预览对不上）
        created.fit()
        created.play(created.defaultAnimation, loopCheck.checked)
        refreshSlotPanel()
        playBtn.textContent = '暂停'
      })
    }).catch(function (err) {
      fail('加载失败：' + (err && err.message ? err.message : String(err)))
    })
  }

  function refreshSkeletonOptions() {
    skeletonSelect.innerHTML = ''
    manifest.skeletons.forEach(function (entry, index) {
      var opt = document.createElement('option')
      opt.value = String(index)
      opt.textContent = entry.name
      skeletonSelect.appendChild(opt)
    })
  }

  function bootstrap() {
    loadManifest().then(function (data) {
      manifest = data
      rev = data.rev
      titleEl.textContent = (data.title ? data.title + ' · ' : '') + 'Hao2D 预览'
      document.title = titleEl.textContent
      refreshSkeletonOptions()
      if (manifest.skeletons.length > 0) mount(manifest.skeletons[0])
    }).catch(function (err) {
      fail('无法读取预览清单：' + (err && err.message ? err.message : String(err)))
    })
  }

  // 每 2.5s 轮询清单版本：编辑器重新预览（换资源）后手机不用重新扫码，自动重载
  setInterval(function () {
    if (!manifest) return
    loadManifest().then(function (data) {
      if (data.rev !== rev) {
        rev = data.rev
        manifest = data
        refreshSkeletonOptions()
        var entry = manifest.skeletons.find(function (s) { return s.id === currentId })
        mount(entry || manifest.skeletons[0])
      }
    }).catch(function () {})
  }, 2500)

  // -------------------------------------------------------------- UI 事件
  skeletonSelect.addEventListener('change', function (event) {
    var entry = manifest.skeletons[Number(event.target.value)]
    if (entry) mount(entry)
  })
  animSelect.addEventListener('change', function (event) {
    if (!stage) return
    stage.play(event.target.value, loopCheck.checked)
    playBtn.textContent = '暂停'
  })
  skinSelect.addEventListener('change', function (event) {
    if (!stage) return
    var ok = stage.setSkin(event.target.value)
    apiNote(ok ? 'SetSkin → 已切换到 ' + event.target.value : 'SetSkin → 皮肤不存在，保持当前皮肤')
    refreshSlotPanel()
  })
  playBtn.addEventListener('click', function () {
    if (!stage) return
    if (stage.playing) { stage.pause(); playBtn.textContent = '播放' }
    else { stage.resume(); playBtn.textContent = '暂停' }
  })
  restartBtn.addEventListener('click', function () {
    if (!stage) return
    stage.seek(0)
    stage.resume()
    playBtn.textContent = '暂停'
  })
  fitBtn.addEventListener('click', function () {
    if (stage) stage.fit()
  })
  progress.addEventListener('input', function (event) {
    seeking = true
    if (stage) stage.setProgress(Number(event.target.value) / 1000)
  })
  progress.addEventListener('change', function () { seeking = false })
  speed.addEventListener('input', function (event) {
    if (stage) stage.setSpeed(Number(event.target.value) / 100)
    speedLabel.textContent = (Number(event.target.value) / 100).toFixed(2) + '×'
  })
  loopCheck.addEventListener('change', function (event) {
    if (stage) stage.setLoop(event.target.checked)
  })

  // ---- IHao2DView：换装 / 显隐 / 显示下标 / 嵌套子骨架 ----
  slotSelect.addEventListener('change', refreshSlotPanel)
  slotDisplay.addEventListener('input', function () {
    displayLabel.textContent = slotDisplay.value + ' / ' + slotDisplay.max
  })
  $('applyAttBtn').addEventListener('click', function () {
    var view = currentView()
    if (!view || !attSelect.value) return
    var ok = view.setSlotAttachment(slotSelect.value, attSelect.value)
    apiNote('SetSlotAttachment → ' + (ok ? '成功：' + attSelect.value : '失败（插槽 / 附件不存在）'))
    refreshSlotPanel()
  })
  $('clearAttBtn').addEventListener('click', function () {
    var view = currentView()
    if (!view) return
    var ok = view.clearSlotAttachmentOverride(slotSelect.value)
    apiNote('ClearSlotAttachmentOverride → ' + (ok ? '已还原' : '失败'))
    refreshSlotPanel()
  })
  slotVisible.addEventListener('change', function () {
    var view = currentView()
    if (!view) return
    var ok = view.setSlotVisible(slotSelect.value, slotVisible.checked)
    apiNote('SetSlotVisible → ' + (ok ? String(slotVisible.checked) : '失败'))
  })
  $('applyDisplayBtn').addEventListener('click', function () {
    var view = currentView()
    if (!view) return
    var index = Number(slotDisplay.value)
    var ok = view.setSlotDisplayIndex(slotSelect.value, index, forceDisplay.checked)
    apiNote('SetSlotDisplayIndex(' + index + (forceDisplay.checked ? ', force' : '') + ') → ' + (ok ? '成功' : '失败'))
    refreshSlotPanel()
  })
  $('clearDisplayBtn').addEventListener('click', function () {
    var view = currentView()
    if (!view) return
    var ok = view.clearSlotDisplayOverride(slotSelect.value)
    apiNote('ClearSlotDisplayOverride → ' + (ok ? '已清除' : '没有强制覆盖'))
    refreshSlotPanel()
  })
  $('applyNestedSkinBtn').addEventListener('click', function () {
    var view = currentView()
    if (!view) return
    var ok = view.setNestedSkin(slotSelect.value, nestedSkinSelect.value)
    apiNote('SetNestedSkin → ' + (ok ? '成功：' + nestedSkinSelect.value : '失败（没有子骨架或皮肤不存在）'))
    refreshSlotPanel()
  })

  panelToggle.addEventListener('click', function () {
    panel.hidden = !panel.hidden
  })

  // -------------------------------------------------------------- 相机手势
  // 绑成函数：切换骨架会换 canvas 元素（见 freshCanvas），换完必须重新绑一次
  function bindCanvasEvents() {
    var pinchDist = 0
    canvas.addEventListener('pointerdown', function (event) {
      canvas.setPointerCapture(event.pointerId)
      pointers[event.pointerId] = { x: event.clientX, y: event.clientY }
    })
    canvas.addEventListener('pointermove', function (event) {
      var prev = pointers[event.pointerId]
      if (!prev) return
      var dx = event.clientX - prev.x
      var dy = event.clientY - prev.y
      pointers[event.pointerId] = { x: event.clientX, y: event.clientY }
      var ids = Object.keys(pointers)
      if (ids.length >= 2 && stage) {
        // 双指：以中点为锚缩放
        var a = pointers[ids[0]]
        var b = pointers[ids[1]]
        var dist = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinchDist > 0) {
          var factor = dist / pinchDist
          var midX = (a.x + b.x) / 2
          var midY = (a.y + b.y) / 2
          stage.zoomAt(factor, midX, midY)
        }
        pinchDist = dist
      } else if (stage) {
        stage.pan(dx, dy)
      }
    })
    function endPointer(event) {
      delete pointers[event.pointerId]
      if (Object.keys(pointers).length < 2) pinchDist = 0
    }
    canvas.addEventListener('pointerup', endPointer)
    canvas.addEventListener('pointercancel', endPointer)

    canvas.addEventListener('wheel', function (event) {
      event.preventDefault()
      if (stage) stage.zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY)
    }, { passive: false })
  }
  bindCanvasEvents()

  window.addEventListener('resize', function () {
    syncBgSize()
    if (stage) stage.resize(window.innerWidth, window.innerHeight)
  })

  // -------------------------------------------------------------- 时间 / 进度 UI 循环
  function uiLoop() {
    syncBgSize()
    drawBackground()
    if (stage) {
      var duration = stage.duration || 0
      var time = stage.time || 0
      if (!seeking) {
        progress.value = String(duration > 0 ? Math.round((time / duration) * 1000) : 0)
        timeLabel.textContent = time.toFixed(2) + ' / ' + duration.toFixed(2)
      }
    }
    requestAnimationFrame(uiLoop)
  }
  requestAnimationFrame(uiLoop)

  bootstrap()
})()
