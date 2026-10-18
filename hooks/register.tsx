import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow } from '../types'
import { agentFileCandidates, parseColor, parseEffort, toDisplayColor } from './colors'
import type { Definition } from './colors'
import { codexCall, drivePath, firstLine, scriptPathOf } from './codex'
import { modelLabel, setEffort, setShellInfo, treePrefix, treeOrder, stopOutcome, padTo, reconcileShells, addAgent, addShell, backgroundTaskIdOf, finishTask, parseNotification, displayWidth, endTool, finishTurn, fitHead, formatElapsed, formatTokens, isLive, setColor, shortType, splitSections, startTool, syncStatus, truncateTo } from './model'

const PANE = 'subagents'
const TITLE = 'Subagents'
const TICK_MS = 1000
const STOP_ARM_MS = 5000
// The desktop's rule: longer than any pane, its box clips the rest.
const RULE_LENGTH = 400

const agents = atom({ plugin: 'subagent-pane', key: 'agents' } as const, [])
const tick = atom({ plugin: 'subagent-pane', key: 'tick' } as const, 0)
const showFinished = atom({ plugin: 'subagent-pane', key: 'showFinished' } as const, false)

// No status icon: the elapsed time's colour is the state (live yellow, done green,
// failed red, killed dim).
const STATUS_COLOR: Record<string, string> = { completed: 'green', failed: 'red' }

// Module variables reset on every reload; the rows live in $.state and survive.
let opened = false

// The engine follows $ only into functions of this same file, so every helper that takes $ lives here.

// Development trace: on only while `.debug` exists in the plugin folder.
// Each event is appended and the last 200 plus the current rows are written to `.debug-dump.json`.
let isTracing = false
const events: unknown[] = []

async function startTrace($: EngineInterface): Promise<void> {
  isTracing = await $.fs.read(`${$.plugin.root}/.debug`).then(() => true, () => false)
}

async function trace($: EngineInterface, kind: string, data: Record<string, unknown>): Promise<void> {
  if (!isTracing) return
  events.push({ at: await $.clock.now(), kind, ...data })
  const rows = await read($, agents)
  await $.fs.write(`${$.plugin.root}/.debug-dump.json`, JSON.stringify({ events: events.slice(-200), rows }, null, 1))
}

// One lookup per agent type per load; built-in types simply find no file.
const definitions = new Map<string, Definition>()

async function resolveDefinition($: EngineInterface, type: string): Promise<Definition> {
  const hit = definitions.get(type)
  if (hit !== undefined) return hit
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const configDir = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`).replace(/\\/g, '/')
  const installed = await $.fs.read(`${configDir}/plugins/installed_plugins.json`).catch(() => '{}')
  let found: Definition = {}
  for (const path of agentFileCandidates(type, configDir, '.', installed)) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (text === undefined) continue
    found = { color: toDisplayColor(parseColor(text)), effort: parseEffort(text) }
    break
  }
  definitions.set(type, found)
  return found
}

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
  // All off by default: the detail line names the model and its effort.
  const showTokens = options.showTokens === true
  const showToolCount = options.showToolCount === true
  const showTool = options.showTool === true
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
    void resolveDefinition($, e.subagentType)
      .then(async def => {
        if (def.color) await update($, agents, rows => setColor(rows, id, def.color!))
        if (def.effort) await update($, agents, rows => setEffort(rows, id, def.effort!))
      })
      .catch(() => undefined)
    await trace($, 'spawn', { id: result.agentId, type: e.subagentType, background: e.background, parent: e.parentAgentId })
    if (!opened) {
      opened = true
      void $.ui.open({ id: PANE, title: TITLE })
    }
    return result
  }).catch(($, e, next) => next(e)) // a display bug must never block a spawn

  // The effort a subagent really runs on is in its model requests: it fills in what the definition file left out.
  on('turn.step', async function* ($, e, next) {
    const effort = e.agentId === undefined || e.effort === undefined ? undefined : String(e.effort)
    if (e.agentId !== undefined && effort !== undefined) {
      const id = e.agentId
      const row = (await read($, agents)).find(r => r.id === id)
      if (row !== undefined && row.effort !== effort) await update($, agents, rows => setEffort(rows, id, effort))
    }
    return yield* next(e)
  })

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
          void describeCodex($, e.command)
            .then(info => (info ? update($, agents, rows => setShellInfo(rows, taskId, info)) : undefined))
            .catch(() => undefined)
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
    // Only the terminal draws one cell per column: padding with spaces lines things up there.
    // Elsewhere (the desktop's proportional text) flex does the aligning.
    const isCellGrid = e.surface === 'terminal'

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
      // Decide and record synchronously, with the time this drawing was made: an await before
      // arming let a fast second press also see "not armed" and only arm again.
      const expiry = armed.get(row.id)
      if (expiry === undefined || expiry < now) {
        armed.set(row.id, now + STOP_ARM_MS)
        await trace($, 'press', { id: row.id, step: 'arm' })
        await update($, tick, () => now + 1)
        return
      }
      armed.delete(row.id)
      await trace($, 'press', { id: row.id, step: 'stop' })
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
    const agentRow = (row: AgentRow, depth = 0) => {
      const elapsed = formatElapsed((row.endedAt ?? now) - row.startedAt)
      const { head: indent, tail: tailIndent } = treePrefix(depth)
      const expiry = armed.get(row.id)
      const isArmed = expiry !== undefined && expiry >= now
      const canStop = isLive(row.status)
      // Armed, the description gives its place to the confirmation so the line keeps its width.
      const desc = canStop && isArmed ? 'press x again to stop' : row.description
      const head = fitHead({ indent, type: shortType(row.type), desc, elapsed }, cols)
      const tokens = showTokens && row.tokensIn + row.tokensOut > 0 ? `${formatTokens(row.tokensIn)}↑ ${formatTokens(row.tokensOut)}↓` : ''
      const toolCount = showToolCount ? `${row.toolCount} tools` : ''
      const detail = row.kind === 'shell'
        ? row.model
          ? [modelLabel(row.model, row.effort), row.note].filter(Boolean).join(' · ')
          : `$ ${(row.command ?? '').replace(/\s+/g, ' ')}`
        : [showTool && row.tool ? `▸ ${row.tool}` : '', modelLabel(shortModel(row.model), row.effort), toolCount, tokens].filter(Boolean).join(' · ')
      const viewButton = (label: string) => (
        <Button key={`view-${row.id}`} plain onPress={() => void $.ui.view({ agentId: row.id })}>
          <Text bold={row.id === viewed} color={row.color}>{label}</Text>
        </Button>
      )
      const stopButton = (
        // Its own keyed Box: hover lights the x only while the pointer is on the x itself.
        <Box key={`stopbox-${row.id}`}>
          <Button key={`stop-${row.id}`} plain dimColor={!isArmed} onPress={() => void pressStop(row)}>
            <Text color={isArmed ? 'red' : undefined} hover={{ color: 'red', dimColor: false }}>x</Text>
          </Button>
        </Box>
      )
      if (!isCellGrid) {
        // The growing middle part pushes the time and the x to the right edge; it gives way when the row is narrow.
        return (
          <Box key={row.id} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              {depth > 0 && <Box paddingLeft={2 * (depth - 1)}><Text dimColor>└</Text></Box>}
              {viewButton(shortType(row.type))}
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                {desc ? <Text color={canStop && isArmed ? 'red' : undefined} wrap="truncate-end">{desc}</Text> : null}
              </Box>
              <Text color={canStop ? 'yellow' : STATUS_COLOR[row.status]} dimColor={row.status === 'killed'}>{elapsed}</Text>
            </Box>
            <Box flexDirection="row" gap={1} paddingLeft={2 * depth + 2}>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                {detail ? <Text dimColor wrap="truncate-end">{detail}</Text> : null}
              </Box>
              {canStop && stopButton}
            </Box>
          </Box>
        )
      }
      return (
        <Box key={row.id} flexDirection="column">
          <Box flexDirection="row">
            {indent && <Text dimColor>{indent}</Text>}
            {viewButton(head.type)}
            <Text color={canStop && isArmed ? 'red' : undefined} wrap="truncate">
              {head.desc ? ` ${head.desc}` : ''}
            </Text>
            <Text color={canStop ? 'yellow' : STATUS_COLOR[row.status]} dimColor={row.status === 'killed'}>{' '.repeat(head.gap)}{elapsed}</Text>
          </Box>
          {canStop ? (
            // The stop control sits at the end of line two: faint at rest, red while the pointer is on it.
            <Box flexDirection="row">
              <Text dimColor>{padTo(truncateTo(`${tailIndent}  ${detail}`, cols - 2), cols - 2)} </Text>
              {stopButton}
            </Box>
          ) : (
            <Text dimColor wrap="truncate">{truncateTo(`${tailIndent}  ${detail}`, cols)}</Text>
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
          {isCellGrid
            ? <Text dimColor> {'─'.repeat(ruleWidth)}</Text>
            : (
              // One row high and clipped: the overlong rule wraps out of sight instead of onto a second line.
              <Box flexGrow={1} flexShrink={1} height={1} overflow="hidden" marginLeft={1}>
                <Text dimColor>{'─'.repeat(RULE_LENGTH)}</Text>
              </Box>
            )}
        </Box>
      </Box>
    )

    // Finished sits at the pane's bottom: an empty block takes whatever height is left above it.
    // The Finished area keeps a minimum height (40% of the pane, at least 6 lines), so opening or
    // closing its list never moves its bar; a longer open list runs past the bottom and the pane scrolls.
    const bodyRows = e.props?.scroll?.bodyRows ?? 0
    const finishedHeight = finished.length > 0 && bodyRows > 0 ? Math.max(6, Math.floor(bodyRows * 0.4)) : 0
    const used = 1 + (rows.length === 0 ? 1 : 0) + live.length * 2
    const spacer = finishedHeight > 0 ? Math.max(0, bodyRows - used - finishedHeight) : 0

    return (
      <Box flexDirection="column">
        {header}
        {rows.length === 0 && <Text dimColor>No subagents yet.</Text>}
        {treeOrder(live).map(node => agentRow(node.row, node.depth))}
        {spacer > 0 && <Box key="spacer" height={spacer} />}
        {finished.length > 0 && (
          <Box key="finished-area" flexDirection="column" minHeight={finishedHeight || undefined}>
            {finishedBar}
            {isExpanded && finished.map(row => agentRow(row))}
          </Box>
        )}
      </Box>
    )
  })
}

const shortModel = (model?: string): string => {
  if (!model) return ''
  const m = model.match(/(opus|sonnet|haiku|fable)/i)
  return m?.[1]?.toLowerCase() ?? model
}

// Codex runs through a wrapper script: its model, effort and task are read back from the command, the script's
// defaults and the prompt file, so the shell row can say more than the opaque command line.
async function describeCodex($: EngineInterface, command: string): Promise<{ model?: string; effort?: string; note?: string } | undefined> {
  const script = scriptPathOf(command)
  const scriptText = script === undefined ? undefined : await $.fs.read(script).catch(() => undefined)
  const call = codexCall(command, scriptText)
  if (call === undefined) return undefined
  const prompt = call.promptFile === undefined ? undefined : await $.fs.read(drivePath(call.promptFile)).catch(() => undefined)
  return { model: call.model, effort: call.effort, note: prompt === undefined ? undefined : firstLine(prompt) }
}
