// Charts: a pie's slices, an xychart's bars and line points and a quadrant
// chart's points are named from the source, selected with a click, and said in
// the next message; a sticky note can sit on one.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { board, look, send, sleep } from './board.mjs'

let b
let page
before(async () => {
  b = await board()
  page = await b.open()
})
after(() => b.close())

/** Posts a chart and waits for it on screen, clickable. */
async function chart(title, mermaid, extra = {}) {
  await b.call('/post', { title, mermaid, ...extra })
  await b.until(async () => (await look(page)).tab === title && (await page.$('svg.chart')), `${title} on screen`)
}
/** Every mark on screen: its label, what it says, whether it is selected. */
const marks = () =>
  page.$$eval('#canvas [data-mark]', els => els.map(el => ({ label: el.dataset.label, say: el.querySelector('title').textContent, picked: el.classList.contains('picked') })))
/** Clicks a mark by its label, as the person would (Shift with `isAdding`). */
async function click(label, isAdding = false) {
  const el = await page.$(`#canvas [data-mark][data-label="${label}"]`)
  const box = await el.boundingBox()
  if (isAdding) await page.keyboard.down('Shift')
  // Inside the mark: a slice's centre may be outside it, so aim at its middle point on screen.
  const at = await el.evaluate(el => {
    const r = el.getBoundingClientRect()
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.3], [0.7, 0.7], [0.3, 0.7], [0.7, 0.3], [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5]]) {
      const x = r.left + r.width * fx
      const y = r.top + r.height * fy
      if (document.elementFromPoint(x, y)?.closest('[data-mark]') === el) return { x, y }
    }
    return null
  })
  assert.ok(at, `no point inside ${label} (${JSON.stringify(box)})`)
  await page.mouse.click(at.x, at.y)
  if (isAdding) await page.keyboard.up('Shift')
}
const picked = async () => (await marks()).filter(m => m.picked).map(m => m.label)

test('a pie: each slice by its label (its colour in the legend)', async () => {
  await chart('Pets', 'pie title Pets\n  "Rats" : 15\n  "Dogs" : 386\n  "Cats" : 85')
  const all = await marks()
  assert.deepEqual(all.map(m => m.label).sort(), ['Cats', 'Dogs', 'Rats'])
  // The biggest slice is the one that says Dogs.
  const sizes = await page.$$eval('#canvas [data-mark]', els => els.map(el => [el.dataset.label, el.getBBox().width * el.getBBox().height]))
  assert.equal(sizes.sort((a, b) => b[1] - a[1])[0][0], 'Dogs')
  assert.match(all.find(m => m.label === 'Dogs').say, /slice "Dogs" \(386, 79%\)/)
})

test('a click selects a slice and the next message says so; a second click lets go', async () => {
  await click('Dogs')
  assert.deepEqual(await picked(), ['Dogs'])
  assert.match(await page.$eval('#stage-hint .chart-keys', el => el.textContent), /^Selected: Dogs · goes with your next message/)
  await send(page, 'why so many?')
  const msg = await b.until(() => b.said.find(s => s.endsWith('why so many?')), 'the message')
  assert.match(msg, /^Selected on the board, in "Pets": the slice "Dogs" \(386, 79%\)\n\nwhy so many\?$/)
  await click('Dogs')
  assert.deepEqual(await picked(), [])
})

test('Shift adds to the selection, a click beside the chart and Escape clear it, and a pan selects nothing', async () => {
  await click('Cats')
  await click('Rats', true)
  assert.deepEqual((await picked()).sort(), ['Cats', 'Rats'])
  await page.keyboard.press('Escape')
  assert.deepEqual(await picked(), [])
  await click('Cats')
  const stage = await (await page.$('#stage')).boundingBox()
  await page.mouse.click(stage.x + 12, stage.y + 12)
  assert.deepEqual(await picked(), [])
  // A drag that starts on a slice pans the board.
  const el = await page.$('#canvas [data-mark][data-label="Dogs"]')
  const box = await el.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 5 })
  await page.mouse.up()
  assert.deepEqual(await picked(), [])
})

test('an xychart: bars and line points by category, with the axis and the series', async () => {
  await chart('Sales', 'xychart-beta\n  title "Sales"\n  x-axis [jan, feb, mar]\n  y-axis "Revenue" 0 --> 100\n  bar [50, 60, 75]\n  line [40, 55, 70]')
  const says = (await marks()).map(m => m.say)
  assert.deepEqual(says, [
    'bar "jan" (Revenue: 50)', 'bar "feb" (Revenue: 60)', 'bar "mar" (Revenue: 75)',
    'point "jan" on the line (Revenue: 40)', 'point "feb" on the line (Revenue: 55)', 'point "mar" on the line (Revenue: 70)',
  ])
  await click('feb')
  await send(page, 'and this?')
  const msg = await b.until(() => b.said.find(s => s.endsWith('and this?')), 'the message')
  assert.match(msg, /in "Sales": the bar "feb" \(Revenue: 60\)/)
})

test('two bar series are told apart', async () => {
  await chart('Two', 'xychart-beta horizontal\n  x-axis [a, b]\n  bar [1, 2]\n  bar [3, 4]')
  assert.deepEqual((await marks()).map(m => m.say), ['bar "a" in bar series 1 (1)', 'bar "b" in bar series 1 (2)', 'bar "a" in bar series 2 (3)', 'bar "b" in bar series 2 (4)'])
})

test('a quadrant chart: points by name, with their quadrant', async () => {
  await chart('Reach', 'quadrantChart\n  x-axis Low --> High\n  y-axis Low --> High\n  quadrant-1 Expand\n  quadrant-3 Drop\n  Campaign A: [0.3, 0.6]\n  Campaign B:::hot: [0.7, 0.8] radius: 9\n  Campaign C: [0.2, 0.1]\n  classDef hot color: #ff3300')
  const by = Object.fromEntries((await marks()).map(m => [m.label, m.say]))
  assert.deepEqual(by, { 'Campaign A': 'point "Campaign A" (0.3, 0.6)', 'Campaign B': 'point "Campaign B" (0.7, 0.8), in "Expand"', 'Campaign C': 'point "Campaign C" (0.2, 0.1), in "Drop"' })
})

test("each chart keeps its own selection, and the message says only the one on screen", async () => {
  await click('Campaign C')
  await page.click('.tab[title="Pets"]')
  await b.until(async () => (await look(page)).tab === 'Pets', 'Pets')
  assert.deepEqual(await picked(), [])
  await send(page, 'plain')
  const msg = await b.until(() => b.said.find(s => s.endsWith('plain')), 'the message')
  assert.equal(msg, 'plain')
  await page.click('.tab[title="Reach"]')
  await b.until(async () => (await picked()).length === 1, 'the selection back')
  assert.deepEqual(await picked(), ['Campaign C'])
})

test('a sticky note can sit on a slice', async () => {
  await chart('Noted', 'pie\n  "Yes" : 70\n  "No" : 30', { notes: [{ on: 'No', text: 'Mostly mobile users' }] })
  await b.until(() => page.$('.sticky'), 'the note')
  const note = await (await page.$('.sticky')).boundingBox()
  const slice = await (await page.$('#canvas [data-mark][data-label="No"]')).boundingBox()
  // Beside its slice, not in the column beside the chart.
  const gap = Math.max(slice.x - (note.x + note.width), note.x - (slice.x + slice.width), slice.y - (note.y + note.height), note.y - (slice.y + slice.height), 0)
  assert.ok(gap < 40, `the note is ${gap}px from its slice`)
})

for (const [name, count] of [['pie.mmd', 4], ['xychart.mmd', 8], ['quadrant.mmd', 4]]) {
  test(`${name}: every slice, bar or point is clickable`, async () => {
    await chart(name, readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'))
    assert.equal((await marks()).length, count)
  })
}

test('diagrams that are not charts are not clickable, and nothing failed', async () => {
  await b.call('/post', { title: 'Flow', mermaid: 'flowchart LR\n  a --> b' })
  await b.until(async () => (await look(page)).tab === 'Flow', 'the flowchart')
  await sleep(200)
  assert.equal(await page.$('#canvas [data-mark]'), null)
  assert.equal(await page.evaluate(() => document.body.classList.contains('on-chart')), false)
  assert.deepEqual(page.errors, [])
})
