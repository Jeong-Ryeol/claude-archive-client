import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandEnv, normalizeConfig, resolveClaudeBin } from '../src/config.js';
import { wsUrl } from '../src/ws.js';

describe('설정', () => {
  it('%VAR% 펼치기', () => {
    expect(expandEnv('%HOMEX%\\a', { HOMEX: 'C:\\U' })).toBe('C:\\U\\a');
  });

  it('claude_bin: 없는 경로면 PATH 의 실행 파일, .cmd 는 보지 않음', () => {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const home = mkdtempSync(path.join(os.tmpdir(), 'home-'));
    const binDir = mkdtempSync(path.join(os.tmpdir(), 'bin-'));
    const cmdDir = mkdtempSync(path.join(os.tmpdir(), 'cmd-'));
    writeFileSync(path.join(cmdDir, 'claude.cmd'), '');
    writeFileSync(path.join(binDir, exe), '');
    const env = { USERPROFILE: home, HOME: home, PATH: [cmdDir, binDir].join(path.delimiter) };
    expect(resolveClaudeBin('%USERPROFILE%\\.local\\bin\\claude.exe', env)).toBe(path.join(binDir, exe));
    // 기본 위치에 있으면 그쪽
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(path.join(home, '.local', 'bin', exe), '');
    expect(resolveClaudeBin('', env)).toBe(path.join(home, '.local', 'bin', exe));
  });

  it('기본값과 ws 주소', () => {
    const c = normalizeConfig({ endpoint: 'http://100.103.235.96:8800/', token: 't' }, {});
    expect(c.concurrency).toBe(2);
    expect(c.worker_id).toBe(os.hostname());
    expect(wsUrl(c.endpoint, 'DESK 1')).toBe('ws://100.103.235.96:8800/ws/worker?worker=DESK+1');
  });
});
