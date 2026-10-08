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
  assert.match(html, /<li><code>Dogs<\/code>: Mostly dogs<\/li>/)
  assert.match(html, /\(Orders DB\)/)
  assert.match(html, /The <b>request path<\/b>/)
  assert.match(html, /why dogs\?/)
  assert.match(html, /<a href="#d1">→ Orders<\/a>/)
  // It opens on its own, from the disk, without errors.
  const saved = await page.browser().newPage()
  const errors = []
  saved.on('pageerror', e => errors.push(String(e)))
  saved.on('console', m => m.type() === 'error' && errors.push(m.text()))
  await saved.goto(`file://${path}`)
  assert.equal(await saved.$$eval('section.diagram', s => s.length), 2)
  assert.ok(await saved.$eval('#d1 img', img => img.complete && img.naturalWidth > 0), 'the canvas picture shows')
  assert.deepEqual(errors, [])
  await saved.close()
})

test('the board saves as Markdown: Mermaid sources, sticky notes and the conversation as written', async () => {
  await choose('#save', 'md')
  const md = (await downloaded(/^whiteboard-tests-.*\.md$/)).data.toString()
  assert.match(md, /^# Whiteboard · tests\n/)
  assert.match(md, /## 1\. Orders\n\n_Edited on the board/)
  assert.match(md, /```mermaid\nflowchart LR\n {2}api\[Orders API\] --> db\[\(Orders DB\)\]/)
  assert.match(md, /## 2\. Pets\n\n```mermaid\npie/)
  assert.match(md, /- on `Dogs`: Mostly dogs/)
  assert.match(md, /\*\*Claude:\*\* \*\*Orders\*\*\n\nThe \*\*request path\*\*\.\n\n→ Diagram 1: Orders/)
  assert.match(md, /\*\*You:\*\* .*why dogs\?/)
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
