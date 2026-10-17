# subagent-pane

Claude Code mod. 사이드 패널에 서브에이전트를 실시간으로 보여 준다.

- 에이전트마다 두 줄: 종류, 설명, 경과 시간(색이 상태: 실행 중 노랑, 완료 초록, 실패 빨강, 중지 회색) / 지금 쓰는 도구, 모델(토큰·도구 횟수는 옵션)
- 백그라운드 Bash/PowerShell(`run_in_background`)도 `bash`/`powershell` 행으로 보인다. 둘째 줄은 `$ 명령`. 끝은 엔진의 작업 알림(`task-notification`)으로 잡으므로, 알림이 늦게 오면 경과 시간도 그만큼 길게 찍힌다
- 종류 이름은 에이전트 정의 파일의 `color:` 색으로 칠한다(API가 색을 주지 않아 `~/.claude/plugins/installed_plugins.json` → `agents/<이름>.md` 를 직접 읽음, 내장 에이전트는 색 없음)
- 종류 이름을 누르면 그 에이전트의 대화 기록으로 전환, `main` 으로 복귀
- 실행 중인 행의 둘째 줄 끝 `x` (평소 흐림, x 에 마우스를 올리면 빨강)를 5초 안에 두 번 누르면 `TaskStop` 으로 중지. 시간은 첫 줄 오른쪽 끝에 붙는다
- 실행 중인 에이전트가 위, 끝난 것은 `▸ Finished · N` 으로 접힌다(누르면 펼침, 최근 끝난 것부터). `clear` 는 끝난 행을 지운다
- 패널이 좁아도 에이전트당 두 줄: 설명부터, 그다음 종류 이름을 폭에 맞춰 자른다(한글은 2칸)
- `/subagent-pane`(축약 `/sap`) 으로 열고 닫는다(머리줄 `close` 도 닫기). 처음 서브에이전트가 생기면 자동으로 열린다(터미널 144칸 이상일 때)

토큰은 에이전트의 턴이 끝날 때 집계된다(실행 중에는 0).

## 옵션

`/config` 의 플러그인 설정(또는 settings.json `pluginConfigs["subagent-pane"].options`):

- `showTokens` (기본 꺼짐): 둘째 줄에 토큰(입력↑ 출력↓)
- `showToolCount` (기본 꺼짐): 둘째 줄에 도구 호출 횟수(`N tools`)

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
