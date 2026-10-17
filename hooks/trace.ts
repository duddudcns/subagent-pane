import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

const agents = atom({ plugin: 'subagent-pane', key: 'agents' } as const, [])

// Development trace: on only while `.debug` exists in the plugin folder.
// Each event is appended and the last 200 plus the current rows are written to `.debug-dump.json`.
let isTracing = false
const events: unknown[] = []

export async function startTrace($: EngineInterface): Promise<void> {
  isTracing = await $.fs.read(`${$.plugin.root}/.debug`).then(() => true, () => false)
}

export async function trace($: EngineInterface, kind: string, data: Record<string, unknown>): Promise<void> {
  if (!isTracing) return
  events.push({ at: await $.clock.now(), kind, ...data })
  const rows = await read($, agents)
  await $.fs.write(`${$.plugin.root}/.debug-dump.json`, JSON.stringify({ events: events.slice(-200), rows }, null, 1))
}
