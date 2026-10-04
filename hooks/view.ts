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

export type Box = { x: number; y: number; w: number; h: number }

function viewBoxOf(rootTag: string, width: number, height: number): Box {
  const m = /viewBox="\s*([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([-\d.e]+)\s*"/.exec(rootTag)
  if (!m) return { x: 0, y: 0, w: width, h: height }
  return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }
}

const n = (v: number) => String(Math.round(v * 100) / 100)

/**
 * The part of the drawing a view shows, in the SVG's own coordinates.
 *
 * `span` is the window's size as a fraction of the drawing, across and down;
 * absent, 1 / zoom both ways. A window narrower than 1 / zoom (the terminal's
 * picture, grown to fill the pane) still pans from edge to edge.
 */
export function windowOf(
  svg: string,
  natural: { width: number; height: number },
  view: ViewState,
  span?: { w: number; h: number },
): Box {
  const root = /<svg\b[^>]*>/.exec(svg)
  const vb = root ? viewBoxOf(root[0], natural.width, natural.height) : { x: 0, y: 0, w: natural.width, h: natural.height }
  const sw = span?.w ?? 1 / view.zoom
  const sh = span?.h ?? 1 / view.zoom
  // Where the window sits along one side: centred when it covers the side,
  // else at the view's centre, stretched so pan's limits reach the edges.
  const place = (start: number, size: number, c: number, s: number) => {
    if (s >= 1) return start + size / 2 - (size * s) / 2
    const reach = view.zoom > 1 ? (1 - s) / (1 - 1 / view.zoom) : 1
    const at = 0.5 + (c - 0.5) * reach
    return Math.max(start, Math.min(start + size * (1 - s), start + at * size - (size * s) / 2))
  }
  return { x: place(vb.x, vb.w, view.cx, sw), y: place(vb.y, vb.h, view.cy, sh), w: vb.w * sw, h: vb.h * sh }
}

/**
 * Cells for the terminal's picture: at fit, the drawing's own shape, as wide as
 * the room allows; zoomed in, that box grown by the zoom until it fills the
 * room. `span` is the window it shows, for windowOf. Cells are about twice as
 * tall as wide.
 */
export function imageBox(natural: { width: number; height: number }, zoom: number, room: { columns: number; rows: number }) {
  const maxCols = Math.max(1, Math.min(255, Math.floor(room.columns)))
  const maxRows = Math.max(1, Math.min(255, Math.floor(room.rows)))
  const aspect = natural.height / natural.width
  let columns = maxCols
  let rows = Math.max(1, Math.round((columns * aspect) / 2))
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.min(maxCols, Math.round((rows * 2) / aspect)))
  }
  if (zoom <= 1) return { columns, rows, span: { w: 1 / zoom, h: 1 / zoom } }
  const grown = { columns: Math.min(maxCols, Math.round(columns * zoom)), rows: Math.min(maxRows, Math.round(rows * zoom)) }
  return { ...grown, span: { w: grown.columns / (columns * zoom), h: grown.rows / (rows * zoom) } }
}

/** A box on screen and the window of the drawing it shows (windowOf's span). */
export type Sized = { width: number; height: number; span: { w: number; h: number } }

/**
 * The desktop's box: the whole pane, always. At fit the drawing sits centred
 * in it at its own size or smaller; zoom scales it from there, and the window
 * (span) is whatever of the drawing the pane holds at that scale.
 */
export function paneBox(natural: { width: number; height: number }, zoom: number, room: { width: number; height: number }): Sized {
  const fit = Math.min(1, room.width / natural.width, room.height / natural.height)
  const scale = fit * zoom
  return { ...room, span: { w: room.width / (scale * natural.width), h: room.height / (scale * natural.height) } }
}

/**
 * The SVG to show for a view: its root's size fixed to the box it is drawn
 * in, its viewBox the window, and the theme's background painted behind.
 */
export function frame(
  svg: string,
  natural: { width: number; height: number },
  view: ViewState,
  background: string | undefined,
  box?: Sized,
): string {
  const root = /<svg\b[^>]*>/.exec(svg)
  if (!root) return svg
  const { x, y, w, h } = windowOf(svg, natural, view, box?.span)
  const size = box ?? natural

  let tag = root[0]
    .replace(/\s(width|height)="[^"]*"/g, '')
    .replace(/\sviewBox="[^"]*"/, '')
    .replace(/\sstyle="[^"]*"/, '')
    .replace(/<svg\b/, `<svg width="${n(size.width)}" height="${n(size.height)}" viewBox="${n(x)} ${n(y)} ${n(w)} ${n(h)}" preserveAspectRatio="xMidYMid meet"`)
  // Mermaid's SVG is transparent; the theme's background goes behind it,
  // wide enough to fill the window when zoomed out.
  const fill = background ? `<rect x="${n(x - w)}" y="${n(y - h)}" width="${n(w * 3)}" height="${n(h * 3)}" fill="${background}"/>` : ''
  tag += fill
  return svg.slice(0, root.index) + tag + svg.slice(root.index + root[0].length)
}
