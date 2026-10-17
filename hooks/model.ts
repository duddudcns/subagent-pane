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

export const splitSections = (list: AgentRow[]): { live: AgentRow[]; finished: AgentRow[] } => ({
  live: list.filter(row => isLive(row.status)),
  finished: list.filter(row => !isLive(row.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
})

// Terminal cells: Hangul, CJK, fullwidth forms and emoji take two.
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1faff], [0x20000, 0x3fffd],
]

const charWidth = (ch: string): number => {
  const code = ch.codePointAt(0) ?? 0
  return WIDE.some(([lo, hi]) => code >= lo && code <= hi) ? 2 : 1
}

export const displayWidth = (text: string): number => [...text].reduce((sum, ch) => sum + charWidth(ch), 0)

export const truncateTo = (text: string, width: number): string => {
  if (displayWidth(text) <= width) return text
  if (width <= 0) return ''
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = charWidth(ch)
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

type Head = { indent: string; type: string; desc: string; elapsed: string; stop?: string }

// The first row line is: indent, icon + space, type, [space + desc], space + elapsed, [space + stop].
// It must fit `cols` so an agent stays two lines: the description gives way first, then the type.
export const fitHead = (head: Head, cols: number): { type: string; desc: string } => {
  const fixed = displayWidth(head.indent) + 2 + displayWidth(head.type) + 1 + displayWidth(head.elapsed) +
    (head.stop ? 1 + displayWidth(head.stop) : 0)
  if (fixed > cols) {
    return { type: truncateTo(head.type, displayWidth(head.type) - (fixed - cols)), desc: '' }
  }
  const room = cols - fixed - 1
  return { type: head.type, desc: room >= 2 ? truncateTo(head.desc, room) : '' }
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
