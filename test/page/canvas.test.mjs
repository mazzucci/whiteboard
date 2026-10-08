// Diagrams as canvases: every example diagram converted on the real page,
// Claude's amendments, the person's changes in words, and how a canvas reads
// back to Claude.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { board, look, move, select, send } from './board.mjs'

let b
let page
before(async () => {
  b = await board()
  page = await b.open()
  await b.call('/post', { mode: 'canvas' })
})
after(() => b.close())

/** Posts a diagram on the canvas board and waits for its canvas (or the page's refusal). */
async function canvasOf(title, mermaid) {
  const { id } = await b.call('/post', { title, mermaid })
  return b.until(async () => (await b.scenes())[id] ?? ((await look(page)).note ? { refused: (await look(page)).note } : null), `${title} on the canvas`)
}

const fixtures = new URL('../../fixtures/', import.meta.url)
const EDITABLE = /^\s*(flowchart|graph|sequenceDiagram|classDiagram|erDiagram|stateDiagram)/m
for (const name of readdirSync(fixtures).filter(n => n.endsWith('.mmd')).sort()) {
  const source = readFileSync(new URL(name, fixtures), 'utf8')
  if (!EDITABLE.test(source.replace(/^---[\s\S]*?\n---\s*\n/, ''))) continue
  test(`${name} becomes boxes and arrows, never an empty canvas`, async () => {
    const scene = await canvasOf(name, source)
    assert.ok(!scene.refused, `refused: ${scene.refused}`)
    assert.ok(scene.boxes.length > 0, 'no boxes')
    assert.equal(scene.images, 0, 'converted to a picture')
  })
}

test('a diagram the canvas cannot read stays drawn, and Claude is told when it tries to amend it', async () => {
  const { id } = await b.call('/post', { title: 'Pie', mermaid: 'pie title Pets\n  "Dogs" : 3\n  "Cats" : 2' })
  await b.until(async () => (await look(page)).tab === 'Pie', 'the pie on screen')
  assert.equal((await look(page)).isCanvas, false)
  assert.equal((await b.scenes())[id], undefined)
  const out = await b.call('/post', { ops: [{ op: 'class', id: 'x', class: 'fine' }] })
  // Amendments go to the latest edited diagram unless one is named: name the pie.
  const tab = (await b.call('/cards')).cards.filter(c => c.kind === 'diagram').findIndex(c => c.id === id) + 1
  const onPie = await b.call('/post', { diagram: tab, ops: [{ op: 'class', id: 'x', class: 'fine' }] })
  assert.match(onPie.error ?? '', /cannot be turned into boxes and arrows/)
  assert.ok(out)
})

test("Claude's amendments apply in place, report what failed, and come back with a small picture", async () => {
  await canvasOf('Orders', 'flowchart LR\n  api[Orders API] --> db[(Orders DB)]\n  api --> inv[inventory.check]')
  const out = await b.call('/post', {
    ops: [
      { op: 'add', id: 'cache', text: 'Stock cache', near: 'inv', side: 'below', class: 'proposed' },
      { op: 'color', id: 'db', color: 'blue' },
      { op: 'text', id: 'api', text: 'Orders API (Go)' },
      { op: 'note', id: 'n1', on: 'api', text: 'Batch here?' },
      { op: 'connect', from: 'db', to: 'nope' },
    ],
  })
  assert.deepEqual(out.done, ['#1 (add)', '#2 (color)', '#3 (text)', '#4 (note)'])
  assert.match(out.errors[0], /no box `nope`/)
  assert.ok(out.look && Buffer.from(out.look, 'base64').length < 120_000, 'a small JPEG')
  const scene = Object.values(await b.scenes()).at(-1)
  const boxes = Object.fromEntries(scene.boxes.map(x => [x.ref, x]))
  assert.equal(boxes.cache.class, 'proposed')
  assert.equal(boxes.db.class, 'blue')
  assert.equal(boxes.api.text, 'Orders API (Go)')
  assert.ok(scene.arrows.some(a => a.from === 'inv' && a.to === 'cache'))
  assert.deepEqual(scene.notes.map(n => [n.on, n.text]), [['api', 'Batch here?']])
})

test("the person's changes reach Claude in words, with what is selected", async () => {
  await move(page, 'db')
  await select(page, 'inv')
  await b.until(async () => /^Send 1 change$/.test((await look(page)).send), `one change counted: ${JSON.stringify(await page.evaluate(() => pendingChanges().map(p => [p.d.title, p.lines])))}`)
  await send(page, 'Make this red.')
  const said = await b.until(() => b.said.find(s => s.includes('Make this red.')), 'the message')
  assert.match(said, /moved `db`/)
  assert.match(said, /Selected on the board, in "Orders": `inv` "inventory.check"/)
  assert.equal((await look(page)).send, 'Send')
})

test('a sequence diagram reads back one box per participant, by name, and only its messages', async () => {
  const scene = await canvasOf('Seq', 'sequenceDiagram\n  actor U as User\n  participant App\n  U->>App: Tap\n  App-->>U: Done')
  assert.deepEqual(scene.boxes.map(x => x.ref).sort(), ['App', 'U'])
  assert.deepEqual(scene.arrows.map(a => `${a.from}->${a.to}`), ['U->App', 'App->U'])
  const out = await b.call('/post', { ops: [{ op: 'class', id: 'App', class: 'fine' }] })
  assert.deepEqual(out.done, ['#1 (class)'])
})

test('a flowchart keeps its own top and bottom boxes apart', async () => {
  const scene = await canvasOf('Nav', 'flowchart TB\n  nav-top[Top nav] --> body[Body] --> nav-bottom[Bottom nav]')
  assert.deepEqual(scene.boxes.map(x => x.ref).sort(), ['body', 'nav-bottom', 'nav-top'])
})

test('an ER table reads back by its name, and Claude amends it by that name', async () => {
  const scene = await canvasOf('Shop', 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains')
  assert.deepEqual(scene.boxes.map(x => x.ref).sort(), ['CUSTOMER', 'LINE_ITEM', 'ORDER'])
  assert.deepEqual(scene.arrows.map(a => `${a.from}->${a.to}`), ['CUSTOMER->ORDER', 'ORDER->LINE_ITEM'])
  const out = await b.call('/post', { ops: [{ op: 'class', id: 'CUSTOMER', class: 'fine' }] })
  assert.deepEqual(out.done, ['#1 (class)'])
})

test("a state diagram's [*] reads back as its start and end, not as boxes with odd names", async () => {
  const scene = await canvasOf('States', 'stateDiagram-v2\n  [*] --> Pending\n  Pending --> Paid: charge ok\n  Paid --> [*]')
  const boxes = Object.fromEntries(scene.boxes.map(x => [x.ref, x]))
  assert.deepEqual(Object.keys(boxes).sort(), ['Paid', 'Pending', 'end', 'start'])
  assert.deepEqual([boxes.start.text, boxes.start.class, boxes.end.text, boxes.end.class], ['[*] start', 'plain', '[*] end', 'plain'])
  assert.deepEqual(scene.arrows.map(a => `${a.from}->${a.to}`).sort(), ['Paid->end', 'Pending->Paid', 'start->Pending'])
})

test("a state of Claude's own named like session_start keeps its name and its colour", async () => {
  const scene = await canvasOf('Session', 'stateDiagram-v2\n  [*] --> session_start\n  session_start --> payment_end\n  payment_end --> [*]\n  classDef red fill:#fdecea,stroke:#c0392b\n  class session_start red')
  const boxes = Object.fromEntries(scene.boxes.map(x => [x.ref, x]))
  assert.deepEqual(Object.keys(boxes).sort(), ['end', 'payment_end', 'session_start', 'start'])
  assert.notEqual(boxes.session_start.class, 'plain')
  const out = await b.call('/post', { ops: [{ op: 'class', id: 'payment_end', class: 'fine' }] })
  assert.deepEqual(out.done, ['#1 (class)'])
})

test("the hand-drawn font (Excalifont) is the board's own: picking it draws, nothing is missing", async () => {
  const missing = []
  page.on('response', r => r.status() === 404 && missing.push(r.url()))
  const faces = await page.evaluate(async () => (await document.fonts.load('20px Excalifont', 'Hand-drawn')).length)
  assert.ok(faces > 0, 'Excalifont loaded')
  assert.deepEqual(missing, [])
})

test('no page error along the way', () => {
  assert.deepEqual(page.errors, [])
})
