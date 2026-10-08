// The brief: Claude's bottom line and sections beside the diagrams. A section
// points at its boxes, is picked to ask about, and changes in place: answers
// land under it, a rewritten line shows the old one, a dropped one is listed.
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

const MAP = `flowchart TB
  U[You] -- sign in --> A[Login service]
  A -- one-time code --> C[The app]
  C -- code for token --> A
  C -- call with token --> R[API]`

const BRIEF = {
  bottomLine: 'OAuth lets an app use your data **without your password**.',
  sections: [
    { id: 'roles', title: 'Four roles', line: 'You, the app, the login service and the API.', focus: ['U', 'A', 'C', 'R'] },
    { id: 'flow', title: 'The main flow', line: 'The app swaps a one-time code for a token.', focus: ['U', 'A', 'C'], cites: [{ label: 'RFC 6749 §4.1', url: 'https://www.rfc-editor.org/rfc/rfc6749#section-4.1' }] },
    { id: 'tokens', title: 'Tokens', line: 'Short-lived and scoped.', focus: ['C', 'R'] },
  ],
}

/** The brief as the page shows it. */
const brief = () =>
  page.evaluate(() => ({
    isShown: document.body.classList.contains('pane-brief'),
    bottomLine: document.querySelector('.bottom-line p')?.textContent ?? null,
    sections: [...document.querySelectorAll('.brief .sec')].map(li => ({
      id: li.dataset.id,
      title: li.querySelector('.sec-title').textContent,
      line: li.querySelector('.line').textContent,
      was: li.querySelector('.was')?.textContent ?? null,
      picked: li.classList.contains('picked'),
      asks: [...li.querySelectorAll('.qa')].map(q => q.innerText.replace(/\s+/g, ' ').trim()),
    })),
    dropped: [...document.querySelectorAll('.brief .dropped .d')].map(d => d.textContent.trim()),
    lit: [...document.querySelectorAll('#canvas g.node.is-focus')].map(g => g.id.replace(/^.*?flowchart-/, '').replace(/-\d+$/, '')).sort(),
  }))
const section = id => `.brief .sec[data-id="${id}"]`

test('a brief arrives beside its diagram: the Brief pane opens on the bottom line and each line, with sources as links', async () => {
  await b.call('/post', { title: 'OAuth', mermaid: MAP, brief: BRIEF })
  await b.until(async () => (await brief()).sections.length === 3 && (await look(page)).tab === 'OAuth', 'the brief and the diagram')
  const now = await brief()
  assert.equal(now.isShown, true)
  assert.equal(now.bottomLine, 'OAuth lets an app use your data without your password.')
  assert.deepEqual(now.sections.map(s => s.title), ['Four roles', 'The main flow', 'Tokens'])
  assert.equal(await page.$eval(`${section('flow')} a.cite`, a => [a.textContent, a.href, a.target].join(' ')), '§ RFC 6749 §4.1 https://www.rfc-editor.org/rfc/rfc6749#section-4.1 _blank')
  // The conversation is one click away and says a brief was written.
  assert.equal(await page.$eval('#messages .brief-event', el => el.textContent), 'Claude wrote a brief')
  assert.deepEqual(page.errors, [])
})

test('pointing at a section lights up its boxes; picking one brings back the diagram that has them', async () => {
  await page.hover(section('tokens'))
  await b.until(async () => (await brief()).lit.join() === 'C,R', 'tokens lit')
  await page.mouse.move(5, 5)
  await b.until(async () => (await brief()).lit.length === 0, 'nothing lit')
  // Another diagram in front, with none of the boxes: picking the section brings the map back.
  await b.call('/post', { title: 'Elsewhere', mermaid: 'flowchart LR\n  x[Cache] --> y[Store]' })
  await b.until(async () => (await look(page)).tab === 'Elsewhere', 'the other diagram')
  await page.click(section('flow'))
  await b.until(async () => (await look(page)).tab === 'OAuth', 'the map is back')
  await page.mouse.move(5, 5)
  await b.until(async () => (await brief()).lit.join() === 'A,C,U', 'flow lit while picked')
  assert.equal((await brief()).sections.find(s => s.id === 'flow').picked, true)
})

test('a question about the picked section reaches Claude with the section, and the answer lands under it', async () => {
  assert.equal(await page.$eval('#about-text', el => el.textContent), 'About “The main flow”: goes with your next message')
  await send(page, 'Why not return the token directly?')
  await b.until(() => b.said.length > 0, 'the message reached the session')
  assert.equal(b.said.at(-1), 'About the brief\'s section `flow` ("The main flow": The app swaps a one-time code for a token.):\nWhy not return the token directly?')
  // The pick went with the message; the question waits under the section.
  await b.until(async () => (await brief()).sections.find(s => s.id === 'flow').asks.length === 1, 'the question under flow')
  let flow = (await brief()).sections.find(s => s.id === 'flow')
  assert.equal(flow.picked, false)
  assert.equal(flow.asks[0], 'You asked: Why not return the token directly? Waiting for Claude…')
  assert.equal(await page.$eval('#about', el => el.hidden), true)

  await b.call('/post', { briefOps: [{ op: 'answer', id: 'flow', text: 'That was the **implicit flow**: the token leaked through the address bar.' }] })
  await b.until(async () => !(await brief()).sections.find(s => s.id === 'flow').asks[0].includes('Waiting'), 'the answer')
  flow = (await brief()).sections.find(s => s.id === 'flow')
  assert.equal(flow.asks[0], 'You asked: Why not return the token directly? That was the implicit flow: the token leaked through the address bar.')
  // In the conversation: the question, marked as being about the section.
  await page.click('.panes [data-pane="chat"]')
  assert.match(await page.evaluate(() => [...document.querySelectorAll('#messages .msg.you')].at(-1).textContent), /Why not return the token directly\?About “The main flow” in the brief/)
  await page.click('.panes [data-pane="brief"]')
})

test('a rewritten line shows the one before it until the person has seen it', async () => {
  await b.call('/post', { briefOps: [{ op: 'update', id: 'flow', line: 'The app swaps a one-time code for a token **over a back channel**.' }] })
  await b.until(async () => (await brief()).sections.find(s => s.id === 'flow').was, 'the old line struck through')
  const flow = (await brief()).sections.find(s => s.id === 'flow')
  assert.equal(flow.line, 'The app swaps a one-time code for a token over a back channel.§ RFC 6749 §4.1updated')
  assert.equal(flow.was, 'The app swaps a one-time code for a token.')
  // Picked (seen): the old line goes, the new one stays.
  await page.click(section('flow'))
  await b.until(async () => !(await brief()).sections.find(s => s.id === 'flow').was, 'seen')
  await page.click(section('flow'))
})

test('a section dropped or added changes the brief, and the conversation says so', async () => {
  await b.call('/post', { briefOps: [{ op: 'drop', id: 'tokens', why: 'not needed here' }, { op: 'add', id: 'pkce', title: 'PKCE', line: 'A secret the app keeps protects the code.', after: 'flow' }] })
  await b.until(async () => (await brief()).dropped.length === 1, 'tokens dropped')
  const now = await brief()
  assert.deepEqual(now.sections.map(s => s.id), ['roles', 'flow', 'pkce'])
  assert.deepEqual(now.dropped, ['Tokens not needed here'])
  const events = await page.$$eval('#messages .brief-event', els => els.map(el => el.textContent))
  assert.deepEqual(events.slice(-2), ['Claude dropped “Tokens”: not needed here', 'Claude added “PKCE”'])
})

test('More detail asks Claude for it, about that section', async () => {
  await page.click(section('pkce'))
  await page.click(`${section('pkce')} [data-act="more"]`)
  await b.until(() => b.said.at(-1)?.endsWith('More detail, please.'), 'asked for more')
  assert.equal(b.said.at(-1), 'About the brief\'s section `pkce` ("PKCE": A secret the app keeps protects the code.):\nMore detail, please.')
  // Asked for, not a question: nothing waits under the section, the detail comes as its body.
  await sleep(300)
  assert.deepEqual((await brief()).sections.find(s => s.id === 'pkce').asks, [])
})

test('a question Claude did not answer under its section says so once Claude is done', async () => {
  await page.click(section('roles'))
  await send(page, 'Which one is mine?')
  await b.until(async () => (await brief()).sections.find(s => s.id === 'roles').asks.length === 1, 'the question under roles')
  assert.match((await brief()).sections.find(s => s.id === 'roles').asks[0], /Waiting for Claude…/)
  // Claude's turn reads it...
  await b.call('/post', { status: 'working' })
  await sleep(300)
  assert.match((await brief()).sections.find(s => s.id === 'roles').asks[0], /Waiting for Claude…/)
  // The turn ends with no answer under the section (Claude answered in the conversation).
  await b.call('/post', { status: 'idle' })
  await b.until(async () => /Not answered here/.test((await brief()).sections.find(s => s.id === 'roles').asks[0]), 'not waiting any more')
  assert.equal((await brief()).sections.find(s => s.id === 'roles').asks[0], 'You asked: Which one is mine? Not answered here: Claude may have answered in the chat.')
})

test("a section lights up a sequence diagram's participants: their boxes and lifelines", async () => {
  await b.call('/post', { title: 'The flow', mermaid: 'sequenceDiagram\n  participant U as Browser\n  participant App as Your app\n  participant AS as Login service\n  U->>App: Log in\n  App->>AS: code + verifier' })
  await b.until(async () => (await look(page)).tab === 'The flow', 'the sequence diagram')
  await b.call('/post', { briefOps: [{ op: 'update', id: 'pkce', focus: ['App', 'AS'] }] })
  await page.hover(section('pkce'))
  const lit = () => page.$$eval('#canvas .is-focus', els => els.map(el => `${el.tagName.toLowerCase()} ${el.getAttribute('name')}`).sort())
  await b.until(async () => (await lit()).length === 6, 'two participants lit')
  assert.deepEqual(await lit(), ['line AS', 'line App', 'rect AS', 'rect AS', 'rect App', 'rect App'])
  await page.mouse.move(5, 5)
})

test('an empty send keeps the pick; a picked section that is dropped takes the composer tag with it', async () => {
  await page.click(section('roles'))
  await page.click('#form [type=submit]')
  await sleep(300)
  assert.equal((await brief()).sections.find(s => s.id === 'roles').picked, true)
  assert.equal(await page.$eval('#about', el => el.hidden), false)
  await b.call('/post', { briefOps: [{ op: 'drop', id: 'roles', why: 'merged' }] })
  await b.until(async () => !(await brief()).sections.some(s => s.id === 'roles'), 'roles dropped')
  assert.equal(await page.$eval('#about', el => el.hidden), true)
  await b.call('/post', { briefOps: [{ op: 'restore', id: 'roles' }] })
  await b.until(async () => (await brief()).sections.some(s => s.id === 'roles'), 'roles back')
})

test('a reconnect keeps the pane the person chose', async () => {
  await page.click('.panes [data-pane="chat"]')
  const { brief: now } = await b.call('/cards')
  await page.evaluate(now => {
    events.onopen()
    onEvent({ data: JSON.stringify({ kind: 'brief', brief: now, changes: [{ op: 'new' }], by: 'claude' }) })
  }, now)
  await b.until(async () => (await brief()).sections.length > 0, 'the brief replayed')
  assert.equal((await brief()).isShown, false)
  await page.reload()
  await page.waitForFunction(() => document.getElementById('conn')?.classList.contains('on'), { timeout: 10_000 })
})

test('a brief posted with a diagram Mermaid rejects is taken off with it, and the one before comes back', async () => {
  const before = (await brief()).bottomLine
  await b.call('/post', { title: 'Broken', mermaid: 'flowchart LR\n  a --> ', brief: { bottomLine: 'A brand new brief', sections: [] }, isNew: true, waitForPage: true })
  await b.until(async () => (await brief()).bottomLine === before, 'the brief before it')
  assert.deepEqual(page.errors, [])
})

test('a page opened again shows the brief as it is, with nothing marked new', async () => {
  await page.reload()
  await page.waitForFunction(() => document.getElementById('conn')?.classList.contains('on'), { timeout: 10_000 })
  await b.until(async () => (await brief()).sections.length === 3, 'the brief again')
  const now = await brief()
  assert.equal(now.isShown, true)
  assert.equal(now.bottomLine, 'OAuth lets an app use your data without your password.')
  assert.deepEqual(now.sections.map(s => [s.id, s.was]), [['flow', null], ['pkce', null], ['roles', null]])
  assert.deepEqual(now.dropped, ['Tokens not needed here'])
  assert.equal((await brief()).sections.find(s => s.id === 'flow').asks.length, 1)
  assert.deepEqual(page.errors, [])
})

test('the board saved as Markdown or a web page starts with the brief', async () => {
  const md = await page.evaluate(() => boardMarkdown())
  assert.ok(md.indexOf('## The brief') < md.indexOf('## OAuth'), 'the brief before the diagrams')
  assert.match(md, /> \*\*Bottom line:\*\* OAuth lets an app use your data \*\*without your password\*\*\./)
  assert.match(md, /### The main flow\n\nThe app swaps a one-time code for a token \*\*over a back channel\*\*\. \[§ RFC 6749 §4\.1\]\(<https:\/\/www\.rfc-editor\.org\/rfc\/rfc6749#section-4\.1>\)/)
  assert.match(md, /\*\*You asked:\*\* Why not return the token directly\?\n\n\*\*Claude:\*\* That was the \*\*implicit flow\*\*/)
  assert.match(md, /_Dropped: Tokens \(not needed here\)\._/)
  const html = await page.evaluate(() => boardHtml())
  assert.match(html, /<section class="brief" id="brief"><h2>The brief<\/h2><blockquote><b>Bottom line:<\/b> OAuth lets an app use your data <b>without your password<\/b>\.<\/blockquote>/)
  assert.doesNotMatch(html, /<script/)
})
