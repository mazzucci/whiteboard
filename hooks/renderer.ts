// The exact renderer's contract: real Mermaid in a headless Chrome
// (renderer/renderd.mjs), reached over a Unix socket. The calls that need the
// engine live in register.tsx, since $ never crosses an import.

export type Rendered = {
  svg: string
  /** The drawing's own size in CSS pixels. */
  width: number
  height: number
  /** The theme's background, painted behind the (transparent) SVG. */
  background?: string
  /** Mermaid's name for the diagram type (`flowchart-v2`, `sequence`, ...). */
  type: string
  ms: number
}
export type RenderOutcome = { ok: true; value: Rendered } | { ok: false; error: string; isSetup?: boolean }

export const MERMAID_VERSION = '12.1.0'
export const PUPPETEER_VERSION = '25.12.0'

// Labels as SVG text, not HTML in <foreignObject>: the pane shows the SVG as
// an image, where embedded HTML is the part least likely to survive.
export const SVG_LABELS = { htmlLabels: false, flowchart: { htmlLabels: false } }

/** The renderer's answer to POST /render, as an outcome. */
export function outcomeOf(status: number, text: string): RenderOutcome {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, error: `renderer answered ${status} with no JSON` }
  }
  if (status !== 200 || typeof data.svg !== 'string') {
    return { ok: false, error: String(data.error ?? `renderer answered ${status}`) }
  }
  return {
    ok: true,
    value: {
      svg: data.svg,
      width: Number(data.width) || 1,
      height: Number(data.height) || 1,
      background: typeof data.background === 'string' ? data.background : undefined,
      type: String(data.type ?? ''),
      ms: Number(data.ms) || 0,
    },
  }
}
