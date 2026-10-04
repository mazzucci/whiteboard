/** One key entry: a label, and the classDef in the diagram whose colours it explains. */
export type LegendEntry = { label: string; class: string }
export type DiagramDoc = { title: string; source: string; theme?: string; legend?: LegendEntry[] }
export type DiagramView = { mode: 'render' | 'code'; zoom: number; cx: number; cy: number }

declare module 'claude-code' {
  interface PluginState {
    whiteboard: {
      doc: DiagramDoc | null
      history: DiagramDoc[]
      index: number
      view: DiagramView
    }
  }
}
