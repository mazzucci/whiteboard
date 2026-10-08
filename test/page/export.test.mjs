// Getting the board out: each diagram as SVG, PNG or .excalidraw, its source
// copied; the whole board as one web page or one Markdown file; a save from
// the wrap-up banner keeps the page open.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { board, look, send, sleep } from './board.mjs'

let b
let page
let dir
before(async () => {
  b = await board()
  page = await b.open()
  dir = mkdtempSync(join(tmpdir(), 'wb-export-'))
  const cdp = await page.createCDPSession()
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true })
  await page.browserContext().overridePermissions(new URL(page.url()).origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'])
})
after(() => {
  rmSync(dir, { recursive: true, force: true })
  return b.close()
})

/**
 * Waits for a finished download whose name matches, and returns its name,
 * contents and where it was kept: moved aside, since a later download of the
 * same name replaces it.
 */
let kept = 0
async function downloaded(pattern) {
  const name = await b.until(() => readdirSync(dir).find(n => pattern.test(n) && !n.endsWith('.crdownload') && statSync(join(dir, n)).size > 0), `a download like ${pattern}`)
  await sleep(200)
  const path = join(dir, `kept-${++kept}-${name}`)
  renameSync(join(dir, name), path)
  return { name, data: readFileSync(path), path }
}
/** Picks a choice in a menu, as the person would. */
async function choose(button, act) {
  await page.click(button)
  await page.click(`${button}-menu [data-act="${act}"]`)
}

const FLOW = 'flowchart LR\n  api[Orders API] --> db[(Orders DB)]\n  api --> inv[inventory.check]'

test('a drawn diagram downloads as an SVG and a PNG, named after the board and the diagram', async () => {
  await b.call('/post', { title: 'Orders', text: 'The **request path**.', mermaid: FLOW, notes: [{ on: 'inv', text: 'N+1 here?' }] })
  await b.until(async () => (await look(page)).tab === 'Orders', 'the diagram')
  await page.click('#export')
  // A drawing has no canvas file to give.
  assert.equal(await page.$eval('#export-menu [data-act="excalidraw"]', el => el.hidden), true)
  await page.click('#export-menu [data-act="svg"]')
  const svg = await downloaded(/^tests-1-orders\.svg$/)
  const text = svg.data.toString()
  assert.match(text, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg[^>]+xmlns="http:\/\/www.w3.org\/2000\/svg"/)
  assert.equal(await page.evaluate(t => new DOMParser().parseFromString(t, 'image/svg+xml').querySelector('parsererror'), text), null, 'the SVG is well-formed')
  await choose('#export', 'png')
  const png = await downloaded(/^tests-1-orders\.png$/)
  assert.deepEqual([...png.data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
  assert.ok(png.data.length > 2000)
})

test('Copy Mermaid source puts the source on the clipboard and says so', async () => {
  await choose('#export', 'mermaid')
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), FLOW)
  assert.equal(await page.$eval('#export .lbl', el => el.textContent), 'Copied')
})

test('an edited diagram downloads as an .excalidraw file and a PNG of the canvas, and not as an SVG', async () => {
  await page.click('#edit')
  await b.until(async () => (await look(page)).isCanvas, 'the canvas')
  await page.evaluate(() => window.boardCanvas().ready)
  await page.click('#export')
  assert.equal(await page.$eval('#export-menu [data-act="svg"]', el => el.hidden), true)
  await page.click('#export-menu [data-act="excalidraw"]')
  const file = JSON.parse((await downloaded(/^tests-1-orders\.excalidraw$/)).data)
  assert.equal(file.type, 'excalidraw')
  assert.ok(file.elements.some(e => e.customData?.ref === 'inv'))
  await choose('#export', 'png')
  const png = await downloaded(/^tests-1-orders\.png$/)
  assert.deepEqual([...png.data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

test('the board saves as one web page: every diagram, its notes and source, and the conversation, with no scripts', async () => {
  await b.call('/post', { title: 'Pets', mermaid: 'pie\n  "Dogs" : 386\n  "Cats" : 85', notes: [{ on: 'Dogs', text: 'Mostly dogs' }] })
  await b.until(async () => (await look(page)).tab === 'Pets', 'the pie')
  await send(page, 'why dogs?')
  await b.until(() => b.said.some(s => s.endsWith('why dogs?')), 'the message')
  await choose('#save', 'html')
  const { data, path } = await downloaded(/^whiteboard-tests-\d{4}-\d{2}-\d{2}-\d{4}\.html$/)
  const html = data.toString()
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">/)
  assert.doesNotMatch(html, /<script/i)
  assert.match(html, /<h2>1\. Orders<\/h2>/)
  assert.match(html, /<h2>2\. Pets<\/h2>/)
  // The edited diagram as its canvas's picture, the drawing as its SVG.
  assert.match(html, /<img alt="Orders, as edited on the board" src="data:image\/png;base64,/)
  assert.match(html, /<figure><svg/)
  assert.match(html, /<li>On <code>Dogs<\/code>: Mostly dogs<\/li>/)
  assert.match(html, /\(Orders DB\)/)
  assert.match(html, /The <b>request path<\/b>/)
  assert.match(html, /why dogs\?/)
  assert.match(html, /<a href="#diagram-1">→ Orders<\/a>/)
  // It opens on its own, from the disk, without errors.
  const saved = await page.browser().newPage()
  const errors = []
  saved.on('pageerror', e => errors.push(String(e)))
  saved.on('console', m => m.type() === 'error' && errors.push(m.text()))
  await saved.goto(`file://${path}`)
  assert.equal(await saved.$$eval('section.diagram', s => s.length), 2)
  assert.ok(await saved.$eval('#diagram-1 img', img => img.complete && img.naturalWidth > 0), 'the canvas picture shows')
  assert.deepEqual(errors, [])
  await saved.close()
})

test('the board saves as Markdown: Mermaid sources, sticky notes and the conversation as written', async () => {
  await choose('#save', 'md')
  const md = (await downloaded(/^whiteboard-tests-.*\.md$/)).data.toString()
  assert.match(md, /^# Whiteboard · tests\n/)
  assert.match(md, /## Orders \(tab 1\)\n\n_Edited on the board/)
  assert.match(md, /```mermaid\nflowchart LR\n {2}api\[Orders API\] --> db\[\(Orders DB\)\]/)
  assert.match(md, /## Pets \(tab 2\)\n\n```mermaid\npie/)
  assert.match(md, /- On `Dogs`: Mostly dogs/)
  assert.match(md, /\*\*Claude:\*\* \*\*Orders\*\*\n\nThe \*\*request path\*\*\.\n\n→ Tab 1: Orders/)
  assert.doesNotMatch(md, /_A newer Mermaid type/, 'a pie needs no warning')
  // A diagram with nothing said is one line.
  assert.match(md, /\n\*\*Claude\*\* drew tab 2: Pets\n/)
  assert.match(md, /\*\*You:\*\* .*why dogs\?/)
})

test('in Markdown, a redrawn diagram shows its latest version with its legend, the earlier ones folded under it, and notes by box name', async () => {
  const classes = '\n  classDef unverified fill:#f4f4f4,stroke:#888888,stroke-dasharray:5 4\n  classDef fine fill:#e6f4ea,stroke:#1e7e34\n  classDef problem fill:#fdecea,stroke:#c0392b'
  const legend = [{ label: 'Not measured', class: 'unverified', stroke: '#888888', isDashed: true }, { label: 'No problem', class: 'fine', stroke: '#1e7e34' }, { label: 'The problem', class: 'problem', stroke: '#c0392b' }]
  const path = cls => `flowchart LR\n  req[POST /checkout]:::${cls[0]} --> quote[pricing.quote]:::${cls[1]} --> inv[inventory.check]:::${cls[2]}${classes}`
  await b.call('/post', { title: 'Hypothesis', mermaid: path(['unverified', 'unverified', 'unverified']), legend })
  await b.call('/post', { title: 'Detail: the loop', mermaid: 'sequenceDiagram\n  quote->>inv: check (x1,240)' })
  await b.call('/post', { title: 'What the trace shows', mermaid: path(['fine', 'problem', 'problem']), legend, notes: [{ on: 'inv', text: '1,240 calls' }] })
  await b.until(async () => (await look(page)).tab === 'What the trace shows', 'the redraw')
  await choose('#save', 'md')
  const md = (await downloaded(/^whiteboard-tests-.*\.md$/)).data.toString()
  // The redraw is open, the hypothesis folded under it; the sequence diagram is its own.
  const latest = md.indexOf('## What the trace shows (tab 5, the latest of 2)')
  assert.ok(latest > 0, md)
  assert.ok(md.indexOf('## Detail: the loop (tab 4)') > latest, 'threads in the order they started: the trace thread began at tab 3')
  assert.match(md, /<details>\n<summary>How it got here: tab 3, Hypothesis<\/summary>\n\n### Tab 3: Hypothesis\n/)
  assert.equal(md.match(/^## Hypothesis/m), null)
  assert.match(md, /> \*\*Legend:\*\* ⬜ Not measured \(dashed\) · 🟩 No problem · 🟥 The problem/)
  assert.match(md, /- On \*\*inventory\.check\*\* \(`inv`\): 1,240 calls/)
  // The colours are the diagram's own classDefs, so GitHub shows them.
  assert.match(md, /```mermaid\nflowchart LR\n {2}req\[POST \/checkout\]:::fine[\s\S]*classDef problem fill:#fdecea,stroke:#c0392b\n```/)
})

test('a menu closes on Escape or a click elsewhere', async () => {
  await page.click('#save')
  assert.equal(await page.$eval('#save-menu', m => m.hidden), false)
  await page.keyboard.press('Escape')
  assert.equal(await page.$eval('#save-menu', m => m.hidden), true)
  await page.click('#export')
  await page.mouse.click(5, 300)
  assert.equal(await page.$eval('#export-menu', m => m.hidden), true)
})

test('every diagram exports as a well-formed SVG file, a label with a <br> in an HTML label too', async () => {
  const sources = readdirSync(new URL('../../fixtures/', import.meta.url)).filter(n => n.endsWith('.mmd')).map(n => [n, readFileSync(new URL(`../../fixtures/${n}`, import.meta.url), 'utf8')])
  sources.push(['html labels', '%%{init: {"flowchart": {"htmlLabels": true}}}%%\nflowchart LR\n  a["one<br>two &amp; three"] --> b["日本語 ラベル"]'])
  for (const [name, mermaid] of sources) {
    await b.call('/post', { title: name, mermaid })
    await b.until(async () => (await look(page)).tab === name, name)
    const problem = await page.evaluate(() => {
      const xml = svgFileOf(diagrams[current])
      const doc = new DOMParser().parseFromString(xml, 'image/svg+xml')
      return doc.querySelector('parsererror')?.textContent ?? (doc.documentElement.namespaceURI === 'http://www.w3.org/2000/svg' ? null : 'not SVG')
    })
    assert.equal(problem, null, name)
  }
})

test('a huge diagram still exports as a PNG, smaller than twice its size', async () => {
  const nodes = Array.from({ length: 60 }, (_, i) => `n${i}[Step number ${i} of a very long pipeline]`).join(' --> ')
  await b.call('/post', { title: 'Huge', mermaid: `flowchart LR\n  ${nodes}` })
  await b.until(async () => (await look(page)).tab === 'Huge', 'the huge diagram')
  const out = await page.evaluate(async () => {
    const d = diagrams[current]
    const blob = await svgToPng(d)
    const img = await createImageBitmap(blob)
    return { w: d.w, width: img.width, height: img.height }
  })
  assert.ok(out.w > 8000, `wide: ${out.w}`)
  assert.ok(out.width <= 16_000 && out.width * out.height <= 16_000_000, JSON.stringify(out))
})

test('in Markdown, a newer Mermaid type says where it may not be drawn', async () => {
  await b.call('/post', { title: 'Latency', mermaid: 'xychart-beta\n  x-axis [a, b]\n  bar [1, 2]' })
  await b.until(async () => (await look(page)).tab === 'Latency', 'the chart')
  assert.match(await page.evaluate(() => boardMarkdown()), /## Latency \(tab \d+\)\n\n_A newer Mermaid type: some viewers/)
})

test('file names keep words in any script', async () => {
  assert.equal(await page.evaluate(() => fileNameOf('tests', '17', '注文フロー v2.')), 'tests-17-注文フロー-v2')
})

test('the saved page: links reach their diagram after a failed one, the page keeps its own font, and a wide diagram fits its column', async () => {
  // A diagram Mermaid rejects is withdrawn: Mermaid's drawings are then numbered ahead of the tabs.
  const bad = await b.call('/post', { title: 'Broken', mermaid: 'flowchart LR\n  A --> call' })
  assert.equal(bad.ok, false)
  await choose('#save', 'html')
  const { path } = await downloaded(/^whiteboard-tests-.*\.html$/)
  const saved = await page.browser().newPage()
  await saved.setViewport({ width: 1000, height: 800 })
  await saved.goto(`file://${path}`)
  const sections = await saved.$$eval('section.diagram', s => s.map(el => el.id))
  const links = await saved.$$eval('nav a', a => a.map(el => el.getAttribute('href').slice(1)))
  assert.deepEqual(links, sections)
  assert.ok(await saved.$$eval('nav a', a => a.every(el => document.getElementById(el.getAttribute('href').slice(1))?.matches('section.diagram'))))
  assert.doesNotMatch(await saved.$eval('section.diagram h2', el => getComputedStyle(el).fontFamily), /trebuchet/i)
  const fits = await saved.$eval('section.diagram:has(h2) figure', () => [...document.querySelectorAll('figure')].every(f => f.firstElementChild.getBoundingClientRect().width <= f.clientWidth + 1))
  assert.ok(fits, 'every diagram fits its column')
  await saved.close()
})

test('menus: arrows move between choices, Escape gives the focus back, one menu open at a time, and a message on the button never sticks', async () => {
  await page.click('#export')
  assert.equal(await page.evaluate(() => document.activeElement.dataset.act), 'svg')
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement.dataset.act), 'png')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  assert.equal(await page.evaluate(() => document.activeElement.dataset.act), 'mermaid')
  // A board key does nothing while a menu is open.
  await page.keyboard.press('c')
  assert.equal(await page.$eval('#source', el => el.hidden), true)
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'export')
  await page.click('#export')
  await page.click('#save')
  assert.equal(await page.$eval('#export', el => el.getAttribute('aria-expanded')), 'false')
  assert.equal(await page.$eval('#export-menu', el => el.hidden), true)
  await page.keyboard.press('Escape')
  await choose('#export', 'mermaid')
  await choose('#export', 'mermaid')
  await sleep(1500)
  assert.equal(await page.$eval('#export .lbl', el => el.textContent), 'Export')
})

test('after a lost connection, the board comes back once: the Markdown has each message once', async () => {
  // A reconnect: the page starts again from nothing, and the server replays every card, as it does to a new connection.
  const before = await page.evaluate(() => cardLog.length)
  const { cards } = await b.call('/cards')
  await page.evaluate(async cards => {
    events.onopen()
    for (const card of cards) onEvent({ data: JSON.stringify(card) })
    await queue
  }, cards)
  await sleep(500)
  assert.equal(await page.evaluate(() => cardLog.length), before)
  const md = await page.evaluate(() => boardMarkdown())
  assert.equal(md.match(/why dogs\?/g).length, 1)
})

test('after Wrap up, Save board keeps the page open and saves it', async () => {
  await b.call('/post', { end: true, text: 'Done.' })
  await b.until(() => page.$('#save-ended'), 'the banner')
  await page.click('#save-ended')
  assert.match((await downloaded(/^whiteboard-tests-.*\.html$/)).data.toString(), /<h2>2\. Pets<\/h2>/)
  await sleep(6000)
  assert.equal(page.isClosed(), false)
  assert.match(await page.$eval('#countdown', el => el.textContent), /^Saved/)
  assert.deepEqual(page.errors, [])
})
