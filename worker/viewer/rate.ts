// Per-client fixed window. The object id is a hash of CF-Connecting-IP, chosen by the Worker.
// Storage holds a short list of timestamps per bucket, never an address and never a repository byte.
// Production backs this class with SQLite (new_sqlite_classes). The counter uses the Durable Object
// storage API so the same code runs under workerd's in-memory storage, which has no SQL API.
import { DurableObject } from 'cloudflare:workers';
import type { RateDecision } from './model.ts';

export class ViewerRateLimit extends DurableObject {
  async admit(bucket: string, now: number, limit: number, windowMs: number): Promise<RateDecision> {
    if (bucket !== 'page' && bucket !== 'pack') return { ok: false, remaining: 0, retryAfterMs: windowMs };
    const cutoff = now - windowMs;
    const stored = await this.ctx.storage.get<number[]>(bucket);
    const hits = (stored ?? []).filter(ts => typeof ts === 'number' && ts > cutoff);
    if (hits.length >= limit) {
      const oldest = hits.reduce((min, ts) => Math.min(min, ts), now);
      return { ok: false, remaining: 0, retryAfterMs: Math.max(0, oldest + windowMs - now) };
    }
    hits.push(now);
    await this.ctx.storage.put(bucket, hits.slice(-1000));
    return { ok: true, remaining: Math.max(0, limit - hits.length), retryAfterMs: 0 };
  }
}
