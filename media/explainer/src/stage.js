// Deterministic stage: window.init(diagrams, mode) then window.seek(t) for any
// t. No wall-clock animation anywhere; every visual is a function of t.
;(() => {
  const $ = id => document.getElementById(id)
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
  const ease = p => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2)
  const fade = (t, t0, t1, d = 0.4) => {
    if (t < t0 || t >= t1) return 0
    return clamp(Math.min((t - t0) / d, (t1 - t) / d), 0, 1)
  }
  const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])

  let D = {} // diagrams: name -> { svg, width, height, source, error }
  let TL = null
  let CPS = { user: 45, claude: 75 }
  const layers = {} // name -> { el, w, h }
  let canvasW = 0
  let canvasH = 0
  let arch = null

  const titleOf = name => {
    if (TL.titles && TL.titles[name]) return TL.titles[name]
    const m = /^---\s*\n[\s\S]*?title:\s*"?([^"\n]*)"?\s*\n[\s\S]*?---/.exec(D[name]?.source || '')
    return m ? m[1] : name
  }

  function makeLayer(name) {
    const d = D[name]
    const el = document.createElement('div')
    el.className = 'layer'
    el.innerHTML = d.svg
    const svg = el.querySelector('svg')
    svg.removeAttribute('style')
    svg.setAttribute('width', d.width)
    svg.setAttribute('height', d.height)
    $('layers').appendChild(el)
    layers[name] = { el, svg, w: d.width, h: d.height }
  }

  function fitScale(w, h) {
    return Math.min((canvasW - 48) / w, (canvasH - 48) / h, TL.maxScale || 1.45)
  }

  // Short error text, derived from Mermaid's real message: the first lines
  // with the caret, then the start of the "Expecting" list.
  function shortError(err) {
    const lines = err.split('\n')
    const head = lines.slice(0, 3).join('\n')
    const exp = lines.slice(3).join(' ')
    const m = /Expecting ('[^']*'), ('[^']*'),.*?(got '[^']*')/.exec(exp)
    const tail = m ? `Expecting ${m[1]}, ${m[2]}, … ${m[3]}` : exp.slice(0, 80)
    return `${head}\n${tail}`
  }

  // ---- Chat -----------------------------------------------------------------
  function renderChat(t) {
    const box = $('messages')
    let items = []
    for (const m of TL.chat) {
      if (m.t0 > t) break
      if (m.kind === 'reset') items = []
      else items.push(m)
    }
    const html = []
    for (const m of items) {
      const age = t - m.t0
      if (m.kind === 'user' || m.kind === 'claude') {
        const n = Math.floor(age * CPS[m.kind])
        const typing = n < m.text.length
        const shown = esc(m.text.slice(0, n))
        html.push(
          `<div class="msg ${m.kind}"><div class="who">${m.kind === 'user' ? 'You' : 'Claude'}</div>${shown}${typing ? '<span class="caret"></span>' : ''}</div>`,
        )
      } else if (m.kind === 'cmd') {
        const done = t >= m.done
        const spin = !done ? `style="transform:rotate(${Math.round((age * 540) % 360)}deg)"` : ''
        html.push(
          `<div class="chip cmd"><span class="glyph term"></span><span class="name">${esc(m.name)}</span><span class="title">${esc(m.arg)}</span><span class="status ${done ? 'ok' : 'spin'}" ${spin}></span></div>`,
        )
      } else {
        const done = t >= m.done
        const bad = m.kind === 'error'
        const status = !done ? 'spin' : bad ? 'bad' : 'ok'
        const spin = !done ? `style="transform:rotate(${Math.round((age * 540) % 360)}deg)"` : ''
        html.push(
          `<div class="chip ${bad && done ? 'error' : ''}"><span class="glyph"></span><span class="name">show_diagram</span><span class="title">${esc(m.title)}</span><span class="status ${status}" ${spin}></span></div>`,
        )
        if (bad && done) {
          const err = shortError(D[m.diagram]?.error || 'Parse error')
          html.push(`<div class="errtext"><b>Mermaid:</b> ${esc(err)}</div>`)
        }
      }
    }
    box.innerHTML = html.join('')
  }

  // ---- Whiteboard -----------------------------------------------------------
  function boardState(t) {
    const s = { history: [], index: -1, zoom: 1, px: 0, py: 0, source: false, scroll: 0, changed: -1e9, wipe: null, xfade: null, key: null, keyT: -1e9 }
    for (const e of TL.board) {
      if (e.t0 > t) break
      if (e.key) { s.key = e.key; s.keyT = e.t0 }
      switch (e.kind) {
        case 'reset':
          s.history = []; s.index = -1; s.zoom = 1; s.px = 0; s.py = 0; s.source = false
          s.changed = -1e9; s.wipe = null; s.xfade = null
          break
        case 'add':
          s.history.push(e.name)
          s.index = s.history.length - 1
          s.zoom = 1; s.px = 0; s.py = 0; s.source = false
          s.changed = e.t0
          s.wipe = e.wipe ? { t0: e.t0, dur: e.wipe } : null
          s.xfade = e.xfade ? { t0: e.t0, dur: e.xfade } : null
          break
        case 'goto':
          s.index = clamp(e.index, 0, s.history.length - 1)
          s.zoom = 1; s.px = 0; s.py = 0; s.source = false
          s.changed = e.t0; s.wipe = null; s.xfade = null
          break
        case 'zoom': s.zoom = e.level; break
        case 'pan': s.px += e.dx; s.py += e.dy; break
        case 'fit': s.zoom = 1; s.px = 0; s.py = 0; break
        case 'source': s.source = e.on; s.scroll = e.scroll || 0; break
      }
    }
    return s
  }

  function placeLayer(L, zoom, px, py, opacity, clip) {
    const s = fitScale(L.w, L.h)
    const W = L.w * s
    const H = L.h * s
    const x = (canvasW - W * zoom) / 2 + px
    const y = (canvasH - H * zoom) / 2 + py
    L.el.style.left = '0px'
    L.el.style.top = '0px'
    L.el.style.width = `${W}px`
    L.el.style.height = `${H}px`
    L.svg.setAttribute('width', W)
    L.svg.setAttribute('height', H)
    L.el.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`
    L.el.style.opacity = opacity
    L.el.style.clipPath = clip || 'none'
  }

  function renderBoard(t) {
    const s = boardState(t)
    for (const name in layers) layers[name].el.style.opacity = 0
    $('wipe-line').style.opacity = 0
    $('board-empty').style.opacity = s.index < 0 ? 1 : 0
    $('counter').textContent = s.index < 0 ? '0 / 0' : `${s.index + 1} / ${s.history.length}`
    $('board-title').textContent = s.index < 0 ? '' : titleOf(s.history[s.index])
    $('ctl-code').classList.toggle('active', s.source)
    $('ctl-prev').classList.toggle('active', s.key === 'p' && t - s.keyT < 0.5)
    $('ctl-next').classList.toggle('active', s.key === 'n' && t - s.keyT < 0.5)

    const src = $('source')
    if (s.index >= 0 && s.source) {
      const name = s.history[s.index]
      const code = D[name].source
        .split('\n')
        .map(line => {
          const m = /classDef (added|changed|removed|confirmed|suspect|unverified|ruledout|high|medium|low|same|done|running|waiting|failed)\b|^\s*class [^\n]*\b(added|changed|removed|confirmed|suspect|unverified|ruledout|high|medium|low|same|done|running|waiting|failed)\s*$/.exec(line)
          const kind = m ? m[1] || m[2] : null
          return kind ? `<span class="hl ${kind}">${esc(line)}</span>` : esc(line)
        })
        .join('\n')
      src.innerHTML = `<div style="transform:translateY(-${s.scroll}px)">${code}</div>`
      src.style.opacity = 1
    } else {
      src.style.opacity = 0
    }

    if (s.index >= 0 && !s.source) {
      const name = s.history[s.index]
      const L = layers[name]
      const age = t - s.changed
      const pop = ease(clamp(age / 0.4, 0, 1))
      const wiping = s.wipe && age < s.wipe.dur && s.index > 0
      const xfading = s.xfade && age < s.xfade.dur && s.index > 0
      if (xfading) {
        // Cross-fade in place: same layout, the new diagram fades over the old one.
        const prev = layers[s.history[s.index - 1]]
        const p = ease(clamp(age / s.xfade.dur, 0, 1))
        placeLayer(prev, 1, 0, 0, 1 - p, null)
        placeLayer(L, 1, 0, 0, p, null)
      } else if (wiping) {
        // Push: the previous diagram slides out left, the new one in from the right.
        const prev = layers[s.history[s.index - 1]]
        const p = ease(clamp(age / s.wipe.dur, 0, 1))
        placeLayer(prev, 1, -p * canvasW, 0, 1, null)
        placeLayer(L, 1, (1 - p) * canvasW, 0, 1, null)
        const line = $('wipe-line')
        line.style.opacity = p < 0.98 ? 1 : 0
        line.style.left = `${(1 - p) * canvasW - 2}px`
      } else {
        const still = s.xfade && s.index > 0
        placeLayer(L, still ? s.zoom : s.zoom * (0.96 + 0.04 * pop), s.px, s.py, still ? 1 : pop, null)
      }
    }

    const cap = $('keycap')
    const ka = t - s.keyT
    if (s.key && ka >= 0 && ka < 0.9) {
      cap.textContent = s.key
      const o = ka < 0.1 ? ka / 0.1 : ka > 0.65 ? (0.9 - ka) / 0.25 : 1
      cap.style.opacity = o
      cap.style.transform = `scale(${0.9 + 0.1 * clamp(ka / 0.1, 0, 1)})`
    } else cap.style.opacity = 0
  }

  // ---- Architecture ---------------------------------------------------------
  const ARCH_ORDER = ['claude', 'L_claude_tool', 'tool', 'L_tool_renderd', 'renderd', 'L_renderd_chrome', 'chrome', 'L_chrome_renderd', 'L_renderd_tool', 'L_tool_pane', 'pane', 'L_tool_claude']

  // Reveals a Mermaid SVG piece by piece: nodes and edges in `order` appear
  // one after another from spec.t0, every spec.step seconds. Anything not in
  // the order (a legend, say) stays visible.
  const reveals = []
  function initReveal(spec) {
    const d = D[spec.name]
    if (!d) return
    const host = $(spec.host)
    host.innerHTML = d.svg
    const svg = host.querySelector('svg')
    svg.removeAttribute('style')
    const s = Math.min(spec.w / d.width, spec.h / d.height)
    svg.setAttribute('width', d.width * s)
    svg.setAttribute('height', d.height * s)
    const items = spec.order.map(key => {
      if (key.startsWith('L_')) {
        const path = [...svg.querySelectorAll('g.edgePaths path')].find(p => p.id.includes(key))
        const inner = [...svg.querySelectorAll('g.edgeLabels g.label[data-id]')].find(g => g.dataset.id.includes(key))
        const label = inner ? inner.closest('g.edgeLabel') || inner : null
        const dotted = path && /dotted/.test(path.getAttribute('class') || '')
        const len = path ? path.getTotalLength() : 0
        const marker = path ? path.getAttribute('marker-end') : null
        if (path) path.style.opacity = 0
        if (label) label.style.opacity = 0
        return { kind: 'edge', path, label, dotted, len, marker }
      }
      const node = [...svg.querySelectorAll('g.nodes > g.node')].find(g => g.id.includes(`flowchart-${key}-`))
      if (node) node.style.opacity = 0
      return { kind: 'node', node }
    })
    reveals.push({ ...spec, items })
  }

  function renderReveals(t) {
    for (const r of reveals) {
      r.items.forEach((it, i) => {
        const p = clamp((t - r.t0 - i * r.step) / 0.45, 0, 1)
        if (it.kind === 'node') {
          if (it.node) it.node.style.opacity = p
        } else {
          if (!it.path) return
          if (it.dotted) {
            it.path.style.opacity = p
          } else {
            it.path.style.strokeDasharray = `${it.len}`
            it.path.style.strokeDashoffset = `${it.len * (1 - ease(p))}`
            it.path.style.opacity = p > 0 ? 1 : 0
            if (it.marker) it.path.setAttribute('marker-end', p >= 1 ? it.marker : 'none')
          }
          if (it.label) it.label.style.opacity = clamp((p - 0.5) * 2, 0, 1)
        }
      })
    }
    if (TL.arch) document.querySelector('#arch .local-note').style.opacity = clamp((t - TL.arch.local) / 0.5, 0, 1)
  }

  // ---- Wall of text (30 s cut): grows ever faster, scrolls, then blurs ----
  let wallText = ''
  function renderWall(t) {
    const w = TL.wall
    if (!w) return
    const el = $('wall-text')
    const box = $('wall-box')
    const u = Math.max(0, t - w.t0)
    const n = Math.floor(w.cps0 * u + 0.5 * w.acc * u * u)
    el.textContent = wallText.slice(0, n)
    const over = el.scrollHeight - box.clientHeight
    el.style.transform = `translateY(${-Math.max(0, over)}px)`
    const b = clamp((t - w.blurAt) / (w.t1 - w.blurAt), 0, 1)
    el.style.filter = b > 0 ? `blur(${(b * 7).toFixed(2)}px)` : 'none'
    el.style.opacity = 1 - 0.5 * b
  }

  // ---- Prose card -----------------------------------------------------------
  let proseText = ''
  function renderProse(t) {
    if (!TL.prose) return
    const p = document.querySelector('#card-prose .prose p')
    const n = Math.max(0, Math.floor((t - TL.prose.t0) * TL.prose.cps))
    p.textContent = proseText.slice(0, n)
    const cur = document.querySelector('#card-prose .cursor')
    cur.style.opacity = 0
  }

  // ---- Public ---------------------------------------------------------------
  window.init = (diagrams, mode = 'full', small = false) => {
    D = diagrams
    TL = window.TIMELINES[mode]
    CPS = TL.cps || window.TIMELINES.CPS
    if (TL.bodyClass) document.body.classList.add(TL.bodyClass)
    if (small) {
      document.body.style.width = '1280px'
      document.body.style.height = '720px'
      $('stage').style.transform = 'scale(0.6666667)'
    }
    const canvas = $('board-canvas')
    canvasW = canvas.offsetWidth
    canvasH = canvas.offsetHeight
    const used = new Set(TL.board.filter(e => e.kind === 'add').map(e => e.name))
    for (const name of used) makeLayer(name)
    proseText = document.querySelector('#card-prose .prose p').textContent
    wallText = $('wall-src').textContent
    if (TL.arch) initReveal({ host: 'arch-canvas', name: '8-architecture', order: ARCH_ORDER, w: 1720, h: 400, t0: TL.arch.t0, step: TL.arch.step })
    for (const r of TL.reveals || []) initReveal(r)
    window.seek(0)
    return { duration: TL.duration, canvasW, canvasH }
  }

  window.seek = t => {
    for (const c of document.querySelectorAll('.card')) c.style.opacity = 0
    for (const c of TL.cards) $(c.id).style.opacity = fade(t, c.t0, c.t1, c.d ?? 0.4)
    renderProse(t)
    renderWall(t)
    for (const f of TL.fades || []) {
      const el = $(f.id)
      const p = fade(t, f.t0, f.t1 ?? 1e9, f.d ?? 0.5)
      el.style.opacity = p
      if (f.rise) el.style.transform = `translateY(${((1 - p) * f.rise).toFixed(1)}px)`
    }
    $('app').style.opacity = fade(t, TL.app.t0, TL.app.t1, 0.5)
    if (TL.intro) {
      // The pane slides in beside the conversation, so the two visibly share one window.
      const p = ease(clamp((t - TL.intro.t0) / TL.intro.dur, 0, 1))
      $('board').style.transform = p < 1 ? `translateX(${((1 - p) * (1920 - $('board').offsetLeft)).toFixed(1)}px)` : 'none'
      $('chat').style.opacity = clamp(p * 1.5, 0, 1)
    }
    const ch = TL.chapters.find(c => t >= c.t0 && t < c.t1)
    $('chapter').textContent = ch ? ch.text : ''
    const cap = TL.captions.find(c => t >= c.t0 && t < c.t1)
    const capEl = $('caption')
    if (cap) {
      capEl.innerHTML = cap.text
      capEl.style.opacity = fade(t, cap.t0, cap.t1, 0.25)
    } else capEl.style.opacity = 0
    renderChat(t)
    renderBoard(t)
    renderReveals(t)
  }
})()
