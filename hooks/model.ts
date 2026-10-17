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

type ShellStart = { id: string; shell: 'bash' | 'powershell'; command: string; description?: string; startedAt: number; parentId?: string }

export const addShell = (list: AgentRow[], shell: ShellStart): AgentRow[] => {
  if (list.some(row => row.id === shell.id)) return list
  const row: AgentRow = {
    id: shell.id,
    kind: 'shell',
    type: shell.shell,
    description: shell.description || shell.command,
    command: shell.command,
    status: 'running',
    startedAt: shell.startedAt,
    parentId: shell.parentId,
    toolCount: 0,
    tokensIn: 0,
    tokensOut: 0,
  }
  return trim([...list, row])
}

const ENDED = new Set(['completed', 'failed', 'killed'])

// A task notification ends the row once; a repeat keeps the first end time.
export const finishTask = (list: AgentRow[], id: string, status: string, now: number): AgentRow[] =>
  patch(list, id, row => ({
    ...row,
    status: ENDED.has(status) ? status : 'completed',
    endedAt: row.endedAt ?? now,
    tool: undefined,
  }))

// A backgrounded Bash/PowerShell call answers with the task id it runs under.
export const backgroundTaskIdOf = (ran: unknown): string | undefined => {
  const result = (ran as { result?: { backgroundTaskId?: unknown } } | undefined)?.result
  return typeof result?.backgroundTaskId === 'string' ? result.backgroundTaskId : undefined
}

// A shell's end notification can go missing; the engine's list of in-flight background
// work (at each main turn's end) is the backstop: a live shell row not in it has ended.
export const reconcileShells = (list: AgentRow[], liveIds: Set<string>, now: number): AgentRow[] =>
  list.map(row =>
    row.kind === 'shell' && isLive(row.status) && !liveIds.has(row.id)
      ? { ...row, status: 'completed', endedAt: row.endedAt ?? now }
      : row,
  )

// What a TaskStop answer means for the row. A stop that worked, or one refused because the
// task already ended, settles the row at once: a shell's end notification may never come.
export const stopOutcome = (isError: boolean, text: string): { settle: string } | { error: string } => {
  if (!isError) return { settle: 'killed' }
  const ended = text.match(/is not running \(status: (\w+)\)/)?.[1]
  if (ended) return { settle: ENDED.has(ended) ? ended : 'completed' }
  if (/No task found/.test(text)) return { settle: 'completed' }
  return { error: text.replace(/<\/?tool_use_error>/g, '').trim() }
}

export const parseNotification = (text: string): { id: string; status?: string } | undefined => {
  const id = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim()
  if (!id) return undefined
  return { id, status: text.match(/<status>([^<]+)<\/status>/)?.[1]?.trim() }
}

export const setColor = (list: AgentRow[], id: string, color: string): AgentRow[] =>
  patch(list, id, row => ({ ...row, color }))

export const setEffort = (list: AgentRow[], id: string, effort: string): AgentRow[] =>
  patch(list, id, row => ({ ...row, effort }))

// A shell row that runs Codex learns its model, effort and task once they are read back.
export const setShellInfo = (list: AgentRow[], id: string, info: { model?: string; effort?: string; note?: string }): AgentRow[] =>
  patch(list, id, row => ({ ...row, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined && v !== '')) }))

// "haiku/medium": the model with its effort when the definition names one.
export const modelLabel = (model: string | undefined, effort: string | undefined): string =>
  [model, effort].filter(Boolean).join('/')

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

// `subagents:runner` shows as `runner`: the plugin prefix only costs width.
export const shortType = (type: string): string => type.slice(type.lastIndexOf(':') + 1)

// Live rows as a tree: each row directly followed by the rows it spawned, in start order.
// A row whose parent is not in the list (main's, or a parent already gone) starts at depth 0.
// A child's first line hangs off its parent with └; its second line keeps the same width in spaces.
export const treePrefix = (depth: number): { head: string; tail: string } =>
  depth <= 0 ? { head: '', tail: '' } : { head: `${'  '.repeat(depth - 1)}└ `, tail: '  '.repeat(depth) }

export const treeOrder = (list: AgentRow[]): { row: AgentRow; depth: number }[] => {
  const ids = new Set(list.map(row => row.id))
  const out: { row: AgentRow; depth: number }[] = []
  const visit = (row: AgentRow, depth: number) => {
    out.push({ row, depth })
    for (const child of list.filter(c => c.parentId === row.id)) visit(child, depth + 1)
  }
  for (const row of list.filter(r => r.parentId === undefined || !ids.has(r.parentId))) visit(row, 0)
  return out
}

export const splitSections =(list: AgentRow[]): { live: AgentRow[]; finished: AgentRow[] } => ({
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

// Pads with spaces to a display width (Hangul counts two).
export const padTo = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - displayWidth(text)))

type Head = { indent: string; type: string; desc: string; elapsed: string }

// At least this many blank cells between the description's end and the elapsed time,
// so a cut description never reads as running into the time.
export const MIN_GAP = 3

// The first row line is: indent, type, [space + desc], gap (>= MIN_GAP), elapsed at the right edge.
// It fills exactly `cols` so an agent stays two lines: the description gives way first, then the type.
export const fitHead = (head: Head, cols: number): { type: string; desc: string; gap: number } => {
  const fixed = displayWidth(head.indent) + displayWidth(head.type) + MIN_GAP + displayWidth(head.elapsed)
  if (fixed > cols) {
    return { type: truncateTo(head.type, displayWidth(head.type) - (fixed - cols)), desc: '', gap: MIN_GAP }
  }
  const room = cols - fixed - 1
  const desc = room >= 2 ? truncateTo(head.desc, room) : ''
  const used = fixed - MIN_GAP + (desc ? 1 + displayWidth(desc) : 0)
  return { type: head.type, desc, gap: cols - used }
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
