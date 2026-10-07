// The board's two modes, Edit, and two pages open on one board.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { board, look, move, showTab, sleep } from './board.mjs'

let b
let page
before(async () => {
  b = await board()
  page = await b.open()
})
after(() => b.close())

const isCanvas = async () => (await look(page)).isCanvas
const flow = (a, c) => `flowchart LR\n  ${a}[${a.toUpperCase()}] --> ${c}[${c.toUpperCase()}]`

test('Edit makes that diagram editable and leaves the board in diagrams mode', async () => {
  await b.call('/post', { title: 'one', mermaid: flow('a', 'b') })
  await b.until(async () => (await look(page)).canEdit, 'Edit offered')
  await page.click('#edit')
  await b.until(isCanvas, 'the canvas')
  assert.equal((await b.call('/cards')).mode, 'diagrams')
  assert.equal((await look(page)).mode, 'diagrams')
  // The next diagram arrives as a drawing.
  await b.call('/post', { title: 'two', mermaid: flow('c', 'd') })
  await b.until(async () => (await look(page)).tab === 'two', 'the next diagram')
  await sleep(500)
  assert.equal(await isCanvas(), false)
})

test('switching to Canvas makes the diagram on screen editable and new ones too, not earlier ones', async () => {
  await page.click('.modes [data-mode="canvas"]')
  await b.until(isCanvas, 'two as a canvas')
  assert.equal((await b.call('/cards')).mode, 'canvas')
  await b.call('/post', { title: 'three', mermaid: flow('e', 'f') })
  await b.until(async () => (await look(page)).tab === 'three' && (await look(page)).isCanvas, 'three arrives editable')
  const ids = Object.keys(await b.scenes())
  assert.equal(ids.length, 3, 'one (edited), two (on screen at the switch), three (new)')
  // Back to diagrams: the next one is a drawing again, and Claude hears of the switch.
  await page.click('.modes [data-mode="diagrams"]')
  await b.call('/post', { title: 'four', mermaid: flow('g', 'h') })
  await b.until(async () => (await look(page)).tab === 'four', 'four')
  await sleep(500)
  assert.equal(await isCanvas(), false)
})

test('a page opened later gets the mode and every canvas', async () => {
  await b.call('/post', { mode: 'canvas' })
  const late = await b.open()
  await b.until(async () => (await look(late)).mode === 'canvas', 'the mode on the new page')
  await late.close()
})

test('a mode switch from Claude leaves no empty card', async () => {
  await b.call('/post', { mode: 'diagrams', waitForPage: false })
  const cards = (await b.call('/cards')).cards
  assert.equal(cards.filter(c => c.kind === 'note' && !c.text).length, 0)
})

test("one page's save keeps another page's unsent change", async () => {
  // Diagram one is a canvas; both pages on it.
  await showTab(page, 1)
  await b.until(isCanvas, 'one on the first page')
  const other = await b.open()
  // Its tabs replay first: then the first one.
  await b.until(async () => (await look(other)).tab === 'four', 'the second page caught up')
  await showTab(other, 1)
  await b.until(async () => (await look(other)).isCanvas, 'one on the second page')
  await move(other, 'b')
  await b.until(async () => (await look(other)).send === 'Send 1 change', "the second page's change")
  await move(page, 'a')
  // Wait until the second page has the first page's save (its `a` moved too).
  const yOf = (p, ref) => p.evaluate(ref => window.boardCanvas().api.getSceneElements().find(e => e.customData?.ref === ref).y, ref)
  const before = await yOf(page, 'a')
  await b.until(async () => Math.abs((await yOf(other, 'a')) - before) < 1, "the first page's save on the second")
  await sleep(600)
  assert.equal((await look(other)).send, 'Send 1 change')
  // Both pages end up with both moves.
  await b.until(async () => Math.abs((await yOf(page, 'b')) - (await yOf(other, 'b'))) < 1 && Math.abs((await yOf(page, 'a')) - (await yOf(other, 'a'))) < 1, 'both pages agree')
  // What it sends is its own change only, once.
  await other.type('#text', 'ok?')
  await other.click('#form [type=submit]')
  const said = await b.until(() => b.said.find(s => s.endsWith('ok?')), 'the message')
  assert.match(said, /moved `b`/)
  assert.doesNotMatch(said, /moved `a`/)
  assert.deepEqual([...page.errors, ...other.errors], [])
})
