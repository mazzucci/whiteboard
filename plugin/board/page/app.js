// The whiteboard page: diagrams on the board, Claude's notes and the
// person's replies in the conversation beside it. Cards arrive over
// server-sent events; each diagram is drawn here with the vendored Mermaid,
// and the page tells the server how it drew, so errors reach Claude.
'use strict'

// The token arrives in the address the plugin opened; it then moves to this
// tab's session storage and leaves the address bar (and the history), so it is
// not shown, bookmarked or passed on. A reload finds it in the tab again.
const token = (() => {
  let t = new URLSearchParams(location.search).get('t')
  try {
    if (t) sessionStorage.setItem('board-token', t)
    else t = sessionStorage.getItem('board-token')
  } catch {
    // No storage: the address keeps the token for this tab.
    return t
  }
  if (location.search) history.replaceState(null, '', location.pathname)
  return t
})()
/** This page's own id: the server asks the page that last spoke to apply Claude's amendments. */
const pageId = Math.random().toString(36).slice(2, 12)
const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const post = (path, body) =>
  fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-board-token': token }, body: JSON.stringify(body) })

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
      // One kind per list: a numbered list right after bullets starts a new one.
      const sameKind = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/
      const items = []
      for (; i < lines.length && sameKind.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, ''))
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
/** What the board said, in order (Claude's notes and diagrams, the person's replies): for a saved board. */
const cardLog = []
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
    // Each board has its own diagrams: only this board's are tabs.
    if (d.board !== boardOn) return
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'tab'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(i === current))
    tab.title = d.title
    tab.innerHTML = `<span class="n">${onBoard().indexOf(d) + 1}</span>${esc(d.title)}`
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
  // A diagram on another board (a chip in the conversation, an amendment): that board comes up with it.
  if (diagrams[i] && diagrams[i].board !== boardOn) return showBoard(diagrams[i].board, true, i)
  const shown = diagrams[current] && canvas.innerHTML ? { d: diagrams[current], nodes: nodesOnCanvas() } : null
  current = Math.max(0, Math.min(diagrams.length - 1, i))
  const d = diagrams[current]
  $('toolbar').hidden = false
  $('stage-empty').hidden = true
  $('d-title').textContent = d.title
  $('d-kind').textContent = d.kind
  const own = onBoard()
  $('d-count').textContent = `${own.indexOf(d) + 1}/${own.length}`
  $('prev').disabled = own[0] === d
  $('next').disabled = own.at(-1) === d
  $('legend').innerHTML = legendHtml(d.legend)
  $('source-code').textContent = d.source
  canvas.innerHTML = d.svg
  showPicks(d)
  // A redraw of the diagram on screen keeps its zoom, and a box both share
  // stays where it was: only what changed moves. Anything else is fitted.
  const held = shown && shown.d !== d ? holdView(shown, nodesOnCanvas()) : null
  if (held) {
    d.view = held
    apply()
  } else if (!d.view) fit(d)
  else apply()
  renderStickies()
  keepInView(d)
  renderTabs()
  showEditor(d)
  // The brief's section being pointed at lights up its boxes on whichever diagram is in front.
  showFocus()
}

/** Whether the diagram on screen is a canvas being edited: then the canvas has the pointer and the keys. */
const isEditing = () => !!diagrams[current]?.scene

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
  // Held from a fitted view: the board may still fit it again if it no longer fits.
  return { zoom: view.zoom, x: view.x + (a.x - b.x) * view.zoom, y: view.y + (a.y - b.y) * view.zoom, isFit: false, isFromFit: !!(view.isFit || view.isFromFit) }
}

/** Fits the whole diagram in the stage, never above 150%, centred. */
function fit(d = diagrams[current]) {
  if (!d) return
  const W = stage.clientWidth
  const H = stage.clientHeight
  const pad = 32
  // The diagram and the sticky notes beside it, all in view.
  const e = extentOf(d)
  const w = e.x1 - e.x0
  const h = e.y1 - e.y0
  // Room at the bottom for the key hint.
  const hint = 28
  const zoom = Math.max(0.05, Math.min((W - pad * 2) / w, (H - pad * 2 - hint) / h, 1.5))
  d.view = { zoom, x: (W - w * zoom) / 2 - e.x0 * zoom, y: Math.max(pad, (H - hint - h * zoom) / 2) - e.y0 * zoom, isFit: true }
  apply()
}

/**
 * A view the board chose (fitted, or held from a fitted one) shows the whole
 * diagram and its notes: when they no longer fit, it fits again. A view the
 * person zoomed or panned is theirs, and stays.
 */
function keepInView(d) {
  const v = d?.view
  if (!v || !(v.isFit || v.isFromFit)) return
  const e = extentOf(d)
  const W = stage.clientWidth
  const H = stage.clientHeight - 28
  const isInside = v.x + e.x0 * v.zoom >= 0 && v.y + e.y0 * v.zoom >= 0 && v.x + e.x1 * v.zoom <= W && v.y + e.y1 * v.zoom <= H
  if (v.isFit ? canvas.querySelector('.sticky') : !isInside) fit(d)
}

/** What a fit takes in, in the drawing's own pixels: the diagram and the notes drawn on it. */
function extentOf(d) {
  const e = { x0: 0, y0: 0, x1: d.w, y1: d.h }
  if (diagrams[current] !== d) return e
  for (const el of canvas.querySelectorAll('.sticky')) {
    const x = parseFloat(el.style.left)
    const y = parseFloat(el.style.top)
    e.x0 = Math.min(e.x0, x)
    e.y0 = Math.min(e.y0, y)
    e.x1 = Math.max(e.x1, x + el.offsetWidth)
    e.y1 = Math.max(e.y1, y + el.offsetHeight)
  }
  return e
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
  d.view = { ...d.view, x: d.view.x + dx, y: d.view.y + dy, isFit: false, isFromFit: false }
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
  // Mermaid's strict mode still draws `click … href` as a link: keep the text, drop the link.
  for (const a of holder.querySelectorAll('a')) a.replaceWith(...a.childNodes)
  if (svg) {
    svg.setAttribute('width', String(w))
    svg.setAttribute('height', String(h))
    svg.style.maxWidth = 'none'
  }
  return { svg: holder.innerHTML, w, h }
}

/** A drawing as a standalone SVG file (XML: a label's `<br>` closed, entities spelled out), for an image or a download. */
function svgXmlOf(svgText) {
  const holder = document.createElement('div')
  holder.innerHTML = svgText
  return new XMLSerializer().serializeToString(holder.querySelector('svg'))
}

const typeOf = source =>
  (source.replace(/^---[\s\S]*?\n---\s*\n/, '').replace(/%%\{[\s\S]*?\}%%/g, '').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('%%')) ?? '')
    .split(/[\s:;{]/)[0]

// ---------------------------------------------------------------- the conversation

function addMessage(card, html, isReplay = false) {
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
  if (isYou && !isReplay) pending.push({ at: card._at ?? 0, el })
  if (!isYou) answered()
  if (!isYou && !isReplay) {
    countUnread()
    countChatUnread()
  }
  showTyping()
  if (isAtBottom || isYou) messages.scrollTop = messages.scrollHeight
  return el
}

// ---------------------------------------------------------------- is Claude working?
//
// The plugin reports each Claude turn's start and end; the person's messages
// that have no answer yet are pending. Every event is numbered as it arrives,
// so a message is answered only by a turn that started after it: one typed
// while Claude works waits for the next turn, which is when Claude reads it.

let claudeState = 'idle'
let arrival = 0
/** Arrival numbers: the latest turn's start, and the latest status of either kind. */
let turnStartedAt = 0
let lastStatusAt = 0
/** The person's messages with no answer yet: { at, el }. */
let pending = []
const waitingCount = () => pending.length

/** Claude answered on the board: settles the messages its current turn has read. */
function answered() {
  pending = claudeState === 'working' ? pending.filter(p => p.at > turnStartedAt) : []
}

/** A turn ended: what it read and did not answer on the board, it answered in the conversation. */
function turnEnded() {
  for (const p of pending.filter(p => p.at < turnStartedAt)) {
    const state = p.el.querySelector('.state')
    if (state) state.textContent = 'Claude answered in the Claude Code conversation'
  }
  pending = pending.filter(p => p.at > turnStartedAt)
}

function showTyping() {
  const typing = $('typing')
  const isWorking = claudeState === 'working'
  const waiting = waitingCount()
  // On a narrow screen the conversation may be hidden: the Chat button shows it too.
  document.querySelector('.views [data-view="chat"]')?.classList.toggle('busy', isWorking || waiting > 0)
  document.querySelector('.panes [data-pane="chat"]')?.classList.toggle('busy', isWorking || waiting > 0)
  typing.hidden = !isWorking && !waiting
  $('typing-text').textContent = isWorking
    ? waiting > 1 ? `Claude is working… your ${waiting} messages are queued` : 'Claude is working…'
    : 'Sent. Claude Code picks it up in a moment…'
  // The brief says it too, from what was just set.
  briefTurnChanged(typing.hidden ? null : $('typing-text').textContent)
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
    if (cardLog.some(c => c.id === card.id)) cardLog.splice(cardLog.findIndex(c => c.id === card.id), 1)
    return
  }
  if (card.kind === 'you') {
    cardLog.push(card)
    const section = card.about && briefNow?.sections.find(s => s.id === card.about)
    addMessage(card, markdown(card.text) + (section ? `<div class="about-tag">About “${esc(section.title)}” in the brief</div>` : ''), isReplay)
    return
  }
  if (card.kind === 'sticky') {
    // Claude's activity on the board answers what its turn has read.
    if (!isReplay) {
      answered()
      showTyping()
    }
    pinned(card.diagram).push(card)
    if (diagrams[current]?.id === card.diagram) {
      renderStickies()
      keepInView(diagrams[current])
    }
    // A note on an earlier diagram brings that diagram up.
    const d = diagrams.find(x => x.id === card.diagram)
    if (!isReplay && d && d.board === boardOn && diagrams[current]?.id !== card.diagram) select(diagrams.indexOf(d))
    return
  }
  let drawn = null
  if (card.mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // The board is white in dark mode too, so a diagram's own colours stay readable.
      theme: card.theme ?? 'default',
      htmlLabels: false,
      flowchart: { htmlLabels: false, wrappingWidth: 400 },
    })
    try {
      const { svg } = await mermaid.render(`d${++seq}`, card.mermaid)
      drawn = natural(svg)
      // A chart's slices, bars and points can be clicked: see charts.js. A
      // chart this page cannot read is still drawn, just not clickable.
      try {
        const marks = await marksOf(card.mermaid)
        const marked = marks && withMarks(drawn.svg, marks)
        if (marked) Object.assign(drawn, { svg: marked, marks, picks: new Set() })
      } catch {
        // Not clickable.
      }
      post('/rendered', { id: card.id, unpinned: unpinnedOf(drawn.svg, card.notes) })
    } catch (err) {
      // Off the board: the server withdraws the card and Claude gets the error.
      post('/rendered', { id: card.id, error: String(err?.message ?? err) })
      document.getElementById(`dd${seq}`)?.remove()
      return
    }
  }
  const title = card.title || (card.mermaid ? typeOf(card.mermaid) || 'Diagram' : '')
  if (drawn) {
    diagrams.push({ id: card.id, board: card.board ?? 'main', title, source: card.mermaid, kind: typeOf(card.mermaid), legend: card.legend, ...drawn, view: null, isNew: !isReplay })
    for (const note of card.notes ?? []) pinned(card.id).push({ by: 'claude', ...note })
  }
  if (card.text || drawn || title) {
    cardLog.push(card)
    const head = card.title && card.text ? `<p><b>${esc(card.title)}</b></p>` : ''
    const el = addMessage(card, head + (card.text ? markdown(card.text) : drawn ? '' : `<p><b>${esc(title)}</b></p>`), isReplay)
    if (drawn) {
      const index = diagrams.length - 1
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'chip'
      chip.textContent = title
      chip.onclick = () => {
        setView('board')
        select(index)
      }
      el.querySelector('.body').append(chip)
    }
  }
  // A diagram on another board waits there; one on this board comes up (and the board has room for it again).
  if (drawn && diagrams.at(-1).board === boardOn) {
    document.body.classList.remove('board-empty')
    select(diagrams.length - 1)
  }
  else if (drawn) renderTabs()
}

/** This board's diagrams, in order. */
const onBoard = () => diagrams.filter(d => d.board === boardOn)
/** The diagram `step` places along this board's diagrams from the one on screen. */
function stepDiagram(step) {
  const own = onBoard()
  const at = own.indexOf(diagrams[current])
  const d = own[Math.max(0, Math.min(own.length - 1, at + step))]
  if (d) select(diagrams.indexOf(d))
}

// ---------------------------------------------------------------- events

let queue = Promise.resolve()
let isReplaying = false
/** The connection to the session's board, once it is open. */
let events = null
// It opens once every script on the page has run (DOMContentLoaded): a
// reconnect or a replayed card may need any of them, and on a slow first load
// the connection could otherwise open between two scripts.
addEventListener('DOMContentLoaded', connect)

function connect() {
  // Without the token this page cannot reach the session (a bookmark, a copied
  // address): it says how to open the board instead of trying.
  if (!token) return showLost('no-token')
  events = new EventSource(`/events?t=${encodeURIComponent(token)}&c=${pageId}`)
  events.onopen = () => {
    // A reconnect replays every card: start again from nothing.
    diagrams = []
    current = -1
    $('tabs').innerHTML = ''
    canvas.innerHTML = ''
    $('toolbar').hidden = true
    $('stage-empty').hidden = false
    document.querySelectorAll('.msg').forEach(m => m.remove())
    pending = []
    stickies.clear()
    cardLog.length = 0
    document.body.classList.remove('on-chart')
    document.querySelectorAll('.brief-event').forEach(el => el.remove())
    resetBoards()
    resetBrief()
    setConnected(true)
    isReplaying = true
    // Replayed cards arrive at once; anything after a short pause is new.
    setTimeout(() => (isReplaying = false), 400)
  }
  events.onerror = () => {
    if (isEnded) return
    setConnected(false)
    // Refused (an old or wrong token): the browser will not try again.
    if (events.readyState === EventSource.CLOSED) showLost('refused')
  }
  events.onmessage = onEvent
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
    document.body.classList.remove('has-banner')
    return
  }
  // No answer is coming while disconnected.
  claudeState = 'idle'
  pending = []
  showTyping()
  lostTimer ??= setTimeout(showLost, LOST_AFTER_MS)
}

/**
 * Says why the page cannot reach the session: lost (the session ended or
 * restarted, still retrying), refused (this page's token is not the board's),
 * or no-token (opened without one).
 */
function showLost(why = 'lost') {
  if (isEnded) return
  $('lost')?.remove()
  clearTimeout(lostTimer)
  $('conn').classList.remove('on')
  $('conn-text').textContent = 'disconnected'
  $('text').disabled = true
  document.querySelectorAll('.composer button').forEach(b => (b.disabled = true))
  const open = 'Run <code>/whiteboard</code> in Claude Code to open the board.'
  const say = {
    lost: [
      '<b>Lost the connection to Claude Code.</b> The session ended or restarted, so this page is read-only now; ' +
        `everything on it stays here. ${open}`,
      'Still trying to reconnect…',
    ],
    refused: ['<b>This page cannot reach the session.</b> It belongs to an earlier board. ' + open, 'Not reconnecting.'],
    'no-token': ['<b>This page was opened without its key.</b> ' + open, ''],
  }[why]
  const banner = document.createElement('div')
  banner.className = 'ended lost'
  banner.id = 'lost'
  document.body.classList.add('has-banner')
  banner.setAttribute('role', 'alert')
  banner.innerHTML =
    `<div>${say[0]}</div>` + `<div class="row"><span>${say[1]}</span><button type="button" id="dismiss">Dismiss</button></div>`
  document.body.append(banner)
  $('dismiss').onclick = () => {
    banner.remove()
    document.body.classList.remove('has-banner')
  }
}
function onEvent(e) {
  const card = JSON.parse(e.data)
  const at = ++arrival
  if (card.kind === 'status') {
    lastStatusAt = at
    // A turn's start is shown at once, not queued behind drawings.
    if (card.state === 'working') {
      claudeState = 'working'
      turnStartedAt = at
      showTyping()
      return
    }
    // A turn's end waits behind its cards, which may still be drawing; a
    // newer turn that started meanwhile keeps the page "working".
    queue = queue.then(() => {
      if (lastStatusAt !== at) return
      if (claudeState === 'working') turnEnded()
      claudeState = 'idle'
      showTyping()
    })
    return
  }
  card._at = at
  const replay = isReplaying
  // A canvas, Claude's amendments to one, or a request for a picture: after the cards before them.
  const act = { scene: () => sceneArrived(card, replay), ops: () => opsArrived(card), snapshot: () => snapshotAsked(card), mode: () => setMode(card.mode, false, replay), brief: () => briefArrived(card, replay), board: () => boardArrived(card, replay) }[card.kind]
  queue = queue.then(() => (act ? act() : add(card, replay))).catch(err => console.error(err))
}

// ---------------------------------------------------------------- controls

$('prev').onclick = () => stepDiagram(-1)
$('next').onclick = () => stepDiagram(1)
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

// One pointer drags to pan; two (a pinch) zoom around their midpoint.
const pointers = new Map()
let drag = null
let pinch = null
const pinchOf = () => {
  const [a, b] = [...pointers.values()]
  const r = stage.getBoundingClientRect()
  return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }
}
stage.addEventListener('pointerdown', e => {
  if (isCode || isEditing() || (e.pointerType === 'mouse' && e.button !== 0) || !diagrams.length || e.target.closest('.sticky')) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  try {
    stage.setPointerCapture(e.pointerId)
  } catch {
    // A pointer the browser cannot capture still pans and pinches inside the stage.
  }
  if (pointers.size === 2) {
    drag = null
    pinch = pinchOf()
  } else if (pointers.size === 1) {
    drag = { x: e.clientX, y: e.clientY }
    stage.classList.add('dragging')
  }
})
stage.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pinch && pointers.size === 2) {
    const now = pinchOf()
    if (pinch.d > 0) zoomBy(now.d / pinch.d, now.x, now.y)
    panBy(now.x - pinch.x, now.y - pinch.y)
    pinch = now
  } else if (drag) {
    panBy(e.clientX - drag.x, e.clientY - drag.y)
    drag = { x: e.clientX, y: e.clientY }
  }
})
const endPointer = e => {
  pointers.delete(e.pointerId)
  pinch = null
  if (pointers.size === 1) {
    const [p] = pointers.values()
    drag = { ...p }
  } else {
    drag = null
    stage.classList.remove('dragging')
  }
}
stage.addEventListener('pointerup', endPointer)
stage.addEventListener('pointercancel', endPointer)
// A double-click or double-tap fits the diagram.
stage.addEventListener('dblclick', e => {
  if (!isCode && !isEditing() && !e.target.closest('.sticky')) fit()
})

// A pinch (or Ctrl/Cmd + scroll) zooms around the pointer; plain scroll pans.
stage.addEventListener(
  'wheel',
  e => {
    if (isCode || isEditing() || !diagrams.length) return
    e.preventDefault()
    const r = stage.getBoundingClientRect()
    if (e.ctrlKey || e.metaKey) zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top)
    else panBy(-e.deltaX, -e.deltaY)
  },
  { passive: false },
)

// Keys, when not typing: arrows pan; i o f zoom; [ ] step; c the source.
document.addEventListener('keydown', e => {
  if ((e.target instanceof Element && e.target.closest('textarea, input, [contenteditable]')) || e.metaKey || e.ctrlKey || e.altKey) return
  // An open menu has the keys.
  if (document.querySelector('.menu:not([hidden])')) return
  // On a canvas, only stepping between diagrams: every other key is the editor's.
  if (isEditing() && e.key !== '[' && e.key !== ']') return
  if (isEditing() && e.target instanceof Element && e.target.closest('.editor')) return
  const step = 80
  const keys = {
    i: () => zoomBy(1.25), o: () => zoomBy(0.8), f: () => fit(),
    ArrowUp: () => panBy(0, step), ArrowDown: () => panBy(0, -step), ArrowLeft: () => panBy(step, 0), ArrowRight: () => panBy(-step, 0),
    '[': () => stepDiagram(-1), ']': () => stepDiagram(1), c: () => setCode(!isCode),
  }
  const act = keys[e.key]
  if (act && diagrams.length) {
    e.preventDefault()
    act()
  }
})

// A fitted diagram stays fitted as the window changes.
// Notes on no box go beside the diagram, or under it on an upright board: a
// rotation that changes which, places them again.
let wasUpright = null
new ResizeObserver(() => {
  const d = diagrams[current]
  const isUpright = stage.clientHeight > stage.clientWidth * 1.2
  if (d && wasUpright !== null && isUpright !== wasUpright && stage.clientWidth) renderStickies()
  wasUpright = isUpright
  if (d?.view?.isFit) fit(d)
}).observe(stage)

// ---------------------------------------------------------------- composer

const box = $('text')
async function send(text, isTyped = true, about = isTyped ? briefAbout() : null) {
  const asked = about?.asked ?? text.trim()
  // Choices on the brief go with any message, or alone.
  const chose = isTyped ? [briefChoicesSaid(), briefDecisionSaid()].filter(Boolean).join(' ') : ''
  // Changes made on a canvas go first, in words (and what is selected, for what they typed).
  text = withChanges(text.trim(), isTyped)
  if (chose) text = text ? `${chose}\n\n${text}` : chose
  // A question about a section of the brief says which, so the answer lands under it.
  if (about && asked && text.endsWith(asked)) text = `${text.slice(0, -asked.length)}${about.said}\n${asked}`
  // More detail is asked for, not a question: nothing waits under the section for an answer.
  // A side board's decision is for the main board's constraint it was opened for.
  const choices = chose ? [...briefChoicesToSend(), ...(briefDecision ? [{ id: briefDecision.board, board: 'main', choice: briefDecision.choice }] : [])] : undefined
  const sent = text
    ? await post('/say', { page: pageId, text, board: boardOn, ...(about && asked ? { about: about.id, asked, ...(about.isMore ? { isMore: true } : {}) } : {}), ...(choices ? { choices } : {}) }).catch(() => null)
    : null
  // post() gives the fetch Response: ok once the board has the message.
  if (choices && sent?.ok) briefChoicesSent()
  if (about && asked && text) briefSent()
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
  send('Let us wrap up: summarise what we concluded in the Claude Code conversation, then close the whiteboard.', false)

// ---------------------------------------------------------------- wrapped up

let isEnded = false

/** The discussion is over: say so, then close the tab, unless the person keeps it. */
function wrappedUp(card) {
  isEnded = true
  claudeState = 'idle'
  pending = []
  showTyping()
  events?.close()
  $('conn').classList.remove('on')
  $('conn-text').textContent = 'wrapped up'
  box.disabled = true
  document.querySelectorAll('.composer button').forEach(b => (b.disabled = true))
  const banner = document.createElement('div')
  banner.className = 'ended'
  document.body.classList.add('has-banner')
  banner.innerHTML =
    `<div><b>Wrapped up.</b> ${card.text ? markdown(card.text).replace(/^<p>|<\/p>$/g, '') : "Claude's summary is in the Claude Code conversation."}</div>` +
    '<div class="row"><span id="countdown"></span><span class="buttons"><button type="button" id="save-ended" title="Every diagram, its notes and the conversation, as one web page">Save board</button><button type="button" id="keep">Keep open</button></span></div>'
  document.body.append(banner)
  let left = 5
  // Not while the person is on the banner: they may be about to save.
  const isHeld = () => banner.matches(':hover') || banner.contains(document.activeElement)
  const tick = () => {
    if (isHeld()) {
      $('countdown').textContent = 'Closing this tab when you move away'
      left = Math.max(left, 3)
      return
    }
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
  // Saving keeps the page open: the save may take a moment, and the person may want another.
  $('save-ended').onclick = async () => {
    $('keep').click()
    try {
      await SAVES.html()
      $('countdown').textContent = 'Saved. The board is read-only now.'
    } catch (err) {
      $('countdown').textContent = `Could not save: ${err?.message ?? err}`
    }
  }
}


// ---------------------------------------------------------------- sticky notes
//
// Claude's sticky notes, pinned beside a box over the drawing, so the diagram
// itself does not change: a proposal, a question, an aside.

/** Notes by diagram card id. */
const stickies = new Map()
const pinned = id => (stickies.has(id) ? stickies.get(id) : stickies.set(id, []).get(id))

/** In a drawing (the canvas, or a diagram not shown yet), the box with this node id, or a chart's slice, bar or point with this label. */
const boxIn = (root, on) =>
  on
    ? [...root.querySelectorAll('g.node[id]')].find(g => g.id.replace(/^.*?flowchart-/, '').replace(/-\d+$/, '') === on) ??
      // A bar before a line's point with the same label.
      [...root.querySelectorAll('[data-mark]')].filter(el => el.dataset.label === on).sort((a, b) => a.classList.contains('line-dot') - b.classList.contains('line-dot'))[0]
    : undefined
const boxOf = on => boxIn(canvas, on)

/** The `on` of each note that names nothing in the drawing: such a note sits beside the diagram. */
function unpinnedOf(svgText, notes) {
  const holder = document.createElement('div')
  holder.innerHTML = svgText
  return (notes ?? []).filter(n => n.on && !boxIn(holder, n.on)).map(n => n.on)
}

const NOTE_W = 214
const NOTE_H = 82

/** The boxes and the notes already placed, as rectangles on the canvas. */
function obstacles(except) {
  const rects = []
  for (const g of canvas.querySelectorAll('g.node, [data-mark], .sticky')) {
    // Itself (a note still being measured) is no obstacle.
    if (g === except || g.style.visibility === 'hidden') continue
    const r = g.getBoundingClientRect()
    const a = toCanvas(r.left, r.top)
    const b = toCanvas(r.right, r.bottom)
    rects.push({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y })
  }
  return rects
}
const overlaps = (p, rects, h = NOTE_H) => rects.some(r => p.x < r.x + r.w && p.x + NOTE_W > r.x && p.y < r.y + r.h && p.y + h > r.y)

/** A point on the canvas, in the drawing's own pixels, from a point on screen. */
function toCanvas(clientX, clientY) {
  const r = canvas.getBoundingClientRect()
  const zoom = diagrams[current]?.view?.zoom ?? 1
  return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom }
}

/**
 * Where a note on a box goes: just below it, or else in the first free place
 * to its right, left or above, clear of other boxes and notes; failing that,
 * below the diagram.
 */
function placeOf(note, stack, h = NOTE_H) {
  const g = boxOf(note.on)
  if (g) {
    const r = g.getBoundingClientRect()
    const a = toCanvas(r.left, r.top)
    const b = toCanvas(r.right, r.bottom)
    const rects = obstacles(g)
    const gap = 12
    const tries = [
      { x: (a.x + b.x - NOTE_W) / 2, y: b.y + gap },
      { x: b.x + gap, y: a.y - 6 },
      { x: a.x - NOTE_W - gap, y: a.y - 6 },
      { x: (a.x + b.x - NOTE_W) / 2, y: a.y - h - gap },
    ]
    for (let shift = 0; shift < 4; shift++) {
      for (const t of tries) {
        const p = { x: t.x, y: t.y + shift * (h + 8) }
        if (!overlaps(p, rects, h)) return p
      }
    }
    // Nowhere free beside it: below the whole diagram, under its box, where it
    // covers nothing.
    const d = diagrams[current]
    return { x: Math.max(0, Math.min((a.x + b.x - NOTE_W) / 2, d.w - NOTE_W)), y: d.h + gap + stack * (NOTE_H + 8) }
  }
  if (Number.isFinite(note.x)) return { x: note.x, y: note.y }
  const d = diagrams[current]
  return { x: d.w + 14, y: 8 + stack * 74 }
}

function renderStickies() {
  canvas.querySelectorAll('.sticky').forEach(el => el.remove())
  const d = diagrams[current]
  if (!d) return
  const perBox = new Map()
  // Notes on no box line up in a column beside the diagram, each below the
  // last; on a tall, narrow board (a phone held upright), under the diagram.
  const isUpright = stage.clientHeight > stage.clientWidth * 1.2
  let column = isUpright ? d.h + 16 : 8
  for (const note of stickies.get(d.id) ?? []) {
    const el = document.createElement('div')
    el.className = 'sticky'
    el.style.visibility = 'hidden'
    el.innerHTML = `<div class="by">Sticky note · Claude</div><div class="md">${inline(note.text)}</div>`
    canvas.append(el)
    // Placed by its real height, so long notes never overlap.
    const h = el.offsetHeight
    let at
    if (boxOf(note.on)) {
      const stack = perBox.get(note.on) ?? 0
      perBox.set(note.on, stack + 1)
      at = placeOf(note, stack, h)
    } else if (Number.isFinite(note.x)) {
      at = { x: note.x, y: note.y }
    } else {
      at = isUpright ? { x: Math.max(0, (d.w - NOTE_W) / 2), y: column } : { x: d.w + 14, y: column }
      column += h + 12
    }
    el.style.left = `${at.x}px`
    el.style.top = `${at.y}px`
    el.style.visibility = ''
  }
}


// ---------------------------------------------------------------- phones: two views
//
// On a narrow screen the board and the conversation take turns at full size,
// switched in the header. Claude's messages that arrive while the board is in
// front are counted on the Chat button.

const isNarrow = () => matchMedia('(max-width: 900px)').matches
let unread = 0
function setView(view) {
  document.body.classList.toggle('view-chat', view === 'chat')
  document.querySelectorAll('.views [data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)))
  if (view === 'chat') {
    unread = 0
    $('unread').hidden = true
    const messages = $('messages')
    messages.scrollTop = messages.scrollHeight
  }
}
function countUnread() {
  if (!isNarrow() || document.body.classList.contains('view-chat')) return
  unread++
  $('unread').textContent = String(unread)
  $('unread').hidden = false
}
document.querySelectorAll('.views [data-view]').forEach(b => (b.onclick = () => setView(b.dataset.view)))
