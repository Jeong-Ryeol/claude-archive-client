# 대화 워커 설치·운영
1. 준비: Node 22 이상, Claude 앱(Claude Code) 설치·로그인. `설치.bat` 더블클릭 → 토큰 붙여넣기. 끝에 요약표(Claude·Codex 로그인, 서버 주소, 감시 폴더)가 나온다.
2. 확인: `logs\worker.log` 에 `서버 접속됨`. 작업 스케줄러에 `claude-talk-worker`(로그온 시 창 없이 실행, 죽으면 5초 뒤 다시 띄움).
3. 재설치·설정 변경: `config.json` 고친 뒤 `설치.bat` 다시 실행(설정 유지, 이전 워커를 끄고 새로 띄움).
4. 서브 PC 추가: 이 `worker` 폴더를 복사(또는 클라이언트 저장소 clone)하고 `설치.bat`. 서버 주소·토큰은 메인 PC 와 같게, `worker_id` 는 비워 두면 컴퓨터명이 들어간다(PC 마다 달라야 함).
5. 자동 업데이트: 시작할 때와 6시간마다 `VERSION` 을 비교해 새 버전이면 받아서 설치하고 스스로 재시작. 끄려면 `config.json` 에 `"auto_update": false`.
6. 수동 업데이트: 워커 폴더에서 `git pull`(또는 새 zip 의 `worker` 를 덮어쓰기, `config.json`·`logs` 는 두기) → `설치.bat`.
7. 로그: `logs\worker.log`(날짜별 7일 보관). 재시작이 1시간에 20번을 넘으면 멈추고 `logs\restart-stop.txt` 를 남긴다 → 로그 확인 후 `설치.bat`.
8. 로그인 오류 카드: "ChatGPT 로그인이 필요합니다" → `설치.bat` 다시 실행(ChatGPT 로그인 창이 뜸), "Claude 로그인이 필요합니다" → Claude 앱을 한 번 열기.
9. 서버 없이 시험: `npm run once -- --cwd C:\tmp\t "1+1은?"` (개발 도구 필요: `npm ci`).
10. 제거: 명령창에서 `설치.bat -Uninstall`(작업 중지·삭제). 폴더는 직접 지운다.
