import WebSocket from 'ws';
import type { Logger } from './log.js';

export type Frame = { t: string; [k: string]: unknown };

export interface LinkOpts {
  endpoint: string;
  token: string;
  workerId: string;
  log: Logger;
  /** 접속 직후 보낼 hello (t 제외) */
  hello: () => Promise<Record<string, unknown>>;
  /** 30초마다 보낼 beat (t 제외) */
  beat: () => Promise<Record<string, unknown>>;
  onFrame: (f: Frame) => void;
  beatMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export function wsUrl(endpoint: string, workerId: string): string {
  const u = new URL(endpoint);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws/worker';
  u.search = '';
  u.searchParams.set('worker', workerId);
  return u.toString();
}

/** ingest 와의 웹소켓. 끊기면 1초→30초 백오프로 다시 붙는다. 끊긴 동안 보낸 프레임은 버퍼에 쌓았다가 붙으면 보낸다. */
export class WorkerLink {
  private ws: WebSocket | null = null;
  private backoff: number;
  private beatTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private outbox: string[] = [];

  constructor(private readonly o: LinkOpts) {
    this.backoff = o.minBackoffMs ?? 1000;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.ws?.close(1000, 'bye');
  }

  send(f: Frame): void {
    const s = JSON.stringify(f);
    if (this.connected) {
      this.ws!.send(s);
      return;
    }
    // 끊긴 동안: ev 만 보관(최근 2000개). beat 등은 버린다.
    if (f.t === 'ev') {
      this.outbox.push(s);
      if (this.outbox.length > 2000) this.outbox.splice(0, this.outbox.length - 2000);
    }
  }

  private connect(): void {
    const url = wsUrl(this.o.endpoint, this.o.workerId);
    const { log } = this.o;
    log.info({ url }, '서버 접속 시도');
    const ws = new WebSocket(url, { headers: { 'X-Ingest-Token': this.o.token }, handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on('open', async () => {
      log.info('서버 접속됨');
      this.backoff = this.o.minBackoffMs ?? 1000;
      try {
        ws.send(JSON.stringify({ t: 'hello', ...(await this.o.hello()) }));
      } catch (e) {
        log.error({ err: String(e) }, 'hello 전송 실패');
      }
      for (const s of this.outbox.splice(0)) ws.send(s);
      if (this.beatTimer) clearInterval(this.beatTimer);
      this.beatTimer = setInterval(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ t: 'beat', ...(await this.o.beat()) }));
        } catch (e) {
          log.warn({ err: String(e) }, 'beat 전송 실패');
        }
      }, this.o.beatMs ?? 30_000);
    });

    ws.on('message', (data) => {
      let f: Frame;
      try {
        f = JSON.parse(String(data));
      } catch {
        log.warn('JSON 이 아닌 프레임 무시');
        return;
      }
      if (!f || typeof f.t !== 'string') return;
      try {
        this.o.onFrame(f);
      } catch (e) {
        log.error({ err: String(e), t: f.t }, '프레임 처리 실패');
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      log.warn({ status: res.statusCode }, res.statusCode === 401 || res.statusCode === 403 ? '토큰이 틀림' : '접속 거부');
    });

    ws.on('error', (e) => log.warn({ err: e.message }, '웹소켓 오류'));

    ws.on('close', (code, reason) => {
      if (this.beatTimer) clearInterval(this.beatTimer);
      this.beatTimer = null;
      if (this.ws === ws) this.ws = null;
      if (this.closed) return;
      if (code === 4401) log.error('토큰이 틀려 서버가 끊음. config.json 의 token 을 확인하세요.');
      const wait = code === 4401 ? (this.o.maxBackoffMs ?? 30_000) : this.backoff;
      log.info({ code, reason: String(reason), retry_ms: wait }, '연결 끊김, 다시 붙음');
      this.retryTimer = setTimeout(() => this.connect(), wait);
      this.backoff = Math.min(this.backoff * 2, this.o.maxBackoffMs ?? 30_000);
    });
  }
}
