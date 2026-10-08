// Getting the board out, all in the page: each diagram as an SVG or a PNG (a
// canvas as a PNG or an .excalidraw file that opens editable on
// excalidraw.com), its Mermaid source copied; the whole board as one web page
// (pictures, sticky notes, sources, the conversation; no scripts) or one
// Markdown file. Nothing is kept anywhere: a save is a download the person
// asks for. Shares the page's global scope with app.js, editing.js and charts.js.
'use strict'

/** The board's name (the session's folder), for file names and titles. */
const boardLabel = () => document.querySelector('.top h1 .label')?.textContent.replace(/^\s*·\s*/, '').trim() || 'board'

/** Now, as a file name wants it: 2026-10-07-1830. */
function stampOf(date = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`
}

/** A file name from words, in any script: lower case, dashes, nothing a file system minds. */
const fileNameOf = (...words) =>
  words
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)

/** Hands the person a file to save. */
function download(name, blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.hidden = true
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000)
}

/** A drawn diagram as a standalone SVG file. */
const svgFileOf = d => `<?xml version="1.0" encoding="UTF-8"?>\n${svgXmlOf(d.svg)}`

/** An edited diagram as an .excalidraw file (laid out to read, or compact inside a saved page). */
const excalidrawOf = (d, isCompact = false) =>
  JSON.stringify(
    { type: 'excalidraw', version: 2, source: 'Whiteboard', elements: d.scene.filter(e => !e.isDeleted), appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} },
    null,
    isCompact ? 0 : 2,
  )

/** A diagram as a PNG: the canvas when it was edited, the drawing otherwise. */
async function pngOf(d) {
  if (d.scene) return (await loadEditor()).png(d.scene)
  return svgToPng(d)
}

// ---------------------------------------------------------------- one diagram

const exportName = (d, ext) => `${fileNameOf(boardLabel(), String(diagrams.indexOf(d) + 1), d.title)}.${ext}`

const EXPORTS = {
  svg: async d => download(exportName(d, 'svg'), new Blob([svgFileOf(d)], { type: 'image/svg+xml' })),
  png: async d => download(exportName(d, 'png'), await pngOf(d)),
  excalidraw: async d => download(exportName(d, 'excalidraw'), new Blob([excalidrawOf(d)], { type: 'application/json' })),
  mermaid: async d => {
    await navigator.clipboard.writeText(d.source)
    return 'Copied'
  },
}

/** Shows the export menu's choices for the diagram on screen: an edited one has no SVG, a drawn one no .excalidraw. */
function fitExportMenu(d) {
  document.querySelector('#export-menu [data-act="svg"]').hidden = !!d?.scene
  document.querySelector('#export-menu [data-act="excalidraw"]').hidden = !d?.scene
}

// ---------------------------------------------------------------- the whole board

const PAGE_CSS = `
body { margin: 0; background: #f5f6f8; color: #1b2130; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 32px 20px 64px; }
header p, .meta { color: #667085; }
nav ol { padding-left: 20px; }
section.diagram, section.conversation { margin-top: 28px; padding: 20px; border: 1px solid #e3e6ec; border-radius: 12px; background: #fff; }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 0 0 4px; }
figure { margin: 16px 0; overflow: auto; text-align: center; }
figure svg, figure img { max-width: 100% !important; height: auto !important; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px; color: #667085; }
.legend i { display: inline-block; width: 12px; height: 12px; border: 2px solid; border-radius: 3px; margin-right: 6px; vertical-align: -2px; }
.legend i.dashed { border-style: dashed; }
ul.notes { padding: 0; list-style: none; display: grid; gap: 8px; }
ul.notes li { padding: 8px 12px; background: #fff1a6; border-radius: 4px; color: #3b3000; }
details { margin-top: 10px; } summary { cursor: pointer; color: #475467; }
pre { overflow: auto; padding: 12px; background: #f5f6f8; border-radius: 8px; font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
code { font: 0.92em ui-monospace, SFMono-Regular, Menlo, monospace; }
.msg { margin: 12px 0; padding: 10px 14px; border-radius: 10px; background: #f0f2f5; }
.msg.you { background: #eaf1ff; margin-left: 15%; }
.msg .who { font-size: 12px; color: #667085; margin-bottom: 2px; }
.msg .md p:first-child { margin-top: 0; } .msg .md p:last-child { margin-bottom: 0; }
table { border-collapse: collapse; } td, th { border: 1px solid #e3e6ec; padding: 4px 8px; }
footer { margin-top: 32px; color: #98a2b3; font-size: 12px; text-align: center; }
`

/** A diagram's drawing as elements to look into (made once). */
const drawingOf = d => {
  if (!d.drawing) {
    d.drawing = document.createElement('div')
    d.drawing.innerHTML = d.svg
  }
  return d.drawing
}

/** What a box says, its lines joined: what a reader knows it by. */
function labelOfBox(el) {
  if (el.dataset?.label) return el.dataset.label
  const lines = [...el.querySelectorAll('tspan')].filter(t => !t.querySelector('tspan')).map(t => t.textContent.trim()).filter(Boolean)
  return (lines.length ? lines.join(' ') : el.textContent).replace(/\s+/g, ' ').trim()
}

/**
 * Each diagram's sticky notes, as { on, label, text }: Claude's on a drawing,
 * everyone's on a canvas; `label` is what the box they sit on says, so a
 * reader without the source knows which box (`inv` is "inventory.check").
 */
function notesOfDiagram(d) {
  if (d.scene) {
    const summary = summaryOf(d.scene)
    const text = new Map((summary.boxes ?? []).map(b => [b.ref, b.text]))
    return (summary.notes ?? []).map(n => ({ on: n.on, label: (text.get(n.on) ?? '').replace(/\s+/g, ' ').trim(), text: n.text }))
  }
  return (stickies.get(d.id) ?? []).map(n => {
    const box = n.on && boxIn(drawingOf(d), n.on)
    return { on: n.on, label: box ? labelOfBox(box) : '', text: n.text }
  })
}

/** Where a note sits, for a reader: the box's words, with its id when that says something else. */
const noteTarget = (n, code = t => `\`${t}\``, bold = t => `**${t}**`) =>
  !n.on ? '' : n.label && n.label !== n.on ? `${bold(n.label)} (${code(n.on)})` : code(n.on)

/** The conversation as the page shows it: Claude's notes and the person's replies, a diagram's chip a link to it. */
function conversationHtml() {
  return [...document.querySelectorAll('#messages .msg')]
    .map(msg => {
      const body = msg.querySelector('.body').cloneNode(true)
      const n = diagrams.findIndex(d => String(d.id) === msg.dataset.card)
      for (const chip of body.querySelectorAll('.chip')) {
        if (n < 0) chip.remove()
        else chip.outerHTML = `<p><a href="#diagram-${n + 1}">→ ${esc(diagrams[n].title)}</a></p>`
      }
      const isYou = msg.classList.contains('you')
      return `<div class="msg ${isYou ? 'you' : 'claude'}"><div class="who">${isYou ? 'You' : 'Claude'}</div><div class="md">${body.innerHTML}</div></div>`
    })
    .join('\n')
}

/**
 * The board as one web page: every diagram's picture (a drawing's SVG, a
 * canvas's PNG), its legend, sticky notes and source, then the conversation.
 * No scripts, and a policy that allows none: it only shows.
 */
async function boardHtml(when = new Date()) {
  const label = boardLabel()
  const sections = []
  for (const [i, d] of diagrams.entries()) {
    let picture = d.svg
    if (d.scene) {
      try {
        picture = `<img alt="${esc(d.title)}, as edited on the board" src="${await dataUrl(await pngOf(d))}">`
      } catch {
        picture = `${d.svg}<p class="meta">This diagram was edited on the board; its edited picture could not be made, so this is Claude's drawing. The canvas is below.</p>`
      }
    }
    const notes = notesOfDiagram(d)
    sections.push(
      // Not `d1`: Mermaid's drawings are `d1`, `d2`…, and their styles would apply to the section.
      `<section class="diagram" id="diagram-${i + 1}">` +
        `<h2>${i + 1}. ${esc(d.title)}</h2><div class="meta">${esc(d.kind)}${d.scene ? ' · edited on the board' : ''}</div>` +
        (d.legend?.length ? `<div class="legend">${legendHtml(d.legend)}</div>` : '') +
        `<figure>${picture}</figure>` +
        (notes.length ? `<ul class="notes">${notes.map(n => `<li>${n.on ? `On ${noteTarget(n, t => `<code>${esc(t)}</code>`, t => `<b>${esc(t)}</b>`)}: ` : ''}${inline(n.text)}</li>`).join('')}</ul>` : '') +
        `<details><summary>Mermaid source</summary><pre><code>${esc(d.source)}</code></pre></details>` +
        (d.scene ? `<details><summary>The canvas (save as a .excalidraw file to open it at excalidraw.com)</summary><pre><code>${esc(excalidrawOf(d, true))}</code></pre></details>` : '') +
        '</section>',
    )
  }
  const contents = diagrams.length ? `<nav><ol>${diagrams.map((d, i) => `<li><a href="#diagram-${i + 1}">${esc(d.title)}</a></li>`).join('')}</ol></nav>` : ''
  const talk = conversationHtml()
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Whiteboard · ${esc(label)} · ${esc(when.toLocaleString())}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
<header><h1>Whiteboard · ${esc(label)}</h1><p>Saved ${esc(when.toLocaleString())} · ${diagrams.length} diagram${diagrams.length === 1 ? '' : 's'}</p></header>
${contents}
${sections.join('\n')}
${talk ? `<section class="conversation"><h2>The conversation on the board</h2>\n${talk}\n</section>` : ''}
<footer>Saved from Whiteboard, a Claude Code plugin · open source · not affiliated with Anthropic</footer>
</main>
</body>
</html>
`
}

/** A Markdown code fence that the text inside cannot close. */
const fenceFor = text => '`'.repeat(Math.max(3, ...[...String(text).matchAll(/`+/g)].map(m => m[0].length + 1)))

/** A legend colour as the coloured square nearest it, for Markdown: grey, red, orange, yellow, green, blue or purple. */
function squareOf(css) {
  paintKit.fillStyle = '#000000'
  paintKit.fillStyle = css || '#888888'
  const hex = paintKit.fillStyle
  const [r, g, b] = /^#/.test(hex) ? [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) : [0.5, 0.5, 0.5]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max - min < 0.12) return '⬜'
  const h = (max === r ? ((g - b) / (max - min) + 6) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4) * 60
  return h < 15 || h >= 335 ? '🟥' : h < 40 ? '🟧' : h < 70 ? '🟨' : h < 170 ? '🟩' : h < 250 ? '🟦' : '🟪'
}
const paintKit = document.createElement('canvas').getContext('2d')

/** A diagram's legend as one Markdown line: what each colour means. */
const legendLine = d =>
  d.legend?.length ? `> **Legend:** ${d.legend.map(e => `${squareOf(e.stroke)} ${e.label}${e.isDashed ? ' (dashed)' : ''}`).join(' · ')}` : ''

/** A diagram's node ids (a flowchart's boxes, a chart's labels), to tell a redraw from a new diagram. */
const idsOf = d =>
  new Set([
    ...[...drawingOf(d).querySelectorAll('g.node[id]')].map(g => g.id.replace(/^.*?flowchart-/, '').replace(/-\d+$/, '')),
    ...[...drawingOf(d).querySelectorAll('[data-mark]')].map(el => el.dataset.label),
  ])

/**
 * The diagrams as threads: a diagram that redraws an earlier one (the same
 * kind, and the same title or most of its boxes) joins that one's thread, as
 * an investigation redraws its picture step by step; a new picture starts its
 * own. Threads in the order they started, each its diagrams in order.
 */
function threadsOf() {
  const threads = []
  for (const d of diagrams) {
    const ids = idsOf(d)
    const thread = threads.findLast(t => {
      const last = t.at(-1)
      if (last.kind !== d.kind) return false
      if (last.title === d.title) return true
      const before = idsOf(last)
      const common = [...ids].filter(id => before.has(id)).length
      return ids.size > 0 && before.size > 0 && common >= 0.6 * Math.max(ids.size, before.size)
    })
    if (thread) thread.push(d)
    else threads.push([d])
  }
  return threads.sort((a, b) => diagrams.indexOf(a[0]) - diagrams.indexOf(b[0]))
}

/** One diagram in Markdown: its legend, its Mermaid, its sticky notes. */
function diagramMarkdown(d, heading) {
  const fence = fenceFor(d.source)
  const notes = notesOfDiagram(d)
  return [
    heading,
    '',
    ...(d.scene ? ["_Edited on the board: this is Claude's Mermaid; the edited canvas is in the board saved as a web page, or exported as .excalidraw._", ''] : []),
    ...(legendLine(d) ? [legendLine(d), ''] : []),
    `${fence}mermaid`,
    d.source.trim(),
    fence,
    '',
    ...(notes.length ? ['Sticky notes:', '', ...notes.map(n => `- ${n.on ? `On ${noteTarget(n)}: ` : ''}${n.text.replace(/\s*\n\s*/g, ' ')}`), ''] : []),
  ]
}

/**
 * The board as Markdown, for a pull request or a postmortem: each diagram's
 * latest version open, with its legend, Mermaid (its colours are its own
 * classDefs, so GitHub, GitLab and Notion show them) and sticky notes; the
 * versions before it folded away under it; then the conversation, as written.
 */
function boardMarkdown(when = new Date()) {
  const lines = [`# Whiteboard · ${boardLabel()}`, '', `Saved ${when.toLocaleString()} · ${diagrams.length} diagram${diagrams.length === 1 ? '' : 's'}`, '']
  const tab = d => diagrams.indexOf(d) + 1
  for (const thread of threadsOf()) {
    const latest = thread.at(-1)
    const earlier = thread.slice(0, -1)
    lines.push(...diagramMarkdown(latest, `## ${latest.title}${earlier.length ? ` (tab ${tab(latest)}, the latest of ${thread.length})` : ` (tab ${tab(latest)})`}`))
    if (earlier.length) {
      lines.push('<details>', `<summary>How it got here: ${earlier.map(d => `tab ${tab(d)}, ${esc(d.title)}`).join('; ')}</summary>`, '')
      for (const d of earlier) lines.push(...diagramMarkdown(d, `### Tab ${tab(d)}: ${d.title}`))
      lines.push('</details>', '')
    }
  }
  const said = cardLog.filter(c => c.kind === 'you' || c.text || c.mermaid)
  if (said.length) {
    lines.push('## The conversation on the board', '')
    for (const c of said) {
      if (c.kind === 'you') {
        lines.push(`**You:** ${c.text}`, '')
        continue
      }
      const n = diagrams.findIndex(d => d.id === c.id)
      // A diagram with nothing said: one line.
      if (!c.text) {
        if (n >= 0) lines.push(`**Claude** drew tab ${n + 1}: ${diagrams[n].title}`, '')
        continue
      }
      lines.push(`**Claude:**${c.title ? ` **${c.title}**` : ''}`, '', c.text, '')
      if (n >= 0) lines.push(`→ Tab ${n + 1}: ${diagrams[n].title}`, '')
    }
  }
  return lines.join('\n')
}

const SAVES = {
  html: async () => {
    const when = new Date()
    download(`${fileNameOf('whiteboard', boardLabel(), stampOf(when))}.html`, new Blob([await boardHtml(when)], { type: 'text/html' }))
  },
  md: async () => {
    const when = new Date()
    download(`${fileNameOf('whiteboard', boardLabel(), stampOf(when))}.md`, new Blob([boardMarkdown(when)], { type: 'text/markdown' }))
  },
}

// ---------------------------------------------------------------- menus

/** Every menu's button, so opening one closes the others. */
const menuButtons = []

/**
 * A button that opens a menu below it, focused on its first choice: arrows
 * move between choices, Enter picks one, Escape or a click elsewhere closes it
 * (focus back on the button). What a choice says back ("Copied", "Failed")
 * shows on the button for a moment, on a phone too.
 */
function menuOf(button, menu, act, onOpen = () => {}) {
  menuButtons.push([button, menu])
  const items = () => [...menu.querySelectorAll('button[data-act]')].filter(b => !b.hidden)
  const close = (isFocusBack = false) => {
    menu.hidden = true
    button.setAttribute('aria-expanded', 'false')
    if (isFocusBack) button.focus()
  }
  const shown = button.querySelector('.lbl') ?? button
  const label = shown.textContent
  const title = button.title
  let saying = null
  const say = (text, ms, why = '') => {
    clearTimeout(saying)
    shown.textContent = text
    button.title = why ? `${title} (${why})` : title
    button.classList.add('said')
    saying = setTimeout(() => {
      shown.textContent = label
      button.title = title
      button.classList.remove('said')
    }, ms)
  }
  button.onclick = e => {
    e.stopPropagation()
    const isOpening = menu.hidden
    for (const [b, m] of menuButtons) {
      m.hidden = true
      b.setAttribute('aria-expanded', 'false')
    }
    if (!isOpening) return
    onOpen()
    menu.hidden = false
    button.setAttribute('aria-expanded', 'true')
    items()[0]?.focus()
  }
  menu.onclick = async e => {
    const item = e.target.closest('button[data-act]')
    if (!item) return
    e.stopPropagation()
    close(true)
    try {
      const said = await act(item.dataset.act)
      if (said) say(said, 1200)
    } catch (err) {
      say('Failed', 2500, `failed: ${err?.message ?? err}`)
    }
  }
  menu.addEventListener('keydown', e => {
    const all = items()
    const at = all.indexOf(document.activeElement)
    const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[e.key]
    if (go !== undefined) {
      e.preventDefault()
      all.at(((go % all.length) + all.length) % all.length)?.focus()
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault()
      close(e.key === 'Escape')
    }
  })
  document.addEventListener('click', e => {
    if (!menu.hidden && !menu.contains(e.target)) close()
  })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !menu.hidden) close(true)
  })
}

menuOf(
  $('export'),
  $('export-menu'),
  what => {
    const d = diagrams[current]
    return d && EXPORTS[what](d)
  },
  () => fitExportMenu(diagrams[current]),
)
menuOf($('save'), $('save-menu'), what => SAVES[what]())
