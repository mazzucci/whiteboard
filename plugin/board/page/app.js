// The whiteboard page: diagrams on the board, Claude's notes and the
// person's replies in the conversation beside it. Cards arrive over
// server-sent events; each diagram is drawn here with the vendored Mermaid,
// and the page tells the server how it drew, so errors reach Claude.
'use strict'

const token = new URLSearchParams(location.search).get('t')
const isDark = matchMedia('(prefers-color-scheme: dark)').matches
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const post = (path, body) =>
  fetch(`${path}?t=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// ---------------------------------------------------------------- Markdown
//
// A small, safe subset: headings, paragraphs, lists, quotes, fenced code,
// tables, **bold**, *italic*, `code`, and http(s) links. Everything is escaped
// first; only the tags written here are produced.

function inline(text) {
  const codes = []
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, '$1<i>$2</i>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`)
}

function markdown(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n')
  const out = []
  let i = 0
  const isTableRow = l => /^\s*\|.*\|\s*$/.test(l)
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const fence = /^\s*```(\w*)/.exec(line)
    if (fence) {
      const body = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i])
      i++
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(5, heading[1].length + 2)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      i++
      continue
    }
    if (isTableRow(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line)
      const rows = []
      for (i += 2; i < lines.length && isTableRow(lines[i]); i++) rows.push(cells(lines[i]))
      out.push(
        `<table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>` +
          rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
          '</tbody></table>',
      )
      continue
    }
    const list = /^\s*([-*]|\d+[.)])\s+/.exec(line)
    if (list) {
      const ordered = /\d/.test(list[1])
      const items = []
      for (; i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, ''))
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map(it => `<li>${inline(it)}</li>`).join('')}</${tag}>`)
      continue
    }
    if (/^\s*>/.test(line)) {
      const quote = []
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''))
      out.push(`<blockquote>${markdown(quote.join('\n'))}</blockquote>`)
      continue
    }
    const para = []
    for (; i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|[-*]\s|\d+[.)]\s|>)/.test(lines[i]) && !isTableRow(lines[i]); i++) {
      para.push(inline(lines[i]))
    }
    if (!para.length) para.push(inline(lines[i++]))
    out.push(`<p>${para.join('<br>')}</p>`)
  }
  return out.join('')
}

// ---------------------------------------------------------------- state

/** Drawn diagrams, in the order they arrived: { id, title, source, kind, legend, svg, w, h, view }. */
let diagrams = []
let current = -1
let isCode = false
let seq = 0

const stage = $('stage')
const canvas = $('canvas')

// ---------------------------------------------------------------- the board

function renderTabs() {
  const tabs = $('tabs')
  tabs.innerHTML = ''
  diagrams.forEach((d, i) => {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'tab'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(i === current))
    tab.title = d.title
    tab.innerHTML = `<span class="n">${i + 1}</span>${esc(d.title)}`
    tab.onclick = () => select(i)
    if (d.isNew) {
      tab.classList.add('new')
      d.isNew = false
    }
    tabs.append(tab)
  })
  tabs.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function legendHtml(entries) {
  return (entries ?? [])
    .map(e => `<span><i class="${e.isDashed ? 'dashed' : ''}" style="border-color:${esc(e.stroke ?? 'currentColor')}"></i>${esc(e.label)}</span>`)
    .join('')
}

function select(i) {
  if (!diagrams.length) return
  const shown = diagrams[current] && canvas.innerHTML ? { d: diagrams[current], nodes: nodesOnCanvas() } : null
  current = Math.max(0, Math.min(diagrams.length - 1, i))
  const d = diagrams[current]
  $('toolbar').hidden = false
  $('stage-empty').hidden = true
  $('d-title').textContent = d.title
  $('d-kind').textContent = d.kind
  $('d-count').textContent = `${current + 1}/${diagrams.length}`
  $('prev').disabled = current === 0
  $('next').disabled = current === diagrams.length - 1
  $('legend').innerHTML = legendHtml(d.legend)
  $('source-code').textContent = d.source
  canvas.innerHTML = d.svg
  // A redraw of the diagram on screen keeps its zoom, and a box both share
  // stays where it was: only what changed moves. Anything else is fitted.
  const held = shown && shown.d !== d ? holdView(shown, nodesOnCanvas()) : null
  if (held) {
    d.view = held
    apply()
  } else if (!d.view) fit(d)
  else apply()
  renderTabs()
}

/** The view of the current diagram: zoom and offset in stage pixels. */
function apply() {
  const d = diagrams[current]
  if (!d) return
  const { zoom, x, y } = d.view
  canvas.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`
  $('pct').textContent = `${Math.round(zoom * 100)}%`
}

/**
 * The boxes of the diagram on the canvas, by node id, at their centres in the
 * drawing's own units. Mermaid prefixes ids with the render and suffixes a
 * counter; the id Claude wrote is in between.
 */
function nodesOnCanvas() {
  const nodes = new Map()
  for (const g of canvas.querySelectorAll('g.node[id]')) {
    const id = g.id.replace(/^.*?flowchart-/, '').replace(/-\d+$/, '')
    const at = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)/.exec(g.getAttribute('transform') ?? '')
    if (at) nodes.set(id, { x: Number(at[1]), y: Number(at[2]) })
  }
  return nodes
}

/**
 * The view that keeps a redraw in place: the same zoom, offset so the first
 * box both diagrams share lands where it was. Null when they are not the same
 * diagram (under 60% of their boxes in common) or the earlier one had no view.
 */
function holdView(shown, nodes) {
  const before = shown.nodes
  const view = shown.d.view
  if (!view || !before.size || !nodes.size) return null
  const common = [...nodes.keys()].filter(id => before.has(id))
  if (common.length < 0.6 * Math.max(before.size, nodes.size)) return null
  const a = before.get(common[0])
  const b = nodes.get(common[0])
  return { zoom: view.zoom, x: view.x + (a.x - b.x) * view.zoom, y: view.y + (a.y - b.y) * view.zoom, isFit: false }
}

/** Fits the whole diagram in the stage, never above 150%, centred. */
function fit(d = diagrams[current]) {
  if (!d) return
  const W = stage.clientWidth
  const H = stage.clientHeight
  const pad = 32
  const zoom = Math.max(0.05, Math.min((W - pad * 2) / d.w, (H - pad * 2) / d.h, 1.5))
  d.view = { zoom, x: (W - d.w * zoom) / 2, y: Math.max(pad, (H - d.h * zoom) / 2), isFit: true }
  apply()
}

/** Zooms by a factor around a point of the stage (its centre by default). */
function zoomBy(factor, px = stage.clientWidth / 2, py = stage.clientHeight / 2) {
  const d = diagrams[current]
  if (!d?.view) return
  const { zoom, x, y } = d.view
  const next = Math.max(0.05, Math.min(8, zoom * factor))
  const k = next / zoom
  d.view = { zoom: next, x: px - (px - x) * k, y: py - (py - y) * k, isFit: false }
  apply()
}

function panBy(dx, dy) {
  const d = diagrams[current]
  if (!d?.view) return
  d.view = { ...d.view, x: d.view.x + dx, y: d.view.y + dy, isFit: false }
  apply()
}

function setCode(on) {
  isCode = on
  $('source').hidden = !on
  $('code').setAttribute('aria-pressed', String(on))
  $('stage-hint').hidden = on
}

/** Mermaid's SVG at its natural size, so the page's zoom is the only scaling. */
function natural(svgText) {
  const holder = document.createElement('div')
  holder.innerHTML = svgText
  const svg = holder.querySelector('svg')
  const box = svg?.viewBox?.baseVal
  const w = box?.width || parseFloat(svg?.getAttribute('width')) || 800
  const h = box?.height || parseFloat(svg?.getAttribute('height')) || 600
  if (svg) {
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
    svg.style.maxWidth = 'none'
  }
  return { svg: holder.innerHTML, w, h }
}

const typeOf = source =>
  (source.replace(/^---[\s\S]*?\n---\s*\n/, '').replace(/%%\{[\s\S]*?\}%%/g, '').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('%%')) ?? '')
    .split(/[\s:;{]/)[0]

// ---------------------------------------------------------------- the conversation

function addMessage(card, html) {
  $('chat-empty')?.remove()
  const isYou = card.kind === 'you'
  const el = document.createElement('div')
  el.className = `msg ${isYou ? 'you' : 'claude'}`
  el.dataset.card = card.id
  el.innerHTML =
    `<div class="who">${isYou ? 'You' : 'Claude'}</div><div class="body md">${html}</div>` +
    (isYou ? '<div class="state">Sent to Claude Code</div>' : '')
  const messages = $('messages')
  const isAtBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80
  messages.insertBefore(el, $('typing'))
  // Waiting for an answer from the moment the person speaks; Claude's next card answers it.
  waiting = isYou ? waiting + 1 : 0
  showTyping()
  if (isAtBottom || isYou) messages.scrollTop = messages.scrollHeight
  return el
}

// ---------------------------------------------------------------- is Claude working?
//
// The plugin reports each Claude turn's start and end; the person's messages
// that have no answer yet are "waiting". Between the two, the page always
// says what is happening after they press Send.

let claudeState = 'idle'
let waiting = 0

function showTyping() {
  const typing = $('typing')
  const isWorking = claudeState === 'working'
  typing.hidden = !isWorking && !waiting
  $('typing-text').textContent = isWorking
    ? waiting > 1 ? `Claude is working… your ${waiting} messages are queued` : 'Claude is working…'
    : 'Sent. Claude Code picks it up in a moment…'
  const messages = $('messages')
  if (!typing.hidden && messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120) messages.scrollTop = messages.scrollHeight
}

// ---------------------------------------------------------------- cards

async function add(card, isReplay) {
  if (card.kind === 'end') {
    wrappedUp(card)
    return
  }
  if (card.kind === 'remove') {
    document.querySelectorAll(`[data-card="${card.id}"]`).forEach(el => el.remove())
    return
  }
  if (card.kind === 'you') {
    addMessage(card, markdown(card.text))
    return
  }
  let drawn = null
  if (card.mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: card.theme ?? (isDark ? 'dark' : 'default'),
      htmlLabels: false,
      flowchart: { htmlLabels: false, wrappingWidth: 400 },
    })
    try {
      const { svg } = await mermaid.render(`d${++seq}`, card.mermaid)
      drawn = natural(svg)
      post('/rendered', { id: card.id })
    } catch (err) {
      // Off the board: the server withdraws the card and Claude gets the error.
      post('/rendered', { id: card.id, error: String(err?.message ?? err) })
      document.getElementById(`dd${seq}`)?.remove()
      return
    }
  }
  const title = card.title || (card.mermaid ? typeOf(card.mermaid) || 'Diagram' : '')
  if (drawn) {
    diagrams.push({ id: card.id, title, source: card.mermaid, kind: typeOf(card.mermaid), legend: card.legend, ...drawn, view: null, isNew: !isReplay })
  }
  if (card.text || drawn || title) {
    const head = card.title && card.text ? `<p><b>${esc(card.title)}</b></p>` : ''
    const el = addMessage(card, head + (card.text ? markdown(card.text) : drawn ? '' : `<p><b>${esc(title)}</b></p>`))
    if (drawn) {
      const index = diagrams.length - 1
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'chip'
      chip.textContent = title
      chip.onclick = () => select(index)
      el.querySelector('.body').append(chip)
    }
  }
  if (drawn) select(diagrams.length - 1)
}

// ---------------------------------------------------------------- events

let queue = Promise.resolve()
let isReplaying = false
const events = new EventSource(`/events?t=${token}`)
events.onopen = () => {
  // A reconnect replays every card: start again from nothing.
  diagrams = []
  current = -1
  $('tabs').innerHTML = ''
  canvas.innerHTML = ''
  $('toolbar').hidden = true
  $('stage-empty').hidden = false
  document.querySelectorAll('.msg').forEach(m => m.remove())
  waiting = 0
  setConnected(true)
  isReplaying = true
  // Replayed cards arrive at once; anything after a short pause is new.
  setTimeout(() => (isReplaying = false), 400)
}
events.onerror = () => {
  if (!isEnded) setConnected(false)
}

// ---------------------------------------------------------------- the connection
//
// Nothing can be sent while the session is out of reach. A short drop (sleep,
// network) reconnects by itself; a session that ended or restarted cannot,
// since its board is gone: after a few seconds the page says so, stays
// readable, and keeps trying quietly in case it was only a long drop.

const LOST_AFTER_MS = 8000
let lostTimer = null

function setConnected(isOn) {
  $('conn').classList.toggle('on', isOn)
  $('conn-text').textContent = isOn ? 'connected to the session' : $('lost') ? 'disconnected' : 'reconnecting…'
  $('text').disabled = !isOn
  document.querySelectorAll('.composer button').forEach(b => (b.disabled = !isOn))
  if (isOn) {
    clearTimeout(lostTimer)
    lostTimer = null
    $('lost')?.remove()
    return
  }
  // No answer is coming while disconnected.
  claudeState = 'idle'
  waiting = 0
  showTyping()
  lostTimer ??= setTimeout(showLost, LOST_AFTER_MS)
}

function showLost() {
  if (isEnded || $('lost')) return
  $('conn-text').textContent = 'disconnected'
  const banner = document.createElement('div')
  banner.className = 'ended lost'
  banner.id = 'lost'
  banner.setAttribute('role', 'alert')
  banner.innerHTML =
    '<div><b>Lost the connection to Claude Code.</b> The session ended or restarted, so this page is read-only now; ' +
    'everything on it stays here. To carry on, run <code>/whiteboard</code> in Claude Code: it opens a new page.</div>' +
    '<div class="row"><span>Still trying to reconnect…</span><button type="button" id="dismiss">Dismiss</button></div>'
  document.body.append(banner)
  $('dismiss').onclick = () => banner.remove()
}
events.onmessage = e => {
  const card = JSON.parse(e.data)
  // Status is now, not history: shown at once, not queued behind drawings.
  if (card.kind === 'status') {
    claudeState = card.state
    showTyping()
    return
  }
  const replay = isReplaying
  queue = queue.then(() => add(card, replay)).catch(err => console.error(err))
}

// ---------------------------------------------------------------- controls

$('prev').onclick = () => select(current - 1)
$('next').onclick = () => select(current + 1)
$('zoom-in').onclick = () => zoomBy(1.25)
$('zoom-out').onclick = () => zoomBy(0.8)
$('fit').onclick = () => fit()
$('pct').ondblclick = () => fit()
$('code').onclick = () => setCode(!isCode)
$('copy').onclick = async () => {
  await navigator.clipboard?.writeText(diagrams[current]?.source ?? '')
  $('copy').textContent = 'Copied'
  setTimeout(() => ($('copy').textContent = 'Copy'), 1200)
}

// Drag to pan.
let drag = null
stage.addEventListener('pointerdown', e => {
  if (isCode || e.button !== 0 || !diagrams.length) return
  drag = { x: e.clientX, y: e.clientY }
  stage.setPointerCapture(e.pointerId)
  stage.classList.add('dragging')
})
stage.addEventListener('pointermove', e => {
  if (!drag) return
  panBy(e.clientX - drag.x, e.clientY - drag.y)
  drag = { x: e.clientX, y: e.clientY }
})
const endDrag = () => {
  drag = null
  stage.classList.remove('dragging')
}
stage.addEventListener('pointerup', endDrag)
stage.addEventListener('pointercancel', endDrag)

// A pinch (or Ctrl/Cmd + scroll) zooms around the pointer; plain scroll pans.
stage.addEventListener(
  'wheel',
  e => {
    if (isCode || !diagrams.length) return
    e.preventDefault()
    const r = stage.getBoundingClientRect()
    if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top)
    else panBy(-e.deltaX, -e.deltaY)
  },
  { passive: false },
)

// Keys, when not typing: arrows pan; i o f zoom; p n step; c the source.
document.addEventListener('keydown', e => {
  if ((e.target instanceof Element && e.target.closest('textarea, input, [contenteditable]')) || e.metaKey || e.ctrlKey || e.altKey) return
  const step = 80
  const keys = {
    i: () => zoomBy(1.25), o: () => zoomBy(0.8), f: () => fit(),
    ArrowUp: () => panBy(0, step), ArrowDown: () => panBy(0, -step), ArrowLeft: () => panBy(step, 0), ArrowRight: () => panBy(-step, 0),
    p: () => select(current - 1), n: () => select(current + 1), c: () => setCode(!isCode),
  }
  const act = keys[e.key]
  if (act && diagrams.length) {
    e.preventDefault()
    act()
  }
})

// A fitted diagram stays fitted as the window changes.
new ResizeObserver(() => {
  const d = diagrams[current]
  if (d?.view?.isFit) fit(d)
}).observe(stage)

// ---------------------------------------------------------------- composer

const box = $('text')
async function send(text) {
  text = text.trim()
  if (text) await post('/say', { text })
}
$('form').onsubmit = e => {
  e.preventDefault()
  const t = box.value
  box.value = ''
  send(t)
}
box.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('form').requestSubmit()
  }
})
$('wrap').onclick = () =>
  send('Let us wrap up: summarise what we concluded in the Claude Code conversation, then close the whiteboard.')

// ---------------------------------------------------------------- wrapped up

let isEnded = false

/** The discussion is over: say so, then close the tab, unless the person keeps it. */
function wrappedUp(card) {
  isEnded = true
  claudeState = 'idle'
  waiting = 0
  showTyping()
  events.close()
  $('conn').classList.remove('on')
  $('conn-text').textContent = 'wrapped up'
  box.disabled = true
  document.querySelectorAll('.composer button').forEach(b => (b.disabled = true))
  const banner = document.createElement('div')
  banner.className = 'ended'
  banner.innerHTML =
    `<div><b>Wrapped up.</b> ${card.text ? markdown(card.text).replace(/^<p>|<\/p>$/g, '') : "Claude's summary is in the Claude Code conversation."}</div>` +
    '<div class="row"><span id="countdown"></span><button type="button" id="keep">Keep open</button></div>'
  document.body.append(banner)
  let left = 5
  const tick = () => {
    $('countdown').textContent = `Closing this tab in ${left} s`
    if (left-- > 0) return
    clearInterval(timer)
    window.close()
    // Browsers only let a page close a tab a script opened: say so if it stayed.
    setTimeout(() => {
      $('countdown').textContent = 'You can close this tab.'
      $('keep').hidden = true
    }, 300)
  }
  const timer = setInterval(tick, 1000)
  tick()
  $('keep').onclick = () => {
    clearInterval(timer)
    $('countdown').textContent = 'Kept open. The board is read-only now.'
    $('keep').hidden = true
  }
}
