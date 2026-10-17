// A Codex run shows as a plain background shell: its model, effort and task live in the wrapper's
// arguments or script, so they are read back from the command line.

export type CodexCall = { model?: string; effort?: string; promptFile?: string }

const tokens = (command: string): string[] =>
  [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? '')

export const scriptPathOf = (command: string): string | undefined => tokens(command).find(t => /\.sh$/.test(t))

const EFFORT = /model_reasoning_effort=\\?["']?(\w+)/

export const codexCall = (command: string, scriptText?: string): CodexCall | undefined => {
  if (/\bcodex\s+exec\b/.test(command)) {
    const model = command.match(/(?:^|\s)(?:-m|--model)\s+["']?([^\s"']+)/)?.[1]
    const effort = command.match(EFFORT)?.[1]
    return { model, effort }
  }
  const script = scriptPathOf(command)
  if (script === undefined || scriptText === undefined || !/\bcodex\s+exec\b/.test(scriptText)) return undefined
  // Positional arguments after the script: prompt, log, model, effort.
  const args = tokens(command).slice(tokens(command).indexOf(script) + 1)
  const dflt = (n: number): string | undefined => scriptText.match(new RegExp(`\\$\\{${n}:-([^}]+)\\}`))?.[1]
  return { model: args[2] ?? dflt(3), effort: args[3] ?? dflt(4), promptFile: args[0] }
}

// A Git Bash path (/c/Users/x) the engine's file reader does not know: spell it as a drive path.
export const drivePath = (path: string): string => path.replace(/^\/([a-zA-Z])\//, (_, d: string) => `${d.toUpperCase()}:/`)

export const firstLine = (text: string): string =>
  (text.split(/\r?\n/).find(line => line.trim() !== '') ?? '').trim()
