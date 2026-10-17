import { expect, mock, test } from 'claude-code/testing'

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
