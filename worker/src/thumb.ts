import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type LaunchOptions } from 'playwright-core';

type Log = { warn: (o: object, m?: string) => void; info?: (o: object, m?: string) => void };

export interface ThumbOpts {
  /** 테스트용 대체 (기본 chromium.launch) */
  launch?: (o: LaunchOptions) => Promise<Browser>;
  log?: Log;
  /** 브라우저를 놀려 두는 시간 뒤 닫기 (기본 60초) */
  idleMs?: number;
  /** 페이지 로드 후 기다림 (기본 1.5초) */
  settleMs?: number;
  channels?: string[];
}

/**
 * 설치된 Edge(없으면 Chrome)로 HTML 첫 화면을 찍는다.
 * 1280×800 레이아웃을 deviceScaleFactor 0.5 로 찍어 640×400 PNG (네이티브 리사이즈 의존성 없음).
 * 어떤 실패든 null — 업로드는 썸네일 없이 진행한다.
 */
export class Thumbnailer {
  private browser: Promise<Browser> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private lastWarn = 0;

  constructor(private readonly o: ThumbOpts = {}) {}

  private warn(err: unknown): void {
    if (Date.now() - this.lastWarn < 60 * 60_000) return;
    this.lastWarn = Date.now();
    this.o.log?.warn({ err: err instanceof Error ? err.message.split('\n')[0] : String(err) }, '썸네일 실패(1시간에 한 번만 기록)');
  }

  private async launchAny(): Promise<Browser> {
    const launch = this.o.launch ?? ((o: LaunchOptions) => chromium.launch(o));
    let last: unknown = new Error('브라우저 채널 없음');
    for (const channel of this.o.channels ?? ['msedge', 'chrome']) {
      try {
        return await launch({ channel, headless: true, timeout: 30_000 });
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const p = this.launchAny();
      this.browser = p;
      p.then(
        (b) => b.on('disconnected', () => {
          if (this.browser === p) this.browser = null;
        }),
        () => {
          if (this.browser === p) this.browser = null;
        },
      );
    }
    return this.browser;
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.close(), this.o.idleMs ?? 60_000);
    this.idle.unref?.();
  }

  async shot(htmlPath: string): Promise<Buffer | null> {
    if (this.idle) clearTimeout(this.idle);
    try {
      const b = await this.getBrowser();
      const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 0.5 });
      try {
        const page = await ctx.newPage();
        await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: 20_000 });
        await page.waitForTimeout(this.o.settleMs ?? 1500);
        return await page.screenshot({ type: 'png', fullPage: false, timeout: 15_000 });
      } finally {
        await ctx.close().catch(() => {});
      }
    } catch (e) {
      this.warn(e);
      return null;
    } finally {
      this.armIdle();
    }
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const p = this.browser;
    this.browser = null;
    if (p) await p.then((b) => b.close()).catch(() => {});
  }
}
