// Editing a diagram on the board: Edit turns it into a canvas (Excalidraw,
// loaded then), where the person drags, writes and connects boxes. What they
// changed goes to Claude as words with their next message; Claude amends the
// canvas with small operations (edit_board) instead of drawing it again; and
// either can ask for a picture of it. Runs beside app.js, whose state
// (diagrams, current, post, …) it shares.
'use strict'

let editor = null // { ready, api, show, unmount } for the diagram on screen, when it is a canvas
/** The board's mode: `diagrams` (Claude's, as drawn) or `canvas` (every diagram editable, amended in place). */
let boardMode = 'diagrams'
/** The mode the person switched to, said to Claude with their next message. */
let modeSwitched = null
/**
 * On a canvas board, which diagrams are editable without asking: those that
 * arrive after the switch (ids above `canvasFrom`), and those the person or
 * the switch picked (`toEdit`). The ones before stay drawings until edited.
 */
let canvasFrom = Infinity
const toEdit = new Set()
let editorLoad = null
/** The canvas on screen, for the board's own tests. */
window.boardCanvas = () => editor

/** Loads the editor once, from this board's own server. */
function loadEditor() {
  editorLoad ??= new Promise((resolve, reject) => {
    window.EXCALIDRAW_ASSET_PATH = `${location.origin}/editor/`
    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = '/editor.css'
    document.head.append(css)
    const js = document.createElement('script')
    js.src = '/editor.js'
    js.onload = () => resolve(window.WhiteboardEditor)
    js.onerror = () => reject(new Error('the editor did not load'))
    document.head.append(js)
  })
  return editorLoad
}

// ---------------------------------------------------------------- what is on a canvas

const NAMES = { unverified: 'grey (not measured)', fine: 'green (no problem)', problem: 'red (a problem)', proposed: 'lavender (proposed)', suspect: 'amber (suspect)', note: 'a sticky note', plain: 'plain' }

/** What the person has selected on a canvas, in words, each box by its ref. */
function selectionOf(elements, ids = []) {
  const live = elements.filter(e => !e.isDeleted)
  const byId = new Map(live.map(e => [e.id, e]))
  const shapes = live.filter(e => ['rectangle', 'ellipse', 'diamond'].includes(e.type))
  const label = e => live.find(t => t.type === 'text' && t.containerId === e.id)?.originalText ?? ''
  const refOf = e => e?.customData?.ref ?? e?.id
  const q = t => `"${String(t).replace(/\s+/g, ' ').trim()}"`
  const picked = new Set(ids.map(id => byId.get(id)).filter(Boolean).map(e => (e.containerId && byId.get(e.containerId)) || e))
  return [...picked].map(e =>
    e.customData?.kind === 'note' ? `the sticky note ${q(label(e))}`
    : ['rectangle', 'ellipse', 'diamond'].includes(e.type) ? `\`${refOf(e)}\` ${q(label(e))}`
    : e.type === 'arrow' || e.type === 'line'
      ? `the arrow ${byId.get(e.startBinding?.elementId) ? `\`${refOf(byId.get(e.startBinding.elementId))}\`` : '(loose)'} → ${byId.get(e.endBinding?.elementId) ? `\`${refOf(byId.get(e.endBinding.elementId))}\`` : '(loose)'}`
    : e.type === 'text' ? `the text ${q(e.originalText)}`
    : e.type === 'freedraw' ? `a freehand mark${nearest(e, shapes) ? ` near \`${refOf(nearest(e, shapes))}\`` : ''}`
    : `a ${e.type}`,
  )
}

/** A canvas in words: boxes, arrows, notes, text and drawings, each box by the ref Claude uses. */
function summaryOf(elements, selectedIds = []) {
  const live = elements.filter(e => !e.isDeleted)
  const byId = new Map(live.map(e => [e.id, e]))
  // A sequence diagram's participant is drawn twice, `App-top` and `App-bottom`: one box, `App`.
  const free = live.filter(e => e.type === 'text' && !e.containerId)
  // A label drawn just under its box (an actor's name) is that box's text.
  const under = new Map()
  for (const s of live.filter(e => ['rectangle', 'ellipse', 'diamond'].includes(e.type))) {
    if (live.some(t => t.type === 'text' && t.containerId === s.id)) continue
    const t = free.find(t => !under.has(t) && t.y >= s.y + s.height - 4 && t.y < s.y + s.height + 70 && Math.abs(centreOf(t).x - centreOf(s).x) < Math.max(s.width, t.width))
    if (t) under.set(t, s.id)
  }
  const named = new Map([...under].map(([t, id]) => [id, t.originalText]))
  const label = e => live.find(t => t.type === 'text' && t.containerId === e.id)?.originalText ?? named.get(e.id) ?? ''
  // A sequence diagram draws each participant twice, `App-top` and `App-bottom`,
  // with the same name: one box, `App`. Only then: a flowchart may have
  // `nav-top` and `nav-bottom` boxes of its own.
  const byRef = new Map(live.map(e => [String(e.customData?.ref ?? e.id), e]))
  const pair = r => {
    const m = /^(.+)-(top|bottom)(-\d+)?$/.exec(r)
    const other = m && byRef.get(`${m[1]}-${m[2] === 'top' ? 'bottom' : 'top'}${m[3] ?? ''}`)
    return other && label(other) === label(byRef.get(r)) ? m : null
  }
  const refOf = e => {
    if (!e) return undefined
    const r = String(e.customData?.ref ?? e.id)
    return pair(r)?.[1] ?? r
  }
  const isRepeat = e => pair(String(e?.customData?.ref ?? e?.id ?? ''))?.[2] === 'bottom'
  const classOf = e => {
    const c = Object.entries(window.WhiteboardEditor?.CLASSES ?? {}).find(([, s]) => s.backgroundColor === e.backgroundColor && s.strokeColor === e.strokeColor)
    if (c) return c[0]
    const named = Object.entries(window.WhiteboardEditor?.COLORS ?? {}).find(([, [fill, stroke]]) => fill === e.backgroundColor && stroke === e.strokeColor)
    if (named) return named[0]
    return e.backgroundColor && e.backgroundColor !== 'transparent' ? e.backgroundColor : 'plain'
  }
  const shapes = live.filter(e => ['rectangle', 'ellipse', 'diamond'].includes(e.type) && !isRepeat(e))
  const box = e => ({ ref: refOf(e), text: label(e), class: classOf(e), x: Math.round(e.x), y: Math.round(e.y), w: Math.round(e.width), h: Math.round(e.height) })
  return {
    boxes: shapes.filter(e => e.customData?.kind !== 'note' && classOf(e) !== 'note').map(box),
    notes: shapes.filter(e => e.customData?.kind === 'note' || classOf(e) === 'note').map(e => ({ ...box(e), on: e.customData?.on ? (pair(e.customData.on)?.[1] ?? e.customData.on) : refOf(nearest(e, shapes)) })),
    arrows: live
      .filter(e => e.type === 'arrow' || e.type === 'line')
      .map(e => ({ from: refOf(byId.get(e.startBinding?.elementId)) ?? null, to: refOf(byId.get(e.endBinding?.elementId)) ?? null, text: label(e) }))
      // A line joined to nothing and saying nothing (a lifeline, a frame) is drawing, not a connection.
      .filter(a => a.from || a.to || a.text),
    texts: free.filter(e => !under.has(e)).map(e => ({ text: e.originalText, near: refOf(nearest(e, shapes)) ?? null })),
    drawings: live.filter(e => e.type === 'freedraw').map(e => ({ near: refOf(nearest(e, shapes)) ?? null })),
    images: live.filter(e => e.type === 'image').length,
    selected: selectionOf(elements, selectedIds),
  }
}

const centreOf = e => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 })
function nearest(e, shapes) {
  const c = centreOf(e)
  let best = null
  let bestD = Infinity
  for (const s of shapes) {
    if (s === e || s.customData?.kind === 'note') continue
    const d = Math.hypot(centreOf(s).x - c.x, centreOf(s).y - c.y)
    if (d < bestD) [best, bestD] = [s, d]
  }
  return best
}

/** Where a box sits next to its nearest neighbour, in words. */
function whereIs(b, boxes) {
  let best = null
  let bestD = Infinity
  for (const o of boxes) {
    if (o.ref === b.ref) continue
    const d = Math.hypot(o.x + o.w / 2 - (b.x + b.w / 2), o.y + o.h / 2 - (b.y + b.h / 2))
    if (d < bestD) [best, bestD] = [o, d]
  }
  if (!best) return ''
  const dx = b.x + b.w / 2 - (best.x + best.w / 2)
  const dy = b.y + b.h / 2 - (best.y + best.h / 2)
  const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right of' : 'left of') : dy > 0 ? 'below' : 'above'
  return ` (${side} \`${best.ref}\`)`
}

const quote = t => `"${String(t).replace(/\s+/g, ' ').trim()}"`

/** What changed between two summaries, as lines for Claude. */
function changesBetween(before, after) {
  const lines = []
  const was = new Map(before.boxes.map(b => [b.ref, b]))
  const now = new Map(after.boxes.map(b => [b.ref, b]))
  for (const b of after.boxes) {
    const o = was.get(b.ref)
    if (!o) {
      lines.push(`added a box \`${b.ref}\` ${quote(b.text)}${b.class !== 'plain' ? `, ${NAMES[b.class] ?? b.class}` : ''}${whereIs(b, after.boxes)}`)
      continue
    }
    if (o.text !== b.text) lines.push(`changed \`${b.ref}\` from ${quote(o.text)} to ${quote(b.text)}`)
    if (o.class !== b.class) lines.push(`made \`${b.ref}\` ${NAMES[b.class] ?? b.class}`)
    if (Math.hypot(o.x - b.x, o.y - b.y) > 40) lines.push(`moved \`${b.ref}\`${whereIs(b, after.boxes)}`)
  }
  for (const o of before.boxes) if (!now.has(o.ref)) lines.push(`removed \`${o.ref}\` ${quote(o.text)}`)
  // Arrows as a multiset: two arrows may join the same boxes (a request, then its answer),
  // so an arrow is the same one only with the same ends and the same label.
  const ends = a => `${a.from}→${a.to}`
  const unmatched = (xs, ys) => {
    const left = [...ys]
    return xs.filter(a => {
      const i = left.findIndex(b => ends(b) === ends(a) && b.text === a.text)
      if (i < 0) return true
      left.splice(i, 1)
      return false
    })
  }
  const added = unmatched(after.arrows, before.arrows)
  const gone = unmatched(before.arrows, after.arrows)
  for (const a of added) {
    // The same ends, another label: relabelled, not a new arrow.
    const i = gone.findIndex(o => ends(o) === ends(a))
    if (i >= 0 && a.from && a.to) {
      gone.splice(i, 1)
      lines.push(`labelled \`${a.from}\` → \`${a.to}\` ${quote(a.text)}`)
    } else {
      lines.push(a.from && a.to ? `connected \`${a.from}\` → \`${a.to}\`${a.text ? ` ${quote(a.text)}` : ''}` : `drew an arrow${a.from ? ` from \`${a.from}\`` : ''}${a.to ? ` to \`${a.to}\`` : ''} not joined at both ends`)
    }
  }
  for (const a of gone) lines.push(`removed the arrow \`${a.from}\` → \`${a.to}\`${a.text ? ` ${quote(a.text)}` : ''}`)
  const notesWere = new Map(before.notes.map(n => [n.ref, n]))
  for (const n of after.notes) {
    const o = notesWere.get(n.ref)
    if (!o) lines.push(`added a sticky note${n.on ? ` by \`${n.on}\`` : ''}: ${quote(n.text)}`)
    else if (o.text !== n.text) lines.push(`changed the sticky note${n.on ? ` by \`${n.on}\`` : ''} to ${quote(n.text)}`)
  }
  for (const n of before.notes) if (!after.notes.some(x => x.ref === n.ref)) lines.push(`removed the sticky note ${quote(n.text)}`)
  const textsWere = new Set(before.texts.map(t => t.text))
  for (const t of after.texts) if (!textsWere.has(t.text)) lines.push(`wrote ${quote(t.text)}${t.near ? ` near \`${t.near}\`` : ''}`)
  const drawn = after.drawings.length - before.drawings.length
  if (drawn > 0) {
    const near = [...new Set(after.drawings.slice(-drawn).map(d => d.near).filter(Boolean))]
    lines.push(`drew ${drawn === 1 ? 'a freehand mark' : `${drawn} freehand marks`}${near.length ? ` near ${near.map(r => `\`${r}\``).join(', ')}` : ''} (read_board with image: true shows them)`)
  }
  return lines
}

// ---------------------------------------------------------------- the canvas on screen

/** Turns a diagram into a canvas: Mermaid's layout, colours and ids, and its sticky notes as notes on it. */
async function makeCanvas(d) {
  const W = await loadEditor()
  let elements
  try {
    elements = await W.fromMermaid(d.source)
  } catch (err) {
    // Said on the page, and to Claude when it asked: never an empty canvas.
    d.noEdit = String(err?.message ?? err)
    showEditNote(d)
    throw err
  }
  const notes = (stickies.get(d.id) ?? []).map((n, i) => ({ op: 'note', id: `note-${i + 1}`, on: n.on, text: n.text }))
  if (notes.length) elements = W.applyOps(elements, notes).elements
  // Every box named before the canvas counts as what Claude knows: naming one later would read as a change.
  elements = withRefs(elements)
  d.scene = elements
  d.known = elements
  saveScene(d)
}

/**
 * The board's mode, from Claude, another page, or the person (`isTheirs`).
 * Switching to a canvas makes the diagram on screen editable, and the ones
 * Claude draws from then on; the earlier ones stay drawings until edited.
 */
function setMode(mode, isTheirs = false, isReplay = false) {
  if (mode !== 'diagrams' && mode !== 'canvas') return
  if (mode === 'canvas' && boardMode !== 'canvas') {
    canvasFrom = Math.max(0, ...diagrams.map(d => d.id))
    if (!isReplay && diagrams[current]) toEdit.add(diagrams[current].id)
  }
  if (mode === 'diagrams') canvasFrom = Infinity
  boardMode = mode
  document.querySelectorAll('.modes [data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)))
  if (isTheirs) {
    post('/mode', { page: pageId, mode })
    modeSwitched = mode
  }
  showEditor(diagrams[current])
}

/** Shows the diagram on screen as a canvas, or takes the canvas away for a drawn diagram. */
async function showEditor(d) {
  // A diagram picked with Edit, or (on a canvas board) drawn since the switch, becomes editable when it is shown.
  if (d && !d.scene && !d.noEdit && EDITABLE.test(d.kind) && (toEdit.has(d.id) || (boardMode === 'canvas' && d.id > canvasFrom))) {
    d.converting ??= makeCanvas(d).finally(() => (d.converting = null))
    await d.converting.catch(() => {})
    if (diagrams[current] !== d) return
  }
  if (editor) {
    editor.unmount()
    editor = null
  }
  const host = $('editor')
  const isCanvas = !!d?.scene
  document.body.classList.toggle('editing', isCanvas)
  host.hidden = !isCanvas
  $('edit').hidden = !d || !!d.scene || !!d.noEdit || !EDITABLE.test(d.kind)
  showEditNote(d)
  if (!isCanvas) return
  const W = await loadEditor()
  if (diagrams[current] !== d) return
  let timer = null
  editor = W.mount(host, {
    elements: d.scene,
    onChange: (els, appState) => {
      const selected = Object.keys(appState?.selectedElementIds ?? {}).filter(id => appState.selectedElementIds[id])
      clearTimeout(timer)
      timer = setTimeout(() => {
        // Only a change the person made: the same elements again (a redraw) are not one.
        const version = els.reduce((n, e) => n + e.version, 0)
        const isSelectionNew = selected.join() !== (d.selected ?? []).join()
        if (version === d.version && !isSelectionNew) return
        d.selected = selected
        if (version !== d.version) {
          // The elements this page changed: its own edits, told apart from another page's.
          const was = new Map((d.scene ?? []).map(e => [e.id, e.version]))
          d.mine ??= new Set()
          for (const e of els) if (was.get(e.id) !== e.version) d.mine.add(e.id)
          d.version = version
          d.scene = withRefs(els)
        }
        // What is selected is part of what Claude reads back.
        saveScene(d)
        showPending()
      }, 400)
    },
  })
}

/** A line in the toolbar when a diagram cannot become a canvas. */
function showEditNote(d) {
  const note = $('edit-note')
  note.hidden = !d?.noEdit || diagrams[current] !== d
  note.textContent = d?.noEdit ? 'This diagram cannot be edited on a canvas; it stays as drawn.' : ''
}

const EDITABLE = /^(flowchart|graph|sequenceDiagram|classDiagram|erDiagram|stateDiagram)/

/** A box the person drew gets a ref from its text, so both sides can name it. */
function withRefs(elements) {
  const used = new Set(elements.map(e => e.customData?.ref).filter(Boolean))
  return elements.map(e => {
    if (e.isDeleted || !['rectangle', 'ellipse', 'diamond'].includes(e.type) || e.customData?.ref) return e
    const text = elements.find(t => t.type === 'text' && t.containerId === e.id && !t.isDeleted)?.originalText ?? ''
    const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'box'
    let ref = base
    for (let n = 2; used.has(ref); n++) ref = `${base}-${n}`
    used.add(ref)
    return { ...e, customData: { ...e.customData, ref } }
  })
}

function saveScene(d) {
  post('/scene', { page: pageId, diagram: d.id, elements: d.scene.filter(e => !e.isDeleted), summary: summaryOf(d.scene, d.selected) })
}

/**
 * The changes not yet sent, counted on the Send button: the canvas against
 * `known`, the canvas as Claude last knew it (when it arrived or was sent,
 * with Claude's own amendments since).
 */
function pendingChanges() {
  return diagrams.filter(d => d.scene && d.known).flatMap(d => {
    const lines = changesBetween(summaryOf(d.known), summaryOf(d.scene))
    return lines.length ? [{ d, lines }] : []
  })
}
function showPending() {
  const n = pendingChanges().reduce((k, p) => k + p.lines.length, 0)
  const send = $('form').querySelector('[type=submit]')
  send.textContent = n ? `Send ${n} change${n === 1 ? '' : 's'}` : 'Send'
}

/** The person's changes, in words, ahead of what they typed; then they count as seen. */
function withChanges(text, withSelection = true) {
  const pending = pendingChanges()
  const said = []
  if (modeSwitched) {
    said.push(modeSwitched === 'canvas' ? 'I switched the board to canvas mode: we edit the diagrams together.' : 'I switched the board back to diagrams mode.')
    modeSwitched = null
  }
  said.push(...pending.map(({ d, lines }) => `I changed "${d.title}" on the board:\n${lines.map(l => `- ${l}`).join('\n')}`))
  for (const { d } of pending) {
    d.known = d.scene
    d.mine = new Set()
  }
  if (pending.length) showPending()
  // What they have selected is what "this" means in what they wrote.
  const d = diagrams[current]
  const selected = d?.scene && text && withSelection ? selectionOf(d.scene, d.selected) : []
  if (selected.length) said.push(`Selected on the board, in "${d.title}": ${selected.join(', ')}`)
  if (!said.length) return text
  return text ? `${said.join('\n\n')}\n\n${text}` : said.join('\n\n')
}

// ---------------------------------------------------------------- from the server

/** A canvas as another page or the server has it. */
async function sceneArrived(event, isReplay) {
  const d = diagrams.find(x => x.id === event.diagram)
  if (!d) return
  await loadEditor()
  // Changes this page has not sent yet stay unsent: they are counted against
  // what Claude knew, not against what another page just saved.
  const isPending = !isReplay && d.known && d.scene && d.mine?.size > 0 && changesBetween(summaryOf(d.known), summaryOf(d.scene)).length > 0
  // Known as it arrives (what was there before this page opened, or what
  // another page sent), but for this page's own unsent edits: those stay
  // against what Claude knew, so they are still told, and only once.
  if (isPending) {
    const known = new Map(d.known.map(e => [e.id, e]))
    const arrived = new Set(event.elements.map(e => e.id))
    d.known = [
      ...event.elements.flatMap(e => (d.mine.has(e.id) ? (known.has(e.id) ? [known.get(e.id)] : []) : [e])),
      ...[...d.mine].filter(id => !arrived.has(id) && known.has(id)).map(id => known.get(id)),
    ]
  } else {
    d.known = event.elements
    d.mine = new Set()
  }
  d.scene = event.elements
  d.version = d.scene.reduce((n, e) => n + e.version, 0)
  if (diagrams[current] === d) {
    if (editor) editor.show(d.scene)
    else showEditor(d)
  }
  if (!isReplay) showPending()
}

/** Claude's amendments: applied here, saved, and answered. */
async function opsArrived(event) {
  // Claude's activity on the board answers what its turn has read.
  answered()
  showTyping()
  const d = diagrams.find(x => x.id === event.diagram)
  if (!d) return post('/applied', { page: pageId, id: event.id, error: 'that diagram is not on this page' })
  try {
    if (!d.scene) await makeCanvas(d)
    const W = await loadEditor()
    // On the canvas as the person has it, unsent changes included: Claude's go on top.
    const current_ = editor && diagrams[current] === d ? editor.api.getSceneElementsIncludingDeleted() : d.scene
    const out = W.applyOps(current_, event.ops)
    d.scene = out.elements
    // What Claude did is not the person's change: their unsent ones stay unsent.
    d.known = W.applyOps(d.known ?? current_, event.ops).elements
    d.version = d.scene.reduce((n, e) => n + e.version, 0)
    saveScene(d)
    if (diagrams[current] !== d) select(diagrams.indexOf(d))
    else if (editor) editor.show(d.scene, true)
    else showEditor(d)
    showPending()
    // A small picture of the result, so Claude sees what it did (a crowded label, an arrow across a box).
    const look = event.look === false ? null : await dataUrl(await W.glance(d.scene)).catch(() => null)
    post('/applied', { page: pageId, id: event.id, done: out.done, errors: out.errors, look })
  } catch (err) {
    post('/applied', { page: pageId, id: event.id, error: String(err?.message ?? err) })
  }
}
/** A picture of a diagram, for Claude. */
async function snapshotAsked(event) {
  const d = diagrams.find(x => x.id === event.diagram)
  try {
    if (!d) throw new Error('that diagram is not on this page')
    let blob
    if (d.scene) {
      const W = await loadEditor()
      blob = await W.png(editor && diagrams[current] === d ? editor.api.getSceneElements() : d.scene)
    } else blob = await svgToPng(d)
    post('/snapshot', { page: pageId, id: event.id, png: await dataUrl(blob) })
  } catch (err) {
    post('/snapshot', { page: pageId, id: event.id, error: String(err?.message ?? err) })
  }
}

const dataUrl = blob =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })

/** A drawn (Mermaid) diagram as a PNG, at twice its size, on white. */
function svgToPng(d) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = d.w * 2
      c.height = d.h * 2
      const g = c.getContext('2d')
      g.fillStyle = '#fff'
      g.fillRect(0, 0, c.width, c.height)
      g.drawImage(img, 0, 0, c.width, c.height)
      c.toBlob(b => (b ? resolve(b) : reject(new Error('no image'))), 'image/png')
    }
    img.onerror = () => reject(new Error('the diagram could not be drawn as an image'))
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(d.svg)}`
  })
}

// ---------------------------------------------------------------- controls

// Edit: this diagram, and only it; the board's mode is the switch at the top.
$('edit').onclick = () => {
  const d = diagrams[current]
  if (!d) return
  toEdit.add(d.id)
  showEditor(d)
}
document.querySelectorAll('.modes [data-mode]').forEach(b => (b.onclick = () => setMode(b.dataset.mode, true)))
