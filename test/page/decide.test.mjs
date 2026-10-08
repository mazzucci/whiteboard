// A decision: Claude's brief in decide mode. Constraints show their state and
// choices; the person's choices go together with their next message and settle
// the constraints; the diagram's boxes say where each one stands; the header
// waits on what is open, then shows the proposal.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { board, send, sleep } from './board.mjs'

let b
let page
before(async () => {
  b = await board()
  page = await b.open()
})
after(() => b.close())

const FLOW = `flowchart TB
  Cart[Cart] --> Acc[Sign in, or guest?]
  Acc --> Pay[Payment]
  Pay --> Done[Confirmation]
  Stock[(Stock)] -.- Pay`

const DECISION = {
  mode: 'decide',
  bottomLine: 'No proposal yet: three constraints decide the checkout.',
  sections: [
    { id: 'accounts', kind: 'constraint', title: 'Accounts', line: 'Guest checkout, or require an account?', focus: ['Acc'], choices: [{ id: 'guest', label: 'Guest checkout', hint: 'offer an account after' }, { id: 'required', label: 'Account required' }], lean: 'guest' },
    { id: 'payments', kind: 'constraint', title: 'Payments', line: 'A hosted payment page, or card fields in our page?', focus: ['Pay'], choices: [{ id: 'hosted', label: 'Hosted page' }, { id: 'embedded', label: 'Embedded fields' }], lean: 'hosted' },
    { id: 'stock', kind: 'constraint', title: 'Stock', line: 'When is stock held?', focus: ['Stock'], choices: [{ id: 'payment', label: 'From payment start' }, { id: 'cart', label: 'From add-to-cart' }] },
    { id: 'markets', kind: 'constraint', status: 'assumed', title: 'Markets', line: 'One country and one currency for now.' },
  ],
}

/** The decision as the page shows it. */
const decision = () =>
  page.evaluate(() => ({
    head: document.querySelector('.bottom-line .k')?.textContent ?? null,
    open: document.querySelector('.bottom-line .open-list')?.textContent ?? null,
    progress: document.querySelector('.brief .progress span')?.textContent ?? null,
    sections: [...document.querySelectorAll('.brief .sec')].map(li => ({
      id: li.dataset.id,
      pill: li.querySelector('.pill')?.textContent ?? null,
      choices: [...li.querySelectorAll('[data-choose]')].map(b => `${b.dataset.choose}${b.classList.contains('chosen') ? '*' : ''}${b.classList.contains('lean') ? '^' : ''}`),
      settled: li.querySelector('.settled-line')?.textContent ?? null,
    })),
    boxes: Object.fromEntries(
      [...document.querySelectorAll('#canvas g.node')].map(g => [g.id.replace(/^.*?flowchart-/, '').replace(/-\d+$/, ''), ['st-open', 'st-assumed', 'st-settled'].find(c => g.classList.contains(c)) ?? '']),
    ),
    tag: document.getElementById('choices-tag').hidden ? null : document.getElementById('choices-text').textContent,
  }))
const sec = id => `.brief .sec[data-id="${id}"]`

test('a decision waits on its open constraints, shows each one’s choices and Claude’s lean, and marks the boxes they decide', async () => {
  await b.call('/post', { title: 'Checkout', mermaid: FLOW, brief: DECISION })
  await b.until(async () => (await decision()).sections.length === 4 && (await decision()).boxes.Acc, 'the decision and its diagram')
  const now = await decision()
  // An assumption does not hold up the proposal.
  assert.equal(now.head, 'Bottom line · waiting on 3 · 1 to confirm')
  assert.equal(now.open, 'Open: Accounts, Payments, Stock')
  assert.equal(now.progress, '0 settled · 1 assumed · 3 open')
  assert.deepEqual(now.sections.map(s => [s.id, s.pill, s.choices]), [
    ['accounts', 'open', ['guest^', 'required']],
    ['payments', 'open', ['hosted^', 'embedded']],
    ['stock', 'open', ['payment', 'cart']],
    ['markets', 'assumed', ['', 'reject']],
  ])
  assert.deepEqual(now.boxes, { Cart: '', Acc: 'st-open', Pay: 'st-open', Done: '', Stock: 'st-open' })
  assert.deepEqual(page.errors, [])
})

test('choices go together with the next message, or alone, and settle their constraints', async () => {
  await page.click(`${sec('accounts')} [data-choose="guest"]`)
  await page.click(`${sec('payments')} [data-choose="embedded"]`)
  // Changed their mind: the other choice instead.
  await page.click(`${sec('payments')} [data-choose="hosted"]`)
  await page.click(`${sec('markets')} [data-choose=""]`)
  let now = await decision()
  assert.deepEqual(now.sections.find(s => s.id === 'payments').choices, ['hosted*^', 'embedded'])
  assert.equal(now.tag, 'My choices on the board: Accounts: Guest checkout; Payments: Hosted page; Markets: confirmed. Goes with your next message (Send alone sends them).')
  // Nothing settled until it is sent.
  assert.equal(now.sections.find(s => s.id === 'accounts').pill, 'open')
  await send(page, 'Stock I am not sure about yet.')
  await b.until(() => b.said.length > 0, 'the message')
  assert.equal(b.said.at(-1), 'My choices on the board: Accounts: Guest checkout; Payments: Hosted page; Markets: confirmed.\n\nStock I am not sure about yet.')
  await b.until(async () => (await decision()).progress === '3 settled · 0 assumed · 1 open', 'settled')
  now = await decision()
  assert.equal(now.tag, null)
  assert.equal(now.head, 'Bottom line · waiting on 1')
  assert.equal(now.sections.find(s => s.id === 'accounts').settled, '✓ Guest checkout · your choice')
  assert.deepEqual(now.boxes, { Cart: '', Acc: 'st-settled', Pay: 'st-settled', Done: '', Stock: 'st-open' })
  const events = await page.$$eval('#messages .brief-event', els => els.map(el => el.textContent))
  assert.deepEqual(events.slice(-3), ['You settled “Accounts”: Guest checkout', 'You settled “Payments”: Hosted page', 'You settled “Markets”'])
})

test("Claude's suggestion is taken or turned down with the next message; a decision with nothing open shows the proposal", async () => {
  await b.call('/post', { briefOps: [{ op: 'add', id: 'email', kind: 'constraint', title: 'Email first', line: 'Ask for the email first.', suggested: true, after: 'accounts' }] })
  await b.until(async () => (await decision()).sections.some(s => s.id === 'email'), 'the suggestion')
  assert.deepEqual((await decision()).sections.find(s => s.id === 'email'), { id: 'email', pill: 'suggestion', choices: ['accept', 'decline'], settled: null })
  // A suggestion does not count as open.
  assert.equal((await decision()).head, 'Bottom line · waiting on 1')
  await page.click(`${sec('email')} [data-choose="accept"]`)
  await page.click(`${sec('stock')} [data-choose="payment"]`)
  await page.click('#form [type=submit]')
  // Everything settled is not yet a proposal: Claude writes it.
  await b.until(async () => (await decision()).head === "Bottom line · all settled, waiting for Claude's proposal", 'nothing open')
  assert.equal(b.said.at(-1), 'My choices on the board: Email first: take it; Stock: From payment start.')
  await b.call('/post', { bottomLine: 'A guest-first, three-step checkout on the hosted payment page; stock held from payment start.' })
  await b.until(async () => (await decision()).head.startsWith('Bottom line · proposal'), 'the proposal')
  assert.equal(await page.$eval('#messages .brief-event:last-of-type', el => el.textContent), 'Claude wrote the proposal')
})

test('saved as Markdown, each constraint says where it stands', async () => {
  const md = await page.evaluate(() => boardMarkdown())
  assert.match(md, /### Accounts _\(settled: Guest checkout\)_/)
  assert.match(md, /### Email first _\(settled: yes\)_/)
  assert.deepEqual(page.errors, [])
})

test('a choice made before Claude changed that constraint does not go with the message', async () => {
  await b.call('/post', { briefOps: [{ op: 'reopen', id: 'payments' }] })
  await b.until(async () => (await decision()).sections.find(s => s.id === 'payments').pill === 'open', 'payments open again')
  await page.click(`${sec('payments')} [data-choose="embedded"]`)
  assert.match((await decision()).tag, /Payments: Embedded fields/)
  // Claude changes the options meanwhile: the click no longer means anything, and is not sent.
  await b.call('/post', { briefOps: [{ op: 'update', id: 'payments', choices: [{ id: 'stripe', label: 'Stripe Checkout' }, { id: 'adyen', label: 'Adyen' }] }] })
  await b.until(async () => (await decision()).tag === null, 'the stale choice gone')
  // Claude's suggestion with choices is taken by choosing one.
  await b.call('/post', { briefOps: [{ op: 'add', id: 'ship', kind: 'constraint', title: 'Shipping', line: 'How is shipping priced?', suggested: true, choices: [{ id: 'flat', label: 'Flat rate' }, { id: 'live', label: 'Live rates' }] }] })
  await b.until(async () => (await decision()).sections.some(s => s.id === 'ship'), 'the suggestion')
  assert.deepEqual((await decision()).sections.find(s => s.id === 'ship').choices, ['flat', 'live', 'decline'])
  await page.click(`${sec('ship')} [data-choose="flat"]`)
  await page.click('#form [type=submit]')
  await b.until(async () => (await decision()).sections.find(s => s.id === 'ship').pill === 'settled', 'taken and settled')
  assert.equal(b.said.at(-1), 'My choices on the board: Shipping: Flat rate.')
})
