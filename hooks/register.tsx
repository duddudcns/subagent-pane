import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow } from '../types'
import { resolveColor } from './colors'
import { startTrace, trace } from './trace'
import { stopOutcome, padTo, reconcileShells, addAgent, addShell, backgroundTaskIdOf, finishTask, parseNotification, displayWidth, endTool, finishTurn, fitHead, formatElapsed, formatTokens, isLive, setColor, shortType, splitSections, startTool, syncStatus, truncateTo } from './model'

const PANE = 'subagents'
const TITLE = 'Subagents'
const TICK_MS = 1000
const STOP_ARM_MS = 5000

const agents = atom({ plugin: 'subagent-pane', key: 'agents' } as const, [])
const tick = atom({ plugin: 'subagent-pane', key: 'tick' } as const, 0)
const showFinished = atom({ plugin: 'subagent-pane', key: 'showFinished' } as const, false)

// No status icon: the elapsed time's colour is the state (live yellow, done green,
// failed red, killed dim).
const STATUS_COLOR: Record<string, string> = { completed: 'green', failed: 'red' }

// Module variables reset on every reload; the rows live in $.state and survive.
let opened = false

// The commands toggle: the engine's pane record survives reloads, the module's does not.
async function togglePane($: EngineInterface) {
  const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (isUp) {
    await $.ui.close({ id: PANE })
    return { text: '서브에이전트 패널을 닫았습니다.' }
  }
  await $.ui.open({ id: PANE, title: TITLE })
  opened = true
  return { text: '서브에이전트 패널을 열었습니다.' }
}

export const register: Register = (on, options) => {
  // Both off by default: the detail line names the current tool and the model.
  const showTokens = options.showTokens === true
  const showToolCount = options.showToolCount === true
  // Stop takes two presses: the first arms it for STOP_ARM_MS, the second calls TaskStop.
  const armed = new Map<string, number>()

  on('session.start', async ($, e, next) => {
    await startTrace($)
    await $.command.register({ name: 'subagent-pane', description: '서브에이전트 실시간 패널 열기/닫기' })
    await $.command.register({ name: 'sap', description: '서브에이전트 패널 열기/닫기 (/subagent-pane 축약)' })
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

  on('command.run', { command: 'subagent-pane' }, togglePane)
  on('command.run', { command: 'sap' }, togglePane)

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
    // The colour lookup reads files: never hold the spawn for it.
    const id = result.agentId
    void resolveColor($, e.subagentType)
      .then(color => (color ? update($, agents, rows => setColor(rows, id, color)) : undefined))
      .catch(() => undefined)
    await trace($, 'spawn', { id: result.agentId, type: e.subagentType, background: e.background, parent: e.parentAgentId })
    if (!opened) {
      opened = true
      void $.ui.open({ id: PANE, title: TITLE })
    }
    return result
  }).catch(($, e, next) => next(e)) // a display bug must never block a spawn

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      await update($, agents, rows => startTool(rows, id, e.tool))
      await trace($, 'tool', { id, tool: e.tool })
    }
    try {
      const ran = await next(e)
      // A backgrounded shell keeps running after the call returns: give it a row of its own.
      if ((e.tool === 'Bash' || e.tool === 'PowerShell') && e.run_in_background) {
        const taskId = backgroundTaskIdOf(ran)
        if (taskId !== undefined) {
          const startedAt = await $.clock.now()
          const shell = e.tool === 'Bash' ? 'bash' : 'powershell'
          await update($, agents, rows =>
            addShell(rows, { id: taskId, shell, command: e.command, description: e.description, startedAt, parentId: id }),
          )
          await trace($, 'shell', { id: taskId, shell, parent: id })
        }
      }
      return ran
    } finally {
      if (id !== undefined) await update($, agents, rows => endTool(rows, id, e.tool))
    }
  }).catch(($, e, next) => next(e))

  // The engine appends a notification row when a background task ends: that is a shell's end.
  on('session.append', async ($, e, next) => {
    const ran = await next(e)
    if ('kind' in e.origin && e.origin.kind === 'task-notification') {
      const text = e.message.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
      const note = parseNotification(text)
      if (note !== undefined) {
        const now = await $.clock.now()
        await update($, agents, rows => finishTask(rows, note.id, note.status ?? 'completed', now))
        await trace($, 'notification', { id: note.id, status: note.status })
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // At each main turn's end the engine lists the background work still in flight.
  on('classic.Stop', async ($, e, next) => {
    const ran = await next(e)
    if (e.background_tasks !== undefined) {
      const live = new Set(e.background_tasks.map(task => task.id))
      const now = await $.clock.now()
      await update($, agents, rows => reconcileShells(rows, live, now))
    }
    return ran
  })

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
    const isExpanded = await read($, showFinished)
    await read($, tick)
    const now = await $.clock.now()
    const { live, finished } = splitSections(rows)
    const viewed = e.props?.view?.agentId
    // Rows fill the pane exactly: the time ends at the right edge.
    const cols = Math.max(12, e.props?.bodyColumns ?? 80)

    const header = (
      <Box flexDirection="row">
        <Text bold>{live.length > 0 ? `${live.length} running` : 'idle'}</Text>
        <Text> </Text>
        {viewed !== undefined && <Button plain dimColor onPress={() => void $.ui.view({})}>main</Button>}
        {viewed !== undefined && <Text> </Text>}
        <Button plain dimColor role="dismiss" onPress={() => void $.ui.close({ id: PANE })}>close</Button>
      </Box>
    )

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
      if ('deny' in ran && ran.deny) {
        $.ui.toast(`Stop failed: ${ran.deny}`)
        return
      }
      const outcome = stopOutcome('isError' in ran && ran.isError === true, ('text' in ran ? ran.text : '') ?? '')
      if ('error' in outcome) {
        $.ui.toast(`Stop failed: ${outcome.error}`)
        return
      }
      const at2 = await $.clock.now()
      await update($, agents, rows => finishTask(rows, row.id, outcome.settle, at2))
    }

    // Exactly two lines per agent: every text is cut to the pane width here, never wrapped.
    const agentRow = (row: AgentRow) => {
      const elapsed = formatElapsed((row.endedAt ?? now) - row.startedAt)
      const indent = row.parentId ? '  ' : ''
      const expiry = armed.get(row.id)
      const isArmed = expiry !== undefined && expiry >= now
      const canStop = isLive(row.status)
      // Armed, the description gives its place to the confirmation so the line keeps its width.
      const desc = canStop && isArmed ? 'press x again to stop' : row.description
      const head = fitHead({ indent, type: shortType(row.type), desc, elapsed }, cols)
      const tokens = showTokens && row.tokensIn + row.tokensOut > 0 ? `${formatTokens(row.tokensIn)}↑ ${formatTokens(row.tokensOut)}↓` : ''
      const toolCount = showToolCount ? `${row.toolCount} tools` : ''
      const detail = row.kind === 'shell'
        ? `$ ${(row.command ?? '').replace(/\s+/g, ' ')}`
        : [row.tool ? `▸ ${row.tool}` : '', shortModel(row.model), toolCount, tokens].filter(Boolean).join(' · ')
      return (
        <Box key={row.id} flexDirection="column">
          <Box flexDirection="row">
            {indent && <Text>{indent}</Text>}
            <Button key={`view-${row.id}`} plain onPress={() => void $.ui.view({ agentId: row.id })}>
              <Text bold={row.id === viewed} color={row.color}>{head.type}</Text>
            </Button>
            <Text color={canStop && isArmed ? 'red' : undefined} wrap="truncate">
              {head.desc ? ` ${head.desc}` : ''}
            </Text>
            <Text color={canStop ? 'yellow' : STATUS_COLOR[row.status]} dimColor={row.status === 'killed'}>{' '.repeat(head.gap)}{elapsed}</Text>
          </Box>
          {canStop ? (
            // The stop control sits at the end of line two: faint at rest, red while the pointer is on it.
            <Box flexDirection="row">
              <Text dimColor>{padTo(truncateTo(`${indent}  ${detail}`, cols - 2), cols - 2)} </Text>
              {/* Its own keyed Box: hover lights the x only while the pointer is on the x itself. */}
              <Box key={`stopbox-${row.id}`}>
                <Button key={`stop-${row.id}`} plain dimColor={!isArmed} onPress={() => void pressStop(row)}>
                  <Text color={isArmed ? 'red' : undefined} hover={{ color: 'red', dimColor: false }}>x</Text>
                </Button>
              </Box>
            </Box>
          ) : (
            <Text dimColor wrap="truncate">{truncateTo(`${indent}  ${detail}`, cols)}</Text>
          )}
        </Box>
      )
    }

    // A blank line, then the label running into a rule to the pane's edge, sets the finished group apart.
    const finishedLabel = `${isExpanded ? '▾' : '▸'} Finished · ${finished.length}`
    const ruleWidth = Math.max(0, cols - displayWidth(finishedLabel) - ' clear '.length)
    const finishedBar = finished.length > 0 && (
      <Box flexDirection="column">
        <Text> </Text>
        <Box flexDirection="row">
          <Button key="finished" plain dimColor onPress={() => void update($, showFinished, open => !open)}>
            {finishedLabel}
          </Button>
          <Text> </Text>
          <Button key="clear" plain dimColor onPress={() => void update($, agents, list => list.filter(row => isLive(row.status)))}>
            clear
          </Button>
          <Text dimColor> {'─'.repeat(ruleWidth)}</Text>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        {rows.length === 0 && <Text dimColor>No subagents yet.</Text>}
        {live.map(agentRow)}
        {finishedBar}
        {isExpanded && finished.map(agentRow)}
      </Box>
    )
  })
}

const shortModel = (model?: string): string => {
  if (!model) return ''
  const m = model.match(/(opus|sonnet|haiku|fable)/i)
  return m?.[1]?.toLowerCase() ?? model
}
