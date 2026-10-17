import type { AgentRow } from '../types'

// Rows kept in the pane; older finished agents fall off first.
export const MAX_ROWS = 50

type Spawned = Pick<AgentRow, 'id' | 'type' | 'description' | 'startedAt'> & Partial<Pick<AgentRow, 'model' | 'parentId'>>

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])

export const isLive = (status: string): boolean => LIVE.has(status)

const patch = (list: AgentRow[], id: string, fn: (row: AgentRow) => AgentRow): AgentRow[] => {
  const at = list.findIndex(row => row.id === id)
  const current = list[at]
  if (current === undefined) return list
  const next = list.slice()
  next[at] = fn(current)
  return next
}

const trim = (list: AgentRow[]): AgentRow[] => {
  if (list.length <= MAX_ROWS) return list
  const drop = list.findIndex(row => !isLive(row.status))
  return trim(list.filter((_, i) => i !== (drop < 0 ? 0 : drop)))
}

export const addAgent = (list: AgentRow[], spawned: Spawned): AgentRow[] => {
  // A resumed agent keeps its id: wake the existing row instead of adding one.
  if (list.some(row => row.id === spawned.id)) {
    return patch(list, spawned.id, row => ({ ...row, status: 'running', endedAt: undefined }))
  }
  const row: AgentRow = { ...spawned, status: 'running', toolCount: 0, tokensIn: 0, tokensOut: 0 }
  return trim([...list, row])
}

export const startTool = (list: AgentRow[], id: string, tool: string): AgentRow[] =>
  patch(list, id, row => ({ ...row, tool, toolCount: row.toolCount + 1 }))

// Parallel calls finish out of order: only clear the tool if it is still the shown one.
export const endTool = (list: AgentRow[], id: string, tool: string): AgentRow[] =>
  patch(list, id, row => (row.tool === tool ? { ...row, tool: undefined } : row))

const REASON_STATUS: Record<string, string> = { answer: 'completed', aborted: 'killed', error: 'failed', refusal: 'failed' }

export const finishTurn = (list: AgentRow[], id: string, reason: string, now: number, usage?: Usage): AgentRow[] =>
  patch(list, id, row => ({
    ...row,
    status: REASON_STATUS[reason] ?? 'completed',
    endedAt: now,
    tool: undefined,
    model: usage?.model ?? row.model,
    tokensIn: row.tokensIn + (usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : 0),
    tokensOut: row.tokensOut + (usage?.output_tokens ?? 0),
  }))

// The engine's list is the truth for status (teammates go idle, stops show as killed).
export const syncStatus = (list: AgentRow[], engine: { id: string; status: string }[], now: number): AgentRow[] => {
  let next = list
  for (const info of engine) {
    next = patch(next, info.id, row => {
      if (row.status === info.status) return row
      const ended = !isLive(info.status)
      return { ...row, status: info.status, endedAt: ended ? (row.endedAt ?? now) : undefined }
    })
  }
  return next
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export const formatElapsed = (ms: number): string => {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${pad2(s % 60)}s`
  return `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m`
}

export const formatTokens = (n: number): string => {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
