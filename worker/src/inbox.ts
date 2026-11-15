import type { Inbox } from './engines/types.js';

export class Mailbox<T> implements Inbox<T> {
  private waiting = new Map<string, (v: T) => void>();
  private early = new Map<string, T>();

  put(id: string, v: T): boolean {
    const w = this.waiting.get(id);
    if (w) {
      this.waiting.delete(id);
      w(v);
      return true;
    }
    this.early.set(id, v);
    return false;
  }

  wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<T | null> {
    if (this.early.has(id)) {
      const v = this.early.get(id) as T;
      this.early.delete(id);
      return Promise.resolve(v);
    }
    return new Promise<T | null>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiting.delete(id);
      };
      const onAbort = () => {
        done();
        reject(new Error('aborted'));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          done();
          resolve(null);
        }, timeoutMs);
      }
      this.waiting.set(id, (v) => {
        done();
        resolve(v);
      });
    });
  }

  pendingIds(): string[] {
    return [...this.waiting.keys()];
  }
}
