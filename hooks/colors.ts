import type { EngineInterface } from 'claude-code'

// The mod API gives no agent colour, so it is read from the agent's definition file
// (`color:` in its frontmatter), the same field the Claude Code UI draws from.

// Claude Code's agent colours; the ANSI names pass through, the rest as hex.
const COLORS: Record<string, string> = {
  red: 'red',
  green: 'green',
  yellow: 'yellow',
  blue: 'blue',
  cyan: 'cyan',
  purple: '#b083f0',
  orange: '#f0883e',
  pink: '#f778ba',
}

export const toDisplayColor = (name: string | undefined): string | undefined =>
  name === undefined ? undefined : COLORS[name.toLowerCase()]

export const parseColor = (markdown: string): string | undefined => {
  const front = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const line = front?.[1]?.match(/^color:\s*([A-Za-z]+)\s*$/m)
  return line?.[1]
}

type Installed = { plugins?: Record<string, { installPath?: string }[]> }

export const agentFileCandidates = (type: string, configDir: string, cwd: string, installedJson: string): string[] => {
  const colon = type.lastIndexOf(':')
  if (colon < 0) return [`${cwd}/.claude/agents/${type}.md`, `${configDir}/agents/${type}.md`]
  const plugin = type.slice(0, colon)
  const name = type.slice(colon + 1)
  let installed: Installed
  try {
    installed = JSON.parse(installedJson) as Installed
  } catch {
    return []
  }
  const key = Object.keys(installed.plugins ?? {}).find(k => k.startsWith(`${plugin}@`))
  const path = key ? installed.plugins?.[key]?.[0]?.installPath : undefined
  return path ? [`${path}/agents/${name}.md`] : []
}

// One lookup per agent type per load; built-in types simply find no file.
const cache = new Map<string, string | undefined>()

export async function resolveColor($: EngineInterface, type: string): Promise<string | undefined> {
  if (cache.has(type)) return cache.get(type)
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const configDir = ((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`).replace(/\\/g, '/')
  const installed = await $.fs.read(`${configDir}/plugins/installed_plugins.json`).catch(() => '{}')
  let color: string | undefined
  for (const path of agentFileCandidates(type, configDir, '.', installed)) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (text === undefined) continue
    color = toDisplayColor(parseColor(text))
    break
  }
  cache.set(type, color)
  return color
}
