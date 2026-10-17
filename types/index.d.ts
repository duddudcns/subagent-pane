export type AgentRow = {
  id: string
  type: string
  description: string
  status: string
  startedAt: number
  endedAt?: number
  model?: string
  parentId?: string
  tool?: string
  toolCount: number
  tokensIn: number
  tokensOut: number
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-pane': { agents: AgentRow[]; tick: number; showFinished: boolean }
  }
}
