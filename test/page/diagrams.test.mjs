// The board as Claude draws on it: diagrams, sticky notes, messages.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { board, look, send } from './board.mjs'

const FLOW = `flowchart LR
  req["POST /checkout<br/>p95 3,400 ms"] --> price["pricing.quote<br/>3,200 ms"] --> inv["inventory.check<br/>1,240 calls"]
  classDef problem fill:#fdecea,stroke:#c0392b,stroke-width:3px,color:#8a1f11
  class price,inv problem`

let b
let page
before(async () => {
  b = await board()
  page = await b.open()
})
after(() => b.close())

test('a diagram is drawn and confirmed, and a broken one goes back to Claude', async () => {
  const ok = await b.call('/post', { title: 'Checkout', mermaid: FLOW })
  assert.equal(ok.drawn, true)
  const bad = await b.call('/post', { title: 'Broken', mermaid: 'flowchart LR\n  A --> call' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /Parse error|Expecting/)
  assert.deepEqual(page.errors, [])
})

test('a sticky note pinned to a box sits by it, and the board keeps its zoom (0.4.0 regression)', async () => {
  await b.call('/post', { title: 'Noted', mermaid: FLOW, notes: [{ on: 'inv', text: 'Proposal: one inventory.check_batch call' }] })
  await b.until(() => page.$('.sticky'), 'the sticky note')
  const state = await look(page)
  assert.match(state.zoom, /^\d+%$/, `zoom reads ${state.zoom}`)
  const at = await page.$eval('.sticky', el => [el.style.left, el.style.top])
  assert.ok(at.every(v => /^-?[\d.]+px$/.test(v)), `note at ${at}`)
  assert.deepEqual(page.errors, [])
  // The canvas editor is not loaded for a drawing.
  assert.equal(await page.evaluate(() => !!window.WhiteboardEditor), false)
})

test('what the person types reaches the session; Wrap up says nothing of a selection', async () => {
  await send(page, 'why is it slow?')
  await b.until(() => b.said.includes('why is it slow?'), 'the message')
  await page.click('#wrap')
  await b.until(() => b.said.some(s => s.startsWith('Let us wrap up')), 'the wrap-up')
  assert.ok(!b.said.at(-1).includes('Selected on the board'))
})
