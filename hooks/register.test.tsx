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
  test(`${surface}: 스폰 → 도구 실행 중 → 종료가 패널에 그대로 그려진다`, async ($, on) => {
    mock.clock(on)
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    on('agent.spawn', async () => ({ model: 'claude-haiku-5-5', agentId: 'ag1' }))
    on('turn.complete', async (_$, e) => ({ text: e.answer }))

    let midRun = ''
    on('tool.call', async () => {
      midRun = await shown()
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

    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'ag1', reason: 'answer', usage: USAGE })

    // Finished agents fold into a collapsed list; pressing it shows them.
    expect(await ui.find({ type: 'Button', text: 'Finished · 1' })).toBeDefined()
    expect(await shown()).not.toContain('Explore')
    await ui.press({ key: 'finished' })
    const texts = await shown()
    expect(texts).toContain('✓')
    expect(texts).toContain('Explore')
    expect(texts).toContain('find the config')
    expect(texts).toContain('1 tools')
    expect(texts).toContain('1.1k↑ 2.0k↓')
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
  expect(displayWidth(bar?.text ?? '')).toBeLessThanOrEqual(cols - 1)
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
  expect(displayWidth(head?.text ?? '')).toBeLessThanOrEqual(cols - 1)
  const detail = (await ui.findAll({ type: 'Text' })).find(t => t.text.includes('tools'))
  expect(displayWidth(detail?.text ?? '')).toBeLessThanOrEqual(cols - 1)
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
