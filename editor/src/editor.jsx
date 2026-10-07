// The board's canvas editor: Excalidraw, with the few things the board needs
// from it, as one global, WhiteboardEditor. Built into plugin/board/vendor/
// by build.mjs; the page (board/page/editing.js) loads it when a diagram is
// first edited.
//
//   fromMermaid(source)                the diagram as canvas elements, each box keeping its Mermaid id as its ref
//   mount(el, { elements, onChange })  an editable canvas: { ready, api, unmount }
//   applyOps(elements, ops)            Claude's amendments: { elements, done, errors }
//   png(elements)                      the canvas as a PNG Blob
import React from 'react'
import { createRoot } from 'react-dom/client'
import { CaptureUpdateAction, Excalidraw, convertToExcalidrawElements, exportToBlob } from '@excalidraw/excalidraw'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import '@excalidraw/excalidraw/index.css'

/** The drawing skill's colours, by class: fill, stroke, dashed. */
const CLASSES = {
  unverified: { backgroundColor: '#f4f4f4', strokeColor: '#888888', strokeStyle: 'dashed' },
  fine: { backgroundColor: '#e6f4ea', strokeColor: '#1e7e34', strokeStyle: 'solid' },
  problem: { backgroundColor: '#fdecea', strokeColor: '#c0392b', strokeStyle: 'solid' },
  proposed: { backgroundColor: '#f1ebfc', strokeColor: '#6f42c1', strokeStyle: 'dashed' },
  suspect: { backgroundColor: '#fff4ce', strokeColor: '#b58100', strokeStyle: 'solid' },
  plain: { backgroundColor: '#ffffff', strokeColor: '#1e1e1e', strokeStyle: 'solid' },
  note: { backgroundColor: '#fff3b0', strokeColor: '#d4a72c', strokeStyle: 'solid' },
}
/** Colours by name, for anything that is not one of the classes: fill, border, text. */
const COLORS = {
  blue: ['#e7f5ff', '#1971c2', '#0b3d6b'],
  green: ['#ebfbee', '#2f9e44', '#1b4d24'],
  red: ['#fff5f5', '#e03131', '#7a1717'],
  orange: ['#fff4e6', '#e8590c', '#6b2a05'],
  yellow: ['#fff9db', '#f08c00', '#5c3a00'],
  purple: ['#f3f0ff', '#7048e8', '#2f1a6b'],
  pink: ['#fff0f6', '#c2255c', '#5c1030'],
  teal: ['#e6fcf5', '#0c8599', '#04404a'],
  grey: ['#f1f3f5', '#868e96', '#343a40'],
  gray: ['#f1f3f5', '#868e96', '#343a40'],
  white: ['#ffffff', '#1e1e1e', '#1e1e1e'],
  black: ['#343a40', '#000000', '#ffffff'],
}
const HEX = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/

/** A colour as Claude gives it (a name, or fill, stroke and text in hex) as Excalidraw styles: the box's and its text's. */
function colorOf(op) {
  const named = op.color ? COLORS[String(op.color).toLowerCase()] : null
  if (op.color && !named && !HEX.test(op.color)) throw new Error(`no colour \`${op.color}\`: ${Object.keys(COLORS).join(', ')}, or #hex`)
  for (const k of ['fill', 'stroke', 'ink']) if (op[k] && !HEX.test(op[k])) throw new Error(`${k} must be #hex`)
  const [fill, stroke, ink] = named ?? (op.color ? [op.color, op.color, '#1e1e1e'] : [])
  const box = { ...(op.fill ?? fill ? { backgroundColor: op.fill ?? fill, fillStyle: 'solid' } : {}), ...(op.stroke ?? stroke ? { strokeColor: op.stroke ?? stroke } : {}) }
  return { box, ink: op.ink ?? ink }
}

/** Each class's text colour, as the skill's classDefs set it. */
const INK = { unverified: '#444444', fine: '#0d3b1a', problem: '#8a1f11', proposed: '#3b1f6e', suspect: '#4d3800', plain: '#1e1e1e', note: '#3d3200' }
/** Plain lines and a clear font: a board, not a sketch. */
const LOOK = { roughness: 0, fillStyle: 'solid' }
const FONT = { fontFamily: 2, fontSize: 16 }

const refOf = e => e.customData?.ref ?? e.id
const isShape = e => ['rectangle', 'ellipse', 'diamond'].includes(e.type)

async function fromMermaid(source) {
  const { elements } = await parseMermaidToExcalidraw(source, { themeVariables: { fontSize: '16px' } })
  // Mermaid's line breaks, as lines.
  const lines = t => (typeof t === 'string' ? t.replace(/<br\s*\/?>/gi, '\n') : t)
  const skeleton = elements.map(e => ({
    ...e,
    ...LOOK,
    ...(e.label ? { label: { ...e.label, ...FONT, text: lines(e.label.text) } } : {}),
    ...(e.type === 'text' ? { ...FONT, text: lines(e.text) } : {}),
    // Mermaid's id is how Claude names a box: kept as its ref.
    ...(isShape(e) && e.id ? { customData: { ref: e.id } } : {}),
  }))
  return convertToExcalidrawElements(skeleton, { regenerateIds: false })
}

function mount(el, { elements, onChange }) {
  const root = createRoot(el)
  let api = null
  const ready = new Promise(resolve => {
    root.render(
      <Excalidraw
        initialData={{
          elements,
          appState: { viewBackgroundColor: '#ffffff', currentItemFontFamily: 2, currentItemRoughness: 0, currentItemFontSize: 16 },
          scrollToContent: true,
        }}
        excalidrawAPI={a => {
          api = a
          resolve(a)
        }}
        onChange={(els, appState) => onChange?.(els, appState)}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false } }}
      />,
    )
  })
  return {
    ready,
    get api() {
      return api
    },
    /** Shows elements changed elsewhere (Claude, another tab), as one step the person can undo; `fit` brings all of it into view. */
    show(next, fit = false) {
      api?.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
      if (fit) api?.scrollToContent(undefined, { fitToContent: true, animate: true, duration: 300 })
    },
    unmount: () => root.unmount(),
  }
}

// ------------------------------------------------------------ Claude's amendments

const bump = e => ({ ...e, version: (e.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() })
const centre = e => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 })

/** Where the line from a box's centre towards a point leaves the box. */
function edgePoint(box, toward) {
  const c = centre(box)
  const dx = toward.x - c.x
  const dy = toward.y - c.y
  if (!dx && !dy) return c
  const k = Math.min(Math.abs(box.width / 2 / (dx || 1e-9)), Math.abs(box.height / 2 / (dy || 1e-9)))
  return { x: c.x + dx * k, y: c.y + dy * k }
}

/** A container and its label, laid out by Excalidraw itself. */
function shapeWithLabel({ id, type = 'rectangle', x, y, width, height, text, style, ink, customData }) {
  return convertToExcalidrawElements(
    [{ type, id, x, y, width, height, ...LOOK, ...style, customData, ...(text ? { label: { text, ...FONT, strokeColor: ink ?? '#1e1e1e' } } : {}) }],
    { regenerateIds: false },
  )
}

/** Canvas text is plain: the Markdown marks Claude may write anyway, taken out. */
const plain = t => String(t ?? '').replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')

function applyOps(elements, ops) {
  let els = [...elements]
  const done = []
  const errors = []
  const live = () => els.filter(e => !e.isDeleted)
  const find = ref => live().find(e => isShape(e) && refOf(e) === ref)
  const labelOf = box => live().find(e => e.type === 'text' && e.containerId === box.id)
  const replace = (id, f) => {
    els = els.map(e => (e.id === id ? bump(f(e)) : e))
  }
  const remove = id => replace(id, e => ({ ...e, isDeleted: true }))
  const overlaps = r => live().some(e => isShape(e) && r.x < e.x + e.width + 20 && r.x + r.width + 20 > e.x && r.y < e.y + e.height + 20 && r.y + r.height + 20 > e.y)

  /**
   * A free spot beside `near`: on `side` if it is free, else on the first free
   * side (below, above, right, left), else stepped along `side`; with no
   * `near`, right of everything.
   */
  function spot(near, side, width, height, gap = 60) {
    const all = live().filter(isShape)
    if (!near) {
      const r = { x: Math.max(0, ...all.map(e => e.x + e.width)) + gap, y: Math.min(...all.map(e => e.y), 0), width, height }
      while (overlaps(r)) r.y += height + 30
      return r
    }
    const at = s =>
      s === 'below' ? { x: near.x + (near.width - width) / 2, y: near.y + near.height + gap, width, height }
      : s === 'above' ? { x: near.x + (near.width - width) / 2, y: near.y - gap - height, width, height }
      : s === 'left' ? { x: near.x - gap - width, y: near.y + (near.height - height) / 2, width, height }
      : { x: near.x + near.width + gap, y: near.y + (near.height - height) / 2, width, height }
    for (const s of [side, 'below', 'above', 'right', 'left']) if (!overlaps(at(s))) return at(s)
    const r = at(side)
    for (let i = 0; i < 30 && overlaps(r); i++) {
      if (side === 'below' || side === 'above') r.x += width + 30
      else r.y += height + 30
    }
    return r
  }

  function setText(box, text) {
    const old = labelOf(box)
    const [, label] = shapeWithLabel({ type: box.type, x: box.x, y: box.y, width: box.width, height: box.height, text })
    const grow = Math.max(0, label.width + 30 - box.width)
    if (old) replace(old.id, t => ({ ...t, ...pick(label, ['text', 'originalText', 'width', 'height', 'x', 'y', 'lineHeight']), x: label.x + grow / 2 }))
    else {
      const t = bump({ ...label, containerId: box.id })
      els.push(t)
      replace(box.id, b => ({ ...b, boundElements: [...(b.boundElements ?? []), { id: t.id, type: 'text' }] }))
    }
    if (grow) replace(box.id, b => ({ ...b, width: b.width + grow }))
  }

  function connect(from, to, label) {
    const a = edgePoint(from, centre(to))
    const b = edgePoint(to, centre(from))
    const id = `arrow-${refOf(from)}-${refOf(to)}-${Math.random().toString(36).slice(2, 6)}`
    const made = convertToExcalidrawElements(
      [{ type: 'arrow', id, x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y, points: [[0, 0], [b.x - a.x, b.y - a.y]], ...LOOK, strokeColor: '#1e1e1e', ...(label ? { label: { text: label, ...FONT } } : {}) }],
      { regenerateIds: false },
    )
    const arrow = { ...made[0], startBinding: { elementId: from.id, focus: 0, gap: 4 }, endBinding: { elementId: to.id, focus: 0, gap: 4 } }
    els.push(arrow, ...made.slice(1))
    for (const box of [from, to]) replace(box.id, e => ({ ...e, boundElements: [...(e.boundElements ?? []), { id: arrow.id, type: 'arrow' }] }))
  }

  const arrowsBetween = (from, to) =>
    live().filter(e => e.type === 'arrow' && e.startBinding?.elementId === from.id && e.endBinding?.elementId === to.id)
  const arrowsOf = box => live().filter(e => e.type === 'arrow' && (e.startBinding?.elementId === box.id || e.endBinding?.elementId === box.id))
  const dropArrow = a => {
    remove(a.id)
    for (const t of live().filter(e => e.containerId === a.id)) remove(t.id)
  }

  for (const [i, op] of ops.entries()) {
    const at = `#${i + 1} (${op.op})`
    try {
      if (op.op === 'add' || op.op === 'note') {
        const ref = String(op.id ?? '').trim()
        if (!ref) throw new Error('needs an id')
        if (find(ref)) throw new Error(`\`${ref}\` is already on the board`)
        const nearRef = op.near ?? op.on
        const near = nearRef ? find(nearRef) : null
        if (nearRef && !near) throw new Error(`no box \`${nearRef}\``)
        const text = plain(op.text)
        // A note is narrow and grows down, as a sticky note does; a box fits its words on a line or two.
        const width = op.op === 'note' ? 170 : Math.max(150, Math.min(320, text.length * 8 + 40))
        const height = op.op === 'note' ? Math.max(64, Math.ceil(text.length / 19) * 20 + 28) : 64
        const r = spot(near, op.side ?? (op.op === 'note' ? 'below' : 'right'), width, height)
        const colored = op.op === 'add' && (op.color || op.fill || op.stroke) ? colorOf(op) : null
        const style = { ...(CLASSES[op.op === 'note' ? 'note' : op.class ?? 'plain'] ?? CLASSES.plain), ...colored?.box }
        const customData = op.op === 'note' ? { ref, kind: 'note', on: near ? refOf(near) : undefined, by: 'claude' } : { ref }
        const cls = op.op === 'note' ? 'note' : op.class ?? 'plain'
        els.push(...shapeWithLabel({ id: ref, type: op.op === 'note' ? 'rectangle' : op.shape ?? 'rectangle', ...r, text, style, ink: colored?.ink ?? INK[cls], customData }))
        if (op.op === 'add' && near && op.connect !== false) connect(near, find(ref), op.label && plain(op.label))
      } else if (op.op === 'connect' || op.op === 'disconnect') {
        const from = find(op.from)
        const to = find(op.to)
        if (!from || !to) throw new Error(`no box \`${!from ? op.from : op.to}\``)
        if (op.op === 'connect') connect(from, to, op.label && plain(op.label))
        else {
          const gone = arrowsBetween(from, to)
          if (!gone.length) throw new Error(`no arrow from \`${op.from}\` to \`${op.to}\``)
          gone.forEach(dropArrow)
        }
      } else if (op.op === 'text') {
        const box = find(op.id)
        if (!box) throw new Error(`no box \`${op.id}\``)
        setText(box, plain(op.text))
      } else if (op.op === 'class') {
        const box = find(op.id)
        if (!box) throw new Error(`no box \`${op.id}\``)
        const style = CLASSES[op.class]
        if (!style) throw new Error(`no class \`${op.class}\`: ${Object.keys(CLASSES).join(', ')}`)
        replace(box.id, e => ({ ...e, ...style }))
        const label = labelOf(box)
        if (label) replace(label.id, t => ({ ...t, strokeColor: INK[op.class] }))
      } else if (op.op === 'color') {
        const box = find(op.id)
        if (!box) throw new Error(`no box \`${op.id}\``)
        const { box: style, ink } = colorOf(op)
        if (!Object.keys(style).length && !ink) throw new Error('give `color` (a name or #hex), or `fill`, `stroke`, `ink`')
        replace(box.id, e => ({ ...e, ...style }))
        const label = labelOf(box)
        if (label && ink) replace(label.id, t => ({ ...t, strokeColor: ink }))
      } else if (op.op === 'remove') {
        const box = find(op.id)
        if (!box) throw new Error(`no box \`${op.id}\``)
        arrowsOf(box).forEach(dropArrow)
        for (const t of live().filter(e => e.containerId === box.id)) remove(t.id)
        remove(box.id)
      } else {
        throw new Error('unknown op: add, note, connect, disconnect, text, class, color, remove')
      }
      done.push(at)
    } catch (err) {
      errors.push(`${at}: ${err.message}`)
    }
  }
  return { elements: els, done, errors }
}

const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]))

async function png(elements) {
  return exportToBlob({
    elements: elements.filter(e => !e.isDeleted),
    appState: { exportBackground: true, viewBackgroundColor: '#ffffff' },
    files: null,
    mimeType: 'image/png',
    exportPadding: 24,
  })
}

window.WhiteboardEditor = { fromMermaid, mount, applyOps, png, CLASSES, COLORS }
