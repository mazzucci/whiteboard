// Fitting, zooming and panning a rendered SVG by rewriting its root tag:
// the drawing is never re-rendered, only the window onto it moves.

/** The Svg element's cap on its source. */
export const SVG_CAP = 131072

export const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6]

/** Where the view looks: zoom 1 shows the whole drawing; cx, cy is the
 *  centre of the window as a fraction of the drawing (0.5, 0.5 is the middle). */
export type ViewState = { zoom: number; cx: number; cy: number }
export const FIT: ViewState = { zoom: 1, cx: 0.5, cy: 0.5 }

export function zoomStep(zoom: number, dir: 1 | -1): number {
  const i = ZOOMS.findIndex(z => z >= zoom - 1e-9)
  const at = i < 0 ? ZOOMS.length - 1 : i
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + dir))] ?? 1
}

/** Pans by a fraction of the visible window; clamped so the window stays on the drawing. */
export function panBy<T extends ViewState>(view: T, dx: number, dy: number): T {
  const half = 0.5 / view.zoom
  const clamp = (c: number) => (view.zoom <= 1 ? 0.5 : Math.max(half, Math.min(1 - half, c)))
  return { ...view, cx: clamp(view.cx + dx / view.zoom), cy: clamp(view.cy + dy / view.zoom) }
}

/** Zooms keeping the window's centre, then clamps. */
export function zoomTo<T extends ViewState>(view: T, zoom: number): T {
  return panBy({ ...view, zoom }, 0, 0)
}

type Box = { x: number; y: number; w: number; h: number }

function viewBoxOf(rootTag: string, width: number, height: number): Box {
  const m = /viewBox="\s*([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([-\d.e]+)\s*"/.exec(rootTag)
  if (!m) return { x: 0, y: 0, w: width, h: height }
  return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }
}

const n = (v: number) => String(Math.round(v * 100) / 100)

/**
 * The SVG to show for a view: its root's size fixed to the box it is drawn
 * in, its viewBox the window, and the theme's background painted behind.
 */
export function frame(
  svg: string,
  natural: { width: number; height: number },
  view: ViewState,
  background: string | undefined,
): string {
  const root = /<svg\b[^>]*>/.exec(svg)
  if (!root) return svg
  const vb = viewBoxOf(root[0], natural.width, natural.height)
  const w = vb.w / view.zoom
  const h = vb.h / view.zoom
  const x = vb.x + view.cx * vb.w - w / 2
  const y = vb.y + view.cy * vb.h - h / 2

  let tag = root[0]
    .replace(/\s(width|height)="[^"]*"/g, '')
    .replace(/\sviewBox="[^"]*"/, '')
    .replace(/\sstyle="[^"]*"/, '')
    .replace(/<svg\b/, `<svg width="${n(natural.width)}" height="${n(natural.height)}" viewBox="${n(x)} ${n(y)} ${n(w)} ${n(h)}" preserveAspectRatio="xMidYMid meet"`)
  // Mermaid's SVG is transparent; the theme's background goes behind it,
  // wide enough to fill the window when zoomed out.
  const fill = background ? `<rect x="${n(x - w)}" y="${n(y - h)}" width="${n(w * 3)}" height="${n(h * 3)}" fill="${background}"/>` : ''
  tag += fill
  return svg.slice(0, root.index) + tag + svg.slice(root.index + root[0].length)
}

/** The size to draw at: the drawing's own, shrunk to fit the room, never enlarged. */
export function fitSize(natural: { width: number; height: number }, room: { width: number; height: number }) {
  const s = Math.min(1, room.width / natural.width, room.height / natural.height)
  return { width: Math.max(40, Math.floor(natural.width * s)), height: Math.max(40, Math.floor(natural.height * s)) }
}
