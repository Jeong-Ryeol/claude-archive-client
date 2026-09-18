# claude-archive-client

Claude 아카이브의 **내 컴퓨터 쪽** 설치물 — 크롬 확장, PC 에이전트, 설치 안내서.
서버 주소·토큰은 관리자에게 받아 직접 입력합니다 (이 저장소엔 비밀값이 없습니다).

```powershell
git clone https://github.com/Jeong-Ryeol/claude-archive-client.git C:\claude-archive-client
cd C:\claude-archive-client
claude
```
Claude Code 에게: **"SETUP-GUIDE.md 따라서 이 노트북 설정 도와줘. 토큰은 내가 직접 입력할게"**

- `chrome-ext/` — claude.ai 로그인 키를 서버로 자동 전달 (Chrome 개발자 모드로 로드). **이 폴더를 지우면 확장이 멈춥니다.**
- `pc-agent/` — Claude Code·Cowork 기록을 5분마다 서버로 (`설치_더블클릭.bat`)
- `SETUP-GUIDE.md` — 순서대로 따라 하는 안내
- `OBSIDIAN-ENCRYPTION-OFF.md` — 옵시디언 노트도 모으려면
