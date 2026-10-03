export type DiagramDoc = { title: string; source: string; theme?: string }
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
