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
    const sections = [...db.getSections()].filter(([, v]) => v > 0)
    const total = sections.reduce((sum, [, v]) => sum + v, 0)
    return sections.map(([label, value], n) => ({ at: ['slice', n, label], label, say: `the slice ${named(label)} (${amount(value)}, ${Math.round((value / total) * 100)}%)` }))
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

/** A CSS colour in one spelling (#rrggbb), so a legend's colour and a slice's compare. */
const paint = document.createElement('canvas').getContext('2d')
function colourOf(css) {
  paint.fillStyle = '#000000'
  paint.fillStyle = css || '#000000'
  return paint.fillStyle
}

/** The SVG with each mark findable (`data-mark`), named on hover, and lines given points to click. */
function withMarks(svgText, marks) {
  const holder = document.createElement('div')
  holder.innerHTML = svgText
  const svg = holder.querySelector('svg')
  const slices = [...svg.querySelectorAll('path.pieCircle')]
  // A slice is the colour of its label in the legend; failing that (more slices
  // than colours), the slices are in the order of the source.
  const legend = [...svg.querySelectorAll('g.legend')].map(g => [colourOf(g.querySelector('rect')?.style.fill), g.textContent.trim()])
  const isByColour = new Set(legend.map(([c]) => c)).size === legend.length
  const sliceOf = new Map(isByColour ? slices.map(p => [legend.find(([c]) => c === colourOf(p.getAttribute('fill')))?.[1], p]) : [])
  const points = new Map([...svg.querySelectorAll('g.data-point')].map(g => [g.querySelector('text')?.textContent.trim(), g]))
  const found = marks.map(m => {
    const [kind, a, b] = m.at
    if (kind === 'slice') return isByColour ? sliceOf.get(b) : slices[a]
    if (kind === 'point') return points.get(a)
    if (kind === 'bar') return svg.querySelectorAll(`g.bar-plot-${a} rect`)[b]
    // A line is one path: a dot at each of its points, to click.
    const path = svg.querySelector(`g.line-plot-${a} path`)
    const at = [...(path?.getAttribute('d') ?? '').matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)][b]
    if (!at) return null
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    dot.setAttribute('cx', at[1])
    dot.setAttribute('cy', at[2])
    dot.setAttribute('r', '9')
    dot.setAttribute('class', 'line-dot')
    path.parentNode.append(dot)
    return dot
  })
  // All or nothing: a chart drawn differently from how it was read is not clickable.
  if (marks.length !== new Set(found).size || found.some(el => !el) || (slices.length && slices.length !== marks.length)) return null
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
  for (const el of svg.querySelectorAll('[data-mark]')) el.classList.toggle('picked', d.picks.has(Number(el.dataset.mark)))
  // The hint says what goes with the next message.
  const hint = document.querySelector('#stage-hint .chart-keys')
  hint.dataset.idle ??= hint.textContent
  const labels = [...d.picks].sort((a, b) => a - b).map(n => d.marks[n].label)
  hint.textContent = labels.length ? `Selected: ${labels.join(', ')} · goes with your next message · Esc clears` : hint.dataset.idle
  hint.classList.toggle('picked', labels.length > 0)
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
