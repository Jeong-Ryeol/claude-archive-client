import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CWD_MISMATCH, DEFAULT_RULES, TopicRegistry, folderProblem, isInside } from '../src/topics.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topics-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('topics 프레임', () => {
  it('폴더·CLAUDE.md·AGENTS.md·uploads 를 만들고 ack 를 돌려준다', async () => {
    const reg = new TopicRegistry();
    const folder = path.join(dir, 'coding', 'deep');
    const ack = await reg.apply([{ id: 'coding', name: '코딩', folder, rules_md: '# 코딩 방\n규칙' }]);
    expect(ack).toEqual({ t: 'topics_ack', count: 1, errors: [] });
    expect(fs.readFileSync(path.join(folder, 'CLAUDE.md'), 'utf8')).toBe('# 코딩 방\n규칙');
    expect(fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8')).toBe('# 코딩 방\n규칙');
    expect(fs.statSync(path.join(folder, 'uploads')).isDirectory()).toBe(true);
  });

  it('내용이 같으면 다시 쓰지 않고, 바뀌면 쓴다', async () => {
    const reg = new TopicRegistry();
    const folder = path.join(dir, 'life');
    const t = { id: 'life', folder, rules_md: 'A' };
    await reg.apply([t]);
    const file = path.join(folder, 'CLAUDE.md');
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, old, old);
    await reg.apply([t]);
    expect(fs.statSync(file).mtimeMs).toBe(old.getTime());
    await reg.apply([{ ...t, rules_md: 'B' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe('B');
    expect(fs.statSync(file).mtimeMs).not.toBe(old.getTime());
  });

  it('rules_md 가 비면 한국어 기본 규칙', async () => {
    const reg = new TopicRegistry();
    const folder = path.join(dir, 'auto');
    await reg.apply([{ id: 'auto', folder, rules_md: '  ' }]);
    const s = fs.readFileSync(path.join(folder, 'AGENTS.md'), 'utf8');
    expect(s).toBe(DEFAULT_RULES);
    expect(s).toContain('한국어');
    expect(s).toContain('질문 1개');
    expect(s).toContain('이 폴더 밖의 파일');
  });

  it('비활성 방은 건너뛰고 매핑표에서도 빠진다', async () => {
    const reg = new TopicRegistry();
    const folder = path.join(dir, 'off');
    const ack = await reg.apply([{ id: 'off', folder, active: false }]);
    expect(ack.count).toBe(0);
    expect(fs.existsSync(folder)).toBe(false);
    expect(reg.guard({ cwd: folder })).not.toBeNull();
  });

  it('루트·상대 경로·시스템 폴더는 거부하고 errors 에 담는다', async () => {
    const reg = new TopicRegistry();
    const root = path.parse(dir).root;
    const sys = process.platform === 'win32' ? 'C:\\Windows\\rooms' : '/etc/rooms';
    const ack = await reg.apply([
      { id: 'root', folder: root },
      { id: 'rel', folder: 'rooms/x' },
      { id: 'sys', folder: sys },
      { id: 'ok', folder: path.join(dir, 'ok') },
    ]);
    expect(ack.count).toBe(1);
    expect(ack.errors.map((e) => e.id)).toEqual(['root', 'rel', 'sys']);
    expect(reg.list().map((t) => t.id)).toEqual(['ok']);
  });

  it('folderProblem: 윈도우 드라이브 없는 경로·Program Files', () => {
    if (process.platform !== 'win32') return;
    expect(folderProblem('\\rooms')).toMatch(/절대 경로/);
    expect(folderProblem('D:\\')).toMatch(/루트/);
    expect(folderProblem('C:\\Program Files\\x', { SystemDrive: 'C:' })).toMatch(/시스템/);
    expect(folderProblem('c:\\windows')).toMatch(/시스템/);
    expect(folderProblem('C:\\claude-rooms\\coding')).toBeNull();
  });
});

describe('job.cwd 검증', () => {
  it('활성 방 폴더 안만 통과', async () => {
    const reg = new TopicRegistry();
    const folder = path.join(dir, 'coding');
    await reg.apply([{ id: 'coding', folder }]);
    expect(reg.guard({ cwd: folder })).toBeNull();
    expect(reg.guard({ cwd: path.join(folder, 'sub', 'x') })).toBeNull();
    expect(reg.topicFor(path.join(folder, 'sub'))?.id).toBe('coding');
    expect(reg.guard({ cwd: path.join(dir, 'coding-other') })).toEqual({ k: 'error', kind: 'other', message: CWD_MISMATCH });
    expect(reg.guard({ cwd: path.join(folder, '..', 'x') })).not.toBeNull();
    expect(reg.guard({ cwd: 'coding' })).not.toBeNull();
  });

  it('매핑표를 받기 전에는 모두 거부, 새 표로 통째로 바뀐다', async () => {
    const reg = new TopicRegistry();
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    expect(reg.guard({ cwd: a })).not.toBeNull();
    const p = reg.apply([{ id: 'a', folder: a }]);
    // 파일 작업이 끝나기 전에도 표는 이미 바뀌어 있다
    expect(reg.guard({ cwd: a })).toBeNull();
    await p;
    await reg.apply([{ id: 'b', folder: b }]);
    expect(reg.guard({ cwd: a })).not.toBeNull();
    expect(reg.guard({ cwd: b })).toBeNull();
  });

  it('윈도우는 대소문자 무시', () => {
    if (process.platform !== 'win32') return;
    expect(isInside('C:\\Rooms\\Coding', 'c:\\rooms\\coding\\x')).toBe(true);
    expect(isInside('C:\\Rooms\\Coding', 'C:\\Rooms\\Coding2')).toBe(false);
  });
});
