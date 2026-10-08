// Charts on the board: a pie's slices, an xychart's bars and line points, a
// quadrant chart's points. Each is named from Mermaid's own reading of the
// source, so a click selects it and the next message says what was selected,
// as on a canvas. Shares the page's global scope with app.js and editing.js.
'use strict'

const CHART_TYPES = new Set(['pie', 'xychart-beta', 'xychart', 'quadrantChart'])
const named = t => `"${String(t).replace(/\s+/g, ' ').trim()}"`
const amount = n => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))))

/**
 * What a chart's marks are, in the order its SVG draws them: per mark, how to
 * find it (`at`), its label (what a sticky note's `on` names) and how it reads
 * to Claude. Null for anything that is not a chart, or a chart this page
 * cannot name reliably.
 */
async function marksOf(source) {
  const type = typeOf(source)
  if (!CHART_TYPES.has(type)) return null
  let db
  try {
    db = (await mermaid.mermaidAPI.getDiagramFromText(source)).db
  } catch {
    return null
  }
  if (type === 'pie') {
    const sections = [...db.getSections()]
    const total = sections.reduce((sum, [, v]) => sum + v, 0)
    // As Mermaid draws them: in the order of the source, without slices under 1%.
    return sections
      .filter(([, v]) => (v / total) * 100 >= 1)
      .map(([label, value], n) => ({ at: ['slice', n], label, say: `the slice ${named(label)} (${amount(value)}, ${Math.round((value / total) * 100)}%)` }))
  }
  if (type === 'quadrantChart') {
    const names = {}
    const values = new Map()
    for (const line of source.split('\n')) {
      const q = /^\s*quadrant-([1-4])\s+(.+?)\s*$/.exec(line)
      if (q) names[q[1]] = q[2]
      // `Name: [x, y]`, or `Name:::class: [x, y]`, with any styles after.
      const p = /^\s*(.+?)(?::::[\w-]+)?\s*:\s*\[\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]/.exec(line)
      if (p) values.set(p[1].replace(/^"|"$/g, ''), [Number(p[2]), Number(p[3])])
    }
    return [...values].map(([label, [x, y]]) => {
      const quadrant = names[x >= 0.5 ? (y >= 0.5 ? 1 : 4) : y >= 0.5 ? 2 : 3]
      return { at: ['point', label], label, say: `the point ${named(label)} (${amount(x)}, ${amount(y)})${quadrant ? `, in ${named(quadrant)}` : ''}` }
    })
  }
  const data = db.getXYChartData()
  const axis = data.yAxis?.title ? `${data.yAxis.title}: ` : ''
  const marks = []
  data.plots.forEach((plot, i) => {
    const same = data.plots.filter(p => p.type === plot.type)
    const series = plot.title ? named(plot.title) : same.length > 1 ? String(same.indexOf(plot) + 1) : ''
    plot.data.forEach(([category, value], j) => {
      const what =
        plot.type === 'bar'
          ? `the bar ${named(category)}${series ? ` in bar series ${series}` : ''}`
          : `the point ${named(category)} on ${series ? `line ${series}` : 'the line'}`
      marks.push({ at: [plot.type, i, j], label: String(category), say: `${what} (${axis}${amount(value)})` })
    })
  })
  return marks
}

/** The SVG with each mark findable (`data-mark`), named on hover, and lines given points to click. */
function withMarks(svgText, marks) {
  const holder = document.createElement('div')
  holder.innerHTML = svgText
  const svg = holder.querySelector('svg')
  const slices = [...svg.querySelectorAll('path.pieCircle')]
  const pointGroups = [...svg.querySelectorAll('g.data-point')]
  const points = new Map(pointGroups.map(g => [g.querySelector('text')?.textContent.trim(), g]))
  const circle = (x, y, r, cls) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    c.setAttribute('cx', x)
    c.setAttribute('cy', y)
    c.setAttribute('r', r)
    c.setAttribute('class', cls)
    return c
  }
  const found = marks.map(m => {
    const [kind, a, b] = m.at
    if (kind === 'slice') return slices[a]
    if (kind === 'point') return points.get(a)
    if (kind === 'bar') return svg.querySelectorAll(`g.bar-plot-${a} rect`)[b]
    // A line is one path: at each of its points, a dot to see and, just
    // around it, a spot to click. Elsewhere on a bar, the click is the bar's.
    const path = svg.querySelector(`g.line-plot-${a} path`)
    const at = [...(path?.getAttribute('d') ?? '').matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)][b]
    if (!at) return null
    const dot = circle(at[1], at[2], 3.5, 'line-point')
    dot.style.fill = path.getAttribute('stroke') || '#8493a6'
    const hit = circle(at[1], at[2], 7, 'line-dot')
    // Transparent in the drawing itself, so its pictures (exports, Claude's look) show only the dot.
    hit.setAttribute('fill', 'transparent')
    path.parentNode.append(dot, hit)
    return hit
  })
  // All or nothing: a chart drawn differently from how it was read is not clickable.
  const isWhole =
    marks.length === new Set(found).size &&
    found.every(Boolean) &&
    (!slices.length || slices.length === marks.length) &&
    (!pointGroups.length || pointGroups.length === marks.length)
  if (!isWhole) return null
  found.forEach((el, n) => {
    el.dataset.mark = String(n)
    el.dataset.label = marks[n].label
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    title.textContent = marks[n].say.replace(/^the /, '')
    el.prepend(title)
  })
  svg.classList.add('chart')
  return holder.innerHTML
}

/** Shows what is selected on the chart on screen. */
function showPicks(d) {
  const svg = canvas.querySelector('svg.chart')
  document.body.classList.toggle('on-chart', !!(svg && d?.marks))
  if (!svg || !d?.marks) return
  svg.classList.toggle('has-picks', d.picks.size > 0)
  for (const el of svg.querySelectorAll('[data-mark]')) {
    const isPicked = d.picks.has(Number(el.dataset.mark))
    el.classList.toggle('picked', isPicked)
    // On top of its neighbours, so its outline shows whole.
    const last = [...el.parentNode.children].filter(c => c.tagName === el.tagName).pop()
    if (isPicked && last !== el) last.after(el)
  }
  // The hint says what goes with the next message: with keys, or by touch.
  // As Claude will read them (a bar and a line's point can share a label).
  const labels = [...d.picks].sort((a, b) => a - b).map(n => d.marks[n].say.replace(/^the /, ''))
  for (const [cls, clear] of [['chart-keys', 'Esc clears'], ['chart-touch', 'tap beside it to clear']]) {
    const hint = document.querySelector(`#stage-hint .${cls}`)
    hint.dataset.idle ??= hint.textContent
    hint.textContent = labels.length ? `Selected: ${labels.join(', ')} · goes with your next message · ${clear}` : hint.dataset.idle
    hint.classList.toggle('picked', labels.length > 0)
  }
}

/** What is selected on a chart, in words. */
const picksOf = d => (d?.marks ? [...d.picks].sort((a, b) => a - b).map(n => d.marks[n].say) : [])

// A click (not the end of a pan) selects a mark; with Shift, Ctrl or Cmd it
// adds to the selection or takes the mark out of it. A click beside the marks,
// or Escape, clears the selection. The mark is taken at the press: the stage
// captures the pointer, so the click itself lands on the stage.
let press = null
stage.addEventListener(
  'pointerdown',
  e => {
    press = { x: e.clientX, y: e.clientY, mark: e.target instanceof Element ? e.target.closest('[data-mark]') : null }
  },
  true,
)
stage.addEventListener('click', e => {
  const d = diagrams[current]
  if (!d?.marks || !press || isCode || isEditing() || e.target.closest?.('.sticky')) return
  if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) return
  const n = press.mark ? Number(press.mark.dataset.mark) : null
  const isAdding = e.shiftKey || e.metaKey || e.ctrlKey
  if (n === null) {
    if (!isAdding) d.picks.clear()
  } else if (isAdding) {
    if (!d.picks.delete(n)) d.picks.add(n)
  } else if (d.picks.size === 1 && d.picks.has(n)) {
    d.picks.clear()
  } else {
    d.picks = new Set([n])
  }
  showPicks(d)
})
document.addEventListener('keydown', e => {
  const d = diagrams[current]
  if (e.key !== 'Escape' || !d?.picks?.size || isEditing()) return
  if (e.target instanceof Element && e.target.closest('textarea, input, [contenteditable]')) return
  d.picks.clear()
  showPicks(d)
})
