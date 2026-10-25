// Minimal types for the Workers runtime modules this viewer imports. The project does not run
// `wrangler types` as part of tests; these declarations cover only what rate.ts touches.
declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
  export interface DurableObjectState {
    storage: DurableObjectStorage;
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  }
  export interface DurableObjectStorage {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    sql: SqlStorage;
  }
  export interface SqlStorage {
    exec<T extends Record<string, SqlValue> = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
  }
  export type SqlValue = string | number | null | ArrayBuffer;
  export interface SqlCursor<T> {
    toArray(): T[];
    one(): T;
  }
}
