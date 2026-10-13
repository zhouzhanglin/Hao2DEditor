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
              return { skeText: skeText, atlasText: atlasText, pages: pages }
            })
          })
      })
  }

  function mount(entry) {
    if (stage) { stage.destroy(); stage = null }
    currentId = entry.id
    showStatus('正在加载…')
    loadSkeleton(entry).then(function (data) {
      return Hao2dRuntime.createStage({
        canvas: canvas,
        pages: data.pages,
        skeText: data.skeText,
        atlasText: data.atlasText
      }).then(function (created) {
        stage = created
        hideStatus()
        errorEl.hidden = true
        created.resize(window.innerWidth, window.innerHeight)
        fillSelect(animSelect, created.animations, created.defaultAnimation)
        fillSelect(skinSelect, created.skins, created.defaultSkin)
        created.setLoop(loopCheck.checked)
        created.setSpeed(Number(speed.value) / 100)
        created.play(created.defaultAnimation, loopCheck.checked)
        playBtn.textContent = '暂停'
        created.fit()
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
    stage.setSkin(event.target.value)
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
  panelToggle.addEventListener('click', function () {
    panel.hidden = !panel.hidden
  })

  // -------------------------------------------------------------- 相机手势
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
  var pinchDist = 0

  canvas.addEventListener('wheel', function (event) {
    event.preventDefault()
    if (stage) stage.zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY)
  }, { passive: false })

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
