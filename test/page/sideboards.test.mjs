// Side boards: a question with a board of its own, opened by Claude from the
// main board. It has its own brief and diagrams; a comparison shows options as
// columns; picking one decides it, settles the main board's constraint, and
// brings the person back. Switching boards tells the server where they are.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { board, look, send, sleep } from './board.mjs'

let b
let page
before(async () => {
  b = await board()
  page = await b.open()
})
after(() => b.close())

/** The page: which board, its tabs, its brief's state, the comparison. */
const where = () =>
  page.evaluate(() => ({
    board: boardOn,
    crumbs: document.querySelector('.brief .crumbs b')?.textContent ?? null,
    tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent),
    bottomLine: document.querySelector('.bottom-line p')?.textContent ?? null,
    head: [...document.querySelectorAll('.cmp th')].map(th => th.childNodes[0]?.textContent ?? ''),
    rows: [...document.querySelectorAll('.cmp tr.crit-row')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim())),
    sides: [...document.querySelectorAll('.brief .side')].map(s => s.textContent),
    comparing: document.body.classList.contains('comparing'),
  }))

test('Claude opens a side board: the page goes there, with its own brief, diagram and comparison', async () => {
  // Past the page's first moments, when what arrives counts as replayed.
  await sleep(600)
  await b.call('/post', {
    title: 'Checkout', mermaid: 'flowchart TB\n  Pay[Payment] -.- Db[(Orders)]',
    brief: { mode: 'decide', bottomLine: 'Waiting on the database.', sections: [{ id: 'database', kind: 'constraint', title: 'Database', line: 'Where do orders live?', focus: ['Db'], choices: [{ id: 'rel', label: 'Relational' }] }] },
  })
  await b.until(async () => (await where()).bottomLine === 'Waiting on the database.', 'the main board')
  await b.call('/post', {
    sideBoard: { id: 'db', title: 'Relational vs not', for: 'database' },
    title: 'Fit', mermaid: 'flowchart LR\n  rel[Relational] --- doc[Documents]',
    brief: {
      bottomLine: 'Relational is the safer default.',
      options: [{ id: 'rel', label: 'Relational' }, { id: 'doc', label: 'Documents' }],
      sections: [{ id: 'tx', title: 'Together', line: 'One step.', cells: { rel: { mark: 'yes', text: 'Transactions.' }, doc: { mark: 'part', text: 'Sometimes.' } } }],
    },
  })
  await b.until(async () => (await where()).board === 'db' && (await where()).tabs.length === 1, 'on the side board')
  const now = await where()
  assert.deepEqual([now.crumbs, now.tabs, now.bottomLine, now.comparing], ['Relational vs not', ['1Fit'], 'Relational is the safer default.', true])
  assert.deepEqual(now.head, ['', 'Relational', 'Documents'])
  assert.equal(await page.$eval('.bottom-line .k', el => el.textContent), 'Bottom line · Claude leans')
  assert.deepEqual(now.rows, [['TogetherOne step.', '✓Transactions.', '~Sometimes.']])
  assert.deepEqual((await page.$$eval('#messages .brief-event', els => els.map(el => el.textContent))).slice(-2), ['Claude opened a side board: “Relational vs not”', 'Claude laid out the comparison'])
  assert.deepEqual(page.errors, [])
})

test('back to the main board and to the side board again: the server knows where the person is', async () => {
  await page.click('.brief .crumbs .back')
  await b.until(async () => (await where()).board === 'main', 'the main board')
  let now = await where()
  assert.deepEqual([now.tabs, now.comparing, now.sides], [['1Checkout'], false, ['↳ Relational vs notopen']])
  await b.until(async () => (await b.call('/cards')).viewing === 'main', 'the server told')
  await page.click('.brief .side')
  await b.until(async () => (await b.call('/cards')).viewing === 'db' && (await where()).board === 'db', 'back on the side board')
  // Claude's change on a board the person is not looking at: noted in the conversation, the page stays.
  await b.call('/post', { board: 'main', briefOps: [{ op: 'update', id: 'database', line: 'Where do orders and stock live?' }] })
  await b.until(async () => (await page.$eval('#messages .brief-event:last-of-type', el => el.textContent)) === 'Claude rewrote “Database”', 'noted')
  assert.equal((await where()).board, 'db')
})

test('picking an option decides the side board: the main board’s constraint is settled and the person is back', async () => {
  await page.click('[data-decide="doc"]')
  assert.match(await page.$eval('#choices-text', el => el.textContent), /I decide on the side board “Relational vs not”: Documents\./)
  await send(page, 'Documents it is.')
  await b.until(async () => (await where()).board === 'main', 'back on the main board')
  assert.match(b.said.at(-1), /^\(On the side board `db`, "Relational vs not":\)\nI decide on the side board “Relational vs not”: Documents\.\n\nDocuments it is\./)
  const now = await where()
  assert.deepEqual(now.sides, ['↳ Relational vs notdecided'])
  assert.equal(await page.$eval('.brief .sec[data-id="database"] .settled-line', el => el.textContent), '✓ Documents · your choice')
  // Its box on the main diagram is green now.
  assert.equal(await page.$eval('#canvas g.node[id*="flowchart-Db-"]', g => g.classList.contains('st-settled')), true)
})

test('saved as Markdown: the main brief, then each side board with its comparison as a table', async () => {
  const md = await page.evaluate(() => boardMarkdown())
  assert.ok(md.indexOf('## The brief') < md.indexOf('## Side board: Relational vs not (decided)'))
  assert.match(md, /\| \| Relational \| Documents \|\n\|---\|---\|---\|\n\| \*\*Together\*\* \| ✓ Transactions\. \| ~ Sometimes\. \|/)
  assert.deepEqual(page.errors, [])
})

test('a reopened page goes to the board the person was last on, and a side board taken off again sends it back to the main board', async () => {
  // A second side board opens (the last board card says the person is there), then they go back to the main board:
  // only /view says so, and a reload must land there, not on the side board.
  await b.call('/post', { sideBoard: { id: 'two', title: 'Second' }, brief: { bottomLine: 'Two.', sections: [] } })
  await b.until(async () => (await where()).board === 'two', 'on the second side board')
  await page.click('.brief .crumbs .back')
  await b.until(async () => (await b.call('/cards')).viewing === 'main', 'the server told')
  await page.reload()
  await page.waitForFunction(() => document.getElementById('conn')?.classList.contains('on'), { timeout: 10_000 })
  await b.until(async () => (await where()).sides.length === 2, 'the boards again')
  assert.equal((await where()).board, 'main')
  // A side board whose diagram Mermaid rejects: opened, then taken off with its brief.
  await sleep(500)
  await b.call('/post', { sideBoard: { id: 'bad', title: 'Bad one' }, title: 'Broken', mermaid: 'flowchart LR\n  a -->', brief: { bottomLine: 'Side.', sections: [] }, waitForPage: true })
  await b.until(async () => (await where()).board === 'main' && !(await where()).sides.some(s => s.includes('Bad one')), 'back on the main board')
  assert.deepEqual(page.errors, [])
})

test('with no brief on the main board, its side boards are still one click away', async () => {
  const other = await board()
  try {
    const p = await other.open()
    await sleep(500)
    await other.call('/post', { sideBoard: { id: 'q', title: 'A question' }, brief: { bottomLine: 'Side.', sections: [] } })
    await other.until(() => p.evaluate(() => boardOn === 'q'), 'on the side board')
    await p.click('.brief .crumbs .back')
    await other.until(() => p.evaluate(() => boardOn === 'main' && document.body.classList.contains('pane-brief') && !!document.querySelector('.brief .side')), 'the list on the main board')
  } finally {
    await other.close()
  }
})

test('a side board with no diagram gives its brief the whole page, until a diagram arrives', async () => {
  await b.call('/post', { sideBoard: { id: 'plain', title: 'No picture' }, brief: { bottomLine: 'Words only.', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], sections: [{ id: 'c', title: 'C', line: 'c', cells: { a: { mark: 'yes', text: 'yes' } } }] } })
  await b.until(() => page.evaluate(() => boardOn === 'plain' && document.body.classList.contains('board-empty')), 'the brief takes the page')
  const width = () => page.$eval('aside.chat', el => el.getBoundingClientRect().width)
  assert.ok((await width()) > 1000, `the brief is ${await width()} px wide`)
  await b.call('/post', { title: 'Now a picture', mermaid: 'flowchart LR\n  a --> b' })
  await b.until(() => page.evaluate(() => !document.body.classList.contains('board-empty')), 'room for the diagram')
  assert.ok((await width()) < 900)
})
