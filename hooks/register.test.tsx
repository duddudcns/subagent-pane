import { expect, mock, test } from 'claude-code/testing'

import { displayWidth } from './model'

const PLUGIN = 'subagent-pane'
const PANE_PROPS = {
  title: 'Subagents',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const USAGE = { input_tokens: 100, output_tokens: 2_000, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: 스폰 → 도구 실행 중 → 종료가 패널에 그대로 그려진다`, { options: { showTool: true } }, async ($, on) => {
    mock.clock(on)
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'ag1' }))
    on('turn.complete', async (_$, e) => ({ text: e.answer }))

    let midRun = ''
    let midRunTimeColor: unknown
    on('tool.call', async () => {
      midRun = await shown()
      midRunTimeColor = (await ui.findAll({ type: 'Text' })).find(t => (surface === 'terminal' ? /^\s+\d+s$/ : /^\s*\d+s$/).test(t.text))?.props.color
      return { result: 'ok' }
    })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: 'subagents', props: PANE_PROPS })
    const shown = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')

    await $.agent.spawn({
      tool_use_id: 'tu1', prompt: 'find x', description: 'find the config', subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
    })
    await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'ag1' } as Parameters<typeof $.tool.call>[0])
    expect(midRun).toContain('▸ Grep')
    expect(midRun).toContain('1 running')
    // A running row's elapsed time is drawn in the running colour.
    expect(midRunTimeColor).toBe('yellow')

    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'ag1', reason: 'answer', usage: USAGE })

    // Finished agents fold into a collapsed list; pressing it shows them.
    expect(await ui.find({ type: 'Button', text: 'Finished · 1' })).toBeDefined()
    expect(await shown()).not.toContain('Explore')
    await ui.press({ key: 'finished' })
    const texts = await shown()
    // No status icon: the elapsed time's colour carries the state.
    expect(texts).not.toContain('✓')
    expect(texts).not.toContain('●')
    // A finished row's elapsed time takes its status colour.
    expect((await ui.findAll({ type: 'Text' })).find(t => (surface === 'terminal' ? /^\s+\d+s$/ : /^\s*\d+s$/).test(t.text))?.props.color).toBe('green')
    expect(texts).toContain('Explore')
    expect(texts).toContain('find the config')
    // The detail line names the model alone: no tool count, no tokens.
    expect(texts).toContain('haiku')
    expect(texts).not.toContain('tools')
    expect(texts).not.toContain('↑')
    expect(texts).not.toContain('▸ Grep')
    // Finished rows offer no stop button, only the clear control.
    expect(await ui.find({ key: 'stop-ag1' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: 'clear' })).toBeDefined()
  })
}

test('Finished 묶음은 빈 줄과 구분선으로 실행 중 묶음과 떨어진다', async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  let next = 0
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: `s${++next}` }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const cols = 40
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: { ...PANE_PROPS, bodyColumns: cols } })
  const spawn = (description: string) => $.agent.spawn({
    tool_use_id: description, prompt: 'x', description, subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  await spawn('still running')
  await spawn('already done')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: 's2', reason: 'answer' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const rule = texts.findIndex(t => t.includes('───'))
  expect(rule).toBeGreaterThan(-1)
  expect(texts[rule - 1]?.trim() ?? 'missing').toBe('')
  const bar = (await ui.findAll({ type: 'Box' })).find(b => b.props.flexDirection === 'row' && b.text.includes('Finished'))
  expect(bar).toBeDefined()
  expect(displayWidth(bar?.text ?? '')).toBeLessThanOrEqual(cols)
})

test('백그라운드 Bash는 행이 생기고, 작업 알림이 오면 끝난다', async ($, on) => {
  mock.clock(on)
  on('tool.call', async () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bsh1' } }))
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: PANE_PROPS })
  await $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'build it', run_in_background: true })
  const shown = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(await shown()).toContain('bash')
  expect(await shown()).toContain('build it')
  expect(await shown()).toContain('$ npm run build')
  expect(await shown()).toContain('1 running')

  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>bsh1</task-id>\n<status>completed</status>\n</task-notification>' }] },
    door: 'delivery',
    origin: { kind: 'task-notification' },
    uuid: 'u1',
  } as Parameters<typeof $.session.append>[0])
  expect(await shown()).toContain('idle')
  expect(await ui.find({ type: 'Button', text: 'Finished · 1' })).toBeDefined()
})

test('알림이 빠진 셸 행도 턴 끝(Stop)의 작업 목록으로 끝난다', async ($, on) => {
  mock.clock(on)
  on('tool.call', async () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'lost1' } }))
  on('classic.Stop', async () => ({}))
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: PANE_PROPS })
  await $.tool.call({ tool: 'Bash', command: 'sleep 40', run_in_background: true })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toContain('1 running')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as Parameters<typeof $.classic.Stop>[0])
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toContain('idle')
})

test('이미 끝난 작업의 중지(No task found)는 에러 대신 행을 끝낸다', async ($, on) => {
  mock.clock(on)
  on('tool.call', async (_$, e) =>
    e.tool === 'TaskStop'
      ? { result: 'Error: No task found with ID: gone1', text: '<tool_use_error>No task found with ID: gone1</tool_use_error>', isError: true }
      : { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'gone1' } })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: PANE_PROPS })
  await $.tool.call({ tool: 'Bash', command: 'sleep 40', run_in_background: true })
  await ui.press({ key: 'stop-gone1' })
  await ui.press({ key: 'stop-gone1' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')).toContain('idle')
})

test('bash 중지가 성공하면 알림 없이도 바로 중지됨으로 끝난다', async ($, on) => {
  mock.clock(on)
  on('tool.call', async (_$, e) =>
    e.tool === 'TaskStop'
      ? { result: { message: 'Successfully stopped task: k1', task_id: 'k1', task_type: 'local_bash' } }
      : { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'k1' } })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: PANE_PROPS })
  await $.tool.call({ tool: 'Bash', command: 'sleep 60', run_in_background: true })
  await ui.press({ key: 'stop-k1' })
  await ui.press({ key: 'stop-k1' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('idle')
  expect(await ui.find({ key: 'stop-k1' })).toBeUndefined()
})

test('포그라운드 Bash는 행을 만들지 않는다', async ($, on) => {
  mock.clock(on)
  on('tool.call', async () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: PANE_PROPS })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await ui.find({ type: 'Text', text: 'No subagents yet.' })).toBeDefined()
})

test('Finished 묶음은 패널 맨 아래에 붙고, 남는 높이는 빈 공간이 채운다', async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: `p${++n}` }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const rows = 20
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows: rows } } })
  const spawn = (d: string) => $.agent.spawn({
    tool_use_id: d, prompt: 'x', description: d, subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  await spawn('live one')
  await spawn('done one')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: 'p2', reason: 'answer' })
  // header 1 + live 2 above; the Finished area keeps a fixed 40% (min 6) = 8 lines; the spacer takes the rest.
  const heightOf = async (key: string) => (await ui.findAll({ type: 'Box' })).find(b => b.key === key)?.props.height
  const minOf = async (key: string) => (await ui.findAll({ type: 'Box' })).find(b => b.key === key)?.props.minHeight
  expect(await minOf('finished-area')).toBe(8)
  expect(await heightOf('spacer')).toBe(rows - 3 - 8)
  // Opening and closing the list never moves the Finished bar.
  await ui.press({ key: 'finished' })
  expect(await heightOf('spacer')).toBe(rows - 3 - 8)
  expect(await minOf('finished-area')).toBe(8)
})

test('펼친 Finished 목록은 자르지 않는다: 넘치면 패널 스크롤로 본다', async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: `m${++n}` }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows: 12 } } })
  for (let i = 1; i <= 8; i++) {
    await $.agent.spawn({
      tool_use_id: `m${i}`, prompt: 'x', description: `job ${i}`, subagentType: 'Explore',
      provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
    })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: `t${i}`, agentId: `m${i}`, reason: 'answer' })
  }
  await ui.press({ key: 'finished' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  for (let i = 1; i <= 8; i++) expect(texts).toContain(`job ${i}`)
})

test('좁은 패널에서도 첫 줄이 폭을 넘지 않는다 (한글 설명 포함)', async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'ag3' }))
  const cols = 30
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: { ...PANE_PROPS, bodyColumns: cols } })
  await $.agent.spawn({
    tool_use_id: 'tu3', prompt: 'x', description: '설정 파일과 훅 파일을 모두 찾아서 정리하기', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  const rowsDrawn = (await ui.findAll({ type: 'Box' })).filter(b => b.props.flexDirection === 'row')
  const head = rowsDrawn.find(b => b.text.includes('general'))
  expect(head).toBeDefined()
  // The time ends exactly at the pane's edge.
  expect(displayWidth(head?.text ?? '')).toBe(cols)
  expect(head?.text.endsWith('0s')).toBe(true)
  const detail = (await ui.findAll({ type: 'Text' })).find(t => t.text.includes('haiku'))
  // Line two ends in the stop control, also at the edge.
  const second = rowsDrawn.find(b => b.text.includes('haiku'))
  expect(displayWidth(second?.text ?? '')).toBe(cols)
  expect(second?.text.endsWith('x')).toBe(true)
  expect(displayWidth(detail?.text ?? '')).toBeLessThanOrEqual(cols)
})

test('/subagent-pane 은 열려 있으면 닫고, 닫혀 있으면 연다', async ($, on) => {
  mock.clock(on)
  let isUp = false
  on('ui.open', async () => {
    isUp = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', async () => {
    isUp = false
    return { value: undefined }
  })
  on('ui.panes', async () => ({ value: isUp ? [{ id: 'subagents', title: 'Subagents', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  const first = await $.command.run({ command: 'subagent-pane', args: '' } as Parameters<typeof $.command.run>[0])
  expect(isUp).toBe(true)
  expect(first.text).toContain('열었')
  const second = await $.command.run({ command: 'subagent-pane', args: '' } as Parameters<typeof $.command.run>[0])
  expect(isUp).toBe(false)
  expect(second.text).toContain('닫았')
  // The short alias toggles the same pane.
  await $.command.run({ command: 'sap', args: '' } as Parameters<typeof $.command.run>[0])
  expect(isUp).toBe(true)
  await $.command.run({ command: 'sap', args: '' } as Parameters<typeof $.command.run>[0])
  expect(isUp).toBe(false)
})

test('옵션을 켜면 도구 횟수와 토큰이 둘째 줄에 나온다', { options: { showTokens: true, showToolCount: true } }, async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'op1' }))
  on('tool.call', async () => ({ result: 'ok' }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: PANE_PROPS })
  await $.agent.spawn({
    tool_use_id: 'op', prompt: 'x', description: 'opt', subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'op1' } as Parameters<typeof $.tool.call>[0])
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: 'op1', reason: 'answer', usage: USAGE })
  await ui.press({ key: 'finished' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(texts).toContain('1 tools')
  expect(texts).toContain('1.1k↑ 2.0k↓')
})

test('메인 루프의 도구 호출은 행을 만들지 않는다', async ($, on) => {
  mock.clock(on)
  on('tool.call', async () => ({ result: 'ok' }))
  await $.tool.call({ tool: 'Grep', pattern: 'x' })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: 'No subagents yet.' })).toBeDefined()
})

test('실행 중인 행의 ■ 는 두 번 눌러야 TaskStop을 부른다', async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'ag2' }))
  const stops: unknown[] = []
  on('tool.call', async (_$, e) => {
    if (e.tool === 'TaskStop') stops.push(e.task_id)
    return { result: 'ok' }
  })
  await $.agent.spawn({
    tool_use_id: 'tu2', prompt: 'wait', description: 'long wait', subagentType: 'runner',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: PANE_PROPS })
  await ui.press({ key: 'stop-ag2' })
  expect(stops).toEqual([])
  await ui.press({ key: 'stop-ag2' })
  expect(stops).toEqual(['ag2'])
})

test('정의 파일에 effort 가 없어도 모델 요청의 effort 가 둘째 줄에 붙는다', async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5-5', agentId: 'ag1' }))
  on('turn.step', async function* () {
    return { turnId: 't1', index: 0, answer: '', toolUses: [] } as never
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: 'subagents', props: PANE_PROPS })
  await $.agent.spawn({
    tool_use_id: 'tu1', prompt: 'p', description: 'review it', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  const shown = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
  expect(await shown()).not.toContain('sonnet/')
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1, agentId: 'ag1' })) void _
  expect(await shown()).toContain('sonnet/high')
})

test('데스크탑: 시간·x·구분선을 공백이 아니라 flex로 오른쪽 끝에 붙인다', async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  let next = 0
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: `d${++next}` }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'subagents', props: PANE_PROPS })
  const spawn = (description: string) => $.agent.spawn({
    tool_use_id: description, prompt: 'x', description, subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  await spawn('still running')
  await spawn('already done')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: 'd2', reason: 'answer' })
  const texts = await ui.findAll({ type: 'Text' })
  // The time is drawn bare: no padding spaces in front of it.
  const time = texts.find(t => /^\d+s$/.test(t.text))
  expect(time).toBeDefined()
  expect(texts.some(t => /^\s+\d+s$/.test(t.text))).toBe(false)
  // The description and the detail line grow to fill the row, pushing the time and the x to the edge.
  const boxes = await ui.findAll({ type: 'Box' })
  const grows = boxes.filter(b => b.props.flexGrow === 1)
  expect(grows.some(b => b.text === 'still running')).toBe(true)
  expect(grows.some(b => b.text.includes('haiku'))).toBe(true)
  expect(await ui.find({ key: 'stop-d1' })).toBeDefined()
  // No padded detail line: nothing ends in a run of spaces.
  expect(texts.some(t => / {3,}$/.test(t.text))).toBe(false)
  // The rule sits in a one-row clipped box, so it cannot spill onto a second line.
  const rule = boxes.filter(b => b.text.includes('───')).sort((x, y) => x.text.length - y.text.length)[0]
  expect(rule?.props.height).toBe(1)
  expect(rule?.props.overflow).toBe('hidden')
  expect(rule?.props.flexGrow).toBe(1)
  // The bar centres its children, so the rule sits at the label's middle, not its top.
  const bar = boxes.find(b => b.props.flexDirection === 'row' && b.text.includes('Finished') && b.text.includes('───'))
  expect(bar?.props.alignItems).toBe('center')
})

test('데스크탑: 실행 중인 행의 x 도 두 번 눌러야 TaskStop을 부른다', async ($, on) => {
  mock.clock(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'ag3' }))
  const stops: unknown[] = []
  on('tool.call', async (_$, e) => {
    if (e.tool === 'TaskStop') stops.push(e.task_id)
    return { result: 'ok' }
  })
  await $.agent.spawn({
    tool_use_id: 'tu3', prompt: 'wait', description: 'long wait', subagentType: 'runner',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'Pane', requestId: 'subagents', props: PANE_PROPS })
  await ui.press({ key: 'stop-ag3' })
  expect(stops).toEqual([])
  await ui.press({ key: 'stop-ag3' })
  expect(stops).toEqual(['ag3'])
})
