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

/** A file name from words: lower case, dashes, nothing a file system minds. */
const fileNameOf = (...words) =>
  words
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
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
const svgFileOf = d => `<?xml version="1.0" encoding="UTF-8"?>\n${d.svg}`

/** An edited diagram as an .excalidraw file. */
const excalidrawOf = d =>
  JSON.stringify(
    { type: 'excalidraw', version: 2, source: 'Whiteboard', elements: d.scene.filter(e => !e.isDeleted), appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} },
    null,
    2,
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
figure svg, figure img { max-width: 100%; height: auto; }
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

/** Each diagram's sticky notes, as { on, text }: Claude's on a drawing, everyone's on a canvas. */
function notesOfDiagram(d) {
  if (d.scene) return (summaryOf(d.scene).notes ?? []).map(n => ({ on: n.on, text: n.text }))
  return (stickies.get(d.id) ?? []).map(n => ({ on: n.on, text: n.text }))
}

/** The conversation as the page shows it: Claude's notes and the person's replies, a diagram's chip a link to it. */
function conversationHtml() {
  return [...document.querySelectorAll('#messages .msg')]
    .map(msg => {
      const body = msg.querySelector('.body').cloneNode(true)
      const n = diagrams.findIndex(d => String(d.id) === msg.dataset.card)
      for (const chip of body.querySelectorAll('.chip')) {
        if (n < 0) chip.remove()
        else chip.outerHTML = `<p><a href="#d${n + 1}">→ ${esc(diagrams[n].title)}</a></p>`
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
      `<section class="diagram" id="d${i + 1}">` +
        `<h2>${i + 1}. ${esc(d.title)}</h2><div class="meta">${esc(d.kind)}${d.scene ? ' · edited on the board' : ''}</div>` +
        (d.legend?.length ? `<div class="legend">${legendHtml(d.legend)}</div>` : '') +
        `<figure>${picture}</figure>` +
        (notes.length ? `<ul class="notes">${notes.map(n => `<li>${n.on ? `<code>${esc(n.on)}</code>: ` : ''}${inline(n.text)}</li>`).join('')}</ul>` : '') +
        `<details><summary>Mermaid source</summary><pre><code>${esc(d.source)}</code></pre></details>` +
        (d.scene ? `<details><summary>The canvas (save as a .excalidraw file to open it at excalidraw.com)</summary><pre><code>${esc(excalidrawOf(d))}</code></pre></details>` : '') +
        '</section>',
    )
  }
  const contents = diagrams.length ? `<nav><ol>${diagrams.map((d, i) => `<li><a href="#d${i + 1}">${esc(d.title)}</a></li>`).join('')}</ol></nav>` : ''
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

/** The board as Markdown: each diagram's Mermaid source and sticky notes, then the conversation, as written. */
function boardMarkdown(when = new Date()) {
  const lines = [`# Whiteboard · ${boardLabel()}`, '', `Saved ${when.toLocaleString()} · ${diagrams.length} diagram${diagrams.length === 1 ? '' : 's'}`, '']
  for (const [i, d] of diagrams.entries()) {
    const fence = fenceFor(d.source)
    lines.push(`## ${i + 1}. ${d.title}`, '')
    if (d.scene) lines.push('_Edited on the board: this is Claude\'s Mermaid; the edited canvas is in the board saved as a web page, or exported as .excalidraw._', '')
    lines.push(`${fence}mermaid`, d.source.trim(), fence, '')
    const notes = notesOfDiagram(d)
    if (notes.length) lines.push('Sticky notes:', '', ...notes.map(n => `- ${n.on ? `on \`${n.on}\`: ` : ''}${n.text.replace(/\s*\n\s*/g, ' ')}`), '')
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
      lines.push(`**Claude:**${c.title && c.text ? ` **${c.title}**` : ''}`, '')
      if (c.text) lines.push(c.text, '')
      if (n >= 0) lines.push(`→ Diagram ${n + 1}: ${diagrams[n].title}`, '')
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

/**
 * A button that opens a menu below it; the menu closes on a choice, a click
 * elsewhere or Escape. What a choice says back ("Copied", "Failed") shows on
 * the button for a moment.
 */
function menuOf(button, menu, act, onOpen = () => {}) {
  const close = () => {
    menu.hidden = true
    button.setAttribute('aria-expanded', 'false')
  }
  button.onclick = e => {
    e.stopPropagation()
    const isOpen = menu.hidden
    if (isOpen) onOpen()
    document.querySelectorAll('.menu').forEach(m => (m.hidden = true))
    menu.hidden = !isOpen
    button.setAttribute('aria-expanded', String(isOpen))
  }
  menu.onclick = async e => {
    const item = e.target.closest('button[data-act]')
    if (!item) return
    e.stopPropagation()
    close()
    const shown = button.querySelector('.lbl') ?? button
    const label = shown.textContent
    const say = (text, ms) => {
      shown.textContent = text
      setTimeout(() => (shown.textContent = label), ms)
    }
    try {
      const said = await act(item.dataset.act)
      if (said) say(said, 1200)
    } catch (err) {
      button.title = `${button.dataset.title ??= button.title} (failed: ${err?.message ?? err})`
      say('Failed', 2000)
    }
  }
  document.addEventListener('click', e => {
    if (!menu.hidden && !menu.contains(e.target)) close()
  })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !menu.hidden) close()
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
