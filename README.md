# subagent-pane

Claude Code mod. 사이드 패널에 서브에이전트를 실시간으로 보여 준다.

- 에이전트마다 두 줄: 상태 아이콘, 종류, 설명, 경과 시간 / 지금 쓰는 도구, 모델, 도구 횟수, 토큰(입력↑ 출력↓)
- 종류 이름을 누르면 그 에이전트의 대화 기록으로 전환, `main` 으로 복귀
- `■` 를 5초 안에 두 번 누르면 `TaskStop` 으로 중지
- `clear` 는 끝난 행을 지운다
- `/subagent-pane`(축약 `/sap`) 으로 열고 닫는다(머리줄 `close` 도 닫기). 처음 서브에이전트가 생기면 자동으로 열린다(터미널 144칸 이상일 때)

토큰은 에이전트의 턴이 끝날 때 집계된다(실행 중에는 0).

## 설치

Claude Code 2.1.287 이상(mods).

```
/plugin marketplace add duddudcns/claude-plugins
/plugin install subagent-pane@duddudcns
```

비공개 저장소라 GitHub 접근 권한과 로그인(`gh auth login`)이 필요하다.

## 개발

- `claude plugin validate .` / `claude plugin test .`
- 폴더에 빈 `.debug` 파일을 두면 이벤트와 행을 `.debug-dump.json` 에 기록한다(실제 세션 확인용).
- 헤드리스 확인: `claude -p --plugin-dir <이 폴더> "<Agent 도구를 쓰는 프롬프트>"` 후 `.debug-dump.json` 확인.
