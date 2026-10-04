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
/**
 * A failure is Mermaid rejecting the source (kept: the same source fails the
 * same way), the renderer not set up, or `isTransient`: the renderer itself
 * failed (stopped, crashed, cut off), so drawing again starts a fresh one.
 */
export type RenderOutcome =
  | { ok: true; value: Rendered }
  | { ok: false; error: string; isSetup?: boolean; isTransient?: boolean }

export const MERMAID_VERSION = '12.1.0'
export const PUPPETEER_VERSION = '25.12.0'

// Labels as SVG text, not HTML in <foreignObject>: the pane shows the SVG as
// an image, where embedded HTML is the part least likely to survive. Mermaid
// wraps a label at 200 px and breaks a long word mid-way to fit
// ("payments.charg|e"); 400 keeps identifiers and file paths whole, and an
// explicit <br/> still breaks a line. A diagram's own config wins.
export const SVG_LABELS = { htmlLabels: false, flowchart: { htmlLabels: false, wrappingWidth: 400 } }

/** The renderer's answer to POST /render, as an outcome. */
export function outcomeOf(status: number, text: string): RenderOutcome {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, error: `renderer answered ${status} with no JSON`, isTransient: true }
  }
  if (status !== 200 || typeof data.svg !== 'string') {
    // 400 is Mermaid's verdict on the source; anything else is the renderer's own trouble.
    return { ok: false, error: String(data.error ?? `renderer answered ${status}`), ...(status !== 400 && { isTransient: true }) }
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
