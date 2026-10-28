import { expect, test } from 'claude-code/testing'

import { codexCall, drivePath, firstLine, scriptPathOf } from './codex'

const SCRIPT = [
  'model="${3:-gpt-6-luna}"',
  'effort="${4:-medium}"',
  'codex exec --yolo --disable hooks -m "$model" -c "model_reasoning_effort=\\"$effort\\"" -C "$dir" - < "$prompt" > "$log" 2>&1',
].join('\n')

test('codex를 직접 부르면 -m 과 effort 를 명령에서 읽는다', async () => {
  const cmd = `codex exec --yolo -m gpt-6.1-sol -c model_reasoning_effort="low" -C . - < p.txt`
  expect(codexCall(cmd)).toEqual({ model: 'gpt-6.1-sol', effort: 'low' })
})

test('run.sh 래퍼는 인자 3,4 를 읽고 없으면 스크립트 기본값을 쓴다', async () => {
  const withArgs = 'bash .claude/skills/codex-yolo/run.sh /tmp/p.txt /tmp/l.log gpt-6.1-sol low'
  expect(codexCall(withArgs, SCRIPT)).toEqual({ model: 'gpt-6.1-sol', effort: 'low', promptFile: '/tmp/p.txt' })
  const noArgs = 'bash .claude/skills/codex-yolo/run.sh "C:/tmp/p x.txt" /tmp/l.log'
  expect(codexCall(noArgs, SCRIPT)).toEqual({ model: 'gpt-6-luna', effort: 'medium', promptFile: 'C:/tmp/p x.txt' })
})

test('기본값이 환경 변수 기본값으로 겹쳐 있으면 안쪽 기본값을 쓴다', async () => {
  const nested = SCRIPT.replace('${3:-gpt-6-luna}', '${3:-${CODEX_MODEL:-gpt-6-luna}}').replace('${4:-medium}', '${4:-${CODEX_EFFORT:-medium}}')
  const noArgs = 'bash run.sh /tmp/p.txt /tmp/l.log'
  expect(codexCall(noArgs, nested)).toEqual({ model: 'gpt-6-luna', effort: 'medium', promptFile: '/tmp/p.txt' })
})

test('codex 와 무관한 명령은 undefined', async () => {
  expect(codexCall('npm test')).toBeUndefined()
  expect(codexCall('bash build.sh a b', 'echo hi')).toBeUndefined()
})

test('스크립트 경로는 .sh 첫 토큰이고 codex 명령 자체에는 없다', async () => {
  expect(scriptPathOf('bash .claude/skills/codex-yolo/run.sh a b')).toBe('.claude/skills/codex-yolo/run.sh')
  expect(scriptPathOf('codex exec -m x -')).toBeUndefined()
})

test('Git Bash 경로는 드라이브 경로로 바꾼다', async () => {
  expect(drivePath('/c/Users/a/p.txt')).toBe('C:/Users/a/p.txt')
  expect(drivePath('C:/x/p.txt')).toBe('C:/x/p.txt')
  expect(drivePath('rel/p.txt')).toBe('rel/p.txt')
})

test('프롬프트 파일의 첫 비어 있지 않은 줄을 한 줄로 줄인다', async () => {
  expect(firstLine('\n\n  # 작업: 손복원   \n다음 줄')).toBe('# 작업: 손복원')
  expect(firstLine('')).toBe('')
})
