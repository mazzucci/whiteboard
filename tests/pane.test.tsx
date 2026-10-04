import { expect, test } from 'claude-code/testing'

const SOURCE = `flowchart LR
  app([Mobile app]) -->|POST /orders| api[Orders API]
  api --> svc[OrderService]
  svc --> db[(Orders DB)]`

const SVG = '<svg id="d1" width="100%" style="max-width: 400px;" viewBox="0 0 400 200" aria-roledescription="flowchart-v2"><g class="node"/></svg>'

const pane = (bodyColumns: number) => ({
  plugin: 'whiteboard',
  component: 'Pane' as const,
  requestId: 'whiteboard',
  props: { title: 'Whiteboard', isFocused: true, bodyColumns, placement: 'dock' as const },
  viewport: { columns: bodyColumns, rows: 40 },
})

type On = Parameters<Parameters<typeof test>[1]>[1]

/**
 * The host beneath the plugin: Node on PATH, an installed renderer that
 * answers every render with SVG unless `reply` says otherwise, a store in memory.
 */
function host(on: On, options: { isInstalled?: boolean; reply?: (source: string) => { status: number; body: object } } = {}) {
  const store = new Map<string, unknown>()
  const renders: { source: string; theme: string }[] = []
  const spawned: string[][] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('config.list', () => ({ value: [] }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/Users/someone' : e.name === 'PATH' ? '/usr/local/bin' : undefined }))
  on('fs.exists', (_$, e) => ({ value: e.path.endsWith('/node') || (options.isInstalled ?? true) }))
  on('process.spawn', async function* (_$, e) {
    spawned.push([...e.argv])
    // Ready, then gone: the next render starts it again, as after an idle exit.
    yield { stream: 'stdout' as const, text: '{"ready":true,"socket":"/Users/someone/.cache/whiteboard/run/ab.sock"}\n' }
    return { code: 0, signal: null }
  })
  on('http.fetch', (_$, e) => {
    expect(e.init?.socketPath).toBe('/Users/someone/.cache/whiteboard/run/ab.sock')
    const body = JSON.parse(String(e.init?.body)) as { source: string; theme: string }
    renders.push(body)
    const out = options.reply?.(body.source) ?? {
      status: 200,
      body: { svg: SVG, width: 400, height: 200, background: 'white', type: 'flowchart-v2', ms: 5 },
    }
    return { value: { status: out.status, ok: out.status === 200, headers: {}, text: JSON.stringify(out.body) } }
  })
  return { store, renders, spawned }
}

const svgOf = async (ui: { find: (q: { type: string }) => Promise<{ props: Record<string, unknown> } | undefined> }) =>
  String((await ui.find({ type: 'Svg' }))?.props.source ?? '')

test('Claude draws a diagram: the desktop pane shows the exact SVG', async ($, on) => {
  const { renders, spawned } = host(on)
  const shown = await $.tool.call({ tool: 'mcp__whiteboard__show_diagram', title: 'Checkout', mermaid: SOURCE })
  expect(JSON.stringify(shown)).toContain('Rendered the flowchart-v2 diagram \\"Checkout\\"')
  expect(renders[0]?.theme).toBe('default')
  // The renderer runs from the plugin, with its home in ~/.cache/<plugin>.
  expect(spawned[0]?.slice(-2)).toEqual(['--home', '/Users/someone/.cache/whiteboard'])

  const ui = await $.ui.mount({ ...pane(120), surface: 'desktop' })
  const svg = await svgOf(ui)
  // Sized to the drawing, its window the whole drawing, the theme's background behind.
  expect(svg).toContain('width="400" height="200" viewBox="0 0 400 200"')
  expect(svg).toContain('<rect x="-400" y="-200" width="1200" height="600" fill="white"/>')
  expect(svg).not.toContain('max-width')
})

test('zoom, pan and the code view by button and hotkey', async ($, on) => {
  host(on)
  await $.tool.call({ tool: 'mcp__whiteboard__show_diagram', mermaid: SOURCE })
  const ui = await $.ui.mount({ ...pane(120), surface: 'desktop' })
  expect((await ui.find({ key: 'pan-right' }))?.props.dimColor).toBe(true)

  await ui.press({ key: 'zoom-in' })
  expect(await svgOf(ui)).toContain('viewBox="40 20 320 160"')
  expect((await ui.find({ key: 'pan-right' }))?.props.dimColor).toBe(false)
  expect((await ui.find({ key: 'pan-right' }))?.props.hotkey).toBe('d')
  await ui.press({ key: 'pan-right' })
  expect(await svgOf(ui)).toContain('viewBox="80 20 320 160"')
  await ui.press({ key: 'fit' })
  expect(await svgOf(ui)).toContain('viewBox="0 0 400 200"')

  await ui.press({ key: 'mode' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe(SOURCE)
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
})

test("Mermaid's error goes back to Claude, and nothing is shown", async ($, on) => {
  host(on, { reply: () => ({ status: 400, body: { error: 'Parse error on line 2:\n...expecting NODE' } }) })
  const shown = await $.tool.call({ tool: 'mcp__whiteboard__show_diagram', mermaid: 'flowchart TD\n  A -->' })
  expect(JSON.stringify(shown)).toContain('Mermaid could not render this diagram')
  expect(JSON.stringify(shown)).toContain('Parse error on line 2')
})

test('a diagram too large for the pane goes back to Claude, and stays out of the history', async ($, on) => {
  const huge = `<svg viewBox="0 0 400 200">${'<g/>'.repeat(40000)}</svg>`
  host(on, {
    reply: source => ({
      status: 200,
      body: { svg: source === SOURCE ? SVG : huge, width: 400, height: 200, type: 'flowchart-v2', ms: 5 },
    }),
  })
  await $.tool.call({ tool: 'mcp__whiteboard__show_diagram', title: 'Small', mermaid: SOURCE })
  const shown = await $.tool.call({ tool: 'mcp__whiteboard__show_diagram', title: 'Huge', mermaid: 'flowchart TD\n  A --> B' })
  expect(JSON.stringify(shown)).toContain('Redraw it as an overview')
  const ui = await $.ui.mount({ ...pane(120), surface: 'desktop' })
  expect(JSON.stringify(await ui.drawn())).toContain('Small')
  expect(JSON.stringify(await ui.drawn())).not.toContain('Huge')
})

test("a file that Mermaid rejects: the pane shows Mermaid's message as code, then the source", async ($, on) => {
  host(on, { reply: () => ({ status: 400, body: { error: 'Parse error on line 2:\n...A -->\n-----^\nExpecting NODE_STRING' } }) })
  on('fs.read', () => ({ value: 'flowchart TD\n  A -->' }))
  await $.command.run({ command: 'whiteboard', args: 'bad.mmd' })
  const ui = await $.ui.mount({ ...pane(120), surface: 'desktop' })
  expect(JSON.stringify(await ui.drawn())).toContain('Mermaid could not render this diagram')
  const blocks = await ui.findAll({ type: 'Code' })
  expect(blocks.map(b => b.props.source)).toEqual(['Parse error on line 2:\n...A -->\n-----^\nExpecting NODE_STRING', 'flowchart TD\n  A -->'])
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ key: 'zoom-in' })).toBeUndefined()
})

test('without the renderer the pane says how to set it up', async ($, on) => {
  host(on, { isInstalled: false })
  const shown = await $.tool.call({ tool: 'mcp__whiteboard__show_diagram', mermaid: SOURCE })
  expect(JSON.stringify(shown)).toContain('/whiteboard setup')
  const ui = await $.ui.mount({ ...pane(120), surface: 'desktop' })
  expect(JSON.stringify(await ui.drawn())).toContain('Run /whiteboard setup')
})

test('each diagram joins the history; prev and next move through it', async ($, on) => {
  host(on)
  await $.tool.call({ tool: 'mcp__whiteboard__show_diagram', title: 'First', mermaid: SOURCE })
  await $.tool.call({ tool: 'mcp__whiteboard__show_diagram', title: 'Second', mermaid: 'sequenceDiagram\n  A->>B: hi' })
  const ui = await $.ui.mount({ ...pane(120), surface: 'desktop' })
  expect(JSON.stringify(await ui.drawn())).toContain('Second')
  expect(JSON.stringify(await ui.drawn())).toContain('2/2')
  await ui.press({ key: 'prev' })
  expect(JSON.stringify(await ui.drawn())).toContain('First')
  await ui.press({ key: 'next' })
  expect(JSON.stringify(await ui.drawn())).toContain('Second')
})

test('VS Code shows the SVG with the same buttons', async ($, on) => {
  host(on)
  await $.tool.call({ tool: 'mcp__whiteboard__show_diagram', mermaid: SOURCE })
  const ui = await $.ui.mount({ ...pane(120), surface: 'vscode' })
  expect(await svgOf(ui)).toContain('viewBox="0 0 400 200"')
  await ui.press({ key: 'zoom-in' })
  expect(await svgOf(ui)).toContain('viewBox="40 20 320 160"')
})

test('the terminal shows the diagram as a PNG image, zooms by rendering a window, and toggles to code', async ($, on) => {
  const { renders } = host(on, {
    reply: () => ({
      status: 200,
      body: { svg: SVG, png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=', width: 400, height: 200, type: 'flowchart-v2', ms: 5 },
    }),
  })
  await $.tool.call({ tool: 'mcp__whiteboard__show_diagram', mermaid: SOURCE })
  const ui = await $.ui.mount({ ...pane(100), surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.source).toEqual({ png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=' })
  // 400 × 200 px: as wide as the pane, half as many rows (cells are about twice as tall as wide).
  expect(image?.props.columns).toBe(100)
  expect(image?.props.rows).toBe(25)
  // Zoom renders just the window the desktop would show, as a new PNG.
  await ui.press({ key: 'zoom-in' })
  expect((renders.at(-1) as { view?: unknown }).view).toEqual({ x: 40, y: 20, w: 320, h: 160 })
  await ui.press({ key: 'pan-right' })
  expect((renders.at(-1) as { view?: { x: number } }).view?.x).toBe(80)
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.press({ key: 'mode' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe(SOURCE)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
})

test('the terminal shows the source and says where to see the diagram', async ($, on) => {
  host(on)
  await $.tool.call({ tool: 'mcp__whiteboard__show_diagram', mermaid: SOURCE })
  const ui = await $.ui.mount({ ...pane(100), surface: 'terminal' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe(SOURCE)
  expect(JSON.stringify(await ui.drawn())).toContain('open this session in Claude desktop')
  expect(await ui.find({ key: 'zoom-in' })).toBeUndefined()
})
