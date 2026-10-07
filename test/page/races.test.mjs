// What an adversarial review found in 0.4.1's first cut, kept as tests: Edit
// pressed twice, an amendment right after a new diagram, notes on a box that
// is not there, a board reopened on a canvas, and odd amendments.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { board, look, move, sleep } from './board.mjs'

let b
before(async () => {
  b = await board()
})
after(() => b.close())

const flow = ids => `flowchart LR\n  ${ids.map((id, i) => (i ? ` --> ${id}[${id}]` : `${id}[${id}]`)).join('')}`

test('Edit pressed twice while the editor loads: one canvas, editable, no errors', async () => {
  const page = await b.open()
  await b.call('/post', { title: 'twice', mermaid: flow(['p', 'q']) })
  await b.until(async () => (await look(page)).canEdit, 'Edit offered')
  await page.evaluate(() => {
    document.getElementById('edit').click()
    document.getElementById('edit').click()
  })
  await b.until(async () => (await look(page)).isCanvas, 'the canvas')
  await sleep(1500)
  assert.equal(await page.$$eval('#editor .excalidraw', els => els.length), 1)
  await move(page, 'q')
  await b.until(async () => (await look(page)).send === 'Send 1 change', 'the move counted')
  assert.deepEqual(page.errors, [])
  await page.close()
})

test('Edit and the Canvas switch together: one canvas', async () => {
  const page = await b.open()
  await b.call('/post', { title: 'both', mermaid: flow(['r', 's']) })
  await b.until(async () => (await look(page)).tab === 'both' && (await look(page)).canEdit, 'Edit offered')
  await page.evaluate(() => {
    document.getElementById('edit').click()
    document.querySelector('.modes [data-mode="canvas"]').click()
  })
  await b.until(async () => (await look(page)).isCanvas, 'the canvas')
  await sleep(1500)
  assert.equal(await page.$$eval('#editor .excalidraw', els => els.length), 1)
  assert.deepEqual(page.errors, [])
  await page.close()
})

test('on a canvas board, an amendment right after a new diagram goes to that diagram', async () => {
  const page = await b.open()
  await b.call('/post', { mode: 'canvas' })
  const a = await b.call('/post', { title: 'A', mermaid: flow(['web', 'api', 'db']) })
  await b.until(async () => (await b.scenes())[a.id], 'A converted')
  const n = await b.call('/post', { title: 'B', mermaid: flow(['api', 'cache', 'queue', 'worker', 'mail']) })
  // At once, before the page has converted B.
  const out = await b.call('/post', { ops: [{ op: 'class', id: 'api', class: 'problem' }, { op: 'note', id: 'n1', on: 'api', text: 'here' }] })
  assert.equal(out.diagram, 'B')
  assert.deepEqual(out.errors, [])
  const scenes = await b.scenes()
  assert.equal(scenes[n.id].boxes.find(x => x.ref === 'api').class, 'problem')
  assert.equal(scenes[a.id].boxes.find(x => x.ref === 'api').class, 'plain', "A's api untouched")
  assert.deepEqual(page.errors, [])
  await page.close()
})

test("a note on a box that is not there: the post's text is still posted, and Claude is told which note failed", async () => {
  const page = await b.open()
  const out = await b.call('/post', { text: 'Two notes for you', notes: [{ on: 'cache', text: 'good pin' }, { on: 'nothere', text: 'lost' }] })
  assert.equal(out.ok, true)
  assert.match(out.noteErrors.join(), /no box `nothere`/)
  const cards = (await b.call('/cards')).cards
  assert.ok(cards.some(c => c.kind === 'note' && c.text === 'Two notes for you'))
  await page.close()
})

test('a diagram posted on a canvas board while no page was open is editable when the page opens', async () => {
  const id = (await b.call('/post', { title: 'while closed', mermaid: flow(['x1', 'x2']) })).id
  const page = await b.open()
  await b.until(async () => (await look(page)).tab === 'while closed' && (await look(page)).isCanvas, 'editable on opening')
  await b.until(async () => (await b.scenes())[id], 'its canvas saved')
  await page.close()
})

test('odd amendments are refused with a reason, not applied half-way', async () => {
  const page = await b.open()
  await b.until(async () => (await look(page)).isCanvas, 'a canvas on screen')
  const out = await b.call('/post', {
    ops: [
      { op: 'text', id: 'x1' },
      { op: 'class', id: 'x1', class: 'note' },
      ...Array.from({ length: 52 }, (_, i) => ({ op: 'class', id: 'x2', class: i % 2 ? 'fine' : 'plain' })),
    ],
  })
  assert.match(out.errors.join('\n'), /#1 \(text\): needs `text`/)
  assert.match(out.errors.join('\n'), /#2 \(class\): no class `note`/)
  assert.match(out.errors.join('\n'), /#51 to #54: not applied, at most 50 at a time/)
  assert.deepEqual(page.errors, [])
  await page.close()
})
