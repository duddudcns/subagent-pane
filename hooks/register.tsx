import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRow } from '../types'
import { startTrace, trace } from './trace'
import { addAgent, endTool, finishTurn, formatElapsed, formatTokens, isLive, startTool, syncStatus } from './model'

const PANE = 'subagents'
const TITLE = 'Subagents'
const TICK_MS = 1000
const STOP_ARM_MS = 5000

const agents = atom({ plugin: 'subagent-pane', key: 'agents' } as const, [])
const tick = atom({ plugin: 'subagent-pane', key: 'tick' } as const, 0)

const ICON: Record<string, [string, string | undefined]> = {
  pending: ['◌', 'yellow'],
  running: ['●', 'yellow'],
  waiting: ['◌', 'yellow'],
  idle: ['◌', undefined],
  completed: ['✓', 'green'],
  failed: ['✗', 'red'],
  killed: ['■', undefined],
}

export const register: Register = on => {
  // Module variables reset on every reload; the rows live in $.state and survive.
  let opened = false
  // Stop takes two presses: the first arms it for STOP_ARM_MS.
  const armed = new Map<string, number>()

  on('session.start', async ($, e, next) => {
    await startTrace($)
    await $.command.register({ name: 'subagent-pane', description: '서브에이전트 실시간 패널 열기' })
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(row => isLive(row.status))) return
        const now = await $.clock.now()
        const engine = await $.agent.list()
        await update($, agents, rows => syncStatus(rows, engine, now))
        await trace($, 'list', { engine: engine.map(a => ({ id: a.id, status: a.status, type: a.type })) })
        await update($, tick, () => now)
      })().catch(() => undefined)
    })
    return next(e)
  })

  on('command.run', { command: 'subagent-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    opened = true
    return { text: '서브에이전트 패널을 열었습니다.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId === undefined) return result
    const startedAt = await $.clock.now()
    await update($, agents, rows =>
      addAgent(rows, {
        id: result.agentId!,
        type: e.subagentType,
        description: e.description,
        startedAt,
        model: result.model,
        parentId: e.parentAgentId,
      }),
    )
    await update($, tick, () => startedAt)
    await trace($, 'spawn', { id: result.agentId, type: e.subagentType, background: e.background, parent: e.parentAgentId })
    if (!opened) {
      opened = true
      void $.ui.open({ id: PANE, title: TITLE })
    }
    return result
  }).catch(($, e, next) => next(e)) // a display bug must never block a spawn

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined) return next(e)
    await update($, agents, rows => startTool(rows, id, e.tool))
    await trace($, 'tool', { id, tool: e.tool })
    try {
      return await next(e)
    } finally {
      await update($, agents, rows => endTool(rows, id, e.tool))
    }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const now = await $.clock.now()
      await update($, agents, rows => finishTurn(rows, id, e.reason, now, e.usage))
      await trace($, 'complete', { id, reason: e.reason, usage: e.usage })
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, agents)
    await read($, tick)
    const now = await $.clock.now()
    const live = rows.filter(row => isLive(row.status)).length
    const viewed = e.props?.view?.agentId

    const header = (
      <Box flexDirection="row">
        <Text bold>{live > 0 ? `${live} running` : 'idle'}</Text>
        <Text dimColor> · {rows.length} total  </Text>
        {viewed !== undefined && <Button plain dimColor onPress={() => void $.ui.view({})}>main</Button>}
        {rows.length > live && (
          <Button plain dimColor onPress={() => void update($, agents, list => list.filter(row => isLive(row.status)))}>
            clear
          </Button>
        )}
      </Box>
    )

    if (rows.length === 0) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>No subagents yet.</Text>
        </Box>
      )
    }

    const pressStop = async (row: AgentRow) => {
      const at = await $.clock.now()
      const expiry = armed.get(row.id)
      if (expiry === undefined || expiry < at) {
        armed.set(row.id, at + STOP_ARM_MS)
        await update($, tick, () => at)
        return
      }
      armed.delete(row.id)
      const ran = await $.tool.call({
        tool: 'TaskStop',
        task_id: row.id,
        consent: `The user pressed "stop" twice on subagent ${row.type} (${row.description}) in the subagent pane.`,
      })
      await trace($, 'stop', { id: row.id, ran: JSON.parse(JSON.stringify(ran)) })
      if ('deny' in ran && ran.deny) $.ui.toast(`Stop failed: ${ran.deny}`)
      else if ('isError' in ran && ran.isError) $.ui.toast(`Stop failed: ${ran.text}`)
    }

    const agentRow = (row: AgentRow) => {
      const [icon, color] = ICON[row.status] ?? ['?', undefined]
      const elapsed = formatElapsed((row.endedAt ?? now) - row.startedAt)
      const indent = row.parentId ? '  ' : ''
      const tokens = row.tokensIn + row.tokensOut > 0 ? `${formatTokens(row.tokensIn)}↑ ${formatTokens(row.tokensOut)}↓` : ''
      const detail = [shortModel(row.model), `${row.toolCount} tools`, tokens].filter(Boolean).join(' · ')
      const expiry = armed.get(row.id)
      const isArmed = expiry !== undefined && expiry >= now
      return (
        <Box key={row.id} flexDirection="column">
          <Box flexDirection="row">
            <Text>{indent}</Text>
            <Text color={color}>{icon} </Text>
            <Button key={`view-${row.id}`} plain onPress={() => void $.ui.view({ agentId: row.id })}>
              <Text bold={row.id === viewed}>{row.type}</Text>
            </Button>
            <Text dimColor wrap="truncate"> {row.description}</Text>
            <Text dimColor> {elapsed} </Text>
            {isLive(row.status) && (
              <Button key={`stop-${row.id}`} plain dimColor={!isArmed} onPress={() => void pressStop(row)}>
                <Text color={isArmed ? 'red' : undefined}>{isArmed ? '■ confirm' : '■'}</Text>
              </Button>
            )}
          </Box>
          <Text dimColor wrap="truncate">
            {indent}  {row.tool ? `▸ ${row.tool}  ` : ''}{detail}
          </Text>
        </Box>
      )
    }

    // Two lines per agent; newest at the bottom, cut to what fits.
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 2) / 2))
    return (
      <Box flexDirection="column">
        {header}
        {rows.slice(-room).map(agentRow)}
      </Box>
    )
  })
}

const shortModel = (model?: string): string => {
  if (!model) return ''
  const m = model.match(/(opus|sonnet|haiku|fable)/i)
  return m?.[1]?.toLowerCase() ?? model
}
