import { expect, test } from 'claude-code/testing'

import { agentFileCandidates, parseColor, toDisplayColor } from './colors'

test('정의 파일 frontmatter의 color만 읽는다', async () => {
  expect(parseColor('---\nname: runner\ncolor: orange\n---\nbody\ncolor: red')).toBe('orange')
  expect(parseColor('---\r\nname: x\r\ncolor:  cyan \r\n---\r\n')).toBe('cyan')
  expect(parseColor('---\nname: x\n---\ncolor: red')).toBeUndefined()
  expect(parseColor('no frontmatter')).toBeUndefined()
})

test('Claude Code 에이전트 색 이름을 터미널 색으로 바꾼다', async () => {
  expect(toDisplayColor('red')).toBe('red')
  expect(toDisplayColor('cyan')).toBe('cyan')
  expect(toDisplayColor('purple')).toMatch(/^#/)
  expect(toDisplayColor('orange')).toMatch(/^#/)
  expect(toDisplayColor('pink')).toMatch(/^#/)
  expect(toDisplayColor('mauve')).toBeUndefined()
  expect(toDisplayColor(undefined)).toBeUndefined()
})

const INSTALLED = JSON.stringify({
  version: 2,
  plugins: { 'subagents@duddudcns': [{ scope: 'user', installPath: 'C:\\c\\plugins\\cache\\duddudcns\\subagents\\0.5.1' }] },
})

test('플러그인 에이전트는 설치 경로의 agents 폴더에서 찾는다', async () => {
  expect(agentFileCandidates('subagents:runner', 'C:/c', '/proj', INSTALLED)).toEqual([
    'C:\\c\\plugins\\cache\\duddudcns\\subagents\\0.5.1/agents/runner.md',
  ])
  expect(agentFileCandidates('nope:runner', 'C:/c', '/proj', INSTALLED)).toEqual([])
  expect(agentFileCandidates('subagents:runner', 'C:/c', '/proj', '{broken')).toEqual([])
})

test('접두사 없는 에이전트는 사용자·프로젝트 agents 폴더, 내장 에이전트는 후보가 있어도 파일이 없을 뿐', async () => {
  expect(agentFileCandidates('code-reviewer', 'C:/c', '/proj', INSTALLED)).toEqual([
    '/proj/.claude/agents/code-reviewer.md',
    'C:/c/agents/code-reviewer.md',
  ])
})
