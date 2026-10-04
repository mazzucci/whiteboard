import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { DiagramDoc, DiagramView } from '../types'
import { MERMAID_VERSION, outcomeOf, PUPPETEER_VERSION, SVG_LABELS } from './renderer'
import type { RenderOutcome } from './renderer'
import { docBox, FIT, frame, imageBox, panBy, SVG_CAP, windowOf, ZOOMS, zoomStep, zoomTo } from './view'
import type { Box } from './view'

/** A window of the drawing and the CSS size to draw it at: the terminal's picture. */
type Picture = Box & { width: number; height: number }

const PANE = 'whiteboard'
const TOOL = 'show_diagram'
const THEME_KEY = 'theme'
const HISTORY_MAX = 30
/** The body rows the pane asks for when it sits above the terminal's prompt (not docked). */
const INLINE_ROWS = 30
/** The terminal Image's cap on a PNG, decoded. */
const PNG_CAP = 2 * 1024 * 1024
const THEMES = ['auto', 'default', 'dark', 'forest', 'neutral', 'base']

const doc = atom({ plugin: 'whiteboard', key: 'doc' } as const, null)
const history = atom({ plugin: 'whiteboard', key: 'history' } as const, [])
const index = atom({ plugin: 'whiteboard', key: 'index' } as const, 0)
const viewState = atom({ plugin: 'whiteboard', key: 'view' } as const, { mode: 'render', ...FIT })

const SAMPLE: DiagramDoc = {
  title: 'Sample: checkout',
  source: `flowchart LR
  shopper([Shopper]) --> web[Storefront]
  web --> api[Orders API]
  api --> pay{{Payment provider}}
  api --> db[(Orders DB)]
  api -. order placed .-> mail[Email service]`,
}

// ---------------------------------------------------------------- renderer
//
// Real Mermaid in a headless browser (renderer/renderd.mjs), started on first
// use, kept warm, reached over a private Unix socket. Everything it needs is
// installed by setup into ~/.cache/<plugin name>.

let socket: Promise<string> | null = null

async function rendererHome($: EngineInterface): Promise<string> {
  return `${(await $.env.get('HOME')) ?? ''}/.cache/${$.plugin.name}`
}

async function isInstalled($: EngineInterface): Promise<boolean> {
  const home = await rendererHome($)
  return (
    (await $.fs.exists(`${home}/mermaid.min.js`)) &&
    (await $.fs.exists(`${home}/node_modules/puppeteer-core/package.json`))
  )
}

/** The node binary: on PATH, or where installers put it when the app's PATH is thin. */
async function nodePath($: EngineInterface): Promise<string> {
  const dirs = ((await $.env.get('PATH')) ?? '').split(':').filter(Boolean)
  for (const dir of [...dirs, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    if (await $.fs.exists(`${dir}/node`)) return `${dir}/node`
  }
  throw new Error('Node.js was not found; the diagram renderer needs it.')
}

function startRenderer($: EngineInterface): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    void (async () => {
      try {
        const argv = [await nodePath($), `${$.plugin.root}/renderer/renderd.mjs`, '--home', await rendererHome($)]
        let out = ''
        let err = ''
        // The loop is the renderer's life: it ends with the child or the module.
        for await (const piece of $.process.spawn({ argv })) {
          if (piece.stream === 'stdout') {
            out += piece.text
            const ready = /\{[^\n]*"ready":true[^\n]*\}/.exec(out)
            if (ready) resolve(String((JSON.parse(ready[0]) as { socket: string }).socket))
          } else {
            err = (err + piece.text).slice(-2000)
          }
        }
        socket = null
        reject(new Error(`The diagram renderer stopped. ${err.trim().split('\n').slice(-3).join(' ')}`))
      } catch (error) {
        socket = null
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })()
  })
}

async function postRender($: EngineInterface, body: string): Promise<RenderOutcome> {
  socket ??= startRenderer($)
  const path = await socket
  const res = await $.http.fetch('http://renderer/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    socketPath: path,
  })
  return outcomeOf(res.status, res.text)
}

/** Renders Mermaid source exactly as Mermaid does; never throws. */
async function render($: EngineInterface, source: string, theme: string, png = false, view?: Picture): Promise<RenderOutcome> {
  if (!(await isInstalled($))) {
    return { ok: false, isSetup: true, error: 'The diagram renderer is not set up yet: run /whiteboard setup.' }
  }
  const bodyAt = (scale: number) => JSON.stringify({ source, theme, config: SVG_LABELS, ...(png && { png: true, scale, view }) })
  const attempt = async (body: string) => {
    try {
      return await postRender($, body)
    } catch {
      // A renderer that went idle or died: start a fresh one, once.
      socket = null
      try {
        return await postRender($, body)
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error), isTransient: true }
      }
    }
  }
  const out = await attempt(bodyAt(2))
  // The terminal's Image takes at most 2 MiB of PNG: a large drawing at
  // double density can pass that, at single density rarely.
  if (out.ok && out.value.png && out.value.png.length * 0.75 > PNG_CAP) return attempt(bodyAt(1))
  return out
}

/** What setup downloads, said before it does: in the pane, and to Claude. */
const SETUP_NOTE =
  `/whiteboard setup downloads puppeteer-core ${PUPPETEER_VERSION} (about 29 MB) and Mermaid ${MERMAID_VERSION}'s ` +
  'script (about 5 MB) from npm into ~/.cache/whiteboard, asking before each. It uses an installed Chrome, Edge, ' +
  'Brave or Chromium, and offers a headless Chrome (about 150 MB) only if none is found. It needs Node.js 22.12 or later.'

/** The plugin's two commands that finish an uninstall. */
const UNINSTALL_NEXT =
  'To remove the plugin too: claude plugin uninstall whiteboard@whiteboard-for-claude-code, ' +
  'then, if you like, claude plugin marketplace remove whiteboard-for-claude-code.'

/** Runs renderer/setup.mjs with `args`, each line in the status line; resolves to its last JSON line. */
async function setupScript($: EngineInterface, args: string[]): Promise<Record<string, unknown>> {
  const argv = [
    await nodePath($),
    `${$.plugin.root}/renderer/setup.mjs`,
    '--home',
    await rendererHome($),
    '--mermaid',
    MERMAID_VERSION,
    '--puppeteer',
    PUPPETEER_VERSION,
    ...args,
  ]
  let buffer = ''
  let last: Record<string, unknown> = { step: 'error', message: 'setup printed nothing' }
  for await (const piece of $.process.spawn({ argv })) {
    if (piece.stream !== 'stdout') continue
    buffer += piece.text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines.filter(Boolean)) {
      last = JSON.parse(line) as Record<string, unknown>
      if (typeof last.message === 'string') $.ui.status(`whiteboard setup: ${last.message}`)
    }
  }
  $.ui.status(undefined)
  return last
}

/** Whether this machine's Node.js can run the renderer: 22.12 or later. */
async function checkNode($: EngineInterface): Promise<string | undefined> {
  let node: string
  try {
    node = await nodePath($)
  } catch {
    return 'Node.js 22.12 or later is needed, and none was found. Install it from https://nodejs.org, then run /whiteboard setup again.'
  }
  const version = (await $.process.run([node, '--version'])).stdout.trim()
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number)
  if (major > 22 || (major === 22 && minor >= 12)) return undefined
  return `Node.js 22.12 or later is needed; ${node} is ${version || 'an unknown version'}. Update it from https://nodejs.org, then run /whiteboard setup again.`
}

/** Asks the person; true only for the one answer that goes ahead. */
async function confirm($: EngineInterface, question: string, yes: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, { options: [yes, 'Cancel'], header: 'Whiteboard' })) === yes
  } catch {
    // Dismissed, or no one to ask (a -p run): no.
    return false
  }
}

/** /whiteboard setup: checks, then downloads only what is missing, each after a yes. */
async function setup($: EngineInterface, downloadBrowser: boolean): Promise<string> {
  const nodeProblem = await checkNode($)
  if (nodeProblem) return nodeProblem
  const plan = await setupScript($, ['--plan'])
  if (plan.step !== 'plan') return `Setup failed: ${String(plan.message)}`
  const home = `~/.cache/${$.plugin.name}`
  const browser = typeof plan.browser === 'string' ? plan.browser : undefined
  const steps: { step: string; question: string }[] = []
  if (!plan.puppeteer) {
    steps.push({
      step: 'puppeteer',
      question: `Download puppeteer-core ${PUPPETEER_VERSION} from npm (about 29 MB) into ${home}? It drives a browser to render diagrams.`,
    })
  }
  if (!plan.mermaid) {
    steps.push({
      step: 'mermaid',
      question: `Download Mermaid ${MERMAID_VERSION}'s script from npm (about 5 MB) into ${home}? It draws the diagrams.`,
    })
  }
  if (downloadBrowser || !browser) {
    steps.push({
      step: 'browser',
      question:
        `${browser ? '' : 'No Chrome, Edge, Brave or Chromium was found. '}Download a headless Chrome ` +
        `(about 150 MB) from Google's Chrome for Testing into ${home}/browsers?`,
    })
  }
  const done: string[] = []
  for (const { step, question } of steps) {
    if (!(await confirm($, question, 'Download'))) {
      const so = done.length ? ` (${done.join(' and ')} done)` : ''
      return `Setup stopped; nothing more was downloaded${so}. Run /whiteboard setup again to continue.`
    }
    const out = await setupScript($, ['--step', step])
    if (out.step !== 'done') return `Setup failed while installing ${step}: ${String(out.message)}`
    done.push(step)
  }
  const using = browser && !downloadBrowser ? `, using ${browser}` : ''
  return `Diagram renderer ready (Mermaid ${MERMAID_VERSION}${using}).`
}

/** /whiteboard uninstall: after a yes, stops the renderer and deletes its folder. */
async function uninstall($: EngineInterface): Promise<string> {
  const home = await rendererHome($)
  if (!(await $.fs.exists(home))) return `Nothing to delete: ${home} does not exist. ${UNINSTALL_NEXT}`
  const question = `Delete the diagram renderer's files in ${home}? The plugin stays installed until you remove it.`
  if (!(await confirm($, question, 'Delete'))) return 'Nothing was deleted.'
  if (socket) {
    try {
      await $.http.fetch('http://renderer/quit', { method: 'POST', socketPath: await socket })
    } catch {
      // Already stopped.
    }
    socket = null
  }
  renders.clear()
  const out = await setupScript($, ['--remove'])
  return out.step === 'done' ? `Deleted ${home}. ${UNINSTALL_NEXT}` : `Nothing was deleted: ${String(out.message)}`
}

// ---------------------------------------------------------------- diagrams

async function show($: EngineInterface, next: DiagramDoc) {
  const list = await update($, history, h => [...h.filter(d => d.source !== next.source), next].slice(-HISTORY_MAX))
  await goTo($, list.length - 1)
  await $.ui.open({ id: PANE, title: 'Whiteboard', rows: INLINE_ROWS })
}

/** Shows one diagram of the history, fitted. */
async function goTo($: EngineInterface, at: number) {
  const list = await read($, history)
  const i = Math.max(0, Math.min(list.length - 1, at))
  const next = list[i]
  if (!next) return
  await update($, index, () => i)
  await update($, doc, () => next)
  await update($, viewState, () => ({ mode: 'render' as const, ...FIT }))
}

// One render per source and theme; a reload starts the cache over.
const renders = new Map<string, Promise<RenderOutcome>>()
function renderCached($: EngineInterface, source: string, theme: string, png = false, view?: Picture): Promise<RenderOutcome> {
  const at = view ? [view.x, view.y, view.w, view.h, view.width, view.height].map(n => n.toFixed(2)).join(' ') : ''
  const key = `${png ? `png ${at}` : 'svg'}\n${theme}\n${source}`
  let hit = renders.get(key)
  if (!hit) {
    hit = render($, source, theme, png, view)
    renders.set(key, hit)
    // A failure to reach the renderer is retried next time; a Mermaid error is kept.
    void hit.then(out => {
      if (!out.ok && (out.isSetup || out.isTransient)) renders.delete(key)
    })
  }
  return hit
}

/**
 * What the terminal's picture of a view shows: the window, and the size in CSS
 * pixels to draw it at, the drawing's own density times the zoom, so zooming in
 * sharpens; at most 2400 px a side.
 */
function pictureOf(drawn: { svg: string; width: number; height: number }, v: DiagramView, box: ReturnType<typeof imageBox>): Picture {
  const win = windowOf(drawn.svg, drawn, v, box.span)
  const width = drawn.width * box.span.w * Math.max(1, v.zoom)
  const height = (width * win.h) / win.w
  const shrink = Math.min(1, 2400 / Math.max(width, height))
  return { ...win, width: Math.max(1, Math.round(width * shrink)), height: Math.max(1, Math.round(height * shrink)) }
}

/** Forgets every render of a diagram and draws the pane again: Refresh. */
async function refresh($: EngineInterface, source: string) {
  for (const key of [...renders.keys()]) if (key.endsWith(`\n${source}`)) renders.delete(key)
  // An ordinary redraw: $.ui.invalidate would also cut off the draw that
  // started the warm renderer, and the renderer with it.
  await update($, viewState, x => ({ ...x }))
}

/**
 * The theme to render with: the diagram's, else the person's choice, else
 * automatic. Automatic is light, except in the terminal, where it follows the
 * Claude Code theme: that setting is the terminal's (it reads "dark" even
 * where it was never set), not the desktop app's appearance.
 */
async function themeFor($: EngineInterface, d: DiagramDoc, surface?: string): Promise<string> {
  if (d.theme && d.theme !== 'auto') return d.theme
  const chosen = await $.store.get(THEME_KEY)
  if (typeof chosen === 'string' && chosen !== 'auto') return chosen
  if (surface !== 'terminal') return 'default'
  try {
    const row = (await $.config.list()).find(r => r.key === 'theme')
    return /dark/i.test(String(row?.value ?? '')) ? 'dark' : 'default'
  } catch {
    return 'default'
  }
}

/** The diagram type from its header line, for titles and messages. */
function typeOf(source: string): string {
  const body = source.replace(/^---[\s\S]*?\n---\s*\n/, '').replace(/%%\{[\s\S]*?\}%%/g, '')
  const first = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('%%')) ?? ''
  return first.split(/[\s:;{]/)[0] ?? ''
}

/** Mermaid's error, trimmed to what helps fix the source. */
function mermaidError(error: string): string {
  return error.replace(/\s+at\s.*$/s, '').trim().slice(0, 1200)
}

/** The first ```mermaid fence of a markdown file, or the whole text. */
function mermaidOf(text: string): string {
  const fence = /```mermaid\s*\n([\s\S]*?)```/.exec(text)
  return (fence?.[1] ?? text).trim()
}

// Mermaid's names for its diagram types, as a header keyword (`sequenceDiagram`,
// `graph`) or as the renderer reports them (`flowchart-v2`, `sequence`, `er`).
const KIND_LABELS: [RegExp, string][] = [
  [/^(flowchart|graph)/i, 'Flowchart'],
  [/^sequence/i, 'Sequence diagram'],
  [/^class/i, 'Class diagram'],
  [/^state/i, 'State diagram'],
  [/^er(Diagram)?$/i, 'Entity-relationship diagram'],
  [/^c4/i, 'C4 diagram'],
  [/^architecture/i, 'Architecture diagram'],
  [/^block/i, 'Block diagram'],
  [/^mindmap/i, 'Mind map'],
  [/^timeline/i, 'Timeline'],
  [/^gantt/i, 'Gantt chart'],
  [/^journey/i, 'User journey'],
  [/^gitGraph/i, 'Git graph'],
  [/^quadrant/i, 'Quadrant chart'],
  [/^xychart/i, 'XY chart'],
  [/^sankey/i, 'Sankey diagram'],
  [/^pie/i, 'Pie chart'],
  [/^kanban/i, 'Kanban board'],
  [/^packet/i, 'Packet diagram'],
  [/^requirement/i, 'Requirement diagram'],
  [/^zenuml/i, 'ZenUML sequence'],
  [/^treemap/i, 'Treemap'],
  [/^radar/i, 'Radar chart'],
]

/** A readable name for a diagram type: `sequenceDiagram` reads "Sequence diagram". */
function kindLabel(kind: string): string {
  const hit = KIND_LABELS.find(([re]) => re.test(kind))
  if (hit) return hit[1]
  const bare = kind.replace(/-(beta|v2|elk)$/i, '')
  return bare ? bare[0]!.toUpperCase() + bare.slice(1) : 'Diagram'
}

/** Text as the Code element takes it: at most 10000 characters, tab and newline its only control characters. */
function codeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 10000)
}

// ---------------------------------------------------------------- the pane

async function drawPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text, Button, Code } = $.ui.resolve(e)
  const Svg = e.surface === 'terminal' ? undefined : $.ui.resolve(e).Svg
  // The terminal has no SVG, but draws a PNG as an Image where it can (the
  // kitty graphics protocol), and the Image's alt text elsewhere.
  const Image = e.surface === 'terminal' ? $.ui.resolve(e).Image : undefined

  const current = await read($, doc)
  if (!current) {
    return (
      <Box flexDirection="column" paddingY={1}>
        <Text bold>No diagram yet</Text>
        <Text dimColor>Ask Claude to draw one, or run /whiteboard sample.</Text>
      </Box>
    )
  }
  const list = await read($, history)
  const at = await read($, index)
  const v = await read($, viewState)
  const theme = await themeFor($, current, e.surface)
  const kind = typeOf(current.source)
  // The terminal shows a PNG of the view's window: the SVG render gives the
  // drawing's coordinates, then the renderer draws just that window.
  const drawn = Svg || Image ? await renderCached($, current.source, theme) : undefined
  const cols = Math.max(20, e.props.bodyColumns || e.viewport?.columns || 80)
  const rows = e.viewport?.rows ?? 40
  // The terminal's picture: the pane's body below its header is about the
  // screen less the prompt and the header, docked; inline, above the prompt,
  // the rows it asked for (INLINE_ROWS), as far as the screen spares them.
  const bodyRows = e.props.placement === 'inline' ? Math.min(INLINE_ROWS, rows - 12) - 4 : rows - 10
  const box = drawn?.ok ? imageBox(drawn.value, v.zoom, { columns: cols, rows: Math.max(4, bodyRows) }) : undefined
  const out =
    Image && drawn?.ok && box && v.mode === 'render'
      ? await renderCached($, current.source, theme, true, pictureOf(drawn.value, v, box))
      : drawn
  const isRender = v.mode === 'render' && Boolean(Svg || Image)
  // Zoom and pan need a picture: the SVG, or the terminal's PNG.
  const canZoom = isRender && Boolean(out?.ok) && Boolean(Svg || (out?.ok && out.value.png))
  // Mermaid's own reading of the type when it rendered, else the header line's.
  const label = kindLabel(out?.ok && out.value.type ? out.value.type : kind)
  // An untitled diagram is titled by its type keyword: the readable name stands in, once.
  const untitled = current.title.toLowerCase() === kind.toLowerCase()
  const title = untitled ? label : current.title

  // The pane's width in CSS pixels, from its columns on the desktop's code
  // font. The Svg is never drawn wider than the pane, whatever this says.
  const paneWidth = cols * 7.5
  const set = (f: (x: DiagramView) => DiagramView) => () => update($, viewState, f)

  // Controls are drawn dim when they would do nothing right now (the first
  // diagram's prev, pan at fit), never removed, so the layout never reflows.
  const atFit = v.zoom <= 1
  // The desktop's box: the drawing at fit times the zoom, cropped across to the pane.
  const sized = Svg && out?.ok ? docBox(out.value, v.zoom, paneWidth) : undefined
  // Pan does something only while the window is smaller than the drawing.
  const span = sized?.span ?? box?.span
  const canPan = Boolean(span && (span.w < 0.999 || span.h < 0.999))
  const first = at <= 0
  const last = at >= list.length - 1

  // Row 1, the document: what this is on the left, where it sits in the history on the right.
  const titleRow = (
    <Box justifyContent="space-between" alignItems="center" gap={2}>
      <Box gap={2} alignItems="center" flexShrink={1}>
        <Text bold wrap="truncate-end">
          {title}
        </Text>
        {!untitled && <Text dimColor>{label}</Text>}
      </Box>
      {list.length > 1 && (
        <Box gap={1} alignItems="center" flexShrink={0}>
          <Button key="prev" plain hotkey="p" dimColor={first} label="◀" onPress={() => goTo($, at - 1)} />
          <Text dimColor>{`${at + 1}/${list.length}`}</Text>
          <Button key="next" plain hotkey="n" dimColor={last} label="▶" onPress={() => goTo($, at + 1)} />
        </Box>
      )}
    </Box>
  )

  // Row 2, the view: zoom and pan on the left, the document's toggles on the
  // right. Remote surfaces send no raw keys to a plugin, so every control is a
  // Button with a one-letter hotkey, live once the pane holds the keyboard
  // (after a click in it). Inert controls are dimmed, never removed, so the
  // row never reflows; groups are Boxes, since a fragment's children stack on
  // the desktop. Zooming out all the way is fit: there is no reset to learn.
  const atMax = v.zoom >= (ZOOMS[ZOOMS.length - 1] ?? 6)
  const toolbar = (Svg || Image) && (
    <Box justifyContent="space-between" alignItems="center" gap={2} flexWrap="wrap">
      <Box gap={2} alignItems="center">
        <Box gap={1} alignItems="center">
          <Button
            key="zoom-in"
            plain
            hotkey="i"
            dimColor={!canZoom || atMax}
            label="Zoom in"
            onPress={set(x => zoomTo(x, zoomStep(x.zoom, 1)))}
          />
          <Text dimColor>{`${Math.round(v.zoom * 100)}%`}</Text>
          <Button
            key="zoom-out"
            plain
            hotkey="o"
            dimColor={!canZoom || atFit}
            label="Zoom out"
            onPress={set(x => zoomTo(x, zoomStep(x.zoom, -1)))}
          />
        </Box>
        <Text dimColor>│</Text>
        <Box gap={1} alignItems="center">
          <Button key="pan-left" plain dimColor={!canZoom || !canPan} hotkey="a" label="←" onPress={set(x => panBy(x, -0.2, 0))} />
          <Button key="pan-up" plain dimColor={!canZoom || !canPan} hotkey="w" label="↑" onPress={set(x => panBy(x, 0, -0.2))} />
          <Button key="pan-down" plain dimColor={!canZoom || !canPan} hotkey="s" label="↓" onPress={set(x => panBy(x, 0, 0.2))} />
          <Button key="pan-right" plain dimColor={!canZoom || !canPan} hotkey="d" label="→" onPress={set(x => panBy(x, 0.2, 0))} />
        </Box>
      </Box>
      <Box gap={2} alignItems="center" flexShrink={0}>
        <Button
          key="mode"
          plain
          hotkey="c"
          label={isRender ? 'Code' : 'Diagram'}
          onPress={set(x => ({ ...x, mode: x.mode === 'render' ? 'code' : 'render' }))}
        />
        {isRender && <Button key="refresh" plain hotkey="r" label="Refresh" onPress={() => refresh($, current.source)} />}
      </Box>
    </Box>
  )

  // The desktop frames the header as a card; the terminal, where rows are
  // scarce, rules it off with one dim line. No colours: both themes work.
  const header =
    e.surface === 'terminal' ? (
      <Box flexDirection="column">
        {titleRow}
        {toolbar}
        <Text dimColor wrap="truncate">
          {'─'.repeat(cols)}
        </Text>
      </Box>
    ) : (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {titleRow}
        {toolbar}
      </Box>
    )

  const code = <Code source={codeText(current.source)} path="diagram.mmd" startLine={1} />
  let body
  if (!isRender) {
    body = code
  } else if (!out?.ok) {
    body = out?.isTransient ? (
      <Box flexDirection="column">
        <Text bold color="yellow">
          The diagram renderer stopped
        </Text>
        <Text dimColor>{`Press r to refresh; it starts again. (${out.error.split('\n')[0]?.slice(0, 200)})`}</Text>
      </Box>
    ) : out?.isSetup ? (
      <Box flexDirection="column">
        <Text bold>The diagram renderer is not set up</Text>
        <Text dimColor>{`Run /whiteboard setup to install it. ${SETUP_NOTE.replace('/whiteboard setup downloads', 'It downloads')}`}</Text>
      </Box>
    ) : (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color="red">
            Mermaid could not render this diagram
          </Text>
          <Text dimColor>Mermaid's message, then the source it was given:</Text>
        </Box>
        <Code source={codeText(mermaidError(out?.error ?? '')) || 'No message.'} />
        {code}
      </Box>
    )
  } else if (Image && out.value.png && box) {
    body = (
      <Image
        source={{ png: out.value.png }}
        columns={box.columns}
        rows={box.rows}
        alt={`${title} (${label}): this terminal cannot show images. Press c for the Mermaid source, or open this session in Claude desktop.`}
      />
    )
  } else if (!Svg) {
    body = (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          The terminal cannot draw this diagram: open this session in Claude desktop or VS Code to see it rendered.
          This is its Mermaid source.
        </Text>
        {code}
      </Box>
    )
  } else {
    const size = sized ?? docBox(out.value, v.zoom, paneWidth)
    // Drawn with no width, the Svg takes the markup's width up to the pane's,
    // its height following the markup's shape.
    const svg = frame(out.value.svg, out.value, v, out.value.background, size)
    body =
      svg.length > SVG_CAP ? (
        <Box flexDirection="column">
          <Text bold color="yellow">
            This diagram is too large to show here
          </Text>
          <Text dimColor>
            {`${Math.round(svg.length / 1024)} KB of SVG; the pane takes up to ${Math.round(SVG_CAP / 1024)} KB. Split or simplify it, or press C for its source.`}
          </Text>
        </Box>
      ) : (
        // Centred in whatever room the pane gives the body, across and down.
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Svg source={svg} alt={untitled ? label : `${title} (${label})`} />
        </Box>
      )
  }

  // On the desktop the pane's whole height, so the body can centre the diagram in it.
  return (
    <Box flexDirection="column" gap={1} {...(Svg && { height: '100%' })}>
      {header}
      {body}
    </Box>
  )
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'whiteboard',
      description: 'Mermaid diagrams beside the conversation: /whiteboard [file.mmd|file.md|sample|setup|theme <name>|uninstall]',
    })
    await $.tool.register({
      name: TOOL,
      description:
        'Render a Mermaid diagram on the Whiteboard pane beside the conversation, exactly as Mermaid ' +
        `${MERMAID_VERSION} draws it. Any diagram type works: flowchart, sequenceDiagram, ` +
        'classDiagram, stateDiagram-v2, erDiagram, C4Context/C4Container, architecture-beta, ' +
        'block-beta, mindmap, timeline, gantt, journey, gitGraph, quadrantChart, xychart-beta, ' +
        'sankey-beta, pie, kanban, packet-beta, requirementDiagram. Use it whenever a picture ' +
        'explains code or a system better than prose: architecture, data flow, call sequences, ' +
        'state machines, schemas. Styling (classDef, style, themes, frontmatter config) is honoured. ' +
        'The pane keeps a history, so each call adds a diagram rather than replacing the last. ' +
        'Before drawing, read the whiteboard:drawing skill: it covers legible layouts, the syntax ' +
        'traps that fail or render badly (HTML in labels, ";" in sequence notes), and a C4 style ' +
        'that lays out cleanly. ' +
        'If Mermaid rejects the source, the call fails with its error: fix the source and call again. ' +
        'A diagram over ~128 KB of SVG is refused the same way: redraw it as an overview.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short title shown above the diagram' },
          mermaid: { type: 'string', description: 'The Mermaid source, starting with the diagram type' },
          theme: {
            type: 'string',
            enum: THEMES,
            description: "Mermaid theme; omit for the user's choice (auto: light, or the terminal's theme in a terminal)",
          },
        },
        required: ['mermaid'],
      },
    })
    return next(e)
  })

  on('command.run', { command: 'whiteboard' }, async ($, e) => {
    const arg = e.args.trim()
    if (!arg) {
      const current = await read($, doc)
      if (!current) await show($, SAMPLE)
      else await $.ui.open({ id: PANE, title: 'Whiteboard', rows: INLINE_ROWS })
      return { text: `Whiteboard opened (${current ? current.title : 'sample'}).` }
    }
    if (arg === 'setup' || arg === 'setup --download-browser') {
      const text = await setup($, arg.endsWith('--download-browser'))
      renders.clear()
      socket = null
      if (text.startsWith('Diagram renderer ready') && (await read($, doc))) await $.ui.open({ id: PANE, title: 'Whiteboard', rows: INLINE_ROWS })
      return { text }
    }
    if (arg === 'uninstall') return { text: await uninstall($) }
    if (arg === 'theme' || arg.startsWith('theme ')) {
      const name = arg.slice('theme'.length).trim()
      if (!THEMES.includes(name)) {
        const now = ((await $.store.get(THEME_KEY)) as string | undefined) ?? 'auto'
        return { text: `Theme is ${now}. Choose one of: ${THEMES.join(', ')}.` }
      }
      await $.store.set(THEME_KEY, name)
      await update($, viewState, x => ({ ...x }))
      return { text: `Diagram theme set to ${name}.` }
    }
    if (arg === 'sample') {
      await show($, SAMPLE)
      return { text: 'Sample diagram opened in the pane.' }
    }
    let text: string
    try {
      text = await $.fs.read(arg)
    } catch (err) {
      return { text: `Couldn't read ${arg}: ${err instanceof Error ? err.message : String(err)}` }
    }
    const next = { title: arg.split('/').at(-1) ?? arg, source: mermaidOf(text) }
    await show($, next)
    return {
      text: `Diagram from ${arg} opened in the pane (${typeOf(next.source) || 'unknown type'}).`,
      context: [`The diagram the user is looking at (Mermaid):\n${next.source}`],
    }
  })

  on('tool.call', { tool: 'mcp__whiteboard__show_diagram' }, async ($, e) => {
    const source = typeof e.mermaid === 'string' ? e.mermaid.trim() : ''
    if (!source) return { deny: 'Nothing drawn: `mermaid` was empty.' }
    const theme = typeof e.theme === 'string' && THEMES.includes(e.theme) ? e.theme : undefined
    const kind = typeOf(source)
    const title = typeof e.title === 'string' && e.title.trim() ? e.title.trim() : kind || 'Diagram'
    const next: DiagramDoc = { title, source, ...(theme && { theme }) }

    const out = await renderCached($, source, await themeFor($, next))
    if (!out.ok && out.isSetup) {
      await show($, next)
      return {
        deny: `${out.error} Ask the user to run it (you cannot run it yourself); the diagram is queued in the pane. Tell them what it does: ${SETUP_NOTE}`,
      }
    }
    if (!out.ok) {
      if (out.isTransient) return { deny: `The diagram renderer failed (${out.error.split('\n')[0]}). Call ${TOOL} again; it restarts the renderer.` }
      return { deny: `Mermaid could not render this diagram:\n${mermaidError(out.error)}\nFix the source and call ${TOOL} again.` }
    }
    // Too large for the pane: back to Claude like a syntax error, and kept out
    // of the history, where it would be a diagram nobody can see.
    if (out.value.svg.length > SVG_CAP) {
      return {
        deny: `This diagram renders to ${Math.round(out.value.svg.length / 1024)} KB of SVG; the pane shows up to ${Math.round(SVG_CAP / 1024)} KB, so it was not shown. Redraw it as an overview of about 8 to 12 nodes, then offer to draw the parts that matter as separate, closer diagrams.`,
      }
    }
    await show($, next)
    return {
      result: `Rendered the ${out.value.type || kind} diagram "${title}" on the Whiteboard (${out.value.width}×${out.value.height} px, Mermaid ${MERMAID_VERSION}).`,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e))
}
