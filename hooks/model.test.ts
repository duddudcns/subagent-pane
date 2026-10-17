import { expect, test } from 'claude-code/testing'

import { addAgent, addShell, finishTask, parseNotification, displayWidth, endTool, finishTurn, fitHead, formatElapsed, formatTokens, isLive, MIN_GAP, setColor, shortType, splitSections, startTool, syncStatus, truncateTo } from './model'

const base = () => addAgent([], { id: 'a1', type: 'Explore', description: 'find x', startedAt: 1_000, model: 'haiku' })

test('스폰하면 running 행이 생기고, 같은 id는 다시 추가되지 않는다', async () => {
  const list = base()
  expect(list).toEqual([
    { id: 'a1', type: 'Explore', description: 'find x', status: 'running', startedAt: 1_000, model: 'haiku', toolCount: 0, tokensIn: 0, tokensOut: 0 },
  ])
  expect(addAgent(list, { id: 'a1', type: 'Explore', description: 'again', startedAt: 2_000 })).toHaveLength(1)
})

test('resume으로 다시 깨어난 끝난 에이전트는 running으로 돌아간다', async () => {
  const done = finishTurn(base(), 'a1', 'answer', 5_000)
  const again = addAgent(done, { id: 'a1', type: 'Explore', description: 'find x', startedAt: 9_000 })
  expect(again[0]).toMatchObject({ status: 'running', endedAt: undefined })
})

test('도구 시작은 현재 도구와 횟수를, 끝은 현재 도구만 지운다', async () => {
  const s = startTool(base(), 'a1', 'Grep')
  expect(s[0]).toMatchObject({ tool: 'Grep', toolCount: 1 })
  expect(endTool(s, 'a1', 'Grep')[0]).toMatchObject({ tool: undefined, toolCount: 1 })
})

test('다른 도구가 이미 시작됐으면 늦게 끝난 도구는 현재 도구를 지우지 않는다', async () => {
  const s = startTool(startTool(base(), 'a1', 'Grep'), 'a1', 'Read')
  expect(endTool(s, 'a1', 'Grep')[0]?.tool).toBe('Read')
})

test('색은 해당 행에만 붙는다', async () => {
  expect(setColor(base(), 'a1', 'cyan')[0]?.color).toBe('cyan')
  expect(setColor(base(), 'zz', 'cyan')[0]?.color).toBeUndefined()
})

test('모르는 id의 도구 호출은 목록을 바꾸지 않는다', async () => {
  const list = base()
  expect(startTool(list, 'zz', 'Bash')).toBe(list)
})

test('턴 종료는 상태·종료 시각·토큰을 채운다 (입력 = uncached + cache read + cache write)', async () => {
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, model: 'claude-haiku-5-5' }
  const f = finishTurn(base(), 'a1', 'answer', 7_000, usage)
  expect(f[0]).toMatchObject({ status: 'completed', endedAt: 7_000, tokensIn: 350, tokensOut: 20, model: 'claude-haiku-5-5', tool: undefined })
  expect(finishTurn(base(), 'a1', 'aborted', 7_000)[0]?.status).toBe('killed')
  expect(finishTurn(base(), 'a1', 'error', 7_000)[0]?.status).toBe('failed')
})

test('엔진 목록의 상태로 맞추되, 끝난 행은 종료 시각을 한 번만 찍는다', async () => {
  const s = syncStatus(base(), [{ id: 'a1', status: 'completed' }], 8_000)
  expect(s[0]).toMatchObject({ status: 'completed', endedAt: 8_000 })
  expect(syncStatus(s, [{ id: 'a1', status: 'completed' }], 9_000)[0]?.endedAt).toBe(8_000)
  expect(syncStatus(base(), [], 8_000)[0]?.status).toBe('running')
})

test('isLive는 아직 끝나지 않은 상태만 참', async () => {
  for (const s of ['pending', 'running', 'waiting', 'idle']) expect(isLive(s)).toBe(true)
  for (const s of ['completed', 'failed', 'killed']) expect(isLive(s)).toBe(false)
})

test('경과 시간 표기: 초, 분:초, 시:분', async () => {
  expect(formatElapsed(0)).toBe('0s')
  expect(formatElapsed(59_999)).toBe('59s')
  expect(formatElapsed(61_000)).toBe('1m01s')
  expect(formatElapsed(3_600_000 + 5 * 60_000)).toBe('1h05m')
})

test('토큰 표기: 1000 미만 그대로, 이상은 k, 백만 이상은 M', async () => {
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(1_250)).toBe('1.3k')
  expect(formatTokens(12_400)).toBe('12k')
  expect(formatTokens(2_500_000)).toBe('2.5M')
})

test('표시 폭: 영문 1칸, 한글·CJK 2칸', async () => {
  expect(displayWidth('abc')).toBe(3)
  expect(displayWidth('설정 찾기')).toBe(9)
  expect(displayWidth('')).toBe(0)
})

test('폭 맞춰 자르기: 넘치면 …로 끝내고, 한글 반 칸은 버린다', async () => {
  expect(truncateTo('hello world', 20)).toBe('hello world')
  expect(truncateTo('hello world', 6)).toBe('hello…')
  expect(truncateTo('설정 찾기', 4)).toBe('설…')
  expect(truncateTo('설정', 2)).toBe('…')
  expect(truncateTo('abc', 0)).toBe('')
})

test('실행 중은 시작 순서 그대로, 완료는 최근에 끝난 것부터', async () => {
  const row = (id: string, status: string, startedAt: number, endedAt?: number) =>
    ({ id, type: 't', description: '', status, startedAt, endedAt, toolCount: 0, tokensIn: 0, tokensOut: 0 })
  const { live, finished } = splitSections([row('a', 'completed', 1, 5), row('b', 'running', 2), row('c', 'failed', 3, 9), row('d', 'running', 4)])
  expect(live.map(r => r.id)).toEqual(['b', 'd'])
  expect(finished.map(r => r.id)).toEqual(['c', 'a'])
})

test('설명과 경과 시간 사이는 최소 3칸 띄운다', async () => {
  expect(MIN_GAP).toBe(3)
  const h = fitHead({ indent: '', type: 'runner', desc: 'Color test: git log and sleep for a while', elapsed: '38s' }, 30)
  expect(h.desc.endsWith('…')).toBe(true)
  expect(h.gap).toBe(MIN_GAP)
})

test('첫 줄은 폭을 꽉 채우고, 경과 시간은 오른쪽 끝(■ 자리 2칸 앞)에 붙는다', async () => {
  const spec = { indent: '', type: 'general-purpose', desc: '설정 파일 찾기', elapsed: '1m02s' }
  // icon(1)+space(1)+type+[space+desc]+gap+elapsed+stop slot(2)
  const line = (h: { type: string; desc: string; gap: number }) =>
    2 + displayWidth(h.type) + (h.desc ? 1 + displayWidth(h.desc) : 0) + h.gap + 5 + 2
  const wide = fitHead(spec, 80)
  expect(wide.type).toBe('general-purpose')
  expect(wide.desc).toBe('설정 파일 찾기')
  expect(line(wide)).toBe(80)
  const mid = fitHead(spec, 30)
  expect(mid.type).toBe('general-purpose')
  expect(mid.gap).toBeGreaterThanOrEqual(MIN_GAP)
  expect(line(mid)).toBeLessThanOrEqual(30)
  const narrow = fitHead(spec, 16)
  expect(narrow.desc).toBe('')
  expect(narrow.gap).toBe(MIN_GAP)
  expect(line(narrow)).toBeLessThanOrEqual(16)
})

test('종류 이름은 플러그인 접두사를 뗀다', async () => {
  expect(shortType('subagents:runner')).toBe('runner')
  expect(shortType('codex:codex-rescue')).toBe('codex-rescue')
  expect(shortType('Explore')).toBe('Explore')
})

test('백그라운드 셸은 shell 행으로 추가된다: 이름은 bash, 설명이 없으면 명령', async () => {
  const list = addShell([], { id: 'b1', shell: 'bash', command: 'npm test', startedAt: 5 })
  expect(list[0]).toMatchObject({ id: 'b1', kind: 'shell', type: 'bash', description: 'npm test', command: 'npm test', status: 'running' })
  const named = addShell([], { id: 'b2', shell: 'powershell', command: 'x', description: 'run tests', startedAt: 5, parentId: 'a1' })
  expect(named[0]).toMatchObject({ type: 'powershell', description: 'run tests', parentId: 'a1' })
})

test('작업 알림은 상태 단어 그대로, 모르는 단어는 completed로 끝낸다', async () => {
  const list = addShell([], { id: 'b1', shell: 'bash', command: 'x', startedAt: 5 })
  expect(finishTask(list, 'b1', 'failed', 9)[0]).toMatchObject({ status: 'failed', endedAt: 9 })
  expect(finishTask(list, 'b1', 'weird', 9)[0]?.status).toBe('completed')
  // A row already ended keeps its first end time.
  const done = finishTask(list, 'b1', 'completed', 9)
  expect(finishTask(done, 'b1', 'completed', 20)[0]?.endedAt).toBe(9)
})

test('알림 본문에서 task-id와 status를 읽는다', async () => {
  const text = [
    '<task-notification>',
    '<task-id>bk3x9</task-id>',
    '<status>completed</status>',
    '<summary>Background command finished</summary>',
    '</task-notification>',
  ].join('\n')
  expect(parseNotification(text)).toEqual({ id: 'bk3x9', status: 'completed' })
  expect(parseNotification('<task-id>z</task-id>')).toEqual({ id: 'z', status: undefined })
  expect(parseNotification('hello')).toBeUndefined()
})
