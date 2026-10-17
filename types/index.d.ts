export type AgentRow = {
  id: string
  type: string
  description: string
  status: string
  startedAt: number
  endedAt?: number
  model?: string
  effort?: string
  // A shell row's task: the first line of the prompt file a Codex run was given.
  note?: string
  parentId?: string
  color?: string
  // 'shell' for a background Bash/PowerShell task; absent for a subagent.
  kind?: 'shell'
  command?: string
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
